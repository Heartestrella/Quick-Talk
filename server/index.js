// Quick Talk — Socket.io media relay server
// All media (voice PCM frames + screen encoded chunks) is relayed through the
// server. Nothing is stored — chunks are broadcast to the room and discarded.
//
// In production this same process also serves the built Vue app out of dist/,
// so behind a single reverse-proxy / TLS terminator you only expose one port.

import express from 'express'
import http from 'http'
import https from 'https'
import path from 'path'
import fs from 'fs'
import crypto from 'crypto'
import { fileURLToPath } from 'url'
import { Server } from 'socket.io'
import { setupWebTransport } from './webtransport.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')
const distDir = path.join(rootDir, 'dist')

// Single source of truth: config.json at the repo root. Copy config.example.json
// to config.json and edit. Missing file → sane HTTP defaults (relay-only, no WT).
const cfgPath = path.join(rootDir, 'config.json')
let cfg = {}
if (fs.existsSync(cfgPath)) {
  try {
    cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
    console.log(`[quick-talk] loaded config from ${cfgPath}`)
  } catch (err) {
    console.warn(`[quick-talk] config.json parse failed — using defaults:`, err.message)
  }
} else {
  console.log(`[quick-talk] no config.json — using defaults (copy config.example.json to change)`)
}

const HOST = cfg.host || '0.0.0.0'
const PORT = Number(cfg.port) || 3001

// Load TLS cert if configured. HTTPS on the main port is required for browsers
// to expose WebCodecs / getDisplayMedia / getUserMedia (secure-context gate).
let httpsOptions = null
if (cfg.ssl?.cert && cfg.ssl?.key) {
  try {
    httpsOptions = {
      cert: fs.readFileSync(cfg.ssl.cert),
      key: fs.readFileSync(cfg.ssl.key)
    }
  } catch (err) {
    console.warn(`[quick-talk] SSL cert/key unreadable — falling back to HTTP:`, err.message)
  }
}

const app = express()
const server = httpsOptions
  ? https.createServer(httpsOptions, app)
  : http.createServer(app)
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  // Screen encoded chunks can hit a few MB at 4K; give ourselves headroom.
  maxHttpBufferSize: 16 * 1024 * 1024
})

app.get('/health', (_, res) => res.json({ ok: true, ts: Date.now() }))

// Serve the built SPA when dist/ exists. In dev this directory won't be
// present and Vite handles the frontend itself.
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir, {
    maxAge: '1h',
    setHeaders(res, filePath) {
      // Hashed asset files can be cached hard; index.html must always revalidate.
      if (filePath.endsWith('index.html')) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
      }
    }
  }))
  // SPA fallback for Vue Router history mode — any GET that isn't an asset
  // or an API path returns index.html.
  app.get(/^\/(?!socket\.io|health|assets\/).*/, (req, res) => {
    res.sendFile(path.join(distDir, 'index.html'))
  })
  console.log(`[quick-talk] serving SPA from ${distDir}`)
} else {
  console.log(`[quick-talk] dist/ not found — running in relay-only mode (dev)`)
}

/**
 * rooms: Map<roomId, Map<socketId, { name, micOn, screenOn }>>
 */
const rooms = new Map()

// -------------------- room password store --------------------
// Persist to disk so restarts don't drop passwords. Kept intentionally simple:
// small file, salted PBKDF2 hash per room (not a security fortress — the point
// is to keep casual visitors out, not thwart the server operator).
const roomsFile = path.join(rootDir, 'rooms.json')
const roomPasswords = new Map()   // roomId -> { salt, hash, createdAt }
function loadRoomPasswords() {
  if (!fs.existsSync(roomsFile)) return
  try {
    const raw = JSON.parse(fs.readFileSync(roomsFile, 'utf8'))
    for (const [rid, entry] of Object.entries(raw || {})) {
      if (entry && typeof entry.hash === 'string' && typeof entry.salt === 'string') {
        roomPasswords.set(rid, entry)
      }
    }
    console.log(`[quick-talk] loaded ${roomPasswords.size} room passwords`)
  } catch (err) {
    console.warn(`[quick-talk] rooms.json parse failed:`, err.message)
  }
}
let saveTimer = null
function saveRoomPasswords() {
  // Debounce — many joins in a burst shouldn't fsync every time.
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    const obj = {}
    for (const [rid, entry] of roomPasswords) obj[rid] = entry
    try {
      fs.writeFileSync(roomsFile + '.tmp', JSON.stringify(obj, null, 2))
      fs.renameSync(roomsFile + '.tmp', roomsFile)
    } catch (err) {
      console.warn('[quick-talk] rooms.json write failed:', err.message)
    }
  }, 500)
}
function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(String(password), salt, 60_000, 32, 'sha256').toString('hex')
}
function setRoomPassword(roomId, password) {
  const salt = crypto.randomBytes(12).toString('hex')
  roomPasswords.set(roomId, {
    salt,
    hash: hashPassword(password, salt),
    createdAt: Date.now()
  })
  saveRoomPasswords()
}
function verifyRoomPassword(roomId, password) {
  const entry = roomPasswords.get(roomId)
  if (!entry) return true                            // no password set → open room
  if (!password) return false
  return hashPassword(password, entry.salt) === entry.hash
}
function roomHasPassword(roomId) {
  return roomPasswords.has(roomId)
}
loadRoomPasswords()

// Optionally spin up a WebTransport relay alongside socket.io. Enabled when
// config.webtransport.port > 0 AND we have a TLS cert. Clients auto-detect via
// a server-issued token during join; if WT is off the frontend silently keeps
// using socket.io for everything.
const wtPort = Number(cfg.webtransport?.port) || 0
const wtHost = cfg.webtransport?.host || HOST
const wtPublicUrl = cfg.webtransport?.publicUrl || null

let wt = null
if (wtPort > 0 && httpsOptions) {
  try {
    wt = setupWebTransport(
      {
        port: wtPort,
        host: wtHost,
        cert: httpsOptions.cert.toString?.() ?? httpsOptions.cert,
        privKey: httpsOptions.key.toString?.() ?? httpsOptions.key,
        publicUrl: wtPublicUrl
      },
      { io, rooms }
    )
    console.log(`[quick-talk] webtransport enabled on udp/${wtPort}`)
  } catch (e) {
    console.warn('[quick-talk] webtransport init failed — running socket.io-only:', e.message)
    wt = null
  }
} else if (wtPort > 0) {
  console.warn('[quick-talk] webtransport.port set but no ssl.cert/ssl.key — WT needs TLS')
}

function serialise(members, exceptId) {
  const list = []
  for (const [id, m] of members) {
    if (id === exceptId) continue
    list.push({ id, name: m.name, micOn: m.micOn, screenOn: m.screenOn })
  }
  return list
}

io.on('connection', (socket) => {
  let currentRoom = null

  socket.on('join', ({ room, name, password, setPassword }) => {
    room = String(room || '').toUpperCase().slice(0, 12)
    if (!room) return

    // If this join carries a setPassword field AND no password is currently
    // registered for the room, register it. First-to-arrive semantics — anyone
    // else asking to join the same room from now on must have this password.
    if (setPassword && !roomHasPassword(room)) {
      setRoomPassword(room, String(setPassword))
    }

    // Password gate. If a password exists for this room, the caller must have
    // supplied it. Reject with a specific reason so the client can prompt.
    if (!verifyRoomPassword(room, password)) {
      socket.emit('auth-required', {
        room,
        reason: password ? 'wrong' : 'needed'
      })
      return
    }

    currentRoom = room

    let members = rooms.get(room)
    if (!members) { members = new Map(); rooms.set(room, members) }
    members.set(socket.id, { name: name || socket.id.slice(0, 6), micOn: false, screenOn: false })
    socket.join(room)

    socket.emit('joined', { room, hasPassword: roomHasPassword(room) })
    socket.emit('peers', { list: serialise(members, socket.id) })
    socket.to(room).emit('peer-joined', {
      id: socket.id,
      name: members.get(socket.id).name,
      micOn: false,
      screenOn: false
    })

    // If WT is available, hand this peer a token + URL so it can open a
    // parallel QUIC session for the heavy screen data.
    if (wt) {
      const { token, url } = wt.issueToken(socket.id, room)
      socket.emit('webtransport', { url, token })
    }
  })

  // Rename mid-room — same shape as join.name, but announced to everyone.
  socket.on('rename', ({ name }) => {
    if (!currentRoom) return
    const members = rooms.get(currentRoom)
    if (!members?.has(socket.id)) return
    const clean = String(name || '').slice(0, 24).trim() || socket.id.slice(0, 6)
    const m = members.get(socket.id)
    m.name = clean
    socket.to(currentRoom).emit('peer-renamed', { id: socket.id, name: clean })
  })

  // Voice: PCM Int16 frames (~640 bytes each = 20ms at 16 kHz mono).
  // Buffer is delivered as raw binary via socket.io; we prepend sender id and forward.
  socket.on('voice', (buf) => {
    if (!currentRoom) return
    socket.to(currentRoom).emit('voice', socket.id, buf)
  })

  // Video: WebCodecs EncodedVideoChunk payload.
  //   msg = { type: 'key'|'delta', ts, data: ArrayBuffer, config?: {...} }
  // Server just relays. Encoder side sends config on every keyframe, so newcomers
  // pick up the next natural keyframe (we also poke the sharer on peer-joined).
  socket.on('video', (msg) => {
    if (!currentRoom) return
    socket.to(currentRoom).emit('video', socket.id, msg)
  })
  // Explicit keyframe request from any peer to any active sharer in the room.
  socket.on('need-keyframe', () => {
    if (!currentRoom) return
    socket.to(currentRoom).emit('need-keyframe')
  })

  // Screen-audio: Opus-encoded EncodedAudioChunk payload from the sharer.
  //   msg = { type: 'key'|'delta', ts, data: ArrayBuffer, sampleRate, channels,
  //           description? }  |  { type: 'end' }  when the sharer stops audio
  socket.on('screen-audio', (msg) => {
    if (!currentRoom) return
    socket.to(currentRoom).emit('screen-audio', socket.id, msg)
  })

  // Viewer discovered it can't decode the current codec — ask any active
  // sharer in the room to switch. Payload: { avoid, wanted, avoidString? }.
  //   wanted:      target family ('h264' | 'hevc' | 'vp9' | ...)
  //   avoidString: specific codec string the viewer rejected (e.g. avc1.640028)
  //                so the sharer can pick a lower profile in the same family.
  socket.on('need-codec', (payload) => {
    if (!currentRoom) return
    if (!payload || typeof payload !== 'object') return
    const wanted = typeof payload.wanted === 'string' ? payload.wanted : 'h264'
    const avoidString = typeof payload.avoidString === 'string' ? payload.avoidString : undefined
    socket.to(currentRoom).emit('need-codec', avoidString ? { wanted, avoidString } : { wanted })
  })

  // Viewer telling the sharer a specific codec string can't decode. Used to
  // skip that exact profile/level on the next encoder pick without giving up
  // the whole codec family.
  socket.on('codec-string-unsupported', (payload) => {
    if (!currentRoom) return
    if (!payload || typeof payload !== 'object') return
    const codec = typeof payload.codec === 'string' ? payload.codec : null
    if (!codec) return
    socket.to(currentRoom).emit('codec-string-unsupported', { codec })
  })

  // Viewer's screen-transport is stalling — probably WebTransport blocked by
  // NAT / middlebox. Relay to the room; the sharer that owns the current
  // share will drop back to plain socket.io for the remainder of the share.
  socket.on('need-tcp', () => {
    if (!currentRoom) return
    socket.to(currentRoom).emit('need-tcp')
  })

  // Sharer reports they can't encode a codec the viewer just asked for.
  // Broadcast so viewers stop looping-requesting the same codec.
  socket.on('codec-unavailable', (payload) => {
    if (!currentRoom) return
    if (!payload || typeof payload !== 'object') return
    const codec = typeof payload.codec === 'string' ? payload.codec : null
    if (!codec) return
    socket.to(currentRoom).emit('codec-unavailable', { codec })
  })

  socket.on('state', ({ micOn, screenOn }) => {
    if (!currentRoom) return
    const members = rooms.get(currentRoom)
    if (!members?.has(socket.id)) return
    const m = members.get(socket.id)
    m.micOn = !!micOn
    m.screenOn = !!screenOn
    socket.to(currentRoom).emit('peer-state', {
      id: socket.id,
      micOn: m.micOn,
      screenOn: m.screenOn
    })
  })

  socket.on('chat', ({ text, image, ts }) => {
    if (!currentRoom) return
    const members = rooms.get(currentRoom)
    if (!members?.has(socket.id)) return
    const safeText = typeof text === 'string' ? text.slice(0, 500) : ''
    // Cap pasted images at ~6MB of base64 to keep the relay pressure sane.
    // Frontend already downscales, but the server is the last line of defence.
    let safeImage = null
    if (typeof image === 'string' && image.startsWith('data:image/') && image.length < 6_500_000) {
      safeImage = image
    }
    if (!safeText && !safeImage) return
    io.to(currentRoom).emit('chat', {
      from: socket.id,
      name: members.get(socket.id).name,
      text: safeText,
      image: safeImage,
      ts: Number(ts) || Date.now()
    })
  })

  socket.on('disconnect', () => {
    if (wt) wt.dropSocket(socket.id)
    if (!currentRoom) return
    const members = rooms.get(currentRoom)
    if (!members) return
    members.delete(socket.id)
    socket.to(currentRoom).emit('peer-left', { id: socket.id })
    if (members.size === 0) rooms.delete(currentRoom)
  })
})

const servesSpa = fs.existsSync(distDir)
const scheme = httpsOptions ? 'https' : 'http'
server.listen(PORT, HOST, () => {
  const role = servesSpa ? 'app + relay' : 'relay only'
  console.log(`[quick-talk] ${role} (${scheme}) on ${HOST}:${PORT}`)
  if (!httpsOptions && HOST !== '127.0.0.1' && HOST !== 'localhost') {
    console.log('[quick-talk] ⚠  HTTP mode — WebCodecs / getUserMedia will be')
    console.log('[quick-talk]    disabled by the browser once you leave localhost.')
    console.log('[quick-talk]    Set ssl.cert / ssl.key in config.json, or put HTTPS in front.')
  }
  import('os').then(({ networkInterfaces }) => {
    const nets = networkInterfaces()
    const ips = []
    for (const name of Object.keys(nets)) {
      for (const net of nets[name] || []) {
        if (net.family === 'IPv4' && !net.internal) ips.push(net.address)
      }
    }
    if (ips.length) {
      console.log('[quick-talk] LAN reachable at:')
      for (const ip of ips) console.log(`               ${scheme}://${ip}:${PORT}`)
    }
  }).catch(() => {})
})
