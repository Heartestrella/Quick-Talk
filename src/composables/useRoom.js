// Quick Talk — server-relayed transport
// Voice: PCM Int16 @ 16 kHz mono, 20 ms frames.
// Screen: WebCodecs VP9/VP8/H.264 encoded chunks (delta-frame compressed).
// Nothing is P2P — every packet passes through the Node.js relay server.

import { reactive, ref, shallowRef, onUnmounted, computed } from 'vue'
import { io } from 'socket.io-client'
import { openWebTransport, WT_KIND } from './useTransport.js'

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
    txAudio: 0,          // bytes/s outbound — mic PCM
    txScreen: 0,         // bytes/s outbound — encoded screen video
    txScreenAudio: 0     // bytes/s outbound — encoded shared tab / system audio (opus)
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

  // WebTransport (QUIC) state. When healthy, screen chunks route through WT
  // instead of socket.io. Falls back to socket.io automatically when unhealthy
  // (session close, missed heartbeats). See useTransport.js for the details.
  const wt = shallowRef(null)                // holds the openWebTransport() return obj (or null)
  const HAS_WEBTRANSPORT = typeof window !== 'undefined' && typeof window.WebTransport !== 'undefined'
  const senderTransport = computed(() =>
    (wt.value && wt.value.healthy.value) ? 'wt' : 'socket'
  )
  let wtInfo = null                          // { url, token } cached for reconnect

  const screenOptions = reactive({
    resolution: '1080p',    // '720p' | '1080p' | '1440p' | '4k' | 'source'
    frameRate: 30,          // fps
    bitrate: 3.0,           // Mbps target (0.5 – 12)
    codec: 'auto',          // 'auto' picks the best available (VP9 > H264 > VP8)
    shareAudio: false       // ask the browser to include tab / system audio
  })

  // Whether this browser can encode audio (needed to send shared tab audio).
  // Playback (AudioDecoder) support is a separate feature check on the viewer.
  const HAS_AUDIO_ENCODER =
    typeof window !== 'undefined' &&
    typeof window.AudioEncoder !== 'undefined' &&
    typeof window.MediaStreamTrackProcessor !== 'undefined'
  const HAS_AUDIO_DECODER =
    typeof window !== 'undefined' &&
    typeof window.AudioDecoder !== 'undefined' &&
    typeof window.EncodedAudioChunk !== 'undefined'

  const codecInfo = ref('')  // reactive info string shown in UI, e.g. "VP9 · 2.8 Mbps"

  let socket = null

  // ---------- audio: shared context, denoise chain, capture worklet ----------
  let audioCtx = null                 // 16 kHz AudioContext for BOTH capture and playback
  let localStream = null              // raw mic MediaStream
  let denoise = null                  // { source, hp, comp, gate, analyser, sink, raf, rewire }
  let captureNode = null              // AudioWorkletNode running pcm-worklet.js
  const nextPlayAt = new Map()        // peerId -> AudioContext currentTime for next chunk
  const remoteGains = new Map()       // peerId -> GainNode (per-peer volume + analyser hook)
  // audioWorklet.addModule() must run once per AudioContext before we can
  // construct AudioWorkletNode. Two paths create the context: enabling the
  // mic (ensureAudioCtx) and receiving remote voice (playPcm). If a peer
  // talked first, playPcm creates the ctx with no worklet loaded, and the
  // next time we try to open the mic, `new AudioWorkletNode(...)` throws.
  // Cache the addModule promise so any path can await it, and it only runs
  // once per successful load.
  let workletReady = null

  function ensureAudioCtxSync() {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: SAMPLE_RATE })
    }
    return audioCtx
  }

  async function ensureAudioCtx() {
    ensureAudioCtxSync()
    if (audioCtx.state === 'suspended') { try { await audioCtx.resume() } catch {} }
    return audioCtx
  }

  async function ensureWorklet() {
    await ensureAudioCtx()
    if (!workletReady) {
      workletReady = audioCtx.audioWorklet.addModule('/pcm-worklet.js').catch((e) => {
        console.warn('audio worklet load failed', e)
        // Reset so a later toggleMic attempt can retry — otherwise a transient
        // network hiccup on the very first mic open bricks the mic forever.
        workletReady = null
        throw e
      })
    }
    return workletReady
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
    if (!IS_SECURE) {
      errorMsg.value = '当前站点不是 HTTPS · 浏览器已禁用麦克风 API · 请通过 https://… 访问'
      setTimeout(() => (errorMsg.value = ''), 6000)
      return
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      errorMsg.value = '此浏览器不支持 getUserMedia'
      setTimeout(() => (errorMsg.value = ''), 4000)
      return
    }
    try {
      // Must load the pcm-worklet before constructing the AudioWorkletNode
      // below. If a remote voice already spun up the audioCtx via playPcm,
      // the worklet was never loaded — ensureWorklet plugs that gap.
      await ensureWorklet()
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
    // Playback doesn't need the worklet, so we use the sync ctor here — but
    // note that if the user later opens their mic, ensureWorklet() will
    // lazily load the pcm-worklet script into the same context.
    if (!audioCtx) ensureAudioCtxSync()
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
  // WebCodecs + getDisplayMedia + getUserMedia are all gated behind Secure
  // Context (HTTPS, or localhost). Over plain http://<lan-ip> or http://<domain>
  // every relevant API becomes `undefined` and the user sees a "browser not
  // supported" error that isn't actually about the browser. Track this
  // separately so we can surface a specific message.
  const IS_SECURE = typeof window !== 'undefined' && window.isSecureContext === true
  // Encoding requires the full pipeline (encoder + reader + decoder for probing);
  // viewing only needs VideoDecoder. Splitting these means phones that lack
  // MediaStreamTrackProcessor can still receive & display a screen share.
  const HAS_ENCODER =
    IS_SECURE &&
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
  let vEncoderTrack = null   // clone() of the display track — the encoder drains
                             // this one so backpressure never starves the local
                             // <video> preview that reads the original stream.
  // ---- screen audio (system / tab sound capture, when the user opts in) ----
  let aEncoder = null
  let aReader = null
  let aTrackProcessor = null
  let aTrack = null          // the audio track we pulled off screenStream
  let aSampleRate = 48000
  let aChannels = 2
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
      // Distinguish "server serves HTTP so the API is disabled" from
      // "browser genuinely doesn't have WebCodecs". The former is by far the
      // most common cause once the app leaves localhost.
      errorMsg.value = !IS_SECURE
        ? '当前站点不是 HTTPS · 浏览器已禁用屏幕共享 API · 请通过 https://… 访问'
        : '当前浏览器不支持屏幕共享 · 请用桌面版 Chrome / Edge / Safari 16.4+'
      setTimeout(() => (errorMsg.value = ''), 6000)
      return
    }
    try {
      const res = RES_MAP[screenOptions.resolution]
      const constraints = { frameRate: { ideal: screenOptions.frameRate, max: 60 }, cursor: 'always' }
      if (res) {
        constraints.width = { ideal: res.width, max: res.width }
        constraints.height = { ideal: res.height, max: res.height }
      }
      // Only ask for audio if the user turned the option on AND this browser
      // has AudioEncoder (Chromium 94+). If we asked without the ability to
      // encode, the browser's picker would show a "共享音频" checkbox we
      // couldn't actually use.
      const wantAudio = screenOptions.shareAudio && HAS_AUDIO_ENCODER
      screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: constraints,
        audio: wantAudio
          ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
          : false
      })
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
          sendVideo(msg)
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
        // constant bitrate — the encoder smears bits across frames instead of
        // spiking a fat keyframe every N frames, which is what was showing up
        // as periodic stutter for the user (and local self-view).
        bitrateMode: 'constant',
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

      // Clone the display track for the encoder — the original still powers
      // the local <video> preview. Without this, encoder backpressure and the
      // GPU cost of emitting each keyframe periodically starves the preview,
      // which is what showed up as "隔几秒卡顿一下".
      vEncoderTrack = track.clone()
      vTrackProcessor = new MediaStreamTrackProcessor({ track: vEncoderTrack })
      vReader = vTrackProcessor.readable.getReader()
      pumpFrames().catch((e) => console.warn('pump ended', e))

      // If the user asked for audio AND the browser handed us a track, spin up
      // the audio encoder. Users can decline the checkbox in the picker, in
      // which case getAudioTracks() is empty — silently fall through.
      if (wantAudio) {
        const at = screenStream.getAudioTracks()[0]
        if (at) startScreenAudio(at)
        else if (screenOptions.shareAudio) {
          errorMsg.value = '你没有勾选浏览器面板里的"共享音频" · 屏幕已在共享，但没有声音'
          setTimeout(() => (errorMsg.value = ''), 5000)
        }
      } else if (screenOptions.shareAudio && !HAS_AUDIO_ENCODER) {
        errorMsg.value = '当前浏览器不支持共享音频编码 · 屏幕已在共享'
        setTimeout(() => (errorMsg.value = ''), 5000)
      }
    } catch (err) {
      console.warn(err)
      errorMsg.value = '屏幕共享失败 · ' + (err?.message || '权限被拒绝')
      setTimeout(() => (errorMsg.value = ''), 4000)
      if (screenStream) { screenStream.getTracks().forEach((t) => t.stop()); screenStream = null }
    }
  }

  async function pumpFrames() {
    // Natural keyframe cadence is intentionally slack — every ~20 s at 30 fps.
    // Late joiners and codec-swap requests already trigger explicit keyframes
    // via `need-keyframe`, so we don't need a tight 4-second beat. The old
    // 120-frame cadence was showing up as a visible stutter every few seconds.
    const KEY_EVERY = 600
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

  // ---------- screen audio: Opus encode captured tab/system sound ----------
  async function startScreenAudio(track) {
    aTrack = track
    const settings = track.getSettings?.() || {}
    aSampleRate = settings.sampleRate || 48000
    aChannels = Math.min(2, settings.channelCount || 2)
    const opusBitrate = 128_000
    try {
      const cfg = {
        codec: 'opus',
        sampleRate: aSampleRate,
        numberOfChannels: aChannels,
        bitrate: opusBitrate
      }
      const probe = await AudioEncoder.isConfigSupported(cfg)
      if (!probe?.supported) {
        console.warn('opus config not supported', cfg)
        stopScreenAudio()
        return
      }
      let aTxBytes = 0
      let aTxTick = performance.now()
      aEncoder = new AudioEncoder({
        output: (chunk, meta) => {
          if (!socket?.connected) return
          const buf = new ArrayBuffer(chunk.byteLength)
          chunk.copyTo(buf)
          const msg = {
            type: chunk.type,
            ts: chunk.timestamp,
            data: buf,
            sampleRate: aSampleRate,
            channels: aChannels
          }
          if (meta?.decoderConfig?.description) {
            msg.description = cloneArrayBuffer(meta.decoderConfig.description)
          }
          sendScreenAudio(msg)
          aTxBytes += buf.byteLength
          const now = performance.now()
          if (now - aTxTick > 1000) {
            me.txScreenAudio = Math.round((aTxBytes * 1000) / (now - aTxTick))
            aTxBytes = 0
            aTxTick = now
          }
        },
        error: (e) => { console.warn('audio encoder', e); stopScreenAudio() }
      })
      aEncoder.configure(probe.config)
    } catch (e) {
      console.warn('audio encoder setup failed', e)
      stopScreenAudio()
      return
    }

    aTrackProcessor = new MediaStreamTrackProcessor({ track })
    aReader = aTrackProcessor.readable.getReader()
    pumpAudioFrames().catch((e) => console.warn('audio pump ended', e))
  }

  async function pumpAudioFrames() {
    while (aEncoder && aEncoder.state === 'configured' && aReader) {
      const { value: frame, done } = await aReader.read()
      if (done) break
      if (!aEncoder || aEncoder.state !== 'configured') { frame.close(); break }
      try { aEncoder.encode(frame) } catch (e) { console.warn('audio encode', e) }
      frame.close()
    }
  }

  function stopScreenAudio() {
    if (aEncoder) { try { aEncoder.close() } catch {}; aEncoder = null }
    if (aReader) { try { aReader.cancel() } catch {}; aReader = null }
    aTrackProcessor = null
    if (aTrack) { try { aTrack.stop() } catch {}; aTrack = null }
    me.txScreenAudio = 0
    // Tell viewers to tear down their screen-audio decoders for us.
    if (socket?.connected) socket.emit('screen-audio', { type: 'end' })
  }

  function stopScreen() {
    stopScreenAudio()
    if (vEncoder) {
      try { vEncoder.close() } catch {}
      vEncoder = null
    }
    if (vReader) { try { vReader.cancel() } catch {}; vReader = null }
    vTrackProcessor = null
    if (vEncoderTrack) { try { vEncoderTrack.stop() } catch {}; vEncoderTrack = null }
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
        bitrateMode: 'constant',
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
        sendVideo(msg)
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
        bitrateMode: 'constant',
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

  // per-peer screen-audio decoders + a dedicated playback AudioContext (48 kHz
  // so we don't downsample). Voice keeps its own 16 kHz context above.
  const screenAudioDecoders = new Map()  // peerId -> AudioDecoder
  const screenAudioGains = new Map()     // peerId -> GainNode
  const screenAudioNext = new Map()      // peerId -> next scheduled play time
  let screenAudioCtx = null
  function ensureScreenAudioCtx() {
    if (!screenAudioCtx) {
      screenAudioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 })
    }
    if (screenAudioCtx.state === 'suspended') {
      screenAudioCtx.resume().catch(() => { needsAudioUnlock.value = true })
    }
    return screenAudioCtx
  }

  function handleScreenAudio(from, msg) {
    if (!HAS_AUDIO_DECODER) return
    if (msg?.data?.byteLength) tallyRx(from, msg.data.byteLength, false)
    if (!msg || msg.type === 'end') {
      const dec = screenAudioDecoders.get(from)
      if (dec) { try { dec.close() } catch {}; screenAudioDecoders.delete(from) }
      const g = screenAudioGains.get(from)
      if (g) { try { g.disconnect() } catch {}; screenAudioGains.delete(from) }
      screenAudioNext.delete(from)
      return
    }
    let dec = screenAudioDecoders.get(from)
    const ctx = ensureScreenAudioCtx()
    if (!dec) {
      let gain = screenAudioGains.get(from)
      if (!gain) {
        gain = ctx.createGain()
        gain.connect(ctx.destination)
        screenAudioGains.set(from, gain)
      }
      dec = new AudioDecoder({
        output: (data) => {
          try {
            const frames = data.numberOfFrames
            const chans = data.numberOfChannels
            const sr = data.sampleRate
            const buffer = ctx.createBuffer(chans, frames, sr)
            for (let c = 0; c < chans; c++) {
              const tmp = new Float32Array(frames)
              data.copyTo(tmp, { planeIndex: c })
              buffer.copyToChannel(tmp, c)
            }
            const src = ctx.createBufferSource()
            src.buffer = buffer
            src.connect(gain)
            const now = ctx.currentTime
            let t = screenAudioNext.get(from) || 0
            if (t < now + JITTER_SEC) t = now + JITTER_SEC
            src.start(t)
            screenAudioNext.set(from, t + buffer.duration)
          } catch (e) { console.warn('screen-audio render', e) }
          data.close()
        },
        error: (e) => {
          console.warn('screen-audio decoder', e)
          try { dec.close() } catch {}
          screenAudioDecoders.delete(from)
        }
      })
      try {
        dec.configure({
          codec: 'opus',
          sampleRate: msg.sampleRate || 48000,
          numberOfChannels: msg.channels || 2,
          description: msg.description ? new Uint8Array(msg.description) : undefined
        })
      } catch (e) {
        console.warn('screen-audio configure failed', e)
        return
      }
      screenAudioDecoders.set(from, dec)
    }
    if (!msg.data) return
    try {
      dec.decode(new EncodedAudioChunk({
        type: msg.type || 'key',
        timestamp: msg.ts || 0,
        data: new Uint8Array(msg.data)
      }))
    } catch (e) { console.warn('screen-audio decode', e) }
  }

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

  // Track per-peer receive rate for the screen video + audio streams. Rolling
  // 1-second window; called from both handleVideoChunk and handleScreenAudio.
  function tallyRx(from, bytes, isFrame) {
    const p = peers.get(from)
    if (!p) return
    p._rxScrBytes = (p._rxScrBytes || 0) + (isFrame ? bytes : 0)
    if (!isFrame) p._rxScrAudBytes = (p._rxScrAudBytes || 0) + bytes
    if (isFrame) p._rxScrFrames = (p._rxScrFrames || 0) + 1
    const now = performance.now()
    if (!p._rxScrTick) p._rxScrTick = now
    const dt = now - p._rxScrTick
    if (dt >= 1000) {
      p.rxScreen = Math.round((p._rxScrBytes * 1000) / dt)
      p.rxScreenAudio = Math.round((p._rxScrAudBytes * 1000) / dt)
      p.rxScreenFps = Math.round((p._rxScrFrames * 1000) / dt)
      p._rxScrBytes = 0
      p._rxScrAudBytes = 0
      p._rxScrFrames = 0
      p._rxScrTick = now
    }
  }

  async function handleVideoChunk(from, msg) {
    if (!HAS_DECODER) {
      if (!decoderUnsupported.value) decoderUnsupported.value = true
      return
    }
    if (msg?.data?.byteLength) tallyRx(from, msg.data.byteLength, true)
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
  // ---------- transport routing helpers ----------
  // If WT is healthy, encode + ship the chunk via QUIC uni-stream. Otherwise
  // fall back to the existing socket.io path.
  function bytesToB64(bytes) {
    if (!bytes) return ''
    const u8 = bytes instanceof Uint8Array
      ? bytes
      : new Uint8Array(bytes)
    let s = ''
    // Small binaries (VP9 descriptor is ~50B, Opus header ~20B); simple loop OK.
    for (let i = 0; i < u8.byteLength; i++) s += String.fromCharCode(u8[i])
    return btoa(s)
  }
  function sendVideo(msg) {
    if (wt.value?.healthy?.value) {
      const meta = { type: msg.type }
      if (msg.config) {
        meta.config = {
          codec: msg.config.codec,
          codedWidth: msg.config.codedWidth,
          codedHeight: msg.config.codedHeight,
          description: msg.config.description ? bytesToB64(msg.config.description) : ''
        }
      }
      wt.value.sendChunk(WT_KIND.VIDEO, msg.ts, meta, new Uint8Array(msg.data))
      return
    }
    if (socket?.connected) socket.emit('video', msg)
  }
  function sendScreenAudio(msg) {
    if (wt.value?.healthy?.value) {
      const meta = {
        type: msg.type,
        sampleRate: msg.sampleRate,
        channels: msg.channels
      }
      if (msg.description) meta.description = bytesToB64(msg.description)
      wt.value.sendChunk(WT_KIND.SCREEN_AUDIO, msg.ts, meta, new Uint8Array(msg.data))
      return
    }
    if (socket?.connected) socket.emit('screen-audio', msg)
  }

  // ---------- WT open + incoming chunk demux ----------
  async function tryOpenWebTransport(info) {
    if (!HAS_WEBTRANSPORT || !info?.url || !info?.token || !me.id) return
    // Close a stale session before starting a new one.
    if (wt.value) { try { wt.value.close() } catch {}; wt.value = null }
    const opened = await openWebTransport({
      url: info.url,
      socketId: me.id,
      token: info.token,
      room: roomId,
      onChunk: onWtChunk,
      onClose: () => { if (wt.value === opened) wt.value = null }
    })
    if (opened) {
      wt.value = opened
      console.log('[wt] session up')
    } else {
      console.log('[wt] open failed — staying on socket.io')
    }
  }

  function onWtChunk(from, kind, ts, meta, payload) {
    if (!from) return
    const p = peers.get(from)
    if (p) p.rxTransport = 'wt'
    if (kind === WT_KIND.VIDEO) {
      const msg = { type: meta.type || 'delta', ts, data: payload }
      if (meta.config) {
        msg.config = {
          codec: meta.config.codec,
          codedWidth: meta.config.codedWidth,
          codedHeight: meta.config.codedHeight,
          description: meta.config.description
            ? Uint8Array.from(atob(meta.config.description), (c) => c.charCodeAt(0)).buffer
            : null
        }
      }
      handleVideoChunk(from, msg)
    } else if (kind === WT_KIND.SCREEN_AUDIO) {
      const msg = {
        type: meta.type || 'key',
        ts,
        data: payload,
        sampleRate: meta.sampleRate || 48000,
        channels: meta.channels || 2
      }
      if (meta.description) {
        msg.description = Uint8Array.from(atob(meta.description), (c) => c.charCodeAt(0)).buffer
      }
      handleScreenAudio(from, msg)
    }
  }

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
          lastFrameTs: 0,
          rxScreen: 0,
          rxScreenAudio: 0,
          rxScreenFps: 0,
          _rxScrBytes: 0,
          _rxScrAudBytes: 0,
          _rxScrFrames: 0,
          _rxScrTick: 0
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
        lastFrameTs: 0,
        rxScreen: 0,
        rxScreenAudio: 0,
        rxScreenFps: 0,
        rxTransport: '',       // 'wt' | 'socket' | '' — latest observed path
        _rxScrBytes: 0,
        _rxScrAudBytes: 0,
        _rxScrFrames: 0,
        _rxScrTick: 0
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
      if (p) {
        p.screenOn = true
        p.lastFrameTs = performance.now()
        p.rxTransport = 'socket'
      }
      if (!activeScreenPeerId.value) activeScreenPeerId.value = from
      handleVideoChunk(from, msg)
    })
    socket.on('need-keyframe', () => { if (me.screenOn) vForceKey = true })
    socket.on('screen-audio', (from, msg) => {
      if (from === me.id) return
      const p = peers.get(from)
      if (p) p.rxTransport = 'socket'
      handleScreenAudio(from, msg)
    })

    // Server hands us a WT URL + short-lived token right after join, IF it has
    // a WT relay configured. Missing/absent → we just stay on socket.io.
    socket.on('webtransport', (info) => {
      wtInfo = info
      tryOpenWebTransport(info)
    })
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
    const adec = screenAudioDecoders.get(id)
    if (adec) { try { adec.close() } catch {}; screenAudioDecoders.delete(id) }
    const ag = screenAudioGains.get(id)
    if (ag) { try { ag.disconnect() } catch {}; screenAudioGains.delete(id) }
    screenAudioNext.delete(id)
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
    if (screenAudioCtx && screenAudioCtx.state === 'suspended') {
      screenAudioCtx.resume().catch(() => {})
    }
    needsAudioUnlock.value = false
  }

  function leave() {
    stopMic()
    stopScreen()
    if (wt.value) { try { wt.value.close() } catch {}; wt.value = null }
    for (const id of Array.from(peers.keys())) cleanupPeer(id)
    if (audioCtx) { try { audioCtx.close() } catch {} audioCtx = null }
    if (screenAudioCtx) { try { screenAudioCtx.close() } catch {} screenAudioCtx = null }
    // Reset per-context worklet load state so re-entering the room next time
    // doesn't inherit a promise tied to a closed AudioContext.
    workletReady = null
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
    isSecure: IS_SECURE,
    senderTransport,          // 'wt' | 'socket' — reactive
    hasWebTransport: HAS_WEBTRANSPORT,
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
