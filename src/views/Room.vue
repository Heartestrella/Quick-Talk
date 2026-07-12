<script setup>
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useRoom } from '../composables/useRoom.js'
import Participant from '../components/Participant.vue'
import ScreenView from '../components/ScreenView.vue'
import AudioMixer from '../components/AudioMixer.vue'

const route = useRoute()
const router = useRouter()
const roomId = String(route.params.id || '').toUpperCase()

// Landing.vue may pass a room-creator password via history.state.setPassword.
// Read it exactly once, then wipe the state so a refresh doesn't re-register
// (or leak the password into the entry the browser will restore on Back).
const setPasswordFromState = (() => {
  try {
    const s = window.history.state
    const p = s && typeof s.setPassword === 'string' ? s.setPassword : null
    if (p) {
      const clean = { ...s }
      delete clean.setPassword
      window.history.replaceState(clean, '')
    }
    return p
  } catch { return null }
})()

const room = useRoom(roomId, setPasswordFromState ? { setPassword: setPasswordFromState } : {})

// Password prompt (rendered when server returns auth-required).
const pwdInput = ref('')
const pwdBusy = computed(() => room.authState.state === 'checking')
function submitPasswordPrompt() {
  const v = pwdInput.value.trim()
  if (!v) return
  room.submitPassword(v)
  pwdInput.value = ''
}
function cancelPasswordPrompt() {
  router.push('/')
}

// In-room rename — clicking the name in the footer opens a small inline editor.
const renaming = ref(false)
const renameInput = ref('')
const renameInputEl = ref(null)
function startRename() {
  renameInput.value = room.me.name
  renaming.value = true
  nextTick(() => renameInputEl.value?.select())
}
function commitRename() {
  const v = renameInput.value.trim()
  if (v && v !== room.me.name) room.setName(v)
  renaming.value = false
}
function cancelRename() {
  renaming.value = false
}

const chatInput = ref('')
const chatScroller = ref(null)
const copyState = ref('idle')
const shareState = ref('idle')     // 'idle' | 'copied' | 'shared'
const isMobile = ref(false)
const chatCollapsed = ref(false) // only relevant on mobile
const screenMenuOpen = ref(false)
const pendingImage = ref(null)     // { dataUrl, w, h, size } — attached but not sent
const fileInputEl = ref(null)
const lightboxSrc = ref(null)      // dataUrl currently expanded
const disconnectDismissed = ref(false)
const mixerOpen = ref(false)

function toggleMixer() { mixerOpen.value = !mixerOpen.value }
function closeMixerOutside(e) {
  if (!mixerOpen.value) return
  const el = document.querySelector('.mixer-anchor')
  if (el && !el.contains(e.target)) mixerOpen.value = false
}

const RESOLUTIONS = [
  { key: '720p',  label: '720p',  hint: '1280 × 720' },
  { key: '1080p', label: '1080p', hint: '1920 × 1080' },
  { key: '1440p', label: '1440p', hint: '2560 × 1440' },
  { key: '4k',    label: '4K',    hint: '3840 × 2160' },
  { key: 'source', label: '原始',  hint: '不缩放' }
]
const FRAMERATES = [15, 24, 30, 60]
const CODECS = [
  { key: 'auto', label: 'AUTO' },
  { key: 'vp9',  label: 'VP9' },
  { key: 'h264', label: 'H.264' },
  { key: 'vp8',  label: 'VP8' }
]
const BITRATE_LABEL = (b) => {
  if (b < 1) return '省流量 · 720p 够用'
  if (b < 3) return '均衡 · 1080p 可读'
  if (b < 6) return '清晰 · 1080p 流畅'
  return '高清 · 1440p+/高动态'
}

function startScreen() {
  screenMenuOpen.value = false
  room.toggleScreen()
}
function toggleScreenMenu() {
  if (room.me.screenOn) {
    room.toggleScreen()
  } else {
    screenMenuOpen.value = !screenMenuOpen.value
  }
}
function closeScreenMenuOutside(e) {
  if (!screenMenuOpen.value) return
  const menu = document.querySelector('.screen-menu-anchor')
  if (menu && !menu.contains(e.target)) screenMenuOpen.value = false
}
function fmtBytes(n) {
  if (!n) return '0 B/s'
  if (n < 1024) return n + ' B/s'
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB/s'
  return (n / 1024 / 1024).toFixed(2) + ' MB/s'
}

function unlockAllAudio() {
  room.unlockAudio()
}

const formattedCode = computed(() => {
  const c = roomId
  return c.length === 6 ? `${c.slice(0, 3)}·${c.slice(3)}` : c
})

const peerCount = computed(() => room.peers.size + 1)
const statusLabel = computed(() => {
  switch (room.connection.value) {
    case 'connected': return '已连接'
    case 'connecting': return '连接中'
    case 'reconnecting': return '重连中'
    default: return '离线 · 仅本地'
  }
})

// Show a persistent notice only after we've been connected once and then lost
// the socket — initial "connecting" isn't newsworthy.
const disconnectNotice = computed(() => {
  if (disconnectDismissed.value) return null
  if (!room.hasConnectedOnce.value) return null
  const c = room.connection.value
  if (c === 'connected') return null
  if (c === 'reconnecting') {
    const n = room.reconnectAttempt.value
    return {
      tone: 'warn',
      text: n > 0
        ? `与服务器断开 · 第 ${n} 次重连中…`
        : '与服务器断开 · 正在重连…'
    }
  }
  return { tone: 'danger', text: '与服务器失去连接 · 消息与语音将无法发送' }
})

// The moment the connection heals, dismiss the "manually closed" flag so the
// next drop shows a fresh banner.
watch(() => room.connection.value, (c) => {
  if (c === 'connected') disconnectDismissed.value = false
})

// On mobile, when someone starts sharing, expand the chat away so the screen
// gets prime real estate. This flips the chat closed exactly once per share
// event — the user can still tap "展开" to bring it back.
watch(() => room.activeScreenPeerId.value, (id, prev) => {
  if (isMobile.value && id && !prev) chatCollapsed.value = true
})

const activeScreenPeer = computed(() => {
  const id = room.activeScreenPeerId.value
  if (!id) return null
  if (id === 'me') return { id: 'me', name: room.me.name, isSelf: true }
  const p = room.peers.get(id)
  return p ? {
    id: p.id,
    name: p.name,
    isSelf: false,
    rxScreen: p.rxScreen || 0,
    rxScreenAudio: p.rxScreenAudio || 0,
    rxScreenFps: p.rxScreenFps || 0,
    rxTransport: p.rxTransport || ''
  } : null
})

async function copyCode() {
  try {
    await navigator.clipboard.writeText(roomId)
    copyState.value = 'copied'
    setTimeout(() => (copyState.value = 'idle'), 1600)
  } catch {}
}

const shareUrl = computed(() => `${window.location.origin}/room/${roomId}`)

async function shareRoom() {
  const url = shareUrl.value
  const text = `加入我的房间 · Quick Talk\n房间号: ${roomId}\n${url}`
  // Prefer the native share sheet on mobile — one tap gets it into WeChat / iMessage etc.
  if (navigator.share) {
    try {
      await navigator.share({ title: 'Quick Talk 房间', text, url })
      shareState.value = 'shared'
      setTimeout(() => (shareState.value = 'idle'), 1600)
      return
    } catch (err) {
      // user cancelled — fall through to clipboard copy
      if (err?.name === 'AbortError') return
    }
  }
  try {
    await navigator.clipboard.writeText(url)
    shareState.value = 'copied'
    setTimeout(() => (shareState.value = 'idle'), 1600)
  } catch {
    // last-ditch: legacy execCommand
    try {
      const ta = document.createElement('textarea')
      ta.value = url
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
      shareState.value = 'copied'
      setTimeout(() => (shareState.value = 'idle'), 1600)
    } catch {}
  }
}

function send() {
  if (!chatInput.value.trim() && !pendingImage.value) return
  room.sendChat(chatInput.value, pendingImage.value?.dataUrl)
  chatInput.value = ''
  pendingImage.value = null
}

// ---------- image attach + paste ----------
const MAX_IMG_DIM = 1600
const IMG_QUALITY = 0.82

function compressImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('read failed'))
    reader.onload = () => {
      const img = new Image()
      img.onerror = () => reject(new Error('decode failed'))
      img.onload = () => {
        let { width, height } = img
        const scale = Math.min(1, MAX_IMG_DIM / Math.max(width, height))
        width = Math.round(width * scale)
        height = Math.round(height * scale)
        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        const ctx = canvas.getContext('2d')
        ctx.drawImage(img, 0, 0, width, height)
        // gifs and small pngs stay as-is only if already small; otherwise re-encode as jpeg
        const isSmall = file.size < 200 * 1024
        const mime = isSmall && (file.type === 'image/png' || file.type === 'image/gif')
          ? file.type
          : 'image/jpeg'
        const dataUrl = canvas.toDataURL(mime, IMG_QUALITY)
        resolve({ dataUrl, w: width, h: height, size: dataUrl.length })
      }
      img.src = reader.result
    }
    reader.readAsDataURL(file)
  })
}

async function attachFile(file) {
  if (!file || !file.type?.startsWith('image/')) return
  try {
    pendingImage.value = await compressImage(file)
  } catch (e) {
    console.warn('image compress failed', e)
  }
}

function onFileInput(e) {
  const file = e.target.files?.[0]
  e.target.value = ''
  if (file) attachFile(file)
}

function openFilePicker() {
  fileInputEl.value?.click()
}

function onPasteChat(e) {
  const items = e.clipboardData?.items || []
  for (const it of items) {
    if (it.kind === 'file' && it.type.startsWith('image/')) {
      const file = it.getAsFile()
      if (file) {
        e.preventDefault()
        attachFile(file)
        return
      }
    }
  }
}

function clearPendingImage() { pendingImage.value = null }
function openLightbox(src) { lightboxSrc.value = src }
function closeLightbox() { lightboxSrc.value = null }

function leaveRoom() {
  room.leave()
  router.push('/')
}

watch(() => room.messages.length, () => {
  nextTick(() => {
    const el = chatScroller.value
    if (el) el.scrollTop = el.scrollHeight
  })
})

function fmtTime(ts) {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function onResize() {
  isMobile.value = window.innerWidth < 900
}

function onKey(e) {
  if (e.target?.tagName === 'INPUT' || e.target?.tagName === 'TEXTAREA') return
  if (e.key === 'm' || e.key === 'M') room.toggleMic()
  if (e.key === 's' || e.key === 'S') room.toggleScreen()
  if (e.key === 'd' || e.key === 'D') room.toggleDenoise()
}

onMounted(() => {
  onResize()
  window.addEventListener('resize', onResize)
  window.addEventListener('keydown', onKey)
  window.addEventListener('mousedown', closeScreenMenuOutside)
  window.addEventListener('mousedown', closeMixerOutside)
})

watch(() => room.screenOptions.frameRate, () => room.retimeScreen())
watch(() => room.screenOptions.bitrate, () => room.applyBitrate?.())
onUnmounted(() => {
  window.removeEventListener('resize', onResize)
  window.removeEventListener('keydown', onKey)
  window.removeEventListener('mousedown', closeScreenMenuOutside)
  window.removeEventListener('mousedown', closeMixerOutside)
})
</script>

<template>
  <div
    class="room"
    :class="{
      'mobile-chat-open': isMobile && !chatCollapsed,
      'mobile-screen-view': isMobile && !!activeScreenPeer
    }"
  >
    <!-- ===== header ===== -->
    <header class="room-header">
      <div class="hdr-l">
        <span class="live-dot" :class="{ off: room.connection.value !== 'connected' }" aria-hidden="true"></span>
        <span class="hdr-tag mono">ROOM</span>
        <button class="code-pill" @click="copyCode" :title="copyState === 'copied' ? '已复制' : '复制房间号'">
          <span class="code-text">{{ formattedCode }}</span>
          <span class="code-copy mono">{{ copyState === 'copied' ? '已复制' : 'COPY' }}</span>
        </button>
        <button
          class="share-btn"
          :class="{ ok: shareState !== 'idle' }"
          @click="shareRoom"
          :title="'一键分享房间链接'"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="18" cy="5" r="3" />
            <circle cx="6" cy="12" r="3" />
            <circle cx="18" cy="19" r="3" />
            <path d="M8.6 10.5l6.8-4M8.6 13.5l6.8 4" />
          </svg>
          <span class="share-lbl">
            {{ shareState === 'shared' ? '已分享' : shareState === 'copied' ? '链接已复制' : '分享链接' }}
          </span>
        </button>
      </div>
      <div class="hdr-r">
        <span class="hdr-info">
          <span class="mono">{{ peerCount }}</span>
          <span class="hdr-info-lbl">人在线</span>
        </span>
        <span class="hdr-sep">·</span>
        <span class="hdr-info">
          <span class="pip" :class="{ on: room.connection.value === 'connected' }"></span>
          <span class="mono status-text">{{ statusLabel }}</span>
        </span>
        <div class="mixer-anchor">
          <button
            class="mixer-btn"
            :class="{ open: mixerOpen }"
            @click="toggleMixer"
            :title="mixerOpen ? '关闭混音器' : '音量混合器'"
            aria-haspopup="dialog"
            :aria-expanded="mixerOpen"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M4 10v4M4 4v3M4 17v3" />
              <path d="M12 8v10M12 4v2" />
              <path d="M20 14v4M20 4v7" />
              <circle cx="4" cy="12" r="1.6" />
              <circle cx="12" cy="6" r="1.6" />
              <circle cx="20" cy="12.5" r="1.6" />
            </svg>
            <span class="mixer-lbl">音量</span>
          </button>
          <transition name="mixer-pop">
            <div v-if="mixerOpen" class="mixer-panel" @mousedown.stop>
              <AudioMixer
                :master-voice="room.masterVoiceVolume"
                :master-screen="room.masterScreenVolume"
                :peers="room.peers"
                :peer-audio="room.peerAudio"
                :set-peer-voice="room.setPeerVoiceVolume"
                :set-peer-screen="room.setPeerScreenVolume"
                :set-peer-muted="room.setPeerMuted"
                :ensure-peer="room.getPeerAudio"
                @close="mixerOpen = false"
              />
            </div>
          </transition>
        </div>
        <button class="leave-btn" @click="leaveRoom" title="离开房间">
          <span class="leave-icon">↩</span>
          <span>离开</span>
        </button>
      </div>
    </header>

    <!-- ===== stage: left = voice, right = chat ===== -->
    <main class="stage">
      <!-- error toast -->
      <transition name="toast">
        <div v-if="room.errorMsg.value" class="toast">
          <span class="pip on danger"></span>
          <span>{{ room.errorMsg.value }}</span>
        </div>
      </transition>

      <!-- autoplay unlock banner -->
      <transition name="toast">
        <button
          v-if="room.needsAudioUnlock.value"
          class="unlock-banner"
          @click="unlockAllAudio"
        >
          <span class="pip on"></span>
          <span>浏览器阻止了远端音频自动播放</span>
          <span class="unlock-cta mono">点击启用 →</span>
        </button>
      </transition>

      <!-- ws disconnect banner -->
      <transition name="toast">
        <div v-if="disconnectNotice" class="disconnect-banner" :class="disconnectNotice.tone">
          <span class="dc-dot" :class="disconnectNotice.tone" aria-hidden="true"></span>
          <span class="dc-text">{{ disconnectNotice.text }}</span>
          <button
            class="dc-close"
            @click="disconnectDismissed = true"
            title="收起提示"
            aria-label="收起断线提示"
          >×</button>
        </div>
      </transition>

      <!-- HTTPS / secure-context notice — persistent until fixed -->
      <div v-if="!room.isSecure" class="disconnect-banner danger secure-banner">
        <span class="dc-dot danger" aria-hidden="true"></span>
        <span class="dc-text">
          此站点不是 HTTPS · 麦克风 / 屏幕共享已被浏览器禁用
        </span>
      </div>

      <!-- left column -->
      <section class="col left">
        <ScreenView
          v-if="activeScreenPeer"
          :peer="activeScreenPeer"
          :attach-canvas="room.attachScreenCanvas"
          :get-self-stream="room.getSelfScreenStream"
          :decoder-unsupported="room.decoderUnsupported.value"
          :awaiting-codec-switch="room.awaitingCodecSwitch.value"
          :self-tx-screen="room.me.txScreen"
          :self-tx-screen-audio="room.me.txScreenAudio || 0"
          :transport="room.senderTransport.value"
        />

        <div class="col-hdr">
          <span class="mono col-tag">
            <span class="tag-line"></span>
            PARTICIPANTS · 在座 {{ peerCount }}
          </span>
        </div>

        <section class="grid" :class="{ compact: !!activeScreenPeer }">
          <Participant
            :name="room.me.name"
            :subtitle="'你 · SELF'"
            :mic-on="room.me.micOn"
            :screen-on="room.me.screenOn"
            :level="room.me.level"
            :gate-open="room.me.gateOpen"
            :denoise-on="room.me.denoiseOn"
            :self="true"
            :active="room.activeScreenPeerId.value === 'me'"
            @focus-screen="room.focusScreen('me')"
          />
          <Participant
            v-for="p in room.peers.values()"
            :key="p.id"
            :name="p.name"
            :subtitle="p.id.slice(0, 4).toUpperCase()"
            :mic-on="p.micOn"
            :screen-on="p.screenOn"
            :level="p.level"
            :active="room.activeScreenPeerId.value === p.id"
            @focus-screen="room.focusScreen(p.id)"
          />
          <div v-if="room.peers.size === 0" class="empty-seat">
            <div class="empty-frame">
              <div class="empty-dots">
                <span></span><span></span><span></span>
              </div>
              <p class="empty-lead">还没有人加入</p>
              <p class="empty-hint">
                把房间号 <span class="mono empty-code">{{ formattedCode }}</span> 分享给朋友
              </p>
            </div>
          </div>
        </section>
      </section>

      <!-- right column: permanent chat -->
      <aside class="col right chat" :class="{ collapsed: isMobile && chatCollapsed }">
        <div class="chat-hdr">
          <div class="chat-title">
            <span class="live-dot small" aria-hidden="true"></span>
            <span class="mono chat-tag">CHANNEL LOG</span>
            <span class="chat-cn">文字消息</span>
          </div>
          <div class="chat-meta">
            <span class="mono chat-count">{{ room.messages.length }}</span>
            <button v-if="isMobile" class="chat-toggle" @click="chatCollapsed = !chatCollapsed">
              {{ chatCollapsed ? '展开' : '收起' }}
            </button>
          </div>
        </div>

        <div class="chat-body" ref="chatScroller">
          <div v-if="!room.messages.length" class="chat-empty">
            <span class="mono">— 频道日志空 —</span>
            <p>说点什么？这里的消息只在通话中可见。</p>
          </div>

          <template v-else>
            <div v-for="(m, i) in room.messages" :key="m.id" class="msg" :class="{ mine: m.mine }">
              <div v-if="i === 0 || room.messages[i - 1].name !== m.name" class="msg-meta">
                <span class="msg-name">{{ m.mine ? '你' : m.name }}</span>
                <span class="mono msg-time">{{ fmtTime(m.ts) }}</span>
              </div>
              <div v-if="m.image" class="msg-img-wrap" @click="openLightbox(m.image)" :title="'点击查看大图'">
                <img class="msg-img" :src="m.image" alt="图片消息" loading="lazy" />
              </div>
              <div v-if="m.text" class="msg-body">{{ m.text }}</div>
            </div>
          </template>
        </div>

        <form class="chat-input" @submit.prevent="send">
          <div v-if="pendingImage" class="attach-preview">
            <img :src="pendingImage.dataUrl" alt="待发送图片" />
            <div class="attach-meta mono">
              <span>{{ pendingImage.w }}×{{ pendingImage.h }}</span>
              <span>·</span>
              <span>{{ Math.round(pendingImage.size / 1024) }} KB</span>
            </div>
            <button
              type="button"
              class="attach-remove"
              @click="clearPendingImage"
              title="移除图片"
              aria-label="移除图片"
            >×</button>
          </div>
          <div class="input-row">
            <button
              type="button"
              class="attach-btn"
              @click="openFilePicker"
              :title="'附加图片 · 也可直接粘贴'"
              aria-label="附加图片"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <rect x="3" y="4" width="18" height="16" rx="2" />
                <circle cx="9" cy="10" r="1.6" />
                <path d="M3 17l5-5 5 5 3-3 5 5" />
              </svg>
            </button>
            <input
              ref="fileInputEl"
              type="file"
              accept="image/*"
              @change="onFileInput"
              hidden
            />
            <div class="input-wrap">
              <span class="input-prefix mono">›</span>
              <input
                v-model="chatInput"
                placeholder="输入消息 · 可粘贴图片"
                autocomplete="off"
                maxlength="500"
                @paste="onPasteChat"
              />
            </div>
            <button
              type="submit"
              class="chat-send"
              :disabled="!chatInput.trim() && !pendingImage"
              title="发送 (Enter)"
            >
              <span>发送</span>
              <span class="arrow">→</span>
            </button>
          </div>
        </form>
      </aside>
    </main>

    <!-- ===== control bar ===== -->
    <footer class="controls">
      <div class="controls-inner">
        <button class="ctl" :class="{ on: room.me.micOn }" @click="room.toggleMic">
          <span class="ctl-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <rect x="9" y="3" width="6" height="12" rx="3" />
              <path d="M5 11a7 7 0 0 0 14 0" />
              <path d="M12 18v3" />
              <path v-if="!room.me.micOn" d="M4 4l16 16" stroke="var(--danger)" stroke-width="2" />
            </svg>
          </span>
          <span class="ctl-label">
            <span class="ctl-title">{{ room.me.micOn ? '麦克风已开' : '开启麦克风' }}</span>
            <span v-if="room.me.micOn && room.me.txAudio > 0" class="tx-chip mono">↑ {{ fmtBytes(room.me.txAudio) }}</span>
            <span v-else class="ctl-hint mono">M</span>
          </span>
        </button>

        <button
          class="ctl denoise-btn"
          :class="{ on: room.me.denoiseOn, dim: !room.me.micOn }"
          @click="room.toggleDenoise"
          :disabled="!room.me.micOn"
          :title="room.me.denoiseOn ? '降噪已开启（高通+压缩+噪声闸门）' : '降噪已关闭 · 原始信号直传'"
        >
          <span class="ctl-icon">
            <!-- little waveform + shield glyph -->
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6l7-3z" />
              <path d="M8.5 12h1.2l1-2 1.5 4 1-2h2.3" stroke-width="1.5" />
            </svg>
          </span>
          <span class="ctl-label">
            <span class="ctl-title">{{ room.me.denoiseOn ? '降噪 · 开' : '降噪 · 关' }}</span>
            <span class="ctl-hint mono">D</span>
          </span>
          <span v-if="room.me.micOn && room.me.denoiseOn" class="gate-pip" :class="{ on: room.me.gateOpen }" aria-hidden="true"></span>
        </button>

        <div class="screen-menu-anchor">
          <button class="ctl" :class="{ on: room.me.screenOn }" @click="toggleScreenMenu">
            <span class="ctl-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <rect x="2.5" y="4" width="19" height="13" rx="2" />
                <path d="M8 21h8" />
                <path d="M12 17v4" />
                <path v-if="room.me.screenOn" d="M12 8v5M9.5 10.5L12 8l2.5 2.5" />
              </svg>
            </span>
            <span class="ctl-label">
              <span class="ctl-title">{{ room.me.screenOn ? '停止共享' : '共享屏幕' }}</span>
              <span v-if="room.me.screenOn && room.me.txScreen > 0" class="tx-chip mono" :title="room.codecInfo.value">
                ↑ {{ fmtBytes(room.me.txScreen) }}
              </span>
              <span v-else class="ctl-hint mono">S</span>
            </span>
          </button>
          <div v-if="room.me.screenOn && room.codecInfo.value" class="codec-tag mono">
            {{ room.codecInfo.value }}
          </div>

          <transition name="pop">
            <div v-if="screenMenuOpen && !room.me.screenOn" class="screen-menu">
              <div class="menu-hdr mono">SCREEN SHARE · 参数</div>

              <div class="menu-row">
                <span class="menu-lbl">分辨率</span>
                <div class="chip-group">
                  <button
                    v-for="r in RESOLUTIONS"
                    :key="r.key"
                    class="chip"
                    :class="{ on: room.screenOptions.resolution === r.key }"
                    @click="room.screenOptions.resolution = r.key"
                    :title="r.hint"
                  >
                    <span>{{ r.label }}</span>
                    <span class="chip-hint mono">{{ r.hint }}</span>
                  </button>
                </div>
              </div>

              <div class="menu-row">
                <span class="menu-lbl">帧率</span>
                <div class="chip-group">
                  <button
                    v-for="f in FRAMERATES"
                    :key="f"
                    class="chip fps"
                    :class="{ on: room.screenOptions.frameRate === f }"
                    @click="room.screenOptions.frameRate = f"
                  >
                    <span class="mono">{{ f }}</span>
                    <span class="chip-hint mono">fps</span>
                  </button>
                </div>
              </div>

              <div class="menu-row">
                <span class="menu-lbl">编码器</span>
                <div class="chip-group">
                  <button
                    v-for="c in CODECS"
                    :key="c.key"
                    class="chip fps"
                    :class="{ on: room.screenOptions.codec === c.key }"
                    @click="room.screenOptions.codec = c.key"
                  >
                    <span class="mono">{{ c.label }}</span>
                  </button>
                </div>
              </div>

              <div class="menu-row">
                <span class="menu-lbl">声音</span>
                <div class="chip-group">
                  <button
                    class="chip fps"
                    :class="{ on: !room.screenOptions.shareAudio }"
                    @click="room.screenOptions.shareAudio = false"
                  >
                    <span class="mono">不共享</span>
                  </button>
                  <button
                    class="chip fps"
                    :class="{ on: room.screenOptions.shareAudio }"
                    @click="room.screenOptions.shareAudio = true"
                    :title="'需要在浏览器面板里勾选“共享标签页音频”'"
                  >
                    <span class="mono">共享系统 / 标签声音</span>
                  </button>
                </div>
              </div>

              <div class="menu-row col">
                <div class="row-hdr">
                  <span class="menu-lbl no-fixed">带宽上限 <span class="drag-hint mono">← 拖 →</span></span>
                  <span class="quality-val mono">{{ room.screenOptions.bitrate.toFixed(1) }} Mbps · {{ BITRATE_LABEL(room.screenOptions.bitrate) }}</span>
                </div>
                <div class="slider-wrap">
                  <span class="scale-lo mono">0.5</span>
                  <div class="slider-track" :style="{ '--fill': ((room.screenOptions.bitrate - 0.5) / 11.5 * 100) + '%' }">
                    <input
                      type="range"
                      min="0.5"
                      max="12"
                      step="0.5"
                      v-model.number="room.screenOptions.bitrate"
                      class="quality-slider"
                    />
                    <div class="tick-marks" aria-hidden="true">
                      <span v-for="n in 24" :key="n" class="tick"></span>
                    </div>
                  </div>
                  <span class="scale-hi mono">12 Mbps</span>
                </div>
              </div>

              <div class="menu-note mono">
                硬件加速 · 帧间压缩 · 服务器中转 · 新人加入自动补关键帧
              </div>

              <div class="menu-foot">
                <button class="menu-cancel" @click="screenMenuOpen = false">取消</button>
                <button class="menu-go" @click="startScreen">
                  开始共享 <span class="arrow">→</span>
                </button>
              </div>
            </div>
          </transition>
        </div>

        <div class="ctl-spacer"></div>

        <div class="ctl-you" :class="{ editing: renaming }">
          <span class="mono">YOU</span>
          <template v-if="!renaming">
            <button
              class="ctl-you-name btn-rename"
              @click="startRename"
              :title="'点击改名'"
            >
              {{ room.me.name }}
              <span class="rename-pencil" aria-hidden="true">✎</span>
            </button>
          </template>
          <template v-else>
            <input
              ref="renameInputEl"
              v-model="renameInput"
              class="rename-input"
              maxlength="24"
              spellcheck="false"
              @keydown.enter.prevent="commitRename"
              @keydown.esc.prevent="cancelRename"
              @blur="commitRename"
              aria-label="修改名字"
            />
          </template>
          <span class="live-mini" :class="{ on: room.me.micOn && room.me.level > 0.05 }"></span>
        </div>
      </div>
    </footer>

    <!-- password prompt (server said auth-required) -->
    <transition name="toast">
      <div
        v-if="room.authState.state === 'prompting' || room.authState.state === 'checking'"
        class="pwd-veil"
      >
        <form class="pwd-dialog" @submit.prevent="submitPasswordPrompt">
          <div class="pwd-hdr">
            <span class="mono pwd-tag">ROOM · 密码保护</span>
            <span class="mono pwd-code">{{ formattedCode }}</span>
          </div>
          <p class="pwd-lead">
            <span v-if="room.authState.reason === 'wrong'" class="pwd-err">
              密码不正确 · 请重试
            </span>
            <span v-else>
              这个房间设有密码 · 请输入以进入
            </span>
          </p>
          <input
            v-model="pwdInput"
            type="password"
            class="pwd-input"
            placeholder="房间密码"
            autocomplete="off"
            spellcheck="false"
            :disabled="pwdBusy"
            autofocus
            aria-label="房间密码"
          />
          <div class="pwd-foot">
            <button
              type="button"
              class="pwd-cancel"
              @click="cancelPasswordPrompt"
              :disabled="pwdBusy"
            >
              返回
            </button>
            <button
              type="submit"
              class="pwd-go"
              :disabled="pwdBusy || !pwdInput.trim()"
            >
              <span v-if="!pwdBusy">进入 <span class="arrow">→</span></span>
              <span v-else>验证中…</span>
            </button>
          </div>
        </form>
      </div>
    </transition>

    <!-- image lightbox -->
    <transition name="toast">
      <div v-if="lightboxSrc" class="lightbox" @click="closeLightbox">
        <img :src="lightboxSrc" alt="图片放大" @click.stop />
        <button class="lightbox-close" @click="closeLightbox" aria-label="关闭">×</button>
      </div>
    </transition>
  </div>
</template>

<style scoped>
.room {
  height: 100%;
  display: grid;
  grid-template-rows: auto 1fr auto;
  background:
    radial-gradient(1400px 800px at 10% 10%, rgba(242, 169, 59, 0.04), transparent 60%),
    radial-gradient(900px 600px at 90% 90%, rgba(74, 141, 168, 0.05), transparent 60%),
    var(--bg);
  position: relative;
  overflow: hidden;
}

/* ============= header ============= */
.room-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 24px;
  border-bottom: 1px solid var(--line-soft);
  min-height: 56px;
  gap: 12px;
  flex-wrap: wrap;
}
.hdr-l, .hdr-r { display: flex; align-items: center; gap: 12px; }

.hdr-tag {
  color: var(--muted);
  font-size: 10px;
  letter-spacing: 0.16em;
}

.live-dot {
  width: 8px; height: 8px;
  border-radius: 50%;
  background: var(--signal);
  box-shadow: 0 0 0 3px var(--signal-soft), 0 0 10px var(--signal-glow);
  animation: pulse 1.6s infinite var(--ease);
}
.live-dot.small { width: 6px; height: 6px; box-shadow: 0 0 0 2px var(--signal-soft), 0 0 8px var(--signal-glow); }
.live-dot.off {
  background: var(--muted);
  box-shadow: none;
  animation: none;
}
@keyframes pulse {
  0%, 100% { box-shadow: 0 0 0 3px var(--signal-soft), 0 0 8px var(--signal-glow); }
  50% { box-shadow: 0 0 0 6px transparent, 0 0 16px var(--signal); }
}

.code-pill {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border: 1px solid var(--line);
  border-radius: 4px;
  background: var(--panel);
  transition: border-color 160ms var(--ease), background 160ms var(--ease);
}
.code-pill:hover {
  border-color: var(--signal);
  background: var(--panel-2);
}
.code-text {
  font-family: var(--font-mono);
  font-size: 15px;
  font-weight: 500;
  color: var(--signal-hot);
  letter-spacing: 0.12em;
}
.code-copy {
  color: var(--muted);
  font-size: 10px;
  letter-spacing: 0.16em;
  padding-left: 8px;
  border-left: 1px solid var(--line);
}

.hdr-info {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--text-2);
  font-size: 13px;
}
.hdr-info-lbl { color: var(--muted); font-size: 12px; }
.hdr-info .mono { color: var(--text); font-size: 14px; }
.hdr-sep { color: var(--dim); }
.status-text { color: var(--muted); font-size: 11px; }

.pip {
  width: 6px; height: 6px;
  border-radius: 50%;
  background: var(--dim);
}
.pip.on { background: var(--ok); box-shadow: 0 0 6px var(--ok); }
.pip.on.danger { background: var(--danger); box-shadow: 0 0 6px var(--danger); }

.leave-btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  border: 1px solid var(--line);
  border-radius: 4px;
  color: var(--text-2);
  font-size: 13px;
  transition: color 160ms var(--ease), border-color 160ms var(--ease), background 160ms var(--ease);
  margin-left: 6px;
}
.leave-btn:hover {
  color: var(--danger);
  border-color: var(--danger);
  background: var(--danger-soft);
}
.leave-icon { font-family: var(--font-mono); font-size: 15px; }

/* share button — sits next to the code pill in the header */
.share-btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border: 1px solid var(--line);
  border-radius: 4px;
  color: var(--text-2);
  background: var(--panel);
  font-size: 12px;
  transition: color 160ms var(--ease), border-color 160ms var(--ease), background 160ms var(--ease);
}
.share-btn svg { width: 15px; height: 15px; }
.share-btn:hover {
  color: var(--signal);
  border-color: var(--signal);
  background: var(--panel-2);
}
.share-btn.ok {
  color: var(--ok);
  border-color: var(--ok);
  background: rgba(125, 190, 114, 0.08);
}
@media (max-width: 520px) {
  .share-btn .share-lbl { display: none; }
  .share-btn { padding: 8px 10px; }
}

/* ============= mixer button + panel ============= */
.mixer-anchor { position: relative; }
.mixer-btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border: 1px solid var(--line);
  border-radius: 4px;
  color: var(--text-2);
  background: var(--panel);
  font-size: 12px;
  transition: color 160ms var(--ease), border-color 160ms var(--ease), background 160ms var(--ease);
}
.mixer-btn svg { width: 15px; height: 15px; }
.mixer-btn:hover,
.mixer-btn.open {
  color: var(--cool);
  border-color: var(--cool);
  background: var(--panel-2);
}
.mixer-panel {
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  z-index: 40;
}
.mixer-pop-enter-active,
.mixer-pop-leave-active {
  transition: opacity 160ms var(--ease), transform 160ms var(--ease);
}
.mixer-pop-enter-from,
.mixer-pop-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}
@media (max-width: 520px) {
  .mixer-btn .mixer-lbl { display: none; }
  .mixer-btn { padding: 8px 10px; }
  .mixer-panel { right: -6px; }
}

/* ============= disconnect banner ============= */
.disconnect-banner {
  position: absolute;
  top: 12px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 30;
  display: inline-flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px 10px 16px;
  border: 1px solid var(--signal);
  background: var(--panel-hi);
  color: var(--text);
  border-radius: 4px;
  font-size: 13px;
  box-shadow: 0 12px 30px -8px rgba(0, 0, 0, 0.6);
  max-width: min(92vw, 520px);
}
.disconnect-banner.warn { border-color: var(--signal); }
.disconnect-banner.danger { border-color: var(--danger); }
.dc-dot {
  width: 8px; height: 8px;
  border-radius: 50%;
  background: var(--signal);
  box-shadow: 0 0 8px var(--signal);
  animation: pulse 1.4s infinite var(--ease);
  flex-shrink: 0;
}
.dc-dot.danger { background: var(--danger); box-shadow: 0 0 8px var(--danger); }
.dc-text { flex: 1; }
.dc-close {
  color: var(--muted);
  font-size: 18px;
  padding: 0 4px;
  line-height: 1;
  transition: color 160ms var(--ease);
}
.dc-close:hover { color: var(--text); }

/* ============= two-column stage ============= */
.stage {
  position: relative;
  display: grid;
  grid-template-columns: 1fr minmax(340px, 400px);
  gap: 0;
  overflow: hidden;
  min-height: 0;
}

@media (max-width: 900px) {
  .stage {
    grid-template-columns: 1fr;
    grid-template-rows: 1fr auto;
  }
}

.col {
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
}

.col.left {
  padding: 24px 32px 24px 32px;
  overflow-y: auto;
  gap: 18px;
}
@media (max-width: 900px) {
  .col.left { padding: 18px 18px 12px; }
}

.col-hdr { display: flex; align-items: center; justify-content: space-between; }
.col-tag {
  color: var(--muted);
  font-size: 10px;
  letter-spacing: 0.16em;
  display: inline-flex;
  align-items: center;
  gap: 10px;
}
.tag-line {
  display: inline-block;
  width: 24px; height: 1px;
  background: var(--line);
}

.toast {
  position: absolute;
  top: 12px;
  left: 50%;
  transform: translateX(-50%);
  background: var(--panel-hi);
  border: 1px solid var(--danger);
  color: var(--text);
  padding: 10px 16px;
  border-radius: 4px;
  font-size: 13px;
  display: flex;
  align-items: center;
  gap: 10px;
  z-index: 30;
  box-shadow: 0 12px 30px -8px rgba(0, 0, 0, 0.6);
}
.toast-enter-active, .toast-leave-active { transition: all 240ms var(--ease); }
.toast-enter-from, .toast-leave-to { opacity: 0; transform: translate(-50%, -8px); }

/* ============ autoplay unlock banner ============ */
.unlock-banner {
  position: absolute;
  top: 12px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 30;
  display: inline-flex;
  align-items: center;
  gap: 12px;
  padding: 10px 18px;
  border: 1px solid var(--signal);
  background: var(--panel-hi);
  color: var(--text);
  border-radius: 4px;
  font-size: 13px;
  cursor: pointer;
  box-shadow: 0 12px 30px -8px rgba(0, 0, 0, 0.6), 0 0 0 3px var(--signal-soft);
  transition: transform 160ms var(--ease);
}
.unlock-banner:hover { transform: translate(-50%, -1px); }
.unlock-cta { color: var(--signal); font-size: 11px; letter-spacing: 0.14em; }

/* ============ screen-share options popover ============ */
.screen-menu-anchor { position: relative; }
.screen-menu {
  position: absolute;
  bottom: calc(100% + 10px);
  left: 0;
  z-index: 40;
  min-width: 320px;
  max-width: 380px;
  background: var(--panel-hi);
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 14px 16px 12px;
  box-shadow: 0 24px 50px -12px rgba(0, 0, 0, 0.7), 0 0 0 1px rgba(255, 255, 255, 0.02) inset;
}
.screen-menu::after {
  content: '';
  position: absolute;
  bottom: -5px;
  left: 26px;
  width: 10px; height: 10px;
  background: var(--panel-hi);
  border-right: 1px solid var(--line);
  border-bottom: 1px solid var(--line);
  transform: rotate(45deg);
}

.menu-hdr {
  color: var(--signal);
  font-size: 10px;
  letter-spacing: 0.16em;
  margin-bottom: 12px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--line-soft);
}

.menu-row {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 8px 0;
}
.menu-lbl {
  flex: 0 0 52px;
  color: var(--text-2);
  font-size: 12px;
  padding-top: 6px;
}
.chip-group {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  flex: 1;
}
.chip {
  display: inline-flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  padding: 6px 10px;
  border: 1px solid var(--line);
  border-radius: 3px;
  background: var(--panel);
  color: var(--text-2);
  font-size: 12px;
  transition: all 140ms var(--ease);
  min-width: 62px;
}
.chip:hover {
  color: var(--text);
  border-color: var(--line-soft);
  background: var(--panel-2);
}
.chip.on {
  color: var(--signal-hot);
  border-color: var(--signal);
  background: linear-gradient(180deg, rgba(242, 169, 59, 0.1), transparent), var(--panel-2);
}
.chip-hint { color: var(--muted); font-size: 9px; letter-spacing: 0.1em; }
.chip.on .chip-hint { color: var(--signal-hot); opacity: 0.85; }
.chip.fps { flex-direction: row; align-items: baseline; gap: 4px; min-width: 0; padding: 8px 12px; }
.chip.fps .mono { font-size: 15px; font-weight: 500; }

.menu-row.col { flex-direction: column; align-items: stretch; gap: 10px; }
.row-hdr { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; }
.menu-lbl.no-fixed { flex: initial; padding-top: 0; display: inline-flex; align-items: center; gap: 8px; }
.drag-hint {
  color: var(--muted);
  font-size: 9px;
  padding: 1px 6px;
  border: 1px solid var(--line);
  border-radius: 3px;
  letter-spacing: 0.14em;
}
.quality-val {
  color: var(--signal-hot);
  font-size: 11px;
  letter-spacing: 0.1em;
  text-align: right;
}

.slider-wrap {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 4px 2px 8px;
}
.scale-lo, .scale-hi {
  color: var(--muted);
  font-size: 10px;
  letter-spacing: 0.08em;
  flex: 0 0 auto;
  white-space: nowrap;
}

/* the track has a filled portion driven by the --fill CSS var */
.slider-track {
  position: relative;
  flex: 1;
  height: 22px;
  border-radius: 11px;
  background: linear-gradient(
    to right,
    var(--signal) 0%,
    var(--signal) var(--fill, 0%),
    var(--panel-hi) var(--fill, 0%),
    var(--panel-hi) 100%
  );
  border: 1px solid var(--line);
  cursor: grab;
  overflow: hidden;
  transition: box-shadow 160ms var(--ease);
}
.slider-track:hover { box-shadow: 0 0 0 2px var(--signal-soft); }
.slider-track:active { cursor: grabbing; }

.tick-marks {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 8px;
  pointer-events: none;
}
.tick {
  width: 1px;
  height: 6px;
  background: rgba(0, 0, 0, 0.35);
}

/* native range input sits invisibly on top for interaction */
.quality-slider {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  margin: 0;
  padding: 0;
  -webkit-appearance: none;
  appearance: none;
  background: transparent;
  outline: none;
  cursor: grab;
}
.quality-slider:active { cursor: grabbing; }

.quality-slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 28px;
  height: 28px;
  border-radius: 4px;
  background: var(--signal);
  border: 1px solid var(--signal-hot);
  box-shadow: 0 0 0 3px var(--signal-soft), 0 3px 8px rgba(0, 0, 0, 0.5);
  cursor: grab;
  transition: transform 100ms var(--ease), box-shadow 100ms var(--ease);
}
.quality-slider::-webkit-slider-thumb:hover {
  transform: scale(1.08);
  box-shadow: 0 0 0 4px var(--signal-glow), 0 4px 12px rgba(0, 0, 0, 0.55);
}
.quality-slider::-webkit-slider-thumb:active { transform: scale(1.02); }

.quality-slider::-moz-range-thumb {
  width: 28px;
  height: 28px;
  border-radius: 4px;
  background: var(--signal);
  border: 1px solid var(--signal-hot);
  box-shadow: 0 0 0 3px var(--signal-soft), 0 3px 8px rgba(0, 0, 0, 0.5);
  cursor: grab;
}
.quality-slider::-moz-range-track { background: transparent; }
.menu-note {
  color: var(--muted);
  font-size: 10px;
  letter-spacing: 0.08em;
  padding: 6px 8px;
  margin-top: 6px;
  background: var(--bg-deep);
  border-radius: 3px;
  border-left: 2px solid var(--cool);
}

.menu-foot {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid var(--line-soft);
}
.menu-cancel {
  padding: 8px 14px;
  color: var(--text-2);
  border: 1px solid var(--line);
  border-radius: 3px;
  font-size: 12px;
}
.menu-cancel:hover { color: var(--text); border-color: var(--line-soft); background: var(--panel-2); }
.menu-go {
  padding: 8px 16px;
  background: var(--signal);
  color: #1A1200;
  border-radius: 3px;
  font-weight: 600;
  font-size: 12px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.menu-go:hover { background: var(--signal-hot); }
.menu-go .arrow { font-family: var(--font-mono); }

.pop-enter-active, .pop-leave-active { transition: opacity 180ms var(--ease), transform 180ms var(--ease); }
.pop-enter-from, .pop-leave-to { opacity: 0; transform: translateY(6px); }

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 20px 18px;
  align-content: start;
  padding: 4px 2px;
}
.grid.compact {
  grid-template-columns: repeat(auto-fill, minmax(176px, 1fr));
  gap: 18px 16px;
}

.empty-seat {
  grid-column: 1 / -1;
  display: grid;
  place-items: center;
  padding: 40px 20px;
}
.empty-frame {
  max-width: 380px;
  text-align: center;
  padding: 30px 24px;
  border: 1px dashed var(--line);
  border-radius: 6px;
  color: var(--text-2);
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.01), transparent);
}
.empty-dots {
  display: flex;
  justify-content: center;
  gap: 8px;
  margin-bottom: 16px;
}
.empty-dots span {
  width: 8px; height: 8px;
  border-radius: 50%;
  background: var(--dim);
  animation: emptyPulse 1.4s infinite var(--ease);
}
.empty-dots span:nth-child(2) { animation-delay: 0.2s; }
.empty-dots span:nth-child(3) { animation-delay: 0.4s; }
@keyframes emptyPulse {
  0%, 100% { background: var(--dim); }
  50% { background: var(--signal); box-shadow: 0 0 8px var(--signal-glow); }
}
.empty-lead { color: var(--text); font-size: 15px; margin-bottom: 6px; }
.empty-hint { color: var(--muted); font-size: 13px; }
.empty-code {
  color: var(--signal-hot);
  padding: 2px 8px;
  background: var(--panel);
  border-radius: 3px;
  letter-spacing: 0.14em;
}

/* ============= permanent chat column ============= */
.chat {
  border-left: 1px solid var(--line-soft);
  background:
    linear-gradient(180deg, rgba(255, 255, 255, 0.015), transparent 30%),
    var(--bg);
  display: grid;
  grid-template-rows: auto 1fr auto;
  min-height: 0;
}
@media (max-width: 900px) {
  .chat {
    border-left: none;
    border-top: 1px solid var(--line-soft);
    max-height: 45vh;
  }
  .chat.collapsed { max-height: 46px; overflow: hidden; }
  .chat.collapsed .chat-body,
  .chat.collapsed .chat-input { display: none; }
}

/* ============= mobile with an active screen share =============
   Give the video the whole left column — hide the participant strip
   and let the ScreenView flex to fill. Chat stays but starts collapsed. */
@media (max-width: 900px) {
  .room.mobile-screen-view .col.left {
    padding: 8px 8px 4px;
    gap: 6px;
  }
  .room.mobile-screen-view .col-hdr,
  .room.mobile-screen-view .grid {
    display: none;
  }
  .room.mobile-screen-view .screen-view {
    flex: 1;
    padding: 6px;
  }
}

/* Landscape mobile with active screen — the video is THE view.
   Rip .room out of its grid, let the video fill 100dvh, and float
   header / controls / chat as overlays that don't steal any pixels. */
@media (max-width: 900px) and (orientation: landscape) {
  .room.mobile-screen-view {
    display: block;
    height: 100vh;
    height: 100dvh;
    position: relative;
    overflow: hidden;
  }
  .room.mobile-screen-view .room-header {
    position: absolute;
    top: 0; left: 0; right: 0;
    z-index: 20;
    padding: 4px 10px;
    min-height: 0;
    border: none;
    background: linear-gradient(180deg, rgba(10,10,12,0.55), transparent);
  }
  .room.mobile-screen-view .hdr-info-lbl,
  .room.mobile-screen-view .code-copy,
  .room.mobile-screen-view .share-lbl,
  .room.mobile-screen-view .status-text,
  .room.mobile-screen-view .hdr-sep {
    display: none;
  }
  .room.mobile-screen-view .stage {
    position: absolute;
    inset: 0;
    display: block;
  }
  .room.mobile-screen-view .col.left {
    height: 100vh;
    height: 100dvh;
    width: 100vw;
    padding: 0;
    overflow: hidden;
  }
  /* ScreenView (child component root) — carries the .room data-v scope, so
     this selector reaches it. Everything nested inside ScreenView is styled
     inside ScreenView.vue via its own landscape media query. */
  .room.mobile-screen-view .screen-view {
    height: 100vh;
    height: 100dvh;
    max-height: none;
    border: none;
    border-radius: 0;
    padding: 0;
    background: #000;
  }
  .room.mobile-screen-view .controls {
    position: absolute;
    bottom: 46px;
    left: 0; right: 0;
    z-index: 14;
    padding: 4px 8px;
    background: linear-gradient(0deg, rgba(10,10,12,0.65), transparent);
    border: none;
  }
  .room.mobile-screen-view .ctl-label { font-size: 11px; }
  .room.mobile-screen-view .ctl-hint,
  .room.mobile-screen-view .ctl-you { display: none; }
  .room.mobile-screen-view .chat {
    position: absolute;
    bottom: 0; left: 0; right: 0;
    z-index: 15;
    max-height: 46px;
    background: rgba(15, 15, 18, 0.88);
    backdrop-filter: blur(6px);
    border-top: 1px solid var(--line-soft);
  }
  .room.mobile-screen-view .chat:not(.collapsed) {
    max-height: 60vh;
  }
}

.chat-hdr {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 20px;
  border-bottom: 1px solid var(--line-soft);
  min-height: 46px;
}
.chat-title { display: inline-flex; align-items: center; gap: 10px; }
.chat-tag { color: var(--signal); font-size: 11px; letter-spacing: 0.14em; }
.chat-cn { color: var(--muted); font-size: 12px; }
.chat-meta { display: inline-flex; align-items: center; gap: 10px; }
.chat-count {
  color: var(--muted);
  font-size: 10px;
  letter-spacing: 0.12em;
  padding: 2px 8px;
  border: 1px solid var(--line);
  border-radius: 3px;
}
.chat-toggle {
  padding: 4px 10px;
  border: 1px solid var(--line);
  border-radius: 3px;
  color: var(--text-2);
  font-size: 11px;
}
.chat-toggle:hover { color: var(--signal); border-color: var(--signal); }

.chat-body {
  overflow-y: auto;
  padding: 20px 20px 24px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 0;
}
.chat-empty {
  color: var(--muted);
  text-align: center;
  padding: 40px 12px;
  border: 1px dashed var(--line);
  border-radius: 4px;
  margin: auto 0;
}
.chat-empty .mono { display: block; margin-bottom: 8px; letter-spacing: 0.12em; }

.msg {
  display: flex;
  flex-direction: column;
  gap: 3px;
  max-width: 90%;
  align-self: flex-start;
}
.msg.mine { align-self: flex-end; align-items: flex-end; }
.msg-meta {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 12px;
  margin-top: 6px;
  margin-bottom: 2px;
}
.msg-name { color: var(--text-2); }
.msg.mine .msg-name { color: var(--signal); }
.msg-time { color: var(--muted); font-size: 10px; letter-spacing: 0.08em; }
.msg-body {
  padding: 8px 12px;
  border-radius: 4px;
  background: var(--panel-2);
  color: var(--text);
  font-size: 14px;
  line-height: 1.55;
  word-break: break-word;
  border: 1px solid var(--line-soft);
}
.msg.mine .msg-body {
  background: linear-gradient(180deg, rgba(242, 169, 59, 0.08), transparent), var(--panel-2);
  border-color: var(--signal-glow);
}

.msg-img-wrap {
  border: 1px solid var(--line-soft);
  border-radius: 4px;
  overflow: hidden;
  cursor: zoom-in;
  background: var(--bg-deep);
  max-width: 260px;
  transition: border-color 160ms var(--ease);
}
.msg.mine .msg-img-wrap { border-color: var(--signal-glow); }
.msg-img-wrap:hover { border-color: var(--signal); }
.msg-img {
  display: block;
  width: 100%;
  height: auto;
  max-height: 260px;
  object-fit: contain;
}

.chat-input {
  display: flex;
  flex-direction: column;
  padding: 12px 14px 14px;
  border-top: 1px solid var(--line-soft);
  gap: 10px;
  background: var(--panel);
}
.input-row {
  display: flex;
  gap: 10px;
  align-items: center;
}
.input-wrap {
  flex: 1;
  display: flex;
  align-items: center;
  padding: 8px 12px;
  border: 1px solid var(--line);
  border-radius: 4px;
  background: var(--panel-2);
  transition: border-color 160ms var(--ease);
}
.input-wrap:focus-within { border-color: var(--signal); }
.input-prefix { color: var(--signal); font-weight: 700; margin-right: 8px; }
.input-wrap input {
  flex: 1;
  font-size: 14px;
  color: var(--text);
}
.input-wrap input::placeholder { color: var(--muted); }
.chat-send {
  padding: 10px 14px;
  border-radius: 4px;
  background: var(--signal);
  color: #1A1200;
  font-weight: 600;
  font-size: 13px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  transition: transform 160ms var(--ease), background 160ms var(--ease), opacity 160ms var(--ease);
}
.chat-send:hover:not(:disabled) { background: var(--signal-hot); }
.chat-send:disabled { opacity: 0.35; cursor: not-allowed; }
.chat-send .arrow { font-family: var(--font-mono); }

/* attach image button + preview */
.attach-btn {
  width: 38px; height: 38px;
  border: 1px solid var(--line);
  border-radius: 4px;
  background: var(--panel-2);
  color: var(--text-2);
  display: grid;
  place-items: center;
  transition: color 140ms var(--ease), border-color 140ms var(--ease), background 140ms var(--ease);
  flex-shrink: 0;
}
.attach-btn:hover {
  color: var(--signal);
  border-color: var(--signal);
  background: var(--panel-hi);
}
.attach-btn svg { width: 18px; height: 18px; }

.attach-preview {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 10px;
  padding: 6px 40px 6px 6px;
  border: 1px dashed var(--signal-glow);
  border-radius: 4px;
  background: linear-gradient(180deg, rgba(242, 169, 59, 0.06), transparent), var(--panel-2);
  align-self: flex-start;
  max-width: 100%;
}
.attach-preview img {
  width: 56px;
  height: 56px;
  object-fit: cover;
  border-radius: 3px;
  border: 1px solid var(--line-soft);
}
.attach-meta {
  color: var(--muted);
  font-size: 10px;
  letter-spacing: 0.08em;
  display: inline-flex;
  gap: 4px;
  white-space: nowrap;
}
.attach-remove {
  position: absolute;
  top: 4px;
  right: 6px;
  width: 22px;
  height: 22px;
  line-height: 1;
  border-radius: 50%;
  color: var(--muted);
  font-size: 18px;
  transition: color 140ms var(--ease), background 140ms var(--ease);
}
.attach-remove:hover { color: var(--danger); background: var(--danger-soft); }

/* ============= lightbox ============= */
.lightbox {
  position: fixed;
  inset: 0;
  background: rgba(6, 6, 8, 0.9);
  backdrop-filter: blur(6px);
  z-index: 100;
  display: grid;
  place-items: center;
  cursor: zoom-out;
  padding: 32px;
}
.lightbox img {
  max-width: 100%;
  max-height: 100%;
  border: 1px solid var(--line);
  border-radius: 4px;
  box-shadow: 0 24px 60px -12px rgba(0, 0, 0, 0.8);
  cursor: default;
}
.lightbox-close {
  position: absolute;
  top: 22px;
  right: 26px;
  width: 40px;
  height: 40px;
  border-radius: 50%;
  color: var(--text);
  font-size: 22px;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid var(--line);
  transition: background 160ms var(--ease), color 160ms var(--ease);
}
.lightbox-close:hover { background: var(--danger-soft); color: var(--danger); }

/* ============= controls ============= */
.controls {
  border-top: 1px solid var(--line-soft);
  padding: 14px 24px;
  background: linear-gradient(180deg, transparent, rgba(0, 0, 0, 0.15));
}
.controls-inner {
  display: flex;
  align-items: center;
  gap: 10px;
  max-width: 1600px;
  margin: 0 auto;
}
.ctl-spacer { flex: 1; }

.ctl {
  display: inline-flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  border: 1px solid var(--line);
  border-radius: 4px;
  background: var(--panel);
  color: var(--text-2);
  transition: all 160ms var(--ease);
  position: relative;
}
.ctl:hover:not(:disabled) {
  color: var(--text);
  border-color: var(--line-soft);
  background: var(--panel-2);
}
.ctl:disabled { opacity: 0.4; cursor: not-allowed; }
.ctl.dim { opacity: 0.6; }
.ctl.on {
  color: var(--signal-hot);
  border-color: var(--signal);
  background: linear-gradient(180deg, rgba(242, 169, 59, 0.08), transparent), var(--panel-2);
  box-shadow: 0 0 0 1px var(--signal-soft), 0 0 16px -6px var(--signal-glow);
}
.ctl-icon {
  width: 22px; height: 22px;
  display: grid; place-items: center;
}
.ctl-icon svg { width: 22px; height: 22px; }
.ctl-label {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
}
.ctl-title { display: inline-flex; align-items: center; gap: 8px; }
.ctl-hint {
  color: var(--muted);
  font-size: 10px;
  padding: 2px 6px;
  border: 1px solid var(--line);
  border-radius: 3px;
}
.ctl.on .ctl-hint { color: var(--signal-hot); border-color: var(--signal-glow); }
.tx-chip {
  color: var(--cool);
  font-size: 10px;
  padding: 2px 6px;
  border: 1px solid var(--cool-soft);
  border-radius: 3px;
  letter-spacing: 0.06em;
}
.ctl.on .tx-chip { color: var(--signal); border-color: var(--signal-glow); }
.codec-tag {
  position: absolute;
  bottom: -18px;
  left: 0;
  color: var(--muted);
  font-size: 9px;
  letter-spacing: 0.08em;
  white-space: nowrap;
  pointer-events: none;
}
.screen-menu-anchor { position: relative; }

.gate-pip {
  position: absolute;
  top: 6px;
  right: 6px;
  width: 5px; height: 5px;
  border-radius: 50%;
  background: var(--dim);
  transition: background 120ms var(--ease), box-shadow 120ms var(--ease);
}
.gate-pip.on {
  background: var(--signal);
  box-shadow: 0 0 6px var(--signal);
}

.ctl-you {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  border: 1px solid var(--line);
  border-radius: 4px;
  background: var(--panel);
  color: var(--text-2);
  font-size: 13px;
}
.ctl-you .mono { color: var(--muted); font-size: 10px; letter-spacing: 0.16em; }
.ctl-you-name { color: var(--text); font-family: var(--font-mono); font-size: 12px; letter-spacing: 0.06em; }
.live-mini {
  width: 8px; height: 8px;
  border-radius: 50%;
  background: var(--dim);
  transition: background 200ms var(--ease), box-shadow 200ms var(--ease);
}
.live-mini.on { background: var(--signal); box-shadow: 0 0 8px var(--signal); }

@media (max-width: 720px) {
  .controls-inner { flex-wrap: wrap; }
  .ctl-you { display: none; }
  .ctl-label .ctl-hint { display: none; }
}

/* ============= password prompt ============= */
.pwd-veil {
  position: fixed;
  inset: 0;
  z-index: 120;
  display: grid;
  place-items: center;
  padding: 24px;
  background: rgba(6, 6, 8, 0.72);
  backdrop-filter: blur(6px);
}
.pwd-dialog {
  width: min(92vw, 380px);
  background: var(--panel-hi);
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 22px 22px 18px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  box-shadow: 0 24px 60px -12px rgba(0, 0, 0, 0.8);
}
.pwd-hdr {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--line-soft);
}
.pwd-tag { color: var(--signal); font-size: 10px; letter-spacing: 0.16em; }
.pwd-code {
  color: var(--signal-hot);
  font-size: 14px;
  letter-spacing: 0.14em;
}
.pwd-lead {
  color: var(--text-2);
  font-size: 13px;
  line-height: 1.6;
  margin: 0;
}
.pwd-err { color: var(--danger); }
.pwd-input {
  height: 42px;
  padding: 0 14px;
  background: var(--panel-2);
  border: 1px solid var(--line);
  border-radius: 4px;
  color: var(--text);
  font-family: var(--font-mono);
  font-size: 14px;
  letter-spacing: 0.08em;
  transition: border-color 160ms var(--ease), box-shadow 160ms var(--ease);
}
.pwd-input:focus {
  outline: none;
  border-color: var(--signal);
  box-shadow: 0 0 0 3px var(--signal-soft);
}
.pwd-input:disabled { opacity: 0.6; }
.pwd-foot {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  padding-top: 6px;
}
.pwd-cancel {
  padding: 8px 14px;
  color: var(--text-2);
  border: 1px solid var(--line);
  border-radius: 3px;
  font-size: 12px;
}
.pwd-cancel:hover:not(:disabled) { color: var(--text); border-color: var(--line-soft); background: var(--panel-2); }
.pwd-go {
  padding: 8px 18px;
  background: var(--signal);
  color: #1A1200;
  border-radius: 3px;
  font-weight: 600;
  font-size: 12px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.pwd-go:hover:not(:disabled) { background: var(--signal-hot); }
.pwd-go:disabled { opacity: 0.5; cursor: not-allowed; }
.pwd-go .arrow { font-family: var(--font-mono); }

/* ============= rename (footer YOU chip) ============= */
.ctl-you.editing {
  border-color: var(--signal);
  background: var(--panel-2);
}
.btn-rename {
  color: var(--text);
  font-family: var(--font-mono);
  font-size: 12px;
  letter-spacing: 0.06em;
  padding: 4px 8px;
  border: 1px dashed transparent;
  border-radius: 3px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  transition: color 140ms var(--ease), border-color 140ms var(--ease), background 140ms var(--ease);
}
.btn-rename:hover {
  color: var(--signal);
  border-color: var(--signal-soft);
  background: var(--panel-2);
}
.rename-pencil {
  color: var(--muted);
  font-size: 11px;
  transition: color 140ms var(--ease);
}
.btn-rename:hover .rename-pencil { color: var(--signal); }
.rename-input {
  min-width: 120px;
  height: 26px;
  padding: 0 8px;
  background: var(--panel-2);
  border: 1px solid var(--signal);
  border-radius: 3px;
  color: var(--text);
  font-family: var(--font-mono);
  font-size: 12px;
  letter-spacing: 0.06em;
  outline: none;
  box-shadow: 0 0 0 2px var(--signal-soft);
}
</style>
