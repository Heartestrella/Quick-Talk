// WebTransport (HTTP/3 / QUIC) relay for Quick Talk.
//
// This runs alongside the existing socket.io server. Screen video + screen
// audio chunks travel over WT uni-streams instead of socket.io whenever both
// sender and receiver have a healthy WT session. Voice / control / chat all
// stay on socket.io (small, reliable, and doesn't need UDP).
//
// Wire format on every uni-stream (single chunk per stream, ended by FIN):
//   [1B kind]           0x01 = video, 0x02 = screen-audio
//   [8B ts BE]          microsecond timestamp
//   [2B metaLen BE]     length of JSON metadata block
//   [metaLen bytes]     JSON metadata (config, type, etc.)
//   [payload...]        encoded frame bytes
//
// Datagrams carry heartbeats only (too small a MTU to hold keyframes; not
// worth building a fragmentation layer):
//   [1B kind]           0xF0 = ping, 0xF1 = pong
//   [4B seq BE]

import { Http3Server } from '@fails-components/webtransport'
import crypto from 'crypto'

const KIND_VIDEO = 0x01
const KIND_SCREEN_AUDIO = 0x02
const KIND_PING = 0xF0
const KIND_PONG = 0xF1
const TOKEN_TTL_MS = 30_000
const MAX_CHUNK_BYTES = 20 * 1024 * 1024   // 20 MB safety cap per uni-stream

const WT_PATH = '/wt'

/**
 * @param {object} opts
 * @param {number} opts.port
 * @param {string} opts.host
 * @param {string} opts.cert          PEM cert
 * @param {string} opts.privKey       PEM private key
 * @param {string} opts.publicUrl     what the client should dial (e.g. https://host:4433)
 * @param {object} ctx
 * @param {import('socket.io').Server} ctx.io
 * @param {Map<string, Map<string, {name, micOn, screenOn}>>} ctx.rooms
 */
export function setupWebTransport(opts, { io, rooms }) {
  const publicUrl = opts.publicUrl || `https://${opts.host}:${opts.port}${WT_PATH}`

  // token → { socketId, room, expiresAt }
  const pendingTokens = new Map()
  // socketId → WebTransportSession — set once hello succeeds, cleared on close
  const wtSessions = new Map()

  function reapExpiredTokens() {
    const now = Date.now()
    for (const [t, v] of pendingTokens) {
      if (v.expiresAt < now) pendingTokens.delete(t)
    }
  }
  setInterval(reapExpiredTokens, 15_000).unref?.()

  const server = new Http3Server({
    port: opts.port,
    host: opts.host,
    secret: crypto.randomBytes(24).toString('hex'),
    cert: opts.cert,
    privKey: opts.privKey
  })

  server.ready
    .then(() => console.log(`[quick-talk] webtransport ready (udp) at ${publicUrl}`))
    .catch((e) => console.warn('[quick-talk] webtransport ready failed', e))

  server.startServer()
  runSessionLoop(server, { io, rooms, pendingTokens, wtSessions }).catch((e) =>
    console.warn('[quick-talk] wt session loop crashed', e)
  )

  return {
    /** Issue a fresh token for a socket.io peer. Called on join. */
    issueToken(socketId, room) {
      const token = crypto.randomBytes(18).toString('base64url')
      pendingTokens.set(token, { socketId, room, expiresAt: Date.now() + TOKEN_TTL_MS })
      return { token, url: publicUrl }
    },
    /** True if `peerId` currently has a live WT session. */
    hasSession(peerId) {
      return wtSessions.has(peerId)
    },
    /** Forget a socket's WT session (called from socket.io disconnect). */
    dropSocket(peerId) {
      const s = wtSessions.get(peerId)
      if (s) { try { s.close() } catch {}; wtSessions.delete(peerId) }
    },
    getSessions: () => wtSessions,
    getServer: () => server
  }
}

// -------------------- session lifecycle --------------------

async function runSessionLoop(server, ctx) {
  const stream = await server.sessionStream(WT_PATH)
  const reader = stream.getReader()
  while (true) {
    const { done, value: session } = await reader.read()
    if (done) break
    handleSession(session, ctx).catch((e) => console.warn('[wt] session error', e?.message))
  }
}

async function handleSession(session, ctx) {
  try {
    await session.ready
  } catch (e) {
    console.warn('[wt] session ready failed', e?.message)
    return
  }

  // First bidi stream is the hello — auth + room binding.
  const hello = await readHello(session)
  if (!hello) { try { session.close() } catch {}; return }
  const meta = ctx.pendingTokens.get(hello.token)
  if (!meta || meta.socketId !== hello.socketId) {
    console.warn('[wt] bad hello, closing session')
    try { session.close() } catch {}
    return
  }
  ctx.pendingTokens.delete(hello.token)

  const peerId = meta.socketId
  const room = meta.room

  // If a previous session existed for this peer (rare — race on reconnect), close it.
  const prev = ctx.wtSessions.get(peerId)
  if (prev) { try { prev.close() } catch {} }
  ctx.wtSessions.set(peerId, session)
  console.log(`[wt] hello ok  peer=${peerId.slice(0, 6)} room=${room}`)

  // Fan out incoming uni-streams (video / screen-audio chunks).
  readUniStreams(session, peerId, room, ctx).catch(() => {})
  // Datagram heartbeats — echo pings back as pongs.
  handleDatagrams(session).catch(() => {})

  try { await session.closed } catch {}
  if (ctx.wtSessions.get(peerId) === session) ctx.wtSessions.delete(peerId)
  console.log(`[wt] session closed  peer=${peerId.slice(0, 6)}`)
}

async function readHello(session) {
  try {
    const bidiReader = session.incomingBidirectionalStreams.getReader()
    // Wait max 5s for hello. cancel() releases the reader if the peer never sends.
    const timer = new Promise((_, rej) => setTimeout(() => rej(new Error('hello timeout')), 5000))
    const { done, value: bidi } = await Promise.race([bidiReader.read(), timer])
    bidiReader.releaseLock()
    if (done || !bidi) return null

    const raw = await readAll(bidi.readable, 4096)
    let msg
    try { msg = JSON.parse(new TextDecoder().decode(raw)) } catch { return null }
    if (!msg?.token || !msg?.socketId) return null

    // ACK on the same bidi stream so the client can proceed.
    const writer = bidi.writable.getWriter()
    await writer.write(new TextEncoder().encode(JSON.stringify({ ok: true })))
    await writer.close()

    return { token: msg.token, socketId: msg.socketId }
  } catch (e) {
    console.warn('[wt] hello read failed', e?.message)
    return null
  }
}

async function readUniStreams(session, fromPeerId, room, ctx) {
  const reader = session.incomingUnidirectionalStreams.getReader()
  while (true) {
    const { done, value: uni } = await reader.read()
    if (done) break
    // Buffer the whole chunk, then fan out. Parallel with other streams — one
    // slow read doesn't block the next stream's processing since each fires
    // its own handleIncomingChunk.
    handleIncomingChunk(uni, fromPeerId, room, ctx).catch((e) =>
      console.warn('[wt] chunk fan-out error', e?.message)
    )
  }
}

async function handleIncomingChunk(uniReadable, fromPeerId, room, ctx) {
  const buf = await readAll(uniReadable, MAX_CHUNK_BYTES)
  if (!buf || buf.byteLength < 11) return
  const members = ctx.rooms.get(room)
  if (!members) return

  // Parse once. We need the header regardless of downstream transport so that
  // the receiver knows which peer sent this chunk (WT sessions are 1:1 with
  // server, so the peer id isn't implicit in the connection). Re-encode with
  // `meta.from` injected before forwarding.
  const decoded = decodeChunkHeader(buf)
  if (!decoded) return
  decoded.meta.from = fromPeerId
  const rewritten = encodeChunkHeader(decoded)

  const wtReceivers = []
  const tcpReceivers = []
  for (const memberId of members.keys()) {
    if (memberId === fromPeerId) continue
    if (ctx.wtSessions.has(memberId)) wtReceivers.push(memberId)
    else tcpReceivers.push(memberId)
  }

  for (const memberId of wtReceivers) {
    const sess = ctx.wtSessions.get(memberId)
    if (!sess) continue
    writeUniStream(sess, rewritten).catch((e) =>
      console.warn('[wt] fan-out to', memberId.slice(0, 6), 'failed', e?.message)
    )
  }

  if (tcpReceivers.length > 0) {
    const socketMsg = buildSocketMsg(decoded)
    const event = decoded.kind === KIND_VIDEO ? 'video' : 'screen-audio'
    for (const memberId of tcpReceivers) {
      ctx.io.to(memberId).emit(event, fromPeerId, socketMsg)
    }
  }
}

function encodeChunkHeader({ kind, ts, meta, payload }) {
  const metaStr = meta && Object.keys(meta).length > 0 ? JSON.stringify(meta) : ''
  const metaBytes = metaStr ? Buffer.from(metaStr, 'utf8') : Buffer.alloc(0)
  const out = Buffer.alloc(1 + 8 + 2 + metaBytes.length + payload.length)
  out.writeUInt8(kind, 0)
  out.writeBigInt64BE(BigInt(ts), 1)
  out.writeUInt16BE(metaBytes.length, 9)
  metaBytes.copy(out, 11)
  Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength).copy(out, 11 + metaBytes.length)
  return out
}

async function writeUniStream(session, buf) {
  const out = await session.createUnidirectionalStream()
  const writer = out.getWriter()
  await writer.write(buf)
  await writer.close()
}

// -------------------- wire helpers --------------------

function decodeChunkHeader(u8) {
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength)
  const kind = view.getUint8(0)
  const ts = Number(view.getBigInt64(1, false))
  const metaLen = view.getUint16(9, false)
  if (11 + metaLen > u8.byteLength) return null
  const metaBytes = u8.subarray(11, 11 + metaLen)
  const payload = u8.subarray(11 + metaLen)
  let meta = {}
  if (metaLen > 0) {
    try { meta = JSON.parse(new TextDecoder().decode(metaBytes)) } catch { return null }
  }
  return { kind, ts, meta, payload }
}

function buildSocketMsg({ kind, ts, meta, payload }) {
  // Payload → ArrayBuffer (fresh copy so we don't hold onto the pooled buffer).
  const data = payload.byteLength > 0
    ? payload.slice().buffer
    : new ArrayBuffer(0)
  if (kind === KIND_VIDEO) {
    const msg = { type: meta.type || 'delta', ts, data }
    if (meta.config) {
      msg.config = {
        codec: meta.config.codec,
        codedWidth: meta.config.codedWidth,
        codedHeight: meta.config.codedHeight,
        description: meta.config.description
          ? Buffer.from(meta.config.description, 'base64').buffer
          : null
      }
    }
    return msg
  }
  // screen-audio
  const msg = {
    type: meta.type || 'key',
    ts,
    data,
    sampleRate: meta.sampleRate || 48000,
    channels: meta.channels || 2
  }
  if (meta.description) {
    msg.description = Buffer.from(meta.description, 'base64').buffer
  }
  return msg
}

// -------------------- datagrams (heartbeat) --------------------

async function handleDatagrams(session) {
  const reader = session.datagrams.readable.getReader()
  const writable = session.datagrams.writable || session.datagrams.createWritable?.()
  const writer = writable ? writable.getWriter() : null
  while (true) {
    const { done, value: u8 } = await reader.read()
    if (done) break
    if (!u8 || u8.byteLength < 1) continue
    if (u8[0] === KIND_PING && writer) {
      // Echo as pong with same seq.
      const pong = new Uint8Array(u8.byteLength)
      pong.set(u8)
      pong[0] = KIND_PONG
      try { await writer.write(pong) } catch {}
    }
    // No other datagram kinds carry data traffic; ignore anything else.
  }
}

// -------------------- utilities --------------------

async function readAll(readable, cap) {
  const reader = readable.getReader()
  const chunks = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    total += value.byteLength
    if (total > cap) { try { reader.cancel() } catch {}; return null }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) { out.set(c, off); off += c.byteLength }
  return out
}
