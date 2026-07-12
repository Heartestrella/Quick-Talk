// Browser-side wrapper around the native WebTransport API. Used by useRoom
// to shove screen video + screen audio chunks over QUIC instead of socket.io.
//
// Wire format matches server/webtransport.js exactly:
//   Uni-stream (one chunk per stream):
//     [1B kind][8B ts BE][2B metaLen][metaLen JSON][payload]
//   Datagram (heartbeat only):
//     [1B kind][4B seq BE]

import { ref } from 'vue'

export const WT_KIND = {
  VIDEO: 0x01,
  SCREEN_AUDIO: 0x02,
  PING: 0xF0,
  PONG: 0xF1
}

const HEARTBEAT_INTERVAL_MS = 1000
const HEARTBEAT_TIMEOUT_MS = 600
const MISS_THRESHOLD = 3            // 3 consecutive misses → unhealthy

/**
 * @param {{ url:string, socketId:string, token:string, room:string,
 *           onChunk:(from:'self', kind:number, ts:number, meta:object, payload:Uint8Array)=>void,
 *           onClose:()=>void }} opts
 */
export async function openWebTransport(opts) {
  if (typeof WebTransport === 'undefined') return null
  let wt
  try {
    wt = new WebTransport(opts.url)
  } catch (e) {
    console.warn('[wt] construct failed', e?.message)
    return null
  }
  try {
    await wt.ready
  } catch (e) {
    console.warn('[wt] ready failed', e?.message)
    return null
  }

  // Hello handshake — bidi stream, JSON in, JSON ack out.
  try {
    const bidi = await wt.createBidirectionalStream()
    const w = bidi.writable.getWriter()
    await w.write(new TextEncoder().encode(JSON.stringify({
      token: opts.token,
      socketId: opts.socketId,
      room: opts.room
    })))
    await w.close()
    const ackBytes = await readAll(bidi.readable, 4096)
    const ack = JSON.parse(new TextDecoder().decode(ackBytes))
    if (!ack?.ok) throw new Error('server rejected hello')
  } catch (e) {
    console.warn('[wt] hello failed', e?.message)
    try { wt.close() } catch {}
    return null
  }

  const healthy = ref(true)
  let closed = false
  let missCount = 0
  let pingSeq = 0
  const pendingPings = new Map()      // seq -> timeoutId

  const dgWritable = wt.datagrams.writable
  const dgWriter = dgWritable.getWriter()

  function markUnhealthy(reason) {
    if (!healthy.value) return
    healthy.value = false
    console.log('[wt] unhealthy —', reason)
  }
  function markHealthy() {
    if (healthy.value) return
    healthy.value = true
    console.log('[wt] healthy again')
  }

  // -------- read incoming uni-streams (screen chunks from server) --------
  // Track how many chunks actually reach us via WT — the sharer's send-side
  // stats can look 100% healthy while the server→viewer UDP path silently
  // drops everything. If this stays at 0 while `[wt] session up` was logged,
  // the receive-side UDP is broken.
  const rxStats = { chunks: 0, bytes: 0, lastLogAt: 0 }
  ;(async () => {
    const reader = wt.incomingUnidirectionalStreams.getReader()
    while (!closed) {
      let read
      try { read = await reader.read() } catch { break }
      if (read.done) break
      const uni = read.value
      readAll(uni, 40 * 1024 * 1024).then((u8) => {
        if (!u8 || u8.byteLength < 11) return
        const dec = decodeChunk(u8)
        if (!dec) return
        rxStats.chunks++
        rxStats.bytes += u8.byteLength
        const now = performance.now()
        if (now - rxStats.lastLogAt > 1000) {
          if (rxStats.chunks > 0) {
            console.log(`[wt] recv chunks=${rxStats.chunks} bytes=${rxStats.bytes}`)
          }
          rxStats.chunks = 0
          rxStats.bytes = 0
          rxStats.lastLogAt = now
        }
        // The server unwraps `from` on the socket.io path; on WT we don't
        // (yet) tag the peer id per-stream because the server only fans out
        // chunks that came from the ORIGINAL sender's session, so who "from"
        // is is only known server-side. Push it into the header as meta.from.
        opts.onChunk?.(dec.meta.from || null, dec.kind, dec.ts, dec.meta, dec.payload)
      }).catch(() => {})
    }
  })().catch(() => {})

  // -------- datagrams: receive pongs --------
  ;(async () => {
    const reader = wt.datagrams.readable.getReader()
    while (!closed) {
      let read
      try { read = await reader.read() } catch { break }
      if (read.done) break
      const u8 = read.value
      if (!u8 || u8.byteLength < 5) continue
      if (u8[0] !== WT_KIND.PONG) continue
      const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength)
      const seq = view.getUint32(1, false)
      const t = pendingPings.get(seq)
      if (t !== undefined) {
        clearTimeout(t)
        pendingPings.delete(seq)
        missCount = 0
        markHealthy()
      }
    }
  })().catch(() => {})

  // -------- heartbeat --------
  const hbTimer = setInterval(() => {
    if (closed) return
    const seq = ++pingSeq
    const buf = new Uint8Array(5)
    buf[0] = WT_KIND.PING
    new DataView(buf.buffer).setUint32(1, seq, false)
    dgWriter.write(buf).catch((e) => markUnhealthy('write ping: ' + e?.message))
    const timeout = setTimeout(() => {
      pendingPings.delete(seq)
      missCount++
      if (missCount >= MISS_THRESHOLD) markUnhealthy(`missed ${missCount} pings`)
    }, HEARTBEAT_TIMEOUT_MS)
    pendingPings.set(seq, timeout)
  }, HEARTBEAT_INTERVAL_MS)

  // -------- session close watchdog --------
  wt.closed.catch(() => {}).finally(() => {
    markUnhealthy('session closed')
    if (!closed) {
      closed = true
      opts.onClose?.()
    }
  })

  function close() {
    if (closed) return
    closed = true
    clearInterval(hbTimer)
    for (const t of pendingPings.values()) clearTimeout(t)
    pendingPings.clear()
    try { dgWriter.releaseLock() } catch {}
    try { wt.close() } catch {}
  }

  async function sendChunk(kind, tsMicros, metaObj, payload) {
    if (closed || !healthy.value) return false
    try {
      const buf = encodeChunk(kind, tsMicros, metaObj, payload)
      const out = await wt.createUnidirectionalStream()
      const writer = out.getWriter()
      await writer.write(buf)
      await writer.close()
      return true
    } catch (e) {
      markUnhealthy('send failed: ' + e?.message)
      return false
    }
  }

  return { healthy, sendChunk, close }
}

// -------------------- wire encode/decode --------------------

function encodeChunk(kind, tsMicros, metaObj, payload) {
  const metaStr = metaObj && Object.keys(metaObj).length > 0
    ? JSON.stringify(metaObj)
    : ''
  const metaBytes = metaStr ? new TextEncoder().encode(metaStr) : new Uint8Array(0)
  const payloadBytes = payload instanceof Uint8Array
    ? payload
    : new Uint8Array(payload)
  const total = 1 + 8 + 2 + metaBytes.byteLength + payloadBytes.byteLength
  const out = new Uint8Array(total)
  const view = new DataView(out.buffer)
  view.setUint8(0, kind)
  // BigInt setter — clamp ts to int64 safely.
  const ts = typeof tsMicros === 'bigint' ? tsMicros : BigInt(Math.floor(tsMicros || 0))
  view.setBigInt64(1, ts, false)
  view.setUint16(9, metaBytes.byteLength, false)
  out.set(metaBytes, 11)
  out.set(payloadBytes, 11 + metaBytes.byteLength)
  return out
}

function decodeChunk(u8) {
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength)
  const kind = view.getUint8(0)
  const ts = Number(view.getBigInt64(1, false))
  const metaLen = view.getUint16(9, false)
  if (11 + metaLen > u8.byteLength) return null
  let meta = {}
  if (metaLen > 0) {
    try { meta = JSON.parse(new TextDecoder().decode(u8.subarray(11, 11 + metaLen))) } catch { return null }
  }
  const payload = u8.subarray(11 + metaLen)
  return { kind, ts, meta, payload }
}

// Drain a ReadableStream fully into a Uint8Array (with a soft cap).
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
