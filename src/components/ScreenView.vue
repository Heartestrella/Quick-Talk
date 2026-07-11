<script setup>
import { ref, watch, onMounted, onUnmounted, nextTick } from 'vue'

const props = defineProps({
  peer: Object,                       // { id, name, isSelf }
  attachCanvas: Function,             // (peerId, canvasEl) for remote screens
  getSelfStream: Function,             // () => MediaStream for local preview
  decoderUnsupported: Boolean,        // viewer's browser can't decode any codec — fatal
  awaitingCodecSwitch: Boolean        // asked sharer to switch codec, waiting for new keyframe
})

const videoEl = ref(null)   // used when self
const canvasEl = ref(null)  // used when remote
const wrapEl = ref(null)    // the element we put into fullscreen
const isFullscreen = ref(false)

async function bind() {
  await nextTick()
  if (props.peer?.isSelf) {
    // self: local <video> shows the display capture
    const s = props.getSelfStream?.()
    if (videoEl.value && s) {
      videoEl.value.srcObject = s
      videoEl.value.play?.().catch(() => {})
    }
  } else if (props.peer && props.attachCanvas && canvasEl.value) {
    props.attachCanvas(props.peer.id, canvasEl.value)
  }
}

async function toggleFullscreen() {
  const doc = document
  const fsEl = doc.fullscreenElement || doc.webkitFullscreenElement
  if (fsEl) {
    try {
      if (doc.exitFullscreen) await doc.exitFullscreen()
      else if (doc.webkitExitFullscreen) doc.webkitExitFullscreen()
    } catch {}
    return
  }
  const el = wrapEl.value
  if (!el) return
  try {
    // iOS Safari on the <video> element supports the older webkitEnterFullscreen.
    if (el.requestFullscreen) await el.requestFullscreen({ navigationUI: 'hide' })
    else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen()
    else if (videoEl.value?.webkitEnterFullscreen) videoEl.value.webkitEnterFullscreen()
    // On phones, most shared screens are landscape 16:9 — a portrait-locked
    // phone would letterbox to a tiny strip. Force landscape while we're in
    // fullscreen; the orientation unlocks the moment the user exits.
    // The Screen Orientation API requires a fullscreen element on Android.
    try { await screen.orientation?.lock?.('landscape') } catch {}
  } catch (err) {
    console.warn('fullscreen failed', err)
  }
}

function onFsChange() {
  const doc = document
  const on = !!(doc.fullscreenElement || doc.webkitFullscreenElement)
  isFullscreen.value = on
  if (!on) {
    try { screen.orientation?.unlock?.() } catch {}
  }
}

onMounted(() => {
  bind()
  document.addEventListener('fullscreenchange', onFsChange)
  document.addEventListener('webkitfullscreenchange', onFsChange)
})
watch(() => props.peer?.id, bind)
onUnmounted(() => {
  document.removeEventListener('fullscreenchange', onFsChange)
  document.removeEventListener('webkitfullscreenchange', onFsChange)
  if (props.peer && !props.peer.isSelf && props.attachCanvas) {
    props.attachCanvas(props.peer.id, null)
  }
})
</script>

<template>
  <section class="screen-view" v-if="peer">
    <div class="screen-hdr">
      <span class="mono screen-tag">
        <span class="pip on"></span>
        SHARED SCREEN
      </span>
      <span class="screen-owner">
        <span class="mono">FROM</span>
        <span class="screen-name">{{ peer.isSelf ? '你' : peer.name }}</span>
      </span>
      <button
        class="fs-btn"
        @click="toggleFullscreen"
        :title="isFullscreen ? '退出全屏' : '全屏显示'"
        :aria-label="isFullscreen ? '退出全屏' : '全屏显示'"
      >
        <svg v-if="!isFullscreen" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M4 9V4h5" />
          <path d="M20 9V4h-5" />
          <path d="M4 15v5h5" />
          <path d="M20 15v5h-5" />
        </svg>
        <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M9 4v5H4" />
          <path d="M15 4v5h5" />
          <path d="M9 20v-5H4" />
          <path d="M15 20v-5h5" />
        </svg>
        <span class="fs-lbl">{{ isFullscreen ? '退出全屏' : '全屏' }}</span>
      </button>
    </div>
    <div class="screen-wrap" ref="wrapEl" :class="{ 'is-fs': isFullscreen }">
      <video
        v-if="peer.isSelf"
        ref="videoEl"
        autoplay
        playsinline
        muted
        class="screen-media"
      ></video>
      <canvas
        v-else
        ref="canvasEl"
        class="screen-media"
      ></canvas>
      <div v-if="!peer.isSelf && decoderUnsupported" class="screen-unsupported">
        <div class="unsup-tag mono">NO DECODER</div>
        <p class="unsup-lead">这个浏览器无法解码屏幕共享</p>
        <p class="unsup-hint">建议改用桌面版 Chrome / Edge，或 iOS 16.4+ Safari</p>
      </div>
      <div v-else-if="!peer.isSelf && awaitingCodecSwitch" class="screen-switching">
        <div class="switch-spin" aria-hidden="true"></div>
        <div class="switch-tag mono">CODEC SWITCH</div>
        <p class="switch-lead">正在请求对方切换编码器…</p>
        <p class="switch-hint">检测到当前编码不兼容本机 · 通常几秒后自动恢复</p>
      </div>
      <span class="scr-tick tl"></span>
      <span class="scr-tick tr"></span>
      <span class="scr-tick bl"></span>
      <span class="scr-tick br"></span>
    </div>
  </section>
</template>

<style scoped>
.screen-view {
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--panel);
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-height: 62vh;
}

.screen-hdr {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 6px;
}
.screen-hdr .screen-owner { margin-left: auto; }

.fs-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border: 1px solid var(--line);
  border-radius: 3px;
  color: var(--text-2);
  background: var(--panel-2);
  font-size: 11px;
  transition: color 140ms var(--ease), border-color 140ms var(--ease), background 140ms var(--ease);
}
.fs-btn svg { width: 14px; height: 14px; }
.fs-btn:hover {
  color: var(--cool);
  border-color: var(--cool);
  background: var(--panel-hi);
}
@media (max-width: 520px) {
  .fs-btn .fs-lbl { display: none; }
  .fs-btn { padding: 6px 8px; }
}
/* When the wrap itself is fullscreen, fill the black space and let the
   canvas/video breathe. */
.screen-wrap.is-fs,
.screen-wrap:fullscreen,
.screen-wrap:-webkit-full-screen {
  width: 100vw;
  height: 100vh;
  max-height: none;
  min-height: 0;
  border-radius: 0;
  background: #000;
  display: grid;
  place-items: center;
}
.screen-wrap:fullscreen .screen-media,
.screen-wrap:-webkit-full-screen .screen-media {
  width: 100%;
  height: 100%;
  max-height: none;
  object-fit: contain;
}
.screen-tag {
  color: var(--cool);
  font-size: 11px;
  letter-spacing: 0.14em;
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.pip { width: 6px; height: 6px; border-radius: 50%; background: var(--dim); }
.pip.on { background: var(--cool); box-shadow: 0 0 6px var(--cool); }

.screen-owner {
  display: inline-flex;
  align-items: baseline;
  gap: 8px;
  color: var(--text-2);
  font-size: 13px;
}
.screen-owner .mono { color: var(--muted); font-size: 10px; letter-spacing: 0.14em; }
.screen-name { color: var(--text); font-family: var(--font-mono); letter-spacing: 0.06em; }

.screen-wrap {
  position: relative;
  flex: 1;
  min-height: 300px;
  background: var(--bg-deep);
  border-radius: 4px;
  overflow: hidden;
  display: grid;
  place-items: center;
}
.screen-media {
  width: 100%;
  height: 100%;
  max-height: 55vh;
  object-fit: contain;
  display: block;
  background: var(--bg-deep);
}

.scr-tick {
  position: absolute;
  width: 14px; height: 14px;
  border-color: var(--cool);
  border-style: solid;
  border-width: 0;
  opacity: 0.6;
}
.scr-tick.tl { top: 8px; left: 8px; border-top-width: 1px; border-left-width: 1px; }
.scr-tick.tr { top: 8px; right: 8px; border-top-width: 1px; border-right-width: 1px; }
.scr-tick.bl { bottom: 8px; left: 8px; border-bottom-width: 1px; border-left-width: 1px; }
.scr-tick.br { bottom: 8px; right: 8px; border-bottom-width: 1px; border-right-width: 1px; }

.screen-unsupported {
  position: absolute;
  inset: 0;
  display: grid;
  place-content: center;
  place-items: center;
  gap: 8px;
  padding: 20px;
  text-align: center;
  background: rgba(13, 13, 16, 0.86);
  backdrop-filter: blur(4px);
}
.unsup-tag {
  color: var(--danger);
  font-size: 10px;
  letter-spacing: 0.18em;
  padding: 3px 8px;
  border: 1px solid var(--danger);
  border-radius: 3px;
}
.unsup-lead { color: var(--text); font-size: 14px; }
.unsup-hint { color: var(--muted); font-size: 12px; }

.screen-switching {
  position: absolute;
  inset: 0;
  display: grid;
  place-content: center;
  place-items: center;
  gap: 10px;
  padding: 20px;
  text-align: center;
  background: rgba(13, 13, 16, 0.82);
  backdrop-filter: blur(4px);
}
.switch-spin {
  width: 26px;
  height: 26px;
  border-radius: 50%;
  border: 2px solid var(--line);
  border-top-color: var(--signal);
  animation: switchspin 0.9s linear infinite;
  margin-bottom: 4px;
}
@keyframes switchspin { to { transform: rotate(360deg); } }
.switch-tag {
  color: var(--signal);
  font-size: 10px;
  letter-spacing: 0.18em;
  padding: 3px 8px;
  border: 1px solid var(--signal);
  border-radius: 3px;
}
.switch-lead { color: var(--text); font-size: 14px; }
.switch-hint { color: var(--muted); font-size: 12px; max-width: 260px; }

/* mobile: this whole panel becomes the primary view, so it can breathe.
   The parent .col.left flex-grows .screen-view to fill available space; we
   flip the wrap to flex:1 too so the canvas gets that space instead of the
   old fixed min-height. */
@media (max-width: 900px) {
  .screen-view {
    max-height: none;
    min-height: 0;
  }
  .screen-wrap {
    flex: 1;
    min-height: 160px;
    max-height: none;
  }
  .screen-media {
    max-height: none;
    object-fit: contain;
  }
}
/* Landscape phone: video fills the screen, header floats as an overlay
   in the top-right so it doesn't eat any of the video's vertical space. */
@media (max-width: 900px) and (orientation: landscape) {
  .screen-view {
    padding: 0;
    gap: 0;
    position: relative;
  }
  .screen-hdr {
    position: absolute;
    top: 6px;
    right: 6px;
    z-index: 5;
    padding: 4px 8px;
    background: rgba(10, 10, 12, 0.55);
    border-radius: 3px;
    backdrop-filter: blur(4px);
  }
  .screen-tag,
  .screen-owner .mono,
  .screen-owner { font-size: 10px; }
  .screen-wrap {
    flex: 1;
    min-height: 0;
    max-height: none;
    height: 100%;
    border-radius: 0;
    background: #000;
  }
}
</style>
