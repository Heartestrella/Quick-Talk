// Quick Talk — Socket.io media relay server
// All media (voice PCM frames + screen encoded chunks) is relayed through the
// server. Nothing is stored — chunks are broadcast to the room and discarded.
//
// In production this same process also serves the built Vue app out of dist/,
// so behind a single reverse-proxy / TLS terminator you only expose one port.

import express from 'express'
import http from 'http'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import { Server } from 'socket.io'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')
const distDir = path.join(rootDir, 'dist')

const app = express()
const server = http.createServer(app)
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
server.listen(PORT, HOST, () => {
  const role = servesSpa ? 'app + relay' : 'relay only'
  console.log(`[quick-talk] ${role} on ${HOST}:${PORT}`)
  import('os').then(({ networkInterfaces }) => {
    const nets = networkInterfaces()
    const ips = []
    for (const name of Object.keys(nets)) {
      for (const net of nets[name] || []) {
        if (net.family === 'IPv4' && !net.internal) ips.push(net.address)
      }
    }
    if (ips.length) {
      // In dev the Vite server is on 5173 with HTTPS. In prod this server
      // serves the app itself on PORT — assume the reverse-proxy terminates
      // TLS or point users straight at the port.
      const devUrl = (ip) => `https://${ip}:5173`
      const prodUrl = (ip) => `http://${ip}:${PORT}`
      const line = servesSpa ? prodUrl : devUrl
      console.log('[quick-talk] LAN reachable at:')
      for (const ip of ips) console.log(`               ${line(ip)}`)
    }
  }).catch(() => {})
})
