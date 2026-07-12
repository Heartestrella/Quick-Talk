<script setup>
import { computed } from 'vue'

const props = defineProps({
  // reactive refs from useRoom — passed as-is so we can mutate .value
  masterVoice: Object,          // ref<number>
  masterScreen: Object,         // ref<number>
  peers: Object,                // reactive Map<peerId, {name, screenOn, rxScreenAudio?}>
  peerAudio: Object,            // reactive Map<peerId, {voice, screen, muted}>
  setPeerVoice: Function,       // (id, v) => void
  setPeerScreen: Function,      // (id, v) => void
  setPeerMuted: Function,       // (id, muted) => void
  ensurePeer: Function          // getPeerAudio(id) — returns { voice, screen, muted }
})
defineEmits(['close'])

// Rendering list of peers in stable order.  Screen slider only shows for peers
// currently sharing (screenOn true) — voice slider always shows.
const peerList = computed(() => {
  const out = []
  for (const p of props.peers.values()) {
    const s = props.peerAudio.get(p.id) || props.ensurePeer(p.id)
    out.push({
      id: p.id,
      name: p.name,
      subtitle: p.id.slice(0, 4).toUpperCase(),
      screenOn: !!p.screenOn,
      hasScreenAudio: (p.rxScreenAudio || 0) > 0,
      settings: s
    })
  }
  return out
})

function pct(v) { return Math.round((Number(v) || 0) * 100) }

function onVoiceInput(id, e) { props.setPeerVoice(id, Number(e.target.value) / 100) }
function onScreenInput(id, e) { props.setPeerScreen(id, Number(e.target.value) / 100) }
function onMasterVoice(e) { props.masterVoice.value = Number(e.target.value) / 100 }
function onMasterScreen(e) { props.masterScreen.value = Number(e.target.value) / 100 }
function toggleMute(id, s) { props.setPeerMuted(id, !s.muted) }

function resetMaster() {
  props.masterVoice.value = 1
  props.masterScreen.value = 1
}
</script>

<template>
  <div class="mixer" role="dialog" aria-label="音量混合器">
    <header class="mx-hdr">
      <div class="mx-title">
        <span class="mono mx-tag">MIXER</span>
        <span class="mx-cn">音量</span>
      </div>
      <div class="mx-actions">
        <button class="mx-reset mono" @click="resetMaster" title="总音量归 100%">RESET</button>
        <button class="mx-close" @click="$emit('close')" aria-label="关闭">×</button>
      </div>
    </header>

    <!-- ===== master section ===== -->
    <section class="mx-section">
      <div class="mx-sec-title">
        <span class="mono">MASTER</span>
        <span class="mx-hint">全局音量 · 影响所有人</span>
      </div>

      <div class="mx-row master">
        <div class="mx-row-lbl">
          <span class="ico mic" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <rect x="9" y="3" width="6" height="12" rx="3" />
              <path d="M5 11a7 7 0 0 0 14 0" />
            </svg>
          </span>
          <span class="mx-lbl">麦克风</span>
        </div>
        <input
          type="range" min="0" max="150" step="1"
          :value="pct(masterVoice.value)"
          @input="onMasterVoice"
          class="mx-slider voice"
          :style="{ '--fill': pct(masterVoice.value) + '%' }"
        />
        <div class="mx-val mono">{{ pct(masterVoice.value) }}</div>
      </div>

      <div class="mx-row master">
        <div class="mx-row-lbl">
          <span class="ico scr" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="2.5" y="4" width="19" height="13" rx="2" />
              <path d="M8 21h8M12 17v4" />
            </svg>
          </span>
          <span class="mx-lbl">屏幕音频</span>
        </div>
        <input
          type="range" min="0" max="150" step="1"
          :value="pct(masterScreen.value)"
          @input="onMasterScreen"
          class="mx-slider screen"
          :style="{ '--fill': pct(masterScreen.value) + '%' }"
        />
        <div class="mx-val mono">{{ pct(masterScreen.value) }}</div>
      </div>
    </section>

    <!-- ===== per-peer section ===== -->
    <section class="mx-section peers">
      <div class="mx-sec-title">
        <span class="mono">PER USER</span>
        <span class="mx-hint">单独调节 · 大调之外的微调</span>
      </div>

      <div v-if="peerList.length === 0" class="mx-empty">
        暂无其他成员
      </div>

      <div v-for="p in peerList" :key="p.id" class="mx-peer" :class="{ muted: p.settings.muted }">
        <div class="mx-peer-hdr">
          <div class="mx-peer-name">
            <span class="mx-avatar">{{ (p.name || '?').charAt(0).toUpperCase() }}</span>
            <span class="mx-name" :title="p.name">{{ p.name }}</span>
            <span class="mx-sub mono">{{ p.subtitle }}</span>
          </div>
          <button
            class="mx-mute"
            :class="{ on: p.settings.muted }"
            @click="toggleMute(p.id, p.settings)"
            :title="p.settings.muted ? '取消静音' : '对我静音'"
          >
            <svg v-if="!p.settings.muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M3 10v4h4l5 4V6L7 10H3z" />
              <path d="M16.5 8.5a5 5 0 0 1 0 7" />
              <path d="M19.5 5.5a9 9 0 0 1 0 13" />
            </svg>
            <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M3 10v4h4l5 4V6L7 10H3z" />
              <path d="M17 9l6 6M23 9l-6 6" />
            </svg>
            <span class="mx-mute-lbl mono">{{ p.settings.muted ? 'MUTED' : 'ON' }}</span>
          </button>
        </div>

        <div class="mx-row">
          <div class="mx-row-lbl small">
            <span class="ico mic" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                <rect x="9" y="3" width="6" height="12" rx="3" />
                <path d="M5 11a7 7 0 0 0 14 0" />
              </svg>
            </span>
            <span>麦克风</span>
          </div>
          <input
            type="range" min="0" max="150" step="1"
            :value="pct(p.settings.voice)"
            :disabled="p.settings.muted"
            @input="onVoiceInput(p.id, $event)"
            class="mx-slider voice"
            :style="{ '--fill': pct(p.settings.voice) + '%' }"
          />
          <div class="mx-val mono">{{ pct(p.settings.voice) }}</div>
        </div>

        <div class="mx-row" v-if="p.screenOn || p.hasScreenAudio">
          <div class="mx-row-lbl small">
            <span class="ico scr" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <rect x="2.5" y="4" width="19" height="13" rx="2" />
                <path d="M8 21h8M12 17v4" />
              </svg>
            </span>
            <span>屏幕音频</span>
            <span v-if="!p.hasScreenAudio" class="mx-inactive mono">未在传</span>
          </div>
          <input
            type="range" min="0" max="150" step="1"
            :value="pct(p.settings.screen)"
            :disabled="p.settings.muted"
            @input="onScreenInput(p.id, $event)"
            class="mx-slider screen"
            :style="{ '--fill': pct(p.settings.screen) + '%' }"
          />
          <div class="mx-val mono">{{ pct(p.settings.screen) }}</div>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.mixer {
  width: 340px;
  max-width: calc(100vw - 24px);
  max-height: 78vh;
  overflow-y: auto;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 6px;
  box-shadow: 0 24px 60px -20px rgba(0, 0, 0, 0.6),
              0 0 0 1px rgba(255, 255, 255, 0.02) inset;
  padding: 12px 14px 16px;
  color: var(--text);
  font-size: 13px;
}
.mx-hdr {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--line);
}
.mx-title { display: inline-flex; align-items: baseline; gap: 8px; }
.mx-tag { color: var(--cool); font-size: 11px; letter-spacing: 0.16em; }
.mx-cn { color: var(--text); font-size: 13px; }
.mx-actions { display: inline-flex; gap: 6px; align-items: center; }
.mx-reset {
  font-size: 10px;
  letter-spacing: 0.14em;
  color: var(--muted);
  background: transparent;
  border: 1px solid var(--line);
  border-radius: 3px;
  padding: 3px 8px;
  cursor: pointer;
  transition: color 140ms var(--ease), border-color 140ms var(--ease);
}
.mx-reset:hover { color: var(--cool); border-color: var(--cool-soft); }
.mx-close {
  width: 24px; height: 24px;
  background: transparent;
  border: 1px solid var(--line);
  border-radius: 3px;
  color: var(--muted);
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
  transition: color 140ms var(--ease), border-color 140ms var(--ease);
}
.mx-close:hover { color: var(--danger); border-color: rgba(225, 74, 61, 0.35); }

.mx-section { padding-top: 12px; }
.mx-sec-title {
  display: flex;
  align-items: baseline;
  gap: 8px;
  color: var(--muted);
  font-size: 10px;
  letter-spacing: 0.16em;
  margin-bottom: 8px;
}
.mx-sec-title .mono { color: var(--cool); }
.mx-hint { color: var(--muted); font-size: 10px; letter-spacing: 0.04em; text-transform: none; }

.mx-row {
  display: grid;
  grid-template-columns: 88px 1fr 40px;
  align-items: center;
  gap: 10px;
  padding: 4px 0;
}
.mx-row.master { padding: 6px 0; }
.mx-row-lbl {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--text-2);
  font-size: 12px;
}
.mx-row-lbl.small { color: var(--text-2); font-size: 11px; }
.ico { width: 14px; height: 14px; color: var(--muted); }
.ico svg { width: 100%; height: 100%; display: block; }
.ico.scr { color: var(--cool); }
.mx-lbl { letter-spacing: 0.04em; }
.mx-inactive {
  color: var(--muted);
  font-size: 9px;
  letter-spacing: 0.12em;
  padding: 1px 5px;
  border: 1px dashed var(--line);
  border-radius: 3px;
  margin-left: 4px;
}
.mx-val {
  text-align: right;
  font-size: 11px;
  color: var(--text-2);
  letter-spacing: 0.02em;
  font-variant-numeric: tabular-nums;
}

/* range slider — thin, matches the aesthetic */
.mx-slider {
  -webkit-appearance: none;
  appearance: none;
  width: 100%;
  height: 4px;
  background: transparent;
  cursor: pointer;
}
.mx-slider::-webkit-slider-runnable-track {
  height: 4px;
  border-radius: 2px;
  background: linear-gradient(
    to right,
    var(--cool) 0,
    var(--cool) var(--fill, 100%),
    var(--panel-2) var(--fill, 100%),
    var(--panel-2) 100%
  );
}
.mx-slider::-moz-range-track {
  height: 4px;
  border-radius: 2px;
  background: var(--panel-2);
}
.mx-slider::-moz-range-progress {
  height: 4px;
  border-radius: 2px;
  background: var(--cool);
}
.mx-slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 14px; height: 14px;
  border-radius: 50%;
  background: var(--text);
  border: 2px solid var(--cool);
  margin-top: -5px;
  cursor: grab;
  box-shadow: 0 0 0 2px rgba(0, 0, 0, 0.35);
  transition: transform 120ms var(--ease);
}
.mx-slider::-webkit-slider-thumb:hover { transform: scale(1.1); }
.mx-slider::-moz-range-thumb {
  width: 12px; height: 12px;
  border-radius: 50%;
  background: var(--text);
  border: 2px solid var(--cool);
  cursor: grab;
}
.mx-slider.screen::-webkit-slider-thumb { border-color: var(--signal); }
.mx-slider.screen::-webkit-slider-runnable-track {
  background: linear-gradient(
    to right,
    var(--signal) 0,
    var(--signal) var(--fill, 100%),
    var(--panel-2) var(--fill, 100%),
    var(--panel-2) 100%
  );
}
.mx-slider.screen::-moz-range-progress { background: var(--signal); }
.mx-slider.screen::-moz-range-thumb { border-color: var(--signal); }
.mx-slider:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}
.mx-slider:disabled::-webkit-slider-thumb { cursor: not-allowed; }

.mx-empty {
  color: var(--muted);
  font-size: 12px;
  padding: 14px 4px;
  text-align: center;
  border: 1px dashed var(--line);
  border-radius: 4px;
}

.mx-peer {
  padding: 10px 8px;
  border: 1px solid var(--line);
  border-radius: 5px;
  margin-bottom: 8px;
  background: var(--panel-2);
  transition: border-color 160ms var(--ease), background 160ms var(--ease);
}
.mx-peer:last-child { margin-bottom: 0; }
.mx-peer.muted { opacity: 0.75; border-color: var(--line-soft); }
.mx-peer-hdr {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
}
.mx-peer-name {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  overflow: hidden;
}
.mx-avatar {
  width: 22px; height: 22px;
  border-radius: 50%;
  border: 1px solid var(--line);
  display: grid;
  place-items: center;
  background: var(--panel);
  color: var(--text-2);
  font-size: 11px;
  font-family: var(--font-display);
}
.mx-name {
  font-family: var(--font-mono);
  font-size: 12px;
  letter-spacing: 0.05em;
  color: var(--text);
  max-width: 150px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mx-sub { color: var(--muted); font-size: 10px; letter-spacing: 0.14em; }

.mx-mute {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  border-radius: 3px;
  border: 1px solid var(--line);
  background: var(--panel);
  color: var(--text-2);
  font-size: 10px;
  cursor: pointer;
  transition: color 140ms var(--ease), border-color 140ms var(--ease), background 140ms var(--ease);
}
.mx-mute svg { width: 12px; height: 12px; }
.mx-mute:hover { color: var(--cool); border-color: var(--cool-soft); }
.mx-mute.on {
  color: var(--danger);
  border-color: rgba(225, 74, 61, 0.45);
  background: rgba(225, 74, 61, 0.08);
}
.mx-mute.on:hover { color: var(--danger); }
.mx-mute-lbl { letter-spacing: 0.14em; }

@media (max-width: 520px) {
  .mixer { width: calc(100vw - 24px); padding: 10px 12px 14px; }
  .mx-row { grid-template-columns: 76px 1fr 36px; }
}
</style>
