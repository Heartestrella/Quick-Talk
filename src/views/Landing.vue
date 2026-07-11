<script setup>
import { ref, computed, onMounted, onUnmounted, nextTick } from 'vue'
import { useRouter } from 'vue-router'
import Waveform from '../components/Waveform.vue'

const router = useRouter()
const digits = ref(['', '', '', '', '', ''])
const inputs = []
function setInputRef(i, el) { inputs[i] = el }
const clock = ref('00:00')
const CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

const full = computed(() => digits.value.every((d) => d.length === 1))
const codePreview = computed(() =>
  digits.value.map((d, i) => (d || (i === 0 ? '_' : '·'))).join('')
)

function normalize(v) {
  return (v || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 1)
}

function onInput(i, e) {
  const v = normalize(e.target.value)
  digits.value[i] = v
  e.target.value = v
  if (v && i < 5) {
    nextTick(() => inputs[i + 1]?.focus())
  }
}

function onKey(i, e) {
  if (e.key === 'Backspace' && !digits.value[i] && i > 0) {
    inputs[i - 1]?.focus()
  }
  if (e.key === 'ArrowLeft' && i > 0) inputs[i - 1]?.focus()
  if (e.key === 'ArrowRight' && i < 5) inputs[i + 1]?.focus()
}

function onPaste(e) {
  e.preventDefault()
  const raw = (e.clipboardData?.getData('text') || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
  raw.split('').slice(0, 6).forEach((c, idx) => {
    digits.value[idx] = c
  })
  const next = Math.min(raw.length, 5)
  nextTick(() => inputs[next]?.focus())
}

function join() {
  if (!full.value) return
  const code = digits.value.join('')
  router.push({ name: 'room', params: { id: code } })
}

function randomCode() {
  let out = ''
  for (let i = 0; i < 6; i++) {
    out += CHARSET[Math.floor(Math.random() * CHARSET.length)]
  }
  return out
}

function create() {
  const code = randomCode()
  router.push({ name: 'room', params: { id: code } })
}

let timer
function tick() {
  const d = new Date()
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const ss = String(d.getSeconds()).padStart(2, '0')
  clock.value = `${hh}:${mm}:${ss}`
}

onMounted(() => {
  tick()
  timer = setInterval(tick, 1000)
  nextTick(() => inputs[0]?.focus())
})
onUnmounted(() => clearInterval(timer))
</script>

<template>
  <div class="landing">
    <!-- console top bar -->
    <header class="bar bar-top">
      <div class="bar-l">
        <span class="live-dot" aria-hidden="true"></span>
        <span class="brand">QUICK<span class="dot-sep">·</span>TALK</span>
        <span class="brand-cn">快聊</span>
      </div>
      <div class="bar-r mono">
        <span class="tag">TRANSCEIVER</span>
        <span class="sep">/</span>
        <span>{{ clock }}</span>
        <span class="sep">/</span>
        <span class="ok">TX·RX READY</span>
      </div>
    </header>

    <main class="stage">
      <!-- corner ticks — frame the console -->
      <span class="tick tick-tl" aria-hidden="true"></span>
      <span class="tick tick-tr" aria-hidden="true"></span>
      <span class="tick tick-bl" aria-hidden="true"></span>
      <span class="tick tick-br" aria-hidden="true"></span>

      <section class="hero">
        <div class="eyebrow">
          <span class="mono num">01</span>
          <span class="eyebrow-line"></span>
          <span class="mono">TUNE IN · 输入频率</span>
        </div>

        <form class="tuner" @submit.prevent="join">
          <div class="code-row" role="group" aria-label="房间号">
            <template v-for="(_, i) in 6" :key="i">
              <input
                :ref="(el) => setInputRef(i, el)"
                :value="digits[i]"
                @input="onInput(i, $event)"
                @keydown="onKey(i, $event)"
                @paste="onPaste"
                @focus="$event.target.select()"
                maxlength="1"
                autocomplete="off"
                spellcheck="false"
                class="digit"
                :class="{ filled: digits[i] }"
                :aria-label="`房间号第 ${i + 1} 位`"
              />
              <span v-if="i === 2" class="code-sep" aria-hidden="true">·</span>
            </template>
          </div>

          <Waveform class="carrier" :active="full" />

          <div class="tuner-foot">
            <span class="mono status">
              <span class="pip" :class="{ on: full }"></span>
              {{ full ? 'FREQ LOCKED · 就绪' : 'AWAITING SIGNAL · 待输入' }}
            </span>
            <button type="submit" class="btn-primary" :disabled="!full">
              接入房间
              <span class="arrow">→</span>
            </button>
          </div>
        </form>

        <div class="divider">
          <span class="line"></span>
          <span class="mono divider-word">或开启新频道</span>
          <span class="line"></span>
        </div>

        <div class="eyebrow">
          <span class="mono num">02</span>
          <span class="eyebrow-line"></span>
          <span class="mono">OPEN NEW CHANNEL · 建立频道</span>
        </div>

        <button class="btn-secondary" @click="create">
          <span class="plus">+</span>
          <span>开一个房间</span>
          <span class="mono hint">系统随机生成 6 位呼号</span>
        </button>
      </section>

      <aside class="marginalia">
        <div class="spec">
          <span class="mono spec-key">MODE</span>
          <span class="spec-val">语音 · 主</span>
        </div>
        <div class="spec">
          <span class="mono spec-key">AUX</span>
          <span class="spec-val">文字 · 屏幕共享</span>
        </div>
        <div class="spec">
          <span class="mono spec-key">AUTH</span>
          <span class="spec-val">无需登录</span>
        </div>
        <div class="spec">
          <span class="mono spec-key">NET</span>
          <span class="spec-val">P2P · WebRTC</span>
        </div>
      </aside>
    </main>

    <footer class="bar bar-bot">
      <span class="mono">v0.1 · MADE FOR QUICK CONVERSATIONS</span>
      <span class="mono hint-kbd">按 <kbd>Enter</kbd> 接入 · <kbd>Tab</kbd> 切位</span>
    </footer>
  </div>
</template>

<style scoped>
.landing {
  height: 100%;
  display: grid;
  grid-template-rows: auto 1fr auto;
  background:
    radial-gradient(1200px 700px at 15% 0%, rgba(242, 169, 59, 0.05), transparent 60%),
    radial-gradient(900px 500px at 90% 100%, rgba(74, 141, 168, 0.05), transparent 60%),
    var(--bg);
  position: relative;
  overflow: hidden;
}

/* ---------- console bars ---------- */
.bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 26px;
  border-block: 1px solid var(--line-soft);
  font-size: 12px;
  letter-spacing: 0.08em;
  color: var(--text-2);
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.02), transparent);
}
.bar-top { border-top: none; }
.bar-bot { border-bottom: none; }

.bar-l { display: flex; align-items: center; gap: 12px; }
.bar-r { display: flex; align-items: center; gap: 10px; }

.mono {
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.1em;
}

.live-dot {
  width: 8px; height: 8px;
  border-radius: 50%;
  background: var(--signal);
  box-shadow: 0 0 0 3px var(--signal-soft), 0 0 12px var(--signal-glow);
  animation: pulse 1.8s infinite var(--ease);
}
@keyframes pulse {
  0%, 100% { box-shadow: 0 0 0 3px var(--signal-soft), 0 0 8px var(--signal-glow); }
  50% { box-shadow: 0 0 0 6px transparent, 0 0 18px var(--signal); }
}

.brand {
  font-family: var(--font-display);
  font-weight: 700;
  font-size: 13px;
  letter-spacing: 0.16em;
  color: var(--text);
}
.dot-sep {
  margin: 0 4px;
  color: var(--signal);
}
.brand-cn {
  color: var(--muted);
  font-size: 12px;
  margin-left: 4px;
}

.tag { color: var(--signal); }
.sep { color: var(--dim); }
.ok { color: var(--ok); }

/* ---------- stage ---------- */
.stage {
  position: relative;
  display: grid;
  grid-template-columns: 1fr 220px;
  gap: 60px;
  padding: 60px 80px 40px;
  align-items: start;
  overflow: auto;
}
@media (max-width: 860px) {
  .stage {
    grid-template-columns: 1fr;
    padding: 40px 24px;
    gap: 40px;
  }
}

/* corner ticks */
.tick {
  position: absolute;
  width: 14px; height: 14px;
  border-color: var(--line);
  border-style: solid;
  border-width: 0;
}
.tick-tl { top: 22px; left: 22px; border-top-width: 1px; border-left-width: 1px; }
.tick-tr { top: 22px; right: 22px; border-top-width: 1px; border-right-width: 1px; }
.tick-bl { bottom: 22px; left: 22px; border-bottom-width: 1px; border-left-width: 1px; }
.tick-br { bottom: 22px; right: 22px; border-bottom-width: 1px; border-right-width: 1px; }

/* ---------- hero ---------- */
.hero {
  max-width: 640px;
  margin: 0 auto;
  width: 100%;
}

.eyebrow {
  display: flex;
  align-items: center;
  gap: 14px;
  color: var(--text-2);
  margin-bottom: 18px;
}
.eyebrow .num {
  color: var(--signal);
  font-weight: 500;
}
.eyebrow-line {
  flex: 0 0 40px;
  height: 1px;
  background: var(--line);
}

/* tuner */
.tuner { margin-bottom: 44px; }

.code-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 24px;
}

.digit {
  width: 64px;
  height: 84px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 4px;
  text-align: center;
  font-family: var(--font-mono);
  font-size: 40px;
  font-weight: 500;
  color: var(--text);
  caret-color: var(--signal);
  transition: border-color 160ms var(--ease), background 160ms var(--ease), box-shadow 160ms var(--ease), transform 160ms var(--ease);
  text-transform: uppercase;
}
.digit::placeholder { color: var(--dim); }
.digit:hover {
  border-color: var(--line-soft);
  background: var(--panel-2);
}
.digit:focus {
  outline: none;
  border-color: var(--signal);
  background: var(--panel-2);
  box-shadow: 0 0 0 3px var(--signal-soft), inset 0 0 0 1px var(--signal-soft);
}
.digit.filled {
  color: var(--signal-hot);
  border-color: var(--signal-glow);
  background: linear-gradient(180deg, rgba(242, 169, 59, 0.05), transparent), var(--panel-2);
}
.code-sep {
  color: var(--dim);
  font-family: var(--font-mono);
  font-size: 32px;
  margin: 0 4px;
}
@media (max-width: 520px) {
  .digit { width: 44px; height: 60px; font-size: 26px; }
  .code-sep { font-size: 22px; }
  .code-row { gap: 6px; }
}

.carrier {
  height: 44px;
  margin-bottom: 22px;
}

.tuner-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  flex-wrap: wrap;
}

.status {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: var(--text-2);
}
.pip {
  width: 6px; height: 6px;
  border-radius: 50%;
  background: var(--dim);
  transition: background 200ms var(--ease), box-shadow 200ms var(--ease);
}
.pip.on {
  background: var(--signal);
  box-shadow: 0 0 8px var(--signal);
}

/* buttons */
.btn-primary {
  padding: 14px 24px;
  background: var(--signal);
  color: #1A1200;
  border-radius: 4px;
  font-weight: 600;
  font-size: 14px;
  letter-spacing: 0.06em;
  display: inline-flex;
  align-items: center;
  gap: 10px;
  transition: transform 160ms var(--ease), background 160ms var(--ease), box-shadow 160ms var(--ease), opacity 160ms var(--ease);
  box-shadow: 0 0 0 1px rgba(255, 196, 81, 0.2), 0 8px 24px -8px var(--signal-glow);
}
.btn-primary:hover:not(:disabled) {
  background: var(--signal-hot);
  transform: translateY(-1px);
  box-shadow: 0 0 0 1px rgba(255, 196, 81, 0.4), 0 12px 30px -8px var(--signal-glow);
}
.btn-primary:active:not(:disabled) { transform: translateY(0); }
.btn-primary:disabled { opacity: 0.35; cursor: not-allowed; }

.btn-primary .arrow {
  font-family: var(--font-mono);
  transition: transform 200ms var(--ease);
}
.btn-primary:hover:not(:disabled) .arrow { transform: translateX(3px); }

.btn-secondary {
  width: 100%;
  padding: 18px 22px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 4px;
  color: var(--text);
  display: flex;
  align-items: center;
  gap: 14px;
  transition: border-color 160ms var(--ease), background 160ms var(--ease), transform 160ms var(--ease);
  text-align: left;
}
.btn-secondary:hover {
  background: var(--panel-2);
  border-color: var(--signal);
  transform: translateY(-1px);
}
.btn-secondary .plus {
  width: 30px; height: 30px;
  border: 1px solid var(--signal);
  color: var(--signal);
  border-radius: 4px;
  display: grid;
  place-items: center;
  font-size: 18px;
  font-weight: 500;
  flex-shrink: 0;
}
.btn-secondary .hint {
  margin-left: auto;
  color: var(--muted);
  font-size: 11px;
}
@media (max-width: 520px) {
  .btn-secondary .hint { display: none; }
}

/* divider */
.divider {
  display: flex;
  align-items: center;
  gap: 14px;
  margin: 34px 0 22px;
  color: var(--muted);
}
.divider .line {
  flex: 1;
  height: 1px;
  background: var(--line);
}
.divider-word {
  color: var(--muted);
}

/* ---------- marginalia (right column spec sheet) ---------- */
.marginalia {
  border-left: 1px dashed var(--line);
  padding-left: 24px;
  padding-top: 40px;
  display: flex;
  flex-direction: column;
  gap: 18px;
  color: var(--text-2);
  align-self: stretch;
}
@media (max-width: 860px) {
  .marginalia {
    border-left: none;
    border-top: 1px dashed var(--line);
    padding: 24px 0 0 0;
    flex-direction: row;
    flex-wrap: wrap;
    gap: 20px 32px;
  }
}
.spec {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.spec-key {
  color: var(--muted);
  font-size: 10px;
  letter-spacing: 0.14em;
}
.spec-val {
  color: var(--text);
  font-size: 14px;
}

/* footer hints */
.hint-kbd { color: var(--muted); }
</style>
