// Quick Talk — server-relayed transport
// Voice: PCM Int16 @ 16 kHz mono, 20 ms frames.
// Screen: WebCodecs VP9/VP8/H.264 encoded chunks (delta-frame compressed).
// Nothing is P2P — every packet passes through the Node.js relay server.

import { reactive, ref, shallowRef, onUnmounted, computed, watch } from 'vue'
import { io } from 'socket.io-client'
import { openWebTransport, WT_KIND } from './useTransport.js'

const NAMES = ['NORTH', 'SOUTH', 'EAST', 'WEST', 'ECHO', 'DELTA', 'FOXTROT', 'GOLF', 'HOTEL', 'INDIA', 'JULIET', 'KILO', 'LIMA', 'MIKE']
function randomHandle() {
  const w = NAMES[Math.floor(Math.random() * NAMES.length)]
  const n = Math.floor(Math.random() * 90 + 10)
  return `${w}-${n}`
}

const SAMPLE_RATE = 16000        // Hz — WIRE format (Int16 mono @ 16 kHz)
const FRAME_SAMPLES = 320        // 20 ms on the wire
const JITTER_SEC = 0.06          // playback lead time to smooth over network jitter

// RNNoise runs at 48 kHz and expects exactly 480-sample float32 frames (10 ms).
// The 48 kHz worklet emits those; main thread runs rnnoise, accumulates 2 frames
// (960 samples ≈ 20 ms), then decimates 3:1 to produce one 320-sample Int16
// frame that matches the existing wire format.
const RNN_SAMPLE_RATE = 48000
const RNN_FRAME_SAMPLES = 480

// Lazy singleton — one wasm module + rnnoise instance for the whole tab.
// Every mic session grabs its own DenoiseState off the shared module (cheap).
// If the wasm 404s or the module errors, `rnnoiseLoad` resolves to null and
// we transparently fall back to the legacy 16 kHz denoise chain.
let rnnoiseModulePromise = null
function loadRnnoise() {
  if (!rnnoiseModulePromise) {
    rnnoiseModulePromise = import('@shiguredo/rnnoise-wasm')
      .then((m) => m.Rnnoise.load())
      .catch((e) => {
        console.warn('[rnnoise] load failed — falling back to legacy denoise chain', e)
        return null
      })
  }
  return rnnoiseModulePromise
}

// localStorage keys — shared between Landing (writes name), Room (reads name +
// reads/writes per-room passwords), and here.
const NAME_KEY = 'qt.name'
const PWDS_KEY = 'qt.passwords'
function loadName() {
  try { return localStorage.getItem(NAME_KEY) || '' } catch { return '' }
}
function loadPasswords() {
  try { return JSON.parse(localStorage.getItem(PWDS_KEY) || '{}') } catch { return {} }
}
function savePassword(roomId, pwd) {
  try {
    const all = loadPasswords()
    if (pwd) all[roomId] = pwd
    else delete all[roomId]
    localStorage.setItem(PWDS_KEY, JSON.stringify(all))
  } catch {}
}

export function useRoom(roomId, opts = {}) {
  // opts.setPassword: from Landing — this join is a room-creator setting a
  // password. Passed to the server on the first join; the server registers it
  // if the room doesn't already have one, then we also cache it locally so we
  // can auto-rejoin.
  const initialSetPassword = typeof opts.setPassword === 'string' ? opts.setPassword : null

  const persistedName = loadName()

  const me = reactive({
    id: null,
    name: persistedName || randomHandle(),
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

  // Password auth: when the server tells us the room needs a password we've
  // never supplied (or supplied wrong), Room.vue watches authState to know
  // whether to show the password prompt.
  //   state:  'idle' | 'prompting' | 'checking' | 'joined'
  //   reason: 'needed' | 'wrong' | null
  const authState = reactive({ state: 'idle', reason: null })
  // Which password we last tried — if the server accepts us, this is what we
  // persist into localStorage for auto-rejoin next time.
  let pendingPassword = (() => {
    // Prefer freshly-typed (setPassword from Landing) over cached — the two
    // shouldn't conflict, but "creator intent" wins.
    if (initialSetPassword) return initialSetPassword
    const cached = loadPasswords()[roomId]
    return typeof cached === 'string' ? cached : null
  })()

  // WebTransport (QUIC) state. When healthy, screen chunks route through WT
  // instead of socket.io. Falls back to socket.io automatically when unhealthy
  // (session close, missed heartbeats). See useTransport.js for the details.
  const wt = shallowRef(null)                // holds the openWebTransport() return obj (or null)
  const HAS_WEBTRANSPORT = typeof window !== 'undefined' && typeof window.WebTransport !== 'undefined'
  // User preference — 'auto' (default: use WT when healthy) or 'tcp' (never
  // use WT). Persisted so a user who has decided QUIC is worse on their
  // network doesn't have to flip it every session.
  //   'tcp' (default) — screen chunks always over socket.io. Reliable, ordered.
  //   'wt'            — screen chunks over WebTransport / QUIC. Lower latency,
  //                     but any UDP loss shows up as picture tearing / stale
  //                     tiles until the next keyframe.
  //
  // Kept dead simple after multiple rounds of debugging: no auto fallback, no
  // watchdogs. The user chooses; a persistent warning banner reminds them
  // (and every viewer in the room) of the tradeoff while UDP is active.
  const TRANSPORT_KEY = 'qt.transport'
  const preferTransport = ref((() => {
    try {
      const v = localStorage.getItem(TRANSPORT_KEY)
      return v === 'wt' ? 'wt' : 'tcp'
    } catch { return 'tcp' }
  })())
  watch(preferTransport, (v) => {
    try { localStorage.setItem(TRANSPORT_KEY, v === 'wt' ? 'wt' : 'tcp') } catch {}
    // Force a keyframe so viewers see the transport swap immediately.
    if (me.screenOn) vForceKey = true
    // Broadcast the switch so every viewer knows we're on UDP and gets the
    // "画面可能撕裂" warning banner. Also fires on toggle back to TCP so the
    // banner clears.
    broadcastTransportMode()
  })
  const senderTransport = computed(() => {
    if (preferTransport.value === 'tcp') return 'tcp'
    return (wt.value && wt.value.healthy.value) ? 'wt' : 'wt-degraded'
  })
  function useWtNow() {
    if (preferTransport.value !== 'wt') return false
    return !!(wt.value && wt.value.healthy.value)
  }
  // What the currently-focused sharer is using, as seen by viewers. Keyed by
  // peerId. Populated via socket `sharer-transport` events from each sharer.
  const peerTransportMode = reactive(new Map())   // peerId -> 'wt' | 'tcp'
  function broadcastTransportMode() {
    if (!socket?.connected || !me.screenOn) return
    socket.emit('sharer-transport', { mode: preferTransport.value })
  }
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
  //   audioCtx      : 16 kHz — remote voice PLAYBACK, and legacy fallback capture
  //   micCtx        : 48 kHz — mic capture when RNNoise is active. Kept separate
  //                   because AudioContext's sampleRate is immutable once created
  //                   and downsampling remote 16 kHz playback into a 48 kHz ctx
  //                   would be wasteful.
  let audioCtx = null                 // 16 kHz playback + fallback capture
  let micCtx = null                   // 48 kHz RNNoise capture (when available)
  let localStream = null              // raw mic MediaStream
  let denoise = null                  // { source, hp, comp, gate, analyser, sink, raf, rewire }
  let captureNode = null              // AudioWorkletNode running pcm-worklet.js
  let rnn = null                      // { state, remainder, resampleAcc } — active RNNoise session, null if fallback
  const rnnoiseReady = ref(false)     // becomes true once wasm is loaded and a state is created
  const nextPlayAt = new Map()        // peerId -> AudioContext currentTime for next chunk
  const remoteGains = new Map()       // peerId -> GainNode (per-peer volume + analyser hook)

  // ---------- mixer: master + per-peer volume / mute ----------
  // Voice and screen-audio each get a master GainNode that all per-peer gains
  // feed into. So the graph is:
  //     per-peer source → per-peer GainNode → masterGain → destination
  // Voice runs at 16 kHz on audioCtx, screen audio runs at 48 kHz on
  // screenAudioCtx; each has its OWN master node.
  const VOLUME_MAX = 1.5              // allow a slight boost above 100 %
  const AUDIO_STORAGE_KEY = 'qt.audio.v2'
  const clampVol = (n) => Math.max(0, Math.min(VOLUME_MAX, Number(n) || 0))

  const persistedMaster = (() => {
    try {
      const raw = localStorage.getItem(AUDIO_STORAGE_KEY)
      if (!raw) return { voice: 1, screen: 1 }
      const j = JSON.parse(raw)
      return { voice: clampVol(j.voice ?? 1), screen: clampVol(j.screen ?? 1) }
    } catch { return { voice: 1, screen: 1 } }
  })()

  const masterVoiceVolume = ref(persistedMaster.voice)
  const masterScreenVolume = ref(persistedMaster.screen)
  // peerId -> { voice, screen, muted } — in-memory only (socket.id changes on
  // reconnect so persisting per-peer would leak/misapply).
  const peerAudio = reactive(new Map())

  let voiceMasterGain = null
  let screenMasterGain = null
  function ensureVoiceMaster() {
    if (voiceMasterGain || !audioCtx) return voiceMasterGain
    voiceMasterGain = audioCtx.createGain()
    voiceMasterGain.gain.value = masterVoiceVolume.value
    voiceMasterGain.connect(audioCtx.destination)
    return voiceMasterGain
  }
  function ensureScreenMaster() {
    if (screenMasterGain || !screenAudioCtx) return screenMasterGain
    screenMasterGain = screenAudioCtx.createGain()
    screenMasterGain.gain.value = masterScreenVolume.value
    screenMasterGain.connect(screenAudioCtx.destination)
    return screenMasterGain
  }
  function getPeerAudio(id) {
    let s = peerAudio.get(id)
    if (!s) { s = { voice: 1, screen: 1, muted: false }; peerAudio.set(id, s) }
    return s
  }
  function applyPeerVoiceGain(id) {
    const g = remoteGains.get(id); if (!g) return
    const s = getPeerAudio(id)
    g.gain.value = s.muted ? 0 : s.voice
  }
  function applyPeerScreenGain(id) {
    const g = screenAudioGains.get(id); if (!g) return
    const s = getPeerAudio(id)
    g.gain.value = s.muted ? 0 : s.screen
  }
  function setMasterVoiceVolume(v) { masterVoiceVolume.value = clampVol(v) }
  function setMasterScreenVolume(v) { masterScreenVolume.value = clampVol(v) }
  function setPeerVoiceVolume(id, v) {
    getPeerAudio(id).voice = clampVol(v)
    applyPeerVoiceGain(id)
  }
  function setPeerScreenVolume(id, v) {
    getPeerAudio(id).screen = clampVol(v)
    applyPeerScreenGain(id)
  }
  function setPeerMuted(id, muted) {
    getPeerAudio(id).muted = !!muted
    applyPeerVoiceGain(id)
    applyPeerScreenGain(id)
  }
  function persistMaster() {
    try {
      localStorage.setItem(AUDIO_STORAGE_KEY, JSON.stringify({
        voice: masterVoiceVolume.value,
        screen: masterScreenVolume.value
      }))
    } catch {}
  }
  // Push master value into the live gain node + persist on any change.
  watch(masterVoiceVolume, (v) => {
    if (voiceMasterGain) voiceMasterGain.gain.value = v
    persistMaster()
  })
  watch(masterScreenVolume, (v) => {
    if (screenMasterGain) screenMasterGain.gain.value = v
    persistMaster()
  })

  // audioWorklet.addModule() must run once per AudioContext before we can
  // construct AudioWorkletNode. Two paths create the context: enabling the
  // mic (ensureAudioCtx) and receiving remote voice (playPcm). If a peer
  // talked first, playPcm creates the ctx with no worklet loaded, and the
  // next time we try to open the mic, `new AudioWorkletNode(...)` throws.
  // Cache the addModule promise per-context so any path can await it.
  const workletReadyByCtx = new WeakMap()

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

  function ensureMicCtxSync() {
    if (!micCtx) {
      micCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: RNN_SAMPLE_RATE })
    }
    return micCtx
  }
  async function ensureMicCtx() {
    ensureMicCtxSync()
    if (micCtx.state === 'suspended') { try { await micCtx.resume() } catch {} }
    return micCtx
  }

  async function ensureWorkletOn(ctx) {
    let p = workletReadyByCtx.get(ctx)
    if (!p) {
      p = ctx.audioWorklet.addModule('/pcm-worklet.js').catch((e) => {
        console.warn('audio worklet load failed', e)
        // Retryable — evict so a later toggleMic can try again.
        workletReadyByCtx.delete(ctx)
        throw e
      })
      workletReadyByCtx.set(ctx, p)
    }
    return p
  }

  // Legacy alias — still used by playPcm (which needs a worklet on audioCtx
  // for the mic path even though playback itself doesn't).
  async function ensureWorklet() {
    await ensureAudioCtx()
    return ensureWorkletOn(audioCtx)
  }

  // Build the classic denoise chain (highpass → compressor → analyser → gate).
  // Used when RNNoise isn't available. Wires against whichever context the
  // caller provides (16 kHz fallback path uses `audioCtx`).
  //
  // When RNNoise IS active, we still build a lightweight version of this on
  // the mic context: only the analyser + gate portion is needed for the level
  // meter and the "on the wire" mute-when-silent behavior, since RNNoise
  // already suppresses stationary noise. `mode` selects which:
  //   'legacy' — full chain (hp, comp, gate)
  //   'meter'  — analyser only, no gate, no filtering
  function buildDenoise(rawStream, ctx, mode = 'legacy') {
    const source = ctx.createMediaStreamSource(rawStream)
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 512
    analyser.smoothingTimeConstant = 0.65

    // Legacy-mode nodes; unused in 'meter' mode.
    let hp = null, comp = null, gate = null
    if (mode === 'legacy') {
      hp = ctx.createBiquadFilter()
      hp.type = 'highpass'
      hp.frequency.value = 90
      comp = ctx.createDynamicsCompressor()
      comp.threshold.value = -28
      comp.knee.value = 12
      comp.ratio.value = 4
      comp.attack.value = 0.005
      comp.release.value = 0.15
      gate = ctx.createGain()
      gate.gain.value = 0
    }

    const sink = ctx.createGain()
    sink.gain.value = 0

    function rewire(on) {
      try { source.disconnect() } catch {}
      if (hp) try { hp.disconnect() } catch {}
      if (comp) try { comp.disconnect() } catch {}
      try { analyser.disconnect() } catch {}
      if (gate) try { gate.disconnect() } catch {}
      if (mode === 'legacy') {
        if (on) {
          source.connect(hp)
          hp.connect(comp)
          comp.connect(analyser)
          analyser.connect(gate)
        } else {
          source.connect(analyser)
          analyser.connect(gate)
          gate.gain.setTargetAtTime(1, ctx.currentTime, 0.01)
        }
        if (captureNode) gate.connect(captureNode)
        gate.connect(sink)
      } else {
        source.connect(analyser)
        if (captureNode) analyser.connect(captureNode)
        analyser.connect(sink)
      }
    }
    rewire(me.denoiseOn)
    sink.connect(ctx.destination)

    const data = new Uint8Array(analyser.frequencyBinCount)
    const OPEN = 0.032, CLOSE = 0.018, HOLD = 0.28
    let lastLoud = 0, gateOpen = false
    const loop = () => {
      // stopMic → destroyDenoise races with an in-flight RAF callback:
      // if the browser had already queued this tick when destroyDenoise ran,
      // cancelAnimationFrame doesn't stop the queued one. Bail here so
      // `denoise.raf = requestAnimationFrame(...)` doesn't NPE.
      if (!denoise) return
      analyser.getByteTimeDomainData(data)
      let sum = 0
      for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128
        sum += v * v
      }
      const rms = Math.sqrt(sum / data.length)
      me.level = Math.min(1, rms * 3.2)
      if (mode === 'legacy' && me.denoiseOn) {
        const now = ctx.currentTime
        if (rms > OPEN) { gateOpen = true; lastLoud = now }
        else if (rms < CLOSE && now - lastLoud > HOLD) gateOpen = false
        gate.gain.setTargetAtTime(gateOpen ? 1 : 0, now, 0.03)
        me.gateOpen = gateOpen
      } else {
        // In RNNoise mode the gate lives inside the wasm (via VAD-shaped
        // output), and there's no analog gate to drive. Just surface a soft
        // level indicator so the UI still shows the person talking.
        me.gateOpen = rms > 0.02
      }
      denoise.raf = requestAnimationFrame(loop)
    }
    denoise = { source, hp, comp, analyser, gate, sink, rewire, raf: null, mode }
    denoise.raf = requestAnimationFrame(loop)
    return denoise
  }

  function destroyDenoise() {
    if (!denoise) return
    cancelAnimationFrame(denoise.raf)
    try { denoise.source.disconnect() } catch {}
    if (denoise.hp) try { denoise.hp.disconnect() } catch {}
    if (denoise.comp) try { denoise.comp.disconnect() } catch {}
    try { denoise.analyser.disconnect() } catch {}
    if (denoise.gate) try { denoise.gate.disconnect() } catch {}
    try { denoise.sink.disconnect() } catch {}
    denoise = null
    me.level = 0
    me.gateOpen = false
  }

  function toggleDenoise() {
    me.denoiseOn = !me.denoiseOn
    if (denoise) denoise.rewire(me.denoiseOn)
  }

  function destroyRnn() {
    if (!rnn) return
    try { rnn.state.destroy() } catch {}
    rnn = null
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
      // Kick off RNNoise wasm load in parallel with getUserMedia — the first
      // toggleMic pays the ~200 KB wasm cost, subsequent toggles are instant.
      const rnnoisePromise = loadRnnoise()

      // Ensure playback context has the worklet loaded too (the mic path
      // itself uses whichever context ends up capturing).
      await ensureAudioCtx()

      const raw = await navigator.mediaDevices.getUserMedia({
        audio: {
          // The browser's own echoCancellation / noiseSuppression give us a
          // cleaner input for RNNoise to work with; leave them on.
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1
        },
        video: false
      })
      localStream = raw

      const rnnoiseInstance = await rnnoisePromise

      let txBytes = 0
      let txTick = performance.now()

      if (rnnoiseInstance) {
        // ---------- RNNoise path (48 kHz mic → wasm denoise → 16 kHz Int16 wire) ----------
        const ctx = await ensureMicCtx()
        await ensureWorkletOn(ctx)

        const state = rnnoiseInstance.createDenoiseState()
        // Downsample 3:1 by averaging every 3 samples — cheap and low-aliasing
        // enough for speech. `remainder` carries samples that didn't fit into
        // the last outgoing 320-sample block.
        rnn = {
          state,
          out16: new Int16Array(FRAME_SAMPLES),
          out16Idx: 0,
          resampleAcc: 0,
          resampleCount: 0
        }
        rnnoiseReady.value = true

        captureNode = new AudioWorkletNode(ctx, 'pcm-capturer', {
          processorOptions: { frameSize: RNN_FRAME_SAMPLES, format: 'float32' }
        })
        captureNode.port.onmessage = (e) => {
          if (!socket?.connected || !rnn) return
          const frame = new Float32Array(e.data)   // 480 samples float32 @ 48 kHz
          // RNNoise expects Int16-range values in a Float32 buffer.
          for (let i = 0; i < frame.length; i++) frame[i] *= 32768
          if (me.denoiseOn) {
            try { rnn.state.processFrame(frame) } catch (err) {
              console.warn('[rnnoise] processFrame threw', err)
            }
          }
          // Downsample 3:1 → 160 samples per 480 in; two 480-frames per wire packet.
          for (let i = 0; i < frame.length; i++) {
            rnn.resampleAcc += frame[i]
            rnn.resampleCount++
            if (rnn.resampleCount === 3) {
              let s = rnn.resampleAcc / 3
              if (s > 32767) s = 32767
              else if (s < -32768) s = -32768
              rnn.out16[rnn.out16Idx++] = s | 0
              rnn.resampleAcc = 0
              rnn.resampleCount = 0
              if (rnn.out16Idx === FRAME_SAMPLES) {
                const buf = rnn.out16.buffer.slice(0)
                socket.emit('voice', buf)
                txBytes += buf.byteLength
                const now = performance.now()
                if (now - txTick > 1000) {
                  me.txAudio = Math.round((txBytes * 1000) / (now - txTick))
                  txBytes = 0
                  txTick = now
                }
                rnn.out16Idx = 0
              }
            }
          }
        }

        buildDenoise(raw, ctx, 'meter')
      } else {
        // ---------- Legacy 16 kHz path ----------
        await ensureWorkletOn(ensureAudioCtxSync())
        captureNode = new AudioWorkletNode(audioCtx, 'pcm-capturer')
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
        buildDenoise(raw, audioCtx, 'legacy')
      }
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
    destroyRnn()
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
      // Still suspended after the resume attempt (mobile before tap) → don't
      // schedule anything. If we did, nextPlayAt would drift into a far
      // future while currentTime stays frozen, and post-unlock we'd play a
      // multi-second echo of stale audio.
      if (audioCtx.state === 'suspended') {
        needsAudioUnlock.value = true
        return
      }
    }
    const int16 = new Int16Array(arrayBuf)
    // per-peer gain → master gain → destination.  Setting up the master lazily
    // here (rather than at ctx creation) keeps the graph identical for peers
    // that never speak.
    let gain = remoteGains.get(from)
    if (!gain) {
      gain = audioCtx.createGain()
      const master = ensureVoiceMaster()
      gain.connect(master || audioCtx.destination)
      remoteGains.set(from, gain)
      // Apply any pre-existing per-peer setting (e.g. user muted this peer
      // before their first voice packet arrived).
      const s = getPeerAudio(from)
      gain.gain.value = s.muted ? 0 : s.voice
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
    // Two-way resync:
    //   too far behind (t in the past)  → nudge to now + JITTER_SEC
    //   too far ahead (t > now + 0.5 s) → same. Otherwise a suspended
    //     AudioContext (mobile before user interaction unlocks it) lets
    //     nextPlayAt accumulate several seconds while audioCtx.currentTime
    //     stays frozen — after unlock every packet plays that many seconds
    //     late, which is what shows up as "语音延迟 10 秒".
    const MAX_QUEUE = 0.5
    if (t < now + JITTER_SEC || t > now + MAX_QUEUE) t = now + JITTER_SEC
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
  // Codec strings any viewer told us they can't decode. Populated via the
  // `codec-string-unsupported` socket event; passed to pickEncoderCodec so
  // we never pick, say, avc1.640028 (H.264 High) again once it's failed.
  const viewerRejectedCodecs = new Set()
  // VideoEncoder emits `meta.decoderConfig` only on the first output after
  // configure() (and on codec swaps). Cache it here so we can attach it to
  // *every* keyframe — otherwise late-joiners / refreshers get keyframes
  // without any decoder config and stay black forever.
  let lastDecoderConfig = null

  // Every codec has multiple valid string forms; different browsers/GPUs
  // support different ones. We try them all in order.
  const CODEC_CANDIDATES = [
    { id: 'vp9',  label: 'VP9',   strings: ['vp09.00.10.08', 'vp09.00.31.08', 'vp09.02.10.10', 'vp9'] },
    // HEVC (H.265). WebCodecs exposes this on Apple platforms + recent
    // Chrome/Edge on hardware that supports it. Same profile@level game as
    // H.264 — Main profile is what browsers actually decode; the last two
    // hex digits are the general-level (L93=3.1, L120=4.0, L123=4.1,
    // L150=5.0, L153=5.1).
    // Both container flavors are worth probing: hvc1.* is the mp4-style
    // in-band-config form Chrome/Safari prefer; hev1.* is the byte-stream
    // form some browsers only expose that way. Try lower levels first for
    // wider decoder support.
    { id: 'hevc', label: 'HEVC',  strings: [
      'hvc1.1.6.L93.B0',   'hev1.1.6.L93.B0',
      'hvc1.1.6.L120.B0',  'hev1.1.6.L120.B0',
      'hvc1.1.6.L123.B0',  'hev1.1.6.L123.B0',
      'hvc1.1.6.L150.B0',  'hev1.1.6.L150.B0',
      'hvc1.1.6.L153.B0',  'hev1.1.6.L153.B0'
    ] },
    // H.264 profile/level strings, ordered by DECODER compatibility.
    //   42xxxx = Baseline (widest support — mobile Safari, older Android, etc.)
    //   4Dxxxx = Main    (still very broad)
    //   64xxxx = High    (many mobile decoders REJECT this — last resort)
    // The two hex digits at the end are the level:
    //   1F = 3.1 (≤ 720p30),  28 = 4.0 (≤ 1080p30),  29 = 4.1 (≤ 1080p60),
    //   32 = 5.0 (≤ 4K30),    33 = 5.1 (≤ 4K60)
    // We need higher-level Baseline/Main entries — otherwise the ONLY probe
    // that passes at 1080p is High @ 4.0, and any viewer that can't decode
    // High profile forces a fallback to VP8.
    { id: 'h264', label: 'H.264', strings: [
      'avc1.42E01F',   // Baseline 3.1 (720p)
      'avc1.42E028',   // Baseline 4.0 (1080p)
      'avc1.42E029',   // Baseline 4.1 (1080p60)
      'avc1.42E032',   // Baseline 5.0 (4K30)
      'avc1.42E033',   // Baseline 5.1 (4K60)
      'avc1.4D401F',   // Main 3.1
      'avc1.4D4028',   // Main 4.0
      'avc1.4D4029',   // Main 4.1
      'avc1.4D4032',   // Main 5.0
      'avc1.4D4033',   // Main 5.1
      'avc1.640028',   // High 4.0 (last — many decoders reject)
      'avc1.640032',   // High 5.0
      'avc1.640033'    // High 5.1
    ] },
    { id: 'vp8',  label: 'VP8',   strings: ['vp8'] },
    { id: 'av1',  label: 'AV1',   strings: ['av01.0.04M.08'] }
  ]

  async function pickEncoderCodec(width, height, framerate, bitrate, { strictFamily = false, avoidStrings = null } = {}) {
    // most encoders require even dimensions
    width = width - (width % 2)
    height = height - (height % 2)

    const wanted = screenOptions.codec === 'auto' ? null : screenOptions.codec
    const wantedCandidate = wanted ? CODEC_CANDIDATES.find((c) => c.id === wanted) : null
    // strictFamily: only search inside the requested family. Used by swapCodec —
    // if the viewer said "I can't decode H.264, please switch to VP8", we must
    // NOT silently pick H.264 again. Without it, viewers loop-request forever.
    const ordered = wantedCandidate
      ? (strictFamily
          ? [wantedCandidate]
          : [wantedCandidate, ...CODEC_CANDIDATES.filter((c) => c.id !== wanted)])
      : CODEC_CANDIDATES
    // avoidStrings: specific codec strings the viewer already told us they
    // can't decode. e.g. H.264 High 4.0 → skip and try Baseline / Main next.
    const rejected = avoidStrings instanceof Set ? avoidStrings : new Set()

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
          if (rejected.has(codecStr)) continue
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

      const chosen = await pickEncoderCodec(width, height, fps, vBitrateBps, { avoidStrings: viewerRejectedCodecs })
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
      // Tell viewers immediately which transport they're about to see. If
      // sharer is on WT we want the "画面可能撕裂" banner to appear as soon
      // as the share starts, not lag behind by any amount.
      broadcastTransportMode()

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
    // Natural keyframe cadence. 3 s over WT (lossy — one bad delta and the
    // decoder freezes on the last good frame until the next key), 20 s over
    // socket.io (TCP, ordered, reliable — no need to burn bandwidth on
    // keyframes). Recomputed each frame so the cadence tracks whichever
    // transport senderTransport lands on.
    const KEY_EVERY_WT = Math.max(1, screenOptions.frameRate * 3)     // ~3 s
    const KEY_EVERY_TCP = Math.max(1, screenOptions.frameRate * 20)   // ~20 s
    function keyEveryNow() {
      const t = senderTransport.value
      return (t === 'wt') ? KEY_EVERY_WT : KEY_EVERY_TCP
    }
    while (vEncoder && vEncoder.state === 'configured' && vReader) {
      const { value: frame, done } = await vReader.read()
      if (done) break
      if (!vEncoder || vEncoder.state !== 'configured') { frame.close(); break }
      const keyFrame = vForceKey || (vFrameCount % keyEveryNow() === 0)
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
    // If we're already on the target family but the current SPECIFIC codec
    // string got rejected, don't take the fast path — we must actually
    // repick to land on a different profile/level inside the family.
    const currentStringRejected = viewerRejectedCodecs.has(vEncoder._codec)
    if (currentFamily === wanted && !currentStringRejected) {
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
      // strictFamily: viewer said "not this family" — we MUST honor that.
      // Silently picking the same family (or the family we just moved away from)
      // is what triggered the "swap codec h264 → vp8 avc1.640028" loop.
      // avoidStrings: skip the exact codec strings the viewer already
      // rejected — so H.264 High 4.0 failing lets us try H.264 Baseline 4.1
      // instead of bailing to VP8.
      chosen = await pickEncoderCodec(w, h, fps, vBitrateBps, {
        strictFamily: true,
        avoidStrings: viewerRejectedCodecs
      })
    } finally {
      screenOptions.codec = savedPref
    }
    if (!chosen) {
      console.warn('[webcodecs] no encoder available for', wanted, '— staying on', currentFamily)
      // Tell the viewer we can't produce this codec so they stop asking for it
      // and cascade to the next candidate (or give up gracefully).
      if (socket?.connected) socket.emit('codec-unavailable', { codec: wanted })
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
        const master = ensureScreenMaster()
        gain.connect(master || ctx.destination)
        screenAudioGains.set(from, gain)
        const s = getPeerAudio(from)
        gain.gain.value = s.muted ? 0 : s.screen
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
            // Same two-way resync as voice (see playPcm).
            if (t < now + JITTER_SEC || t > now + 0.5) t = now + JITTER_SEC
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

  // Per-peer dedup — sharer sends keyframes over WT AND socket.io, so viewer
  // receives each keyframe twice. Whichever gets in first wins; the second
  // is dropped by ts match.
  const seenChunkTs = new Map()          // peerId -> Set<ts>  (recent-only)
  const SEEN_WINDOW = 200                // ~7 s at 30 fps
  // Per-peer key/delta arrival counters for a per-second console log — lets
  // the user see whether keyframes are actually reaching them.
  const rxCounters = new Map()           // peerId -> { key, delta, dedup, lastLogAt }

  // Per-peer tracking of the last chunk timestamp we FED to the decoder.
  // QUIC uni-streams don't preserve order between streams — chunk N+1 can
  // land before chunk N. If we blindly feed the decoder in arrival order,
  // deltas that reference frames the decoder hasn't seen yet blow up. We
  // reorder chunks that arrive slightly early by holding them a tiny window,
  // and drop chunks that arrive too late to matter (past the current one).
  const lastChunkTs = new Map()          // peerId -> ts (microseconds)
  const reorderBuf = new Map()           // peerId -> [{msg, addedAt}]
  const REORDER_WINDOW_MS = 60           // how long we hold an out-of-order chunk
  // Watchdog: if too much wall-clock time passes without a keyframe on a
  // WT-fed stream (deltas keep coming but partial corruption froze part of
  // the canvas), request one.
  const lastKeyAt = new Map()            // peerId -> performance.now()
  const KEYFRAME_STARVATION_MS = 5000    // if no key in 5 s, ping sharer

  // Which codec families this device can actually decode. Populated lazily on
  // first video-chunk. Used to (a) skip re-asking for a codec swap we already
  // know is going to fail, (b) show a helpful message.
  const decoderSupport = { vp9: null, h264: null, vp8: null, av1: null }
  // Per-family hw/sw preference that probeDecoder found workable — stashed so
  // makeDecoder can reuse the same opts (probe-passed / configure-throws split
  // is what put us into an infinite codec-switch loop).
  const decoderOptsByFamily = { vp9: null, h264: null, vp8: null, av1: null }
  // Codecs the *sharer* explicitly said they can't encode. Prevents us from
  // asking for a codec they've already refused. Populated on 'codec-unavailable'.
  const encoderSupport = { vp9: null, h264: null, vp8: null, av1: null }
  // Per-family debounce for requestCodecSwitch — bug 3 in the plan file.
  const lastSwitchRequestAt = new Map()   // family -> performance.now()
  const CODEC_FAMILY = (codec) => {
    if (codec.startsWith('vp09') || codec === 'vp9') return 'vp9'
    if (codec.startsWith('avc1') || codec.startsWith('avc3') || codec === 'h264') return 'h264'
    if (codec.startsWith('hvc1') || codec.startsWith('hev1') || codec === 'hevc' || codec === 'h265') return 'hevc'
    if (codec === 'vp8' || codec.startsWith('vp08')) return 'vp8'
    if (codec.startsWith('av01') || codec === 'av1') return 'av1'
    return codec
  }

  // Individual codec strings the viewer has rejected (H.264 High profile,
  // HEVC Main 5.1, etc.). Separate from decoderSupport[family] because
  // ONE H.264 profile failing doesn't mean H.264 is dead — Baseline might
  // still work, we just need to tell the sharer to try that instead.
  const rejectedCodecStrings = new Set()

  // Probe a decoder config against a cascade of hw/sw preferences. Returns
  // { supported, opts } so the caller can configure() with the *same* opts —
  // otherwise a probe-passed / configure-throws mismatch bounces us back into
  // requestCodecSwitch (which caused the H.264-High → VP8 codec churn loop).
  async function probeDecoder(cfg) {
    const attempts = [
      { hardwareAcceleration: 'prefer-hardware' },
      { hardwareAcceleration: 'prefer-software' },
      {}
    ]
    for (const opts of attempts) {
      try {
        const s = await VideoDecoder.isConfigSupported({
          codec: cfg.codec,
          codedWidth: cfg.codedWidth,
          codedHeight: cfg.codedHeight,
          description: cfg.description ? new Uint8Array(cfg.description) : undefined,
          ...opts
        })
        if (s.supported) return { supported: true, opts }
      } catch {}
    }
    return { supported: false, opts: null }
  }

  function makeDecoder(peerId, cfg, opts = {}) {
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
        pendingChunks.delete(peerId)
        lastChunkTs.delete(peerId)
        // A dead decoder without a fresh keyframe = viewer stares at a stale
        // canvas for up to KEY_EVERY frames. Ask the sharer NOW so we don't
        // have to wait for the natural cadence.
        if (socket?.connected) socket.emit('need-keyframe')
      }
    })
    // Use the same hw/sw preference that probeDecoder found workable — otherwise
    // hardcoding 'prefer-hardware' here can reject a config that
    // isConfigSupported blessed under 'prefer-software'.
    dec.configure({
      codec: cfg.codec,
      codedWidth: cfg.codedWidth,
      codedHeight: cfg.codedHeight,
      description: cfg.description ? new Uint8Array(cfg.description) : undefined,
      optimizeForLatency: true,
      ...(opts || {})
    })
    videoDecoders.set(peerId, dec)
    return dec
  }

  // Cascade the sharer through H.264 → HEVC → VP9 → AV1 → VP8 when the
  // current codec isn't decodable. H.264 first because it's the most
  // universally supported on mobile hardware. VP8 last — its software
  // encoder produces essentially unwatchable output at 1080p, so we only
  // land there when literally nothing else works.
  const CODEC_FALLBACK_ORDER = ['h264', 'hevc', 'vp9', 'av1', 'vp8']
  function pickNextCodecTo(currentFamily) {
    for (const f of CODEC_FALLBACK_ORDER) {
      if (f === currentFamily) continue
      // Skip families the sharer has told us they can't encode.
      if (encoderSupport[f] === false) continue
      if (decoderSupport[f] === false) continue
      return f
    }
    return null
  }

  function requestCodecSwitch(currentCodec) {
    if (!socket?.connected) return
    const family = CODEC_FAMILY(currentCodec)
    // Remember the EXACT codec string that failed. A future probe of a
    // different profile in the same family (H.264 Baseline vs High) should
    // still be allowed.
    rejectedCodecStrings.add(currentCodec)
    // Tell the sharer which specific string failed — they'll skip it when
    // repicking, letting them try a lower profile in the same family.
    socket.emit('codec-string-unsupported', { codec: currentCodec })
    // Debounce per-family: even after we mark decoderSupport[family]=false,
    // in-flight chunks with an old config can arrive and re-trigger us. 2 s is
    // enough to cover a swap round-trip without blocking a genuine re-probe if
    // the user re-shares from scratch.
    const now = performance.now()
    const last = lastSwitchRequestAt.get(family) || 0
    if (now - last < 2000) return
    lastSwitchRequestAt.set(family, now)
    // Ask the sharer to try again in the same family first — they might have
    // a lower profile available. Only if they can't produce anything in this
    // family will they hit `codec-unavailable` and we'll cascade families.
    console.log('[webcodecs] requesting codec re-probe: rejected', currentCodec, '— staying in family', family, 'if possible')
    awaitingCodecSwitch.value = true
    socket.emit('need-codec', { avoid: currentCodec, wanted: family, avoidString: currentCodec })
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
    // Any incoming chunk — WT or socket.io — proves frames are flowing.
    // The stall watchdog uses lastFrameTs to decide whether to nag `need-tcp`;
    // if we only touched it on the socket.io path (like we did originally),
    // a perfectly healthy WT link would look "stalled" and get killed after
    // 7 s. That's the bug behind "sharer sees 0% loss, viewer still asks for
    // TCP fallback".
    const p = peers.get(from)
    if (p) p.lastFrameTs = performance.now()

    // ---- Dual-send dedup ----
    // Sharer mirrors keyframes over WT + socket.io; if we already handled
    // this ts, drop the second copy silently.
    let seen = seenChunkTs.get(from)
    if (!seen) { seen = new Set(); seenChunkTs.set(from, seen) }
    let counter = rxCounters.get(from)
    if (!counter) { counter = { key: 0, delta: 0, dedup: 0, lastLogAt: performance.now() }
      rxCounters.set(from, counter)
    }
    if (seen.has(msg.ts)) {
      counter.dedup++
      // Fall through to the periodic log below, then bail.
      const now = performance.now()
      if (now - counter.lastLogAt > 1000) {
        console.log(`[rx] ${from.slice(0, 6)}  key=${counter.key} delta=${counter.delta} dedup=${counter.dedup}`)
        counter.key = 0; counter.delta = 0; counter.dedup = 0
        counter.lastLogAt = now
      }
      return
    }
    seen.add(msg.ts)
    if (seen.size > SEEN_WINDOW) {
      // Sets iterate in insertion order — evict the oldest.
      const first = seen.values().next().value
      seen.delete(first)
    }
    if (msg.type === 'key') counter.key++
    else counter.delta++
    const nowLog = performance.now()
    if (nowLog - counter.lastLogAt > 1000) {
      console.log(`[rx] ${from.slice(0, 6)}  key=${counter.key} delta=${counter.delta} dedup=${counter.dedup}`)
      counter.key = 0; counter.delta = 0; counter.dedup = 0
      counter.lastLogAt = nowLog
    }

    // ---- QUIC uni-stream reordering ----
    // WT delivers each chunk on its own uni-stream, and between-stream
    // ordering isn't guaranteed. A chunk that arrives with ts LESS than the
    // last-fed ts is a late duplicate/reordering — drop it (the decoder
    // already moved past that timestamp).
    // Keyframes always pass — they reset the decoder anyway.
    if (msg.type !== 'key' && !msg.config) {
      const lastFedTs = lastChunkTs.get(from)
      if (lastFedTs !== undefined && msg.ts < lastFedTs) {
        // Too late — decoder is past this point. Deltas older than the
        // current position can only produce garbage.
        return
      }
    }
    let dec = videoDecoders.get(from)
    // Config → (re)build decoder. Fresh encoder = fresh ts baseline, so wipe
    // the reorder guards or we'd reject every new delta as "too old".
    if (msg.config) {
      if (dec) { try { dec.close() } catch {}; videoDecoders.delete(from); dec = null }
      lastChunkTs.delete(from)
      lastKeyAt.delete(from)
      const family = CODEC_FAMILY(msg.config.codec)
      // Probe once per codec family — if unsupported, ask sharer to switch.
      if (decoderSupport[family] === null) {
        const probe = await probeDecoder(msg.config)
        decoderSupport[family] = probe.supported
        decoderOptsByFamily[family] = probe.opts
      }
      if (!decoderSupport[family]) {
        requestCodecSwitch(msg.config.codec)
        return
      }
      try {
        dec = makeDecoder(from, msg.config, decoderOptsByFamily[family])
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
      lastChunkTs.set(from, msg.ts)
      if (msg.type === 'key') lastKeyAt.set(from, performance.now())
    } catch (e) {
      console.warn('decode err', e)
      // Delta chunk failing to decode = its reference frame is missing.
      // Salvage this: ask for a fresh keyframe so we recover on the next tick
      // instead of freezing the canvas until the natural cadence catches up.
      if (socket?.connected && msg.type !== 'key') socket.emit('need-keyframe')
    }
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
  // WT send stats — surfaced in the console every second so you can tell
  // whether a bad share is send-side (WT drops) or receive-side.
  const wtSendStats = { ok: 0, fail: 0, lastLogAt: 0 }
  function logWtStats(now) {
    if (now - wtSendStats.lastLogAt < 1000) return
    if (wtSendStats.ok || wtSendStats.fail) {
      const failPct = Math.round(100 * wtSendStats.fail / (wtSendStats.ok + wtSendStats.fail))
      console.log(`[wt] send ok=${wtSendStats.ok} fail=${wtSendStats.fail} (${failPct}% loss)`)
      wtSendStats.ok = 0
      wtSendStats.fail = 0
    }
    wtSendStats.lastLogAt = now
  }
  function sendVideo(msg) {
    if (useWtNow()) {
      const meta = { type: msg.type }
      if (msg.config) {
        meta.config = {
          codec: msg.config.codec,
          codedWidth: msg.config.codedWidth,
          codedHeight: msg.config.codedHeight,
          description: msg.config.description ? bytesToB64(msg.config.description) : ''
        }
      }
      // Dual-send keyframes over BOTH WT (low-latency, may drop) and
      // socket.io (higher latency, TCP-reliable). Whichever arrives first at
      // the viewer wins — the other gets deduped by ts. Deltas stay
      // WT-only because they're 10× more numerous; doubling them would cost
      // ~30% bandwidth for negligible robustness win.
      //
      // Why: a lost keyframe over UDP leaves the viewer stuck on a stale
      // canvas for up to `KEY_EVERY_WT` seconds while every delta arriving
      // in between fails to decode. Losing ~5% of keyframes to UDP jitter
      // shows up as "画面残留数秒". Mirroring keyframes on TCP eliminates
      // that failure mode without significantly bloating the wire.
      if (msg.type === 'key' && socket?.connected) socket.emit('video', msg)
      wt.value.sendChunk(WT_KIND.VIDEO, msg.ts, meta, new Uint8Array(msg.data)).then((ok) => {
        const now = performance.now()
        if (ok) wtSendStats.ok++
        else {
          wtSendStats.fail++
          // Delta failed on WT and wasn't mirrored above — send via socket.io.
          if (msg.type !== 'key' && socket?.connected) socket.emit('video', msg)
        }
        logWtStats(now)
      }).catch(() => {
        wtSendStats.fail++
        if (msg.type !== 'key' && socket?.connected) socket.emit('video', msg)
        logWtStats(performance.now())
      })
      return
    }
    if (socket?.connected) socket.emit('video', msg)
  }
  function sendScreenAudio(msg) {
    if (useWtNow()) {
      const meta = {
        type: msg.type,
        sampleRate: msg.sampleRate,
        channels: msg.channels
      }
      if (msg.description) meta.description = bytesToB64(msg.description)
      wt.value.sendChunk(WT_KIND.SCREEN_AUDIO, msg.ts, meta, new Uint8Array(msg.data)).then((ok) => {
        if (!ok && socket?.connected) socket.emit('screen-audio', msg)
      }).catch(() => {
        if (socket?.connected) socket.emit('screen-audio', msg)
      })
      return
    }
    if (socket?.connected) socket.emit('screen-audio', msg)
  }

  // ---------- WT open + incoming chunk demux ----------
  // Attempt tracking — retry with exponential-ish backoff while the user
  // wants WT but it's not up. Cleared on success / when user switches to
  // TCP-only preference.
  let wtOpenInFlight = false
  let wtRetryTimer = null
  function scheduleWtRetry(delayMs) {
    if (wtRetryTimer) return
    wtRetryTimer = setTimeout(() => {
      wtRetryTimer = null
      if (preferTransport.value !== 'wt') return
      if (wt.value) return
      if (!wtInfo) return
      tryOpenWebTransport(wtInfo).catch(() => {})
    }, delayMs)
  }
  async function tryOpenWebTransport(info) {
    if (!HAS_WEBTRANSPORT || !info?.url || !info?.token || !me.id) return
    // Guard against parallel opens (e.g. user toggles preference while a
    // scheduled retry hasn't fired yet).
    if (wtOpenInFlight) return
    wtOpenInFlight = true
    // Close a stale session before starting a new one.
    if (wt.value) { try { wt.value.close() } catch {}; wt.value = null }
    const opened = await openWebTransport({
      url: info.url,
      socketId: me.id,
      token: info.token,
      room: roomId,
      onChunk: onWtChunk,
      onClose: () => {
        if (wt.value === opened) wt.value = null
        // Session died. If user still wants WT, schedule a retry so we can
        // reconnect once the network / server recovers.
        if (preferTransport.value === 'wt') scheduleWtRetry(5000)
      }
    })
    wtOpenInFlight = false
    if (opened) {
      wt.value = opened
      console.log('[wt] session up')
    } else {
      console.log('[wt] open failed — falling back to socket.io (data still flows over TCP)')
      // If user prefers WT, keep trying quietly in the background so the
      // moment their UDP path recovers, we resume QUIC without needing them
      // to toggle anything.
      if (preferTransport.value === 'wt') scheduleWtRetry(8000)
    }
  }

  // React to user flipping preferTransport → 'wt' after we've already been
  // running: try opening a session if we don't have one.
  watch(preferTransport, (v) => {
    if (v === 'wt' && !wt.value && wtInfo) {
      tryOpenWebTransport(wtInfo).catch(() => {})
    }
    // Switching back to TCP → cancel pending retries so we stop pinging the
    // dead endpoint on a schedule.
    if (v !== 'wt' && wtRetryTimer) {
      clearTimeout(wtRetryTimer)
      wtRetryTimer = null
    }
  })

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

  // Send join with whatever password we currently have (cached, freshly
  // typed, or none). setPassword is only sent on the initial join by a
  // room-creator; the server will register it if the room is fresh.
  function sendJoin() {
    if (!socket) return
    const payload = { room: roomId, name: me.name }
    if (pendingPassword) payload.password = pendingPassword
    // Only send setPassword on the *very first* join attempt of the session —
    // don't leak it on reconnects.
    if (initialSetPassword && authState.state === 'idle') {
      payload.setPassword = initialSetPassword
    }
    if (authState.state === 'prompting') authState.state = 'checking'
    socket.emit('join', payload)
  }

  // Called from Room.vue when the user enters a password in the prompt.
  function submitPassword(pwd) {
    pendingPassword = String(pwd || '')
    authState.state = 'checking'
    sendJoin()
  }

  // Rename (in-room). Persists locally so the next room reuses the new name.
  function setName(newName) {
    const clean = String(newName || '').slice(0, 24).trim()
    if (!clean || clean === me.name) return
    me.name = clean
    try { localStorage.setItem(NAME_KEY, clean) } catch {}
    if (socket?.connected) socket.emit('rename', { name: clean })
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
      sendJoin()
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

    // Server accepted the join — persist whichever password made it through so
    // reload / auto-reconnect skips the prompt.
    socket.on('joined', ({ hasPassword }) => {
      authState.state = 'joined'
      authState.reason = null
      if (hasPassword && pendingPassword) savePassword(roomId, pendingPassword)
    })

    // Server rejected the join because the room is password-protected and we
    // either didn't supply one, or supplied a wrong one. Flip to 'prompting'
    // and let Room.vue render the input dialog.
    socket.on('auth-required', ({ reason }) => {
      // Wrong cached password? Wipe it so the user isn't stuck re-trying it.
      if (reason === 'wrong' && pendingPassword) {
        savePassword(roomId, null)
        pendingPassword = null
      }
      authState.state = 'prompting'
      authState.reason = reason || 'needed'
    })

    socket.on('peer-renamed', ({ id, name }) => {
      const p = peers.get(id)
      if (p) p.name = String(name || '').slice(0, 24)
    })

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
          screenOnAt: p.screenOn ? performance.now() : 0,
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
        screenOnAt: screenOn ? performance.now() : 0,
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
      if (!wasSharing && screenOn) p.screenOnAt = performance.now()
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
    socket.on('need-codec', ({ wanted, avoidString }) => {
      if (!me.screenOn) return
      // Viewer told us which specific string they rejected — record it before
      // repicking so swapCodec doesn't hand back the same one.
      if (typeof avoidString === 'string') viewerRejectedCodecs.add(avoidString)
      const target = typeof wanted === 'string' ? wanted : 'h264'
      swapCodec(target).catch((e) => console.warn('swapCodec failed', e))
    })
    // A viewer told us a specific codec string can't decode. This is separate
    // from `need-codec` because sometimes multiple viewers reject different
    // strings — we just accumulate the set.
    socket.on('codec-string-unsupported', ({ codec }) => {
      if (typeof codec !== 'string') return
      viewerRejectedCodecs.add(codec)
      // If we're currently encoding a rejected string, re-pick immediately.
      if (me.screenOn && vEncoder && vEncoder._codec === codec) {
        const family = CODEC_FAMILY(codec)
        swapCodec(family).catch((e) => console.warn('swapCodec (rejected string) failed', e))
      }
    })
    // Sharer told viewers which transport they're using — populate map so
    // viewers can show the "画面可能撕裂" banner while UDP is active.
    socket.on('sharer-transport', (payload) => {
      if (!payload) return
      const fromId = payload.from   // server tags this
      const mode = payload.mode === 'wt' ? 'wt' : 'tcp'
      if (fromId) peerTransportMode.set(fromId, mode)
    })

    // Sharer told us they can't produce this codec. Mark it so pickNextCodecTo
    // skips it — otherwise we'd bounce right back with the same request.
    socket.on('codec-unavailable', ({ codec }) => {
      if (typeof codec !== 'string') return
      encoderSupport[codec] = false
      // If we're currently waiting on a switch that landed here, try the next
      // candidate now instead of waiting for the next incoming keyframe.
      if (awaitingCodecSwitch.value) {
        const next = pickNextCodecTo(codec)
        if (!next) {
          decoderUnsupported.value = true
          awaitingCodecSwitch.value = false
          return
        }
        console.log('[webcodecs] sharer cannot produce', codec, '— trying', next)
        // Reset debounce so requestCodecSwitch fires immediately for the new target.
        lastSwitchRequestAt.delete(next)
        socket.emit('need-codec', { avoid: codec, wanted: next })
      }
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
    lastChunkTs.delete(id)
    lastKeyAt.delete(id)
    reorderBuf.delete(id)
    seenChunkTs.delete(id)
    rxCounters.delete(id)
    peerTransportMode.delete(id)
    screenCanvases.delete(id)
    const adec = screenAudioDecoders.get(id)
    if (adec) { try { adec.close() } catch {}; screenAudioDecoders.delete(id) }
    const ag = screenAudioGains.get(id)
    if (ag) { try { ag.disconnect() } catch {}; screenAudioGains.delete(id) }
    screenAudioNext.delete(id)
    peerAudio.delete(id)
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
    // Nuke the accumulated future-schedule so post-unlock frames land at
    // now + JITTER_SEC instead of "wherever we were when the ctx froze +
    // however many seconds of buffer we accumulated". Without this, unlock
    // starts a 5-10 s echo of stale audio.
    nextPlayAt.clear()
    screenAudioNext.clear()
    needsAudioUnlock.value = false
  }

  function leave() {
    stopMic()
    stopScreen()
    if (wt.value) { try { wt.value.close() } catch {}; wt.value = null }
    for (const id of Array.from(peers.keys())) cleanupPeer(id)
    if (audioCtx) { try { audioCtx.close() } catch {} audioCtx = null }
    if (micCtx) { try { micCtx.close() } catch {} micCtx = null }
    if (screenAudioCtx) { try { screenAudioCtx.close() } catch {} screenAudioCtx = null }
    // Per-context worklet promises are held in a WeakMap keyed on the
    // AudioContext, so closing the contexts is enough to let them GC.
    if (socket) { try { socket.disconnect() } catch {} }
  }

  // Viewer-side keyframe-starvation watchdog: even when deltas keep flowing,
  // a corrupt / lost delta earlier in the stream can leave part of the canvas
  // stuck on an old frame. If we haven't seen a keyframe in a while but we
  // ARE receiving chunks, poke the sharer.
  const keyStarveTimer = setInterval(() => {
    if (!socket?.connected) return
    const now = performance.now()
    for (const p of peers.values()) {
      if (!p.screenOn) continue
      const lastKey = lastKeyAt.get(p.id) || 0
      const lastFrame = p.lastFrameTs || 0
      // Only nag if frames ARE flowing (avoids overlap with the TCP-fallback
      // watchdog below). Frames flowing + keyframe old = suspected staleness.
      if (lastFrame && now - lastFrame < 2000 && lastKey && now - lastKey > KEYFRAME_STARVATION_MS) {
        console.warn('[decoder] no keyframe from', p.id.slice(0, 6), 'for', Math.round((now - lastKey) / 1000), 's — nudging sharer')
        socket.emit('need-keyframe')
        // Reset so we don't spam every tick.
        lastKeyAt.set(p.id, now)
      }
    }
  }, 1000)

  onUnmounted(() => {
    clearInterval(keyStarveTimer)
    leave()
  })
  connect()

  const anyScreen = computed(() => {
    if (me.screenOn) return true
    for (const p of peers.values()) if (p.screenOn) return true
    return false
  })

  // Persistent UDP warning banner. Shown to the local user whenever THEY've
  // selected UDP (whether or not they're currently sharing — the moment they
  // start sharing it'll go UDP, so warn ahead of time), and shown to viewers
  // whenever any active sharer they can see is on UDP. Previously we
  // gated the sharer's own banner on `me.screenOn` too — that made the
  // banner blink off if screen sharing wasn't active for a moment, which
  // read as "the warning auto-closes after 3 s".
  const anySharerOnUdp = computed(() => {
    if (preferTransport.value === 'wt') return true
    for (const p of peers.values()) {
      if (!p.screenOn) continue
      if (peerTransportMode.get(p.id) === 'wt') return true
    }
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
    senderTransport,          // 'wt' | 'wt-degraded' | 'tcp' — reactive
    hasWebTransport: HAS_WEBTRANSPORT,
    preferTransport,          // ref: 'tcp' (default) | 'wt' — persisted
    anySharerOnUdp,           // computed<bool>: any active sharer on UDP right now
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
    leave,

    // ---------- identity ----------
    authState,
    submitPassword,
    setName,

    // ---------- mixer ----------
    masterVoiceVolume,
    masterScreenVolume,
    peerAudio,                       // reactive Map<peerId, { voice, screen, muted }>
    setMasterVoiceVolume,
    setMasterScreenVolume,
    setPeerVoiceVolume,
    setPeerScreenVolume,
    setPeerMuted,
    getPeerAudio                     // ensures + returns { voice, screen, muted }
  }
}
