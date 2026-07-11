// Quick Talk — server-relayed transport
// Voice: PCM Int16 @ 16 kHz mono, 20 ms frames.
// Screen: WebCodecs VP9/VP8/H.264 encoded chunks (delta-frame compressed).
// Nothing is P2P — every packet passes through the Node.js relay server.

import { reactive, ref, onUnmounted, computed } from 'vue'
import { io } from 'socket.io-client'

const NAMES = ['NORTH', 'SOUTH', 'EAST', 'WEST', 'ECHO', 'DELTA', 'FOXTROT', 'GOLF', 'HOTEL', 'INDIA', 'JULIET', 'KILO', 'LIMA', 'MIKE']
function randomHandle() {
  const w = NAMES[Math.floor(Math.random() * NAMES.length)]
  const n = Math.floor(Math.random() * 90 + 10)
  return `${w}-${n}`
}

const SAMPLE_RATE = 16000        // Hz
const FRAME_SAMPLES = 320        // 20 ms
const JITTER_SEC = 0.06          // playback lead time to smooth over network jitter

export function useRoom(roomId) {
  const me = reactive({
    id: null,
    name: randomHandle(),
    micOn: false,
    screenOn: false,
    level: 0,
    denoiseOn: true,
    gateOpen: false,
    txAudio: 0,          // bytes/s outbound
    txScreen: 0
  })

  const peers = reactive(new Map()) // id -> { id, name, level, micOn, screenOn, lastFrameTs }
  const messages = reactive([])
  const connection = ref('connecting')
  const activeScreenPeerId = ref(null)
  const errorMsg = ref('')
  const needsAudioUnlock = ref(false)
  const decoderUnsupported = ref(false)
  const awaitingCodecSwitch = ref(false)   // viewer: asked sharer to swap codec, waiting for new keyframe
  // true after the very first successful socket connect — used to distinguish
  // "still connecting for the first time" from "we dropped and are reconnecting"
  const hasConnectedOnce = ref(false)
  const reconnectAttempt = ref(0)

  const screenOptions = reactive({
    resolution: '1080p',    // '720p' | '1080p' | '1440p' | '4k' | 'source'
    frameRate: 30,          // fps
    bitrate: 3.0,           // Mbps target (0.5 – 12)
    codec: 'auto'           // 'auto' picks the best available (VP9 > H264 > VP8)
  })

  const codecInfo = ref('')  // reactive info string shown in UI, e.g. "VP9 · 2.8 Mbps"

  let socket = null

  // ---------- audio: shared context, denoise chain, capture worklet ----------
  let audioCtx = null                 // 16 kHz AudioContext for BOTH capture and playback
  let localStream = null              // raw mic MediaStream
  let denoise = null                  // { source, hp, comp, gate, analyser, sink, raf, rewire }
  let captureNode = null              // AudioWorkletNode running pcm-worklet.js
  const nextPlayAt = new Map()        // peerId -> AudioContext currentTime for next chunk
  const remoteGains = new Map()       // peerId -> GainNode (per-peer volume + analyser hook)

  async function ensureAudioCtx() {
    if (audioCtx) {
      if (audioCtx.state === 'suspended') { try { await audioCtx.resume() } catch {} }
      return audioCtx
    }
    audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: SAMPLE_RATE })
    try {
      await audioCtx.audioWorklet.addModule('/pcm-worklet.js')
    } catch (e) {
      console.warn('audio worklet load failed', e)
    }
    return audioCtx
  }

  function buildDenoise(rawStream) {
    const source = audioCtx.createMediaStreamSource(rawStream)
    const hp = audioCtx.createBiquadFilter()
    hp.type = 'highpass'
    hp.frequency.value = 90

    const comp = audioCtx.createDynamicsCompressor()
    comp.threshold.value = -28
    comp.knee.value = 12
    comp.ratio.value = 4
    comp.attack.value = 0.005
    comp.release.value = 0.15

    const analyser = audioCtx.createAnalyser()
    analyser.fftSize = 512
    analyser.smoothingTimeConstant = 0.65

    const gate = audioCtx.createGain()
    gate.gain.value = 0

    // The worklet needs a downstream sink to be scheduled; we go to a muted
    // gain so we never hear ourselves.
    const sink = audioCtx.createGain()
    sink.gain.value = 0

    function rewire(on) {
      try { source.disconnect() } catch {}
      try { hp.disconnect() } catch {}
      try { comp.disconnect() } catch {}
      try { analyser.disconnect() } catch {}
      try { gate.disconnect() } catch {}
      if (on) {
        source.connect(hp)
        hp.connect(comp)
        comp.connect(analyser)
        analyser.connect(gate)
      } else {
        source.connect(analyser)
        analyser.connect(gate)
        gate.gain.setTargetAtTime(1, audioCtx.currentTime, 0.01)
      }
      // gate always feeds the capture worklet (if present) and the sink
      if (captureNode) gate.connect(captureNode)
      gate.connect(sink)
    }
    rewire(me.denoiseOn)
    sink.connect(audioCtx.destination)

    // gate control + level metering
    const data = new Uint8Array(analyser.frequencyBinCount)
    const OPEN = 0.032, CLOSE = 0.018, HOLD = 0.28
    let lastLoud = 0, gateOpen = false
    const loop = () => {
      analyser.getByteTimeDomainData(data)
      let sum = 0
      for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128
        sum += v * v
      }
      const rms = Math.sqrt(sum / data.length)
      me.level = Math.min(1, rms * 3.2)
      if (me.denoiseOn) {
        const now = audioCtx.currentTime
        if (rms > OPEN) { gateOpen = true; lastLoud = now }
        else if (rms < CLOSE && now - lastLoud > HOLD) gateOpen = false
        gate.gain.setTargetAtTime(gateOpen ? 1 : 0, now, 0.03)
        me.gateOpen = gateOpen
      } else {
        me.gateOpen = true
      }
      denoise.raf = requestAnimationFrame(loop)
    }
    denoise = { source, hp, comp, analyser, gate, sink, rewire, raf: null }
    denoise.raf = requestAnimationFrame(loop)
    return denoise
  }

  function destroyDenoise() {
    if (!denoise) return
    cancelAnimationFrame(denoise.raf)
    try { denoise.source.disconnect() } catch {}
    try { denoise.hp.disconnect() } catch {}
    try { denoise.comp.disconnect() } catch {}
    try { denoise.analyser.disconnect() } catch {}
    try { denoise.gate.disconnect() } catch {}
    try { denoise.sink.disconnect() } catch {}
    denoise = null
    me.level = 0
    me.gateOpen = false
  }

  function toggleDenoise() {
    me.denoiseOn = !me.denoiseOn
    if (denoise) denoise.rewire(me.denoiseOn)
  }

  // ---------- microphone: capture PCM and send ----------
  async function toggleMic() {
    if (me.micOn) return stopMic()
    try {
      await ensureAudioCtx()
      const raw = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
          sampleRate: SAMPLE_RATE
        },
        video: false
      })
      localStream = raw

      // Create the capture worklet before the denoise chain so it's ready to be wired in.
      captureNode = new AudioWorkletNode(audioCtx, 'pcm-capturer')
      let txBytes = 0
      let txTick = performance.now()
      captureNode.port.onmessage = (e) => {
        if (!socket?.connected) return
        socket.emit('voice', e.data) // ArrayBuffer, 640 bytes
        txBytes += e.data.byteLength
        const now = performance.now()
        if (now - txTick > 1000) {
          me.txAudio = Math.round((txBytes * 1000) / (now - txTick))
          txBytes = 0
          txTick = now
        }
      }

      buildDenoise(raw)
      me.micOn = true
      broadcastState()
    } catch (err) {
      console.warn(err)
      errorMsg.value = '无法访问麦克风 · ' + (err?.message || '权限被拒绝')
      setTimeout(() => (errorMsg.value = ''), 4000)
    }
  }

  function stopMic() {
    destroyDenoise()
    if (captureNode) { try { captureNode.disconnect() } catch {}; captureNode.port.onmessage = null; captureNode = null }
    if (localStream) { localStream.getTracks().forEach((t) => t.stop()); localStream = null }
    me.micOn = false
    me.txAudio = 0
    broadcastState()
  }

  // ---------- audio playback (per-peer scheduled queue) ----------
  function playPcm(from, arrayBuf) {
    if (!audioCtx) {
      // create a playback-only context so listeners without mic still hear us
      audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: SAMPLE_RATE })
    }
    if (audioCtx.state === 'suspended') {
      audioCtx.resume().catch(() => { needsAudioUnlock.value = true })
    }
    const int16 = new Int16Array(arrayBuf)
    // per-peer gain lets us route into a shared analyser for waveform if we want
    let gain = remoteGains.get(from)
    if (!gain) {
      gain = audioCtx.createGain()
      gain.connect(audioCtx.destination)
      remoteGains.set(from, gain)
    }
    // level for waveform (cheap RMS)
    let sum = 0
    for (let i = 0; i < int16.length; i++) sum += (int16[i] / 32768) ** 2
    const rms = Math.sqrt(sum / int16.length)
    const p = peers.get(from)
    if (p) { p.level = Math.min(1, rms * 3.2); p.lastFrameTs = performance.now() }

    const buffer = audioCtx.createBuffer(1, int16.length, SAMPLE_RATE)
    const ch = buffer.getChannelData(0)
    for (let i = 0; i < int16.length; i++) ch[i] = int16[i] / 32768
    const src = audioCtx.createBufferSource()
    src.buffer = buffer
    src.connect(gain)
    const now = audioCtx.currentTime
    let t = nextPlayAt.get(from) || 0
    if (t < now + JITTER_SEC) t = now + JITTER_SEC   // fresh start (or we fell behind → resync)
    src.start(t)
    nextPlayAt.set(from, t + buffer.duration)
  }

  // ---------- screen share: WebCodecs hardware encoder ----------
  const RES_MAP = {
    '720p':  { width: 1280, height: 720 },
    '1080p': { width: 1920, height: 1080 },
    '1440p': { width: 2560, height: 1440 },
    '4k':    { width: 3840, height: 2160 },
    'source': null
  }
  // Encoding requires the full pipeline (encoder + reader + decoder for probing);
  // viewing only needs VideoDecoder. Splitting these means phones that lack
  // MediaStreamTrackProcessor can still receive & display a screen share.
  const HAS_ENCODER =
    typeof window !== 'undefined' &&
    typeof window.VideoEncoder !== 'undefined' &&
    typeof window.VideoDecoder !== 'undefined' &&
    typeof window.MediaStreamTrackProcessor !== 'undefined'
  const HAS_DECODER =
    typeof window !== 'undefined' &&
    typeof window.VideoDecoder !== 'undefined' &&
    typeof window.EncodedVideoChunk !== 'undefined'

  let screenStream = null
  let vEncoder = null
  let vReader = null
  let vTrackProcessor = null
  let vFrameCount = 0
  let vForceKey = true
  let vBitrateBps = 3_000_000
  // VideoEncoder emits `meta.decoderConfig` only on the first output after
  // configure() (and on codec swaps). Cache it here so we can attach it to
  // *every* keyframe — otherwise late-joiners / refreshers get keyframes
  // without any decoder config and stay black forever.
  let lastDecoderConfig = null

  // Every codec has multiple valid string forms; different browsers/GPUs
  // support different ones. We try them all in order.
  const CODEC_CANDIDATES = [
    { id: 'vp9',  label: 'VP9',   strings: ['vp09.00.10.08', 'vp09.00.31.08', 'vp09.02.10.10', 'vp9'] },
    { id: 'h264', label: 'H.264', strings: ['avc1.42E01F', 'avc1.42001E', 'avc1.42E01E', 'avc1.4D401F', 'avc1.4D001F', 'avc1.640028'] },
    { id: 'vp8',  label: 'VP8',   strings: ['vp8'] },
    { id: 'av1',  label: 'AV1',   strings: ['av01.0.04M.08'] }
  ]

  async function pickEncoderCodec(width, height, framerate, bitrate) {
    // most encoders require even dimensions
    width = width - (width % 2)
    height = height - (height % 2)

    const wanted = screenOptions.codec === 'auto' ? null : screenOptions.codec
    const ordered = wanted
      ? [CODEC_CANDIDATES.find((c) => c.id === wanted), ...CODEC_CANDIDATES.filter((c) => c.id !== wanted)].filter(Boolean)
      : CODEC_CANDIDATES

    // Progressively loosen constraints — some machines reject the strict combo.
    const optionSets = [
      { hardwareAcceleration: 'prefer-hardware', latencyMode: 'realtime' },
      { hardwareAcceleration: 'prefer-software', latencyMode: 'realtime' },
      { hardwareAcceleration: 'no-preference',   latencyMode: 'realtime' },
      { hardwareAcceleration: 'no-preference' },
      {}
    ]

    for (const opts of optionSets) {
      for (const c of ordered) {
        for (const codecStr of c.strings) {
          const cfg = {
            codec: codecStr,
            width, height,
            bitrate,
            framerate,
            ...opts
          }
          try {
            const s = await VideoEncoder.isConfigSupported(cfg)
            console.log('[webcodecs] probe', codecStr, opts, '→', s.supported ? 'OK' : 'nope')
            if (s.supported) {
              return { id: c.id, label: c.label, string: codecStr, config: s.config, opts }
            }
          } catch (err) {
            console.log('[webcodecs] probe', codecStr, opts, '→ threw', err?.message)
          }
        }
      }
    }
    return null
  }

  function cloneArrayBuffer(input) {
    if (!input) return null
    const src = input instanceof ArrayBuffer
      ? new Uint8Array(input)
      : new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
    const out = new ArrayBuffer(src.byteLength)
    new Uint8Array(out).set(src)
    return out
  }

  async function toggleScreen() {
    if (me.screenOn) return stopScreen()
    if (!HAS_ENCODER) {
      errorMsg.value = '当前设备无法作为共享端 · 请用桌面版 Chrome / Edge / Safari 16.4+'
      setTimeout(() => (errorMsg.value = ''), 5000)
      return
    }
    try {
      const res = RES_MAP[screenOptions.resolution]
      const constraints = { frameRate: { ideal: screenOptions.frameRate, max: 60 }, cursor: 'always' }
      if (res) {
        constraints.width = { ideal: res.width, max: res.width }
        constraints.height = { ideal: res.height, max: res.height }
      }
      screenStream = await navigator.mediaDevices.getDisplayMedia({ video: constraints, audio: false })
      const track = screenStream.getVideoTracks()[0]
      track.addEventListener('ended', stopScreen)

      const settings = track.getSettings()
      let width = settings.width || (res ? res.width : 1920)
      let height = settings.height || (res ? res.height : 1080)
      // encoders reject odd dimensions
      width = width - (width % 2)
      height = height - (height % 2)
      const fps = Math.min(60, Math.max(1, settings.frameRate || screenOptions.frameRate))
      vBitrateBps = Math.round(screenOptions.bitrate * 1_000_000)

      const chosen = await pickEncoderCodec(width, height, fps, vBitrateBps)
      if (!chosen) {
        throw new Error('本机 WebCodecs 无可用编码器 · 详见 Console')
      }
      console.log('[webcodecs] chosen', chosen.string, chosen.opts)
      codecInfo.value = `${chosen.label} · ${(vBitrateBps / 1_000_000).toFixed(1)} Mbps · ${width}×${height}@${fps}fps`

      vFrameCount = 0
      vForceKey = true
      lastDecoderConfig = null
      let txBytes = 0
      let txTick = performance.now()

      vEncoder = new VideoEncoder({
        output: (chunk, meta) => {
          if (!socket?.connected) return
          const buf = new ArrayBuffer(chunk.byteLength)
          chunk.copyTo(buf)
          const msg = {
            type: chunk.type,        // 'key' | 'delta'
            ts: chunk.timestamp,     // microseconds
            data: buf
          }
          // WebCodecs only hands us `meta.decoderConfig` once (right after
          // configure). Cache it and stamp every keyframe with it so viewers
          // that join mid-share get a decodable stream on the next key.
          if (meta?.decoderConfig) {
            lastDecoderConfig = {
              codec: meta.decoderConfig.codec,
              codedWidth: meta.decoderConfig.codedWidth,
              codedHeight: meta.decoderConfig.codedHeight,
              description: cloneArrayBuffer(meta.decoderConfig.description)
            }
          }
          if (chunk.type === 'key' && lastDecoderConfig) {
            msg.config = {
              codec: lastDecoderConfig.codec,
              codedWidth: lastDecoderConfig.codedWidth,
              codedHeight: lastDecoderConfig.codedHeight,
              // Clone per-send — socket.io may transfer the ArrayBuffer.
              description: lastDecoderConfig.description
                ? cloneArrayBuffer(lastDecoderConfig.description)
                : null
            }
          }
          socket.emit('video', msg)
          txBytes += buf.byteLength
          const now = performance.now()
          if (now - txTick > 1000) {
            me.txScreen = Math.round((txBytes * 1000) / (now - txTick))
            txBytes = 0
            txTick = now
          }
        },
        error: (e) => {
          console.warn('encoder error', e)
          errorMsg.value = '编码器错误 · ' + (e?.message || e)
          setTimeout(() => (errorMsg.value = ''), 5000)
        }
      })
      const encoderConfig = {
        codec: chosen.string,
        width, height,
        bitrate: vBitrateBps,
        framerate: fps,
        bitrateMode: 'variable',
        ...chosen.opts   // whichever hw/latency combo actually passed the probe
      }
      vEncoder.configure(encoderConfig)
      // stash for live re-configure when the user drags the bitrate slider
      vEncoder._codec = chosen.string
      vEncoder._w = width
      vEncoder._h = height
      vEncoder._opts = chosen.opts

      me.screenOn = true
      activeScreenPeerId.value = 'me'
      broadcastState()

      vTrackProcessor = new MediaStreamTrackProcessor({ track })
      vReader = vTrackProcessor.readable.getReader()
      pumpFrames().catch((e) => console.warn('pump ended', e))
    } catch (err) {
      console.warn(err)
      errorMsg.value = '屏幕共享失败 · ' + (err?.message || '权限被拒绝')
      setTimeout(() => (errorMsg.value = ''), 4000)
      if (screenStream) { screenStream.getTracks().forEach((t) => t.stop()); screenStream = null }
    }
  }

  async function pumpFrames() {
    // Force a keyframe roughly every 4 seconds so recovery is bounded.
    const KEY_EVERY = 120
    while (vEncoder && vEncoder.state === 'configured' && vReader) {
      const { value: frame, done } = await vReader.read()
      if (done) break
      if (!vEncoder || vEncoder.state !== 'configured') { frame.close(); break }
      const keyFrame = vForceKey || (vFrameCount % KEY_EVERY === 0)
      vForceKey = false
      try { vEncoder.encode(frame, { keyFrame }) } catch (e) { console.warn('encode', e) }
      frame.close()
      vFrameCount++
    }
  }

  function stopScreen() {
    if (vEncoder) {
      try { vEncoder.close() } catch {}
      vEncoder = null
    }
    if (vReader) { try { vReader.cancel() } catch {}; vReader = null }
    vTrackProcessor = null
    if (screenStream) { screenStream.getTracks().forEach((t) => t.stop()); screenStream = null }
    me.screenOn = false
    me.txScreen = 0
    codecInfo.value = ''
    lastDecoderConfig = null
    if (activeScreenPeerId.value === 'me') activeScreenPeerId.value = null
    broadcastState()
  }

  // update encoder bitrate live (when user drags the slider)
  function applyBitrate() {
    if (!vEncoder || vEncoder.state !== 'configured') return
    const b = Math.round(screenOptions.bitrate * 1_000_000)
    try {
      vEncoder.configure({
        codec: vEncoder._codec,
        width: vEncoder._w,
        height: vEncoder._h,
        bitrate: b,
        framerate: screenOptions.frameRate,
        bitrateMode: 'variable',
        ...(vEncoder._opts || {})
      })
      vBitrateBps = b
      vForceKey = true
      codecInfo.value = codecInfo.value.replace(/[\d.]+ Mbps/, `${screenOptions.bitrate.toFixed(1)} Mbps`)
    } catch (e) { console.warn('reconfigure failed', e) }
  }
  function retimeScreen() { /* fps changes now require restart; no-op */ }

  // Swap the encoder to a different codec while the screen share stays live.
  // Triggered by a viewer that couldn't decode the current codec (typically
  // mobile Safari receiving VP9 asking for H.264).
  async function swapCodec(wanted) {
    if (!me.screenOn || !vEncoder) return
    const currentFamily = CODEC_FAMILY(vEncoder._codec)
    if (currentFamily === wanted) {
      // Already on target — just force a keyframe so the requesting viewer
      // gets a fresh decoderConfig immediately.
      vForceKey = true
      return
    }
    const w = vEncoder._w
    const h = vEncoder._h
    const fps = screenOptions.frameRate
    // pickEncoderCodec reads screenOptions.codec; temporarily override.
    const savedPref = screenOptions.codec
    screenOptions.codec = wanted
    let chosen
    try {
      chosen = await pickEncoderCodec(w, h, fps, vBitrateBps)
    } finally {
      screenOptions.codec = savedPref
    }
    if (!chosen) {
      console.warn('[webcodecs] no encoder available for', wanted, '— staying on', currentFamily)
      return
    }
    console.log('[webcodecs] swap codec', currentFamily, '→', wanted, chosen.string)

    // Build the new encoder BEFORE closing the old one so pumpFrames never
    // sees a null vEncoder between the two (its while() loop would exit and
    // sharing would silently stop).
    let txBytes = 0
    let txTick = performance.now()
    // The codec changed — invalidate the cached decoder config so the next
    // meta.decoderConfig from the new encoder overwrites it before we start
    // stamping keyframes.
    lastDecoderConfig = null
    const oldEncoder = vEncoder
    const newEncoder = new VideoEncoder({
      output: (chunk, meta) => {
        if (!socket?.connected) return
        const buf = new ArrayBuffer(chunk.byteLength)
        chunk.copyTo(buf)
        const msg = { type: chunk.type, ts: chunk.timestamp, data: buf }
        if (meta?.decoderConfig) {
          lastDecoderConfig = {
            codec: meta.decoderConfig.codec,
            codedWidth: meta.decoderConfig.codedWidth,
            codedHeight: meta.decoderConfig.codedHeight,
            description: cloneArrayBuffer(meta.decoderConfig.description)
          }
        }
        if (chunk.type === 'key' && lastDecoderConfig) {
          msg.config = {
            codec: lastDecoderConfig.codec,
            codedWidth: lastDecoderConfig.codedWidth,
            codedHeight: lastDecoderConfig.codedHeight,
            description: lastDecoderConfig.description
              ? cloneArrayBuffer(lastDecoderConfig.description)
              : null
          }
        }
        socket.emit('video', msg)
        txBytes += buf.byteLength
        const now = performance.now()
        if (now - txTick > 1000) {
          me.txScreen = Math.round((txBytes * 1000) / (now - txTick))
          txBytes = 0
          txTick = now
        }
      },
      error: (e) => {
        console.warn('encoder error', e)
        errorMsg.value = '编码器错误 · ' + (e?.message || e)
        setTimeout(() => (errorMsg.value = ''), 5000)
      }
    })
    try {
      newEncoder.configure({
        codec: chosen.string,
        width: w, height: h,
        bitrate: vBitrateBps,
        framerate: fps,
        bitrateMode: 'variable',
        ...chosen.opts
      })
    } catch (e) {
      console.warn('new encoder configure failed', e)
      try { newEncoder.close() } catch {}
      return
    }
    newEncoder._codec = chosen.string
    newEncoder._w = w
    newEncoder._h = h
    newEncoder._opts = chosen.opts

    // Atomic swap.
    vEncoder = newEncoder
    vForceKey = true
    codecInfo.value = `${chosen.label} · ${(vBitrateBps / 1_000_000).toFixed(1)} Mbps · ${w}×${h}@${fps}fps`
    try { oldEncoder.close() } catch {}
  }

  // ---------- screen receive: decode WebCodecs chunks into a per-peer canvas ----------
  const videoDecoders = new Map()   // peerId -> VideoDecoder
  const pendingChunks = new Map()   // peerId -> [] chunks buffered while waiting for keyframe/config
  const screenCanvases = new Map()  // peerId -> HTMLCanvasElement

  // Which codec families this device can actually decode. Populated lazily on
  // first video-chunk. Used to (a) skip re-asking for a codec swap we already
  // know is going to fail, (b) show a helpful message.
  const decoderSupport = { vp9: null, h264: null, vp8: null, av1: null }
  const CODEC_FAMILY = (codec) => {
    if (codec.startsWith('vp09') || codec === 'vp9') return 'vp9'
    if (codec.startsWith('avc1') || codec.startsWith('avc3') || codec === 'h264') return 'h264'
    if (codec === 'vp8' || codec.startsWith('vp08')) return 'vp8'
    if (codec.startsWith('av01') || codec === 'av1') return 'av1'
    return codec
  }

  async function probeDecoder(cfg) {
    try {
      const s = await VideoDecoder.isConfigSupported({
        codec: cfg.codec,
        codedWidth: cfg.codedWidth,
        codedHeight: cfg.codedHeight,
        description: cfg.description ? new Uint8Array(cfg.description) : undefined,
        hardwareAcceleration: 'prefer-hardware'
      })
      return !!s.supported
    } catch {
      return false
    }
  }

  function makeDecoder(peerId, cfg) {
    const dec = new VideoDecoder({
      output: (frame) => {
        const canvas = screenCanvases.get(peerId)
        if (!canvas) { frame.close(); return }
        const w = frame.displayWidth
        const h = frame.displayHeight
        if (canvas.width !== w) canvas.width = w
        if (canvas.height !== h) canvas.height = h
        const cx = canvas.getContext('2d')
        cx.drawImage(frame, 0, 0)
        frame.close()
        // If we successfully rendered, clear any "waiting for switch" state.
        if (awaitingCodecSwitch.value) awaitingCodecSwitch.value = false
        if (decoderUnsupported.value) decoderUnsupported.value = false
      },
      error: (e) => {
        console.warn('decoder error', peerId.slice(0, 4), e)
        try { dec.close() } catch {}
        videoDecoders.delete(peerId)
      }
    })
    dec.configure({
      codec: cfg.codec,
      codedWidth: cfg.codedWidth,
      codedHeight: cfg.codedHeight,
      description: cfg.description ? new Uint8Array(cfg.description) : undefined,
      optimizeForLatency: true,
      hardwareAcceleration: 'prefer-hardware'
    })
    videoDecoders.set(peerId, dec)
    return dec
  }

  // Cascade the sharer through H.264 → VP8 → AV1 → VP9 when the current codec
  // isn't decodable. H.264 first because it's the most universally supported on
  // mobile hardware.
  const CODEC_FALLBACK_ORDER = ['h264', 'vp8', 'av1', 'vp9']
  function pickNextCodecTo(currentFamily) {
    for (const f of CODEC_FALLBACK_ORDER) {
      if (f !== currentFamily && decoderSupport[f] !== false) return f
    }
    return null
  }

  function requestCodecSwitch(currentCodec) {
    if (!socket?.connected) return
    const family = CODEC_FAMILY(currentCodec)
    decoderSupport[family] = false
    const wanted = pickNextCodecTo(family)
    if (!wanted) {
      // We've marked everything as unsupported — surrender.
      decoderUnsupported.value = true
      awaitingCodecSwitch.value = false
      return
    }
    console.log('[webcodecs] requesting codec switch: current', family, 'wanted', wanted)
    awaitingCodecSwitch.value = true
    socket.emit('need-codec', { avoid: family, wanted })
  }

  async function handleVideoChunk(from, msg) {
    if (!HAS_DECODER) {
      if (!decoderUnsupported.value) decoderUnsupported.value = true
      return
    }
    let dec = videoDecoders.get(from)
    // Config → (re)build decoder
    if (msg.config) {
      if (dec) { try { dec.close() } catch {}; videoDecoders.delete(from); dec = null }
      const family = CODEC_FAMILY(msg.config.codec)
      // Probe once per codec family — if unsupported, ask sharer to switch.
      if (decoderSupport[family] === null) {
        decoderSupport[family] = await probeDecoder(msg.config)
      }
      if (!decoderSupport[family]) {
        requestCodecSwitch(msg.config.codec)
        return
      }
      try {
        dec = makeDecoder(from, msg.config)
      } catch (e) {
        console.warn('decoder configure failed', msg.config.codec, e)
        decoderSupport[family] = false
        requestCodecSwitch(msg.config.codec)
        return
      }
    }
    if (!dec) {
      // No decoder yet (no config seen). Delta frames are useless — drop them.
      // Keep only the latest keyframe just in case config arrives in a later message.
      if (msg.type === 'key') {
        const list = pendingChunks.get(from) || []
        list.length = 0
        list.push(msg)
        pendingChunks.set(from, list)
      }
      return
    }
    try {
      const chunk = new EncodedVideoChunk({
        type: msg.type,
        timestamp: msg.ts,
        data: new Uint8Array(msg.data)
      })
      dec.decode(chunk)
    } catch (e) { console.warn('decode err', e) }
  }

  function attachScreenCanvas(peerId, el) {
    if (!el) { screenCanvases.delete(peerId); return }
    screenCanvases.set(peerId, el)
  }

  // ---------- signaling / room events ----------
  function connect() {
    socket = io({
      path: '/socket.io/',
      transports: ['websocket', 'polling']
    })

    socket.on('connect', () => {
      me.id = socket.id
      connection.value = 'connected'
      hasConnectedOnce.value = true
      reconnectAttempt.value = 0
      socket.emit('join', { room: roomId, name: me.name })
      broadcastState()
    })
    socket.on('disconnect', (reason) => {
      // socket.io auto-reconnects unless the disconnect was intentional.
      connection.value = reason === 'io client disconnect' ? 'offline' : 'reconnecting'
    })
    socket.on('connect_error', () => { connection.value = 'reconnecting' })
    socket.io.on('reconnect_attempt', (n) => {
      reconnectAttempt.value = n
      connection.value = 'reconnecting'
    })
    socket.io.on('reconnect_failed', () => { connection.value = 'offline' })

    socket.on('peers', ({ list }) => {
      let sawSharer = false
      for (const p of list) {
        if (p.id === me.id) continue
        peers.set(p.id, {
          id: p.id,
          name: p.name,
          level: 0,
          micOn: !!p.micOn,
          screenOn: !!p.screenOn,
          lastFrameTs: 0
        })
        if (p.screenOn) sawSharer = true
        if (p.screenOn && !activeScreenPeerId.value) activeScreenPeerId.value = p.id
      }
      // I'm joining a room that already has an active screen share — ask for
      // a fresh keyframe (with config) so I don't have to wait up to 4 s.
      if (sawSharer && HAS_DECODER) socket.emit('need-keyframe')
    })

    socket.on('peer-joined', ({ id, name, micOn, screenOn }) => {
      if (id === me.id) return
      peers.set(id, {
        id, name, level: 0,
        micOn: !!micOn, screenOn: !!screenOn,
        lastFrameTs: 0
      })
      // If I'm currently sharing, force a keyframe so this new peer can start decoding
      // rather than waiting up to 4 seconds for the next natural keyframe.
      if (me.screenOn && vEncoder) vForceKey = true
    })

    socket.on('peer-left', ({ id }) => cleanupPeer(id))

    socket.on('peer-state', ({ id, micOn, screenOn }) => {
      const p = peers.get(id)
      if (!p) return
      p.micOn = micOn
      const wasSharing = p.screenOn
      p.screenOn = screenOn
      if (!screenOn && activeScreenPeerId.value === id) activeScreenPeerId.value = null
      if (screenOn && !activeScreenPeerId.value) activeScreenPeerId.value = id
      // A peer just started sharing — poke them so we get a keyframe right
      // away (with cached decoder config), instead of waiting for the natural
      // ~4 s cadence.
      if (!wasSharing && screenOn && HAS_DECODER) socket.emit('need-keyframe')
      // sharer stopped → tear down the decoder so the next start gets a fresh one
      if (wasSharing && !screenOn) {
        const dec = videoDecoders.get(id)
        if (dec) { try { dec.close() } catch {}; videoDecoders.delete(id) }
        pendingChunks.delete(id)
        const canvas = screenCanvases.get(id)
        if (canvas) canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height)
      }
    })

    socket.on('voice', (from, buf) => {
      if (from === me.id) return
      // socket.io may deliver ArrayBuffer or Uint8Array — normalise
      const arrayBuf = buf instanceof ArrayBuffer ? buf : buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
      playPcm(from, arrayBuf)
    })

    socket.on('video', (from, msg) => {
      if (from === me.id) return
      const p = peers.get(from)
      if (p) { p.screenOn = true; p.lastFrameTs = performance.now() }
      if (!activeScreenPeerId.value) activeScreenPeerId.value = from
      handleVideoChunk(from, msg)
    })
    socket.on('need-keyframe', () => { if (me.screenOn) vForceKey = true })
    socket.on('need-codec', ({ wanted }) => {
      if (!me.screenOn) return
      const target = typeof wanted === 'string' ? wanted : 'h264'
      swapCodec(target).catch((e) => console.warn('swapCodec failed', e))
    })

    socket.on('chat', ({ from, name, text, image, ts }) => {
      messages.push({
        id: `${from}-${ts}-${Math.random()}`,
        from, name, text, image, ts,
        mine: from === me.id
      })
    })
  }

  function broadcastState() {
    if (!socket?.connected) return
    socket.emit('state', { micOn: me.micOn, screenOn: me.screenOn })
  }

  function cleanupPeer(id) {
    peers.delete(id)
    nextPlayAt.delete(id)
    const g = remoteGains.get(id)
    if (g) { try { g.disconnect() } catch {}; remoteGains.delete(id) }
    const dec = videoDecoders.get(id)
    if (dec) { try { dec.close() } catch {}; videoDecoders.delete(id) }
    pendingChunks.delete(id)
    screenCanvases.delete(id)
    if (activeScreenPeerId.value === id) activeScreenPeerId.value = null
  }

  // ---------- chat ----------
  function sendChat(text, image) {
    const t = (text || '').trim()
    if (!t && !image) return
    const ts = Date.now()
    const payload = { text: t, ts }
    if (image) payload.image = image
    if (socket?.connected) socket.emit('chat', payload)
    else messages.push({
      id: `local-${ts}`,
      from: me.id || 'me',
      name: me.name,
      text: t, image, ts,
      mine: true
    })
  }

  function focusScreen(peerId) { activeScreenPeerId.value = peerId }

  function unlockAudio() {
    if (audioCtx && audioCtx.state === 'suspended') {
      audioCtx.resume().catch(() => {})
    }
    needsAudioUnlock.value = false
  }

  function leave() {
    stopMic()
    stopScreen()
    for (const id of Array.from(peers.keys())) cleanupPeer(id)
    if (audioCtx) { try { audioCtx.close() } catch {} audioCtx = null }
    if (socket) { try { socket.disconnect() } catch {} }
  }

  onUnmounted(() => leave())
  connect()

  const anyScreen = computed(() => {
    if (me.screenOn) return true
    for (const p of peers.values()) if (p.screenOn) return true
    return false
  })

  return {
    me,
    peers,
    messages,
    connection,
    activeScreenPeerId,
    anyScreen,
    errorMsg,
    needsAudioUnlock,
    decoderUnsupported,
    awaitingCodecSwitch,
    hasConnectedOnce,
    reconnectAttempt,
    screenOptions,
    codecInfo,
    hasEncoder: HAS_ENCODER,
    hasDecoder: HAS_DECODER,
    toggleMic,
    toggleScreen,
    toggleDenoise,
    unlockAudio,
    sendChat,
    attachScreenCanvas,
    getSelfScreenStream: () => screenStream,
    applyBitrate,
    retimeScreen,
    focusScreen,
    leave
  }
}
