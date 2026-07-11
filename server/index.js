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
import { fileURLToPath } from 'url'
import { Server } from 'socket.io'
import { setupWebTransport } from './webtransport.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')
const distDir = path.join(rootDir, 'dist')

// If SSL_CERT and SSL_KEY point at readable files, serve HTTPS directly —
// no reverse proxy needed. Required for WebCodecs / getDisplayMedia /
// getUserMedia to be exposed to the page (secure-context gate).
const sslCertPath = process.env.SSL_CERT
const sslKeyPath = process.env.SSL_KEY
let httpsOptions = null
if (sslCertPath && sslKeyPath) {
  try {
    httpsOptions = {
      cert: fs.readFileSync(sslCertPath),
      key: fs.readFileSync(sslKeyPath)
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

// Optionally spin up a WebTransport relay alongside socket.io. Enabled when
// WEBTRANSPORT_PORT is set AND we have a TLS cert. Clients auto-detect via a
// server-issued token during join; if WT is off the frontend silently keeps
// using socket.io for everything.
const wtPort = Number(process.env.WEBTRANSPORT_PORT || 0)
const wtHost = process.env.WEBTRANSPORT_HOST || HOST_default()
const wtPublicUrl = process.env.WEBTRANSPORT_PUBLIC_URL || null
function HOST_default() { return process.env.HOST || '0.0.0.0' }

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
  console.warn('[quick-talk] WEBTRANSPORT_PORT set but no SSL_CERT/SSL_KEY — WT needs TLS')
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

  socket.on('join', ({ room, name }) => {
    room = String(room || '').toUpperCase().slice(0, 12)
    if (!room) return
    currentRoom = room

    let members = rooms.get(room)
    if (!members) { members = new Map(); rooms.set(room, members) }
    members.set(socket.id, { name: name || socket.id.slice(0, 6), micOn: false, screenOn: false })
    socket.join(room)

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
  // sharer in the room to switch. Payload: { avoid, wanted }.
  socket.on('need-codec', (payload) => {
    if (!currentRoom) return
    if (!payload || typeof payload !== 'object') return
    const wanted = typeof payload.wanted === 'string' ? payload.wanted : 'h264'
    socket.to(currentRoom).emit('need-codec', { wanted })
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

const PORT = process.env.PORT || 3001
const HOST = process.env.HOST || '0.0.0.0'
const servesSpa = fs.existsSync(distDir)
const scheme = httpsOptions ? 'https' : 'http'
server.listen(PORT, HOST, () => {
  const role = servesSpa ? 'app + relay' : 'relay only'
  console.log(`[quick-talk] ${role} (${scheme}) on ${HOST}:${PORT}`)
  if (!httpsOptions && HOST !== '127.0.0.1' && HOST !== 'localhost') {
    console.log('[quick-talk] ⚠  HTTP mode — WebCodecs / getUserMedia will be')
    console.log('[quick-talk]    disabled by the browser once you leave localhost.')
    console.log('[quick-talk]    Set SSL_CERT and SSL_KEY, or put HTTPS in front (Caddy/Nginx).')
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
