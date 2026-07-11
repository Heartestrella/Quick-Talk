<script setup>
import { computed } from 'vue'
import Waveform from './Waveform.vue'

const props = defineProps({
  name: String,
  subtitle: String,
  micOn: Boolean,
  screenOn: Boolean,
  level: Number,
  self: Boolean,
  active: Boolean,
  denoiseOn: { type: Boolean, default: false },
  gateOpen: { type: Boolean, default: true }
})
defineEmits(['focus-screen'])

// "透传中" — 麦克风开、闸门放行、有实际音量
const speaking = computed(() => {
  if (!props.micOn) return false
  if (props.self && props.denoiseOn && !props.gateOpen) return false
  return (props.level || 0) > 0.06
})
const initial = computed(() => (props.name || '?').charAt(0).toUpperCase())
</script>

<template>
  <article
    class="p-tile"
    :class="{ speaking, muted: !micOn, self, active }"
    @click="screenOn ? $emit('focus-screen') : null"
    :role="screenOn ? 'button' : undefined"
    :tabindex="screenOn ? 0 : undefined"
  >
    <!-- corner label -->
    <div class="p-corner mono">{{ subtitle }}</div>

    <!-- speaking indicator: amber LED -->
    <div class="p-led" :class="{ on: speaking }" aria-hidden="true"></div>

    <!-- avatar / identity -->
    <div class="p-body">
      <div class="p-avatar" :class="{ live: speaking }">
        <span>{{ initial }}</span>
      </div>
      <div class="p-name" :title="name">{{ name }}</div>
      <div class="p-tags">
        <span class="p-tag" :class="{ off: !micOn }">
          <span class="tag-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <rect x="9" y="3" width="6" height="12" rx="3" />
              <path d="M5 11a7 7 0 0 0 14 0" />
              <path v-if="!micOn" d="M4 4l16 16" stroke="currentColor" stroke-width="2.2" />
            </svg>
          </span>
          <span>{{ micOn ? 'MIC' : 'MUTE' }}</span>
        </span>
        <span v-if="screenOn" class="p-tag screen">
          <span class="tag-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="2.5" y="4" width="19" height="13" rx="2" />
              <path d="M8 21h8M12 17v4" />
            </svg>
          </span>
          <span>共享中</span>
        </span>
        <span v-if="self && micOn && denoiseOn" class="p-tag dn">
          <span class="tag-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6l7-3z" />
            </svg>
          </span>
          <span>降噪</span>
        </span>
      </div>
    </div>

    <!-- live waveform footer -->
    <div class="p-wave">
      <Waveform :active="speaking" :amplitude="level" :bars="32" />
    </div>
  </article>
</template>

<style scoped>
.p-tile {
  position: relative;
  aspect-ratio: 4 / 3;
  min-height: 160px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background:
    linear-gradient(180deg, rgba(255, 255, 255, 0.02), transparent 40%),
    var(--panel);
  padding: 16px 16px 8px;
  overflow: hidden;
  transition: border-color 200ms var(--ease), transform 200ms var(--ease), box-shadow 200ms var(--ease);
  display: flex;
  flex-direction: column;
  box-shadow: 0 4px 14px -8px rgba(0, 0, 0, 0.55), 0 1px 0 rgba(255, 255, 255, 0.02) inset;
}
.p-tile.self {
  border-color: var(--line-soft);
  background:
    linear-gradient(180deg, rgba(74, 141, 168, 0.06), transparent 50%),
    var(--panel);
}
.p-tile.self::before {
  content: '';
  position: absolute;
  top: 0; left: 0;
  width: 3px;
  height: 100%;
  background: var(--cool);
  opacity: 0.7;
}
.p-tile.speaking {
  border-color: var(--signal);
  box-shadow: 0 0 0 1px var(--signal-glow), 0 0 24px -8px var(--signal-glow);
}
.p-tile.active {
  outline: 1px dashed var(--cool);
  outline-offset: -6px;
}
.p-tile[role='button'] { cursor: pointer; }
.p-tile[role='button']:hover { transform: translateY(-2px); }

.p-corner {
  position: absolute;
  top: 12px;
  right: 14px;
  color: var(--muted);
  font-size: 10px;
  letter-spacing: 0.14em;
}

.p-ice {
  position: absolute;
  top: 34px;
  right: 14px;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 9px;
  letter-spacing: 0.1em;
  padding: 2px 6px;
  border-radius: 3px;
  border: 1px solid var(--line-soft);
  background: rgba(0, 0, 0, 0.25);
}
.p-ice-pip {
  width: 5px; height: 5px;
  border-radius: 50%;
  background: currentColor;
  box-shadow: 0 0 5px currentColor;
}
.p-ice.tone-ok { color: var(--ok); border-color: rgba(125, 190, 114, 0.28); }
.p-ice.tone-wait { color: var(--signal); border-color: var(--signal-glow); }
.p-ice.tone-warn { color: var(--signal-hot); border-color: var(--signal-glow); }
.p-ice.tone-bad { color: var(--danger); border-color: rgba(225, 74, 61, 0.35); }
.p-ice.tone-off { color: var(--muted); border-color: var(--line); }

.p-led {
  position: absolute;
  top: 14px;
  left: 14px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--dim);
  transition: background 160ms var(--ease), box-shadow 160ms var(--ease);
}
.p-led.on {
  background: var(--signal);
  box-shadow: 0 0 0 3px var(--signal-soft), 0 0 12px var(--signal);
  animation: ledFlicker 1.2s infinite var(--ease);
}
@keyframes ledFlicker {
  0%, 100% { box-shadow: 0 0 0 3px var(--signal-soft), 0 0 10px var(--signal); }
  50% { box-shadow: 0 0 0 4px transparent, 0 0 18px var(--signal-hot); }
}

.p-body {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 8px 4px;
}

.p-avatar {
  width: 60px;
  height: 60px;
  border-radius: 50%;
  border: 1px solid var(--line);
  background: var(--panel-2);
  display: grid;
  place-items: center;
  color: var(--text-2);
  font-family: var(--font-display);
  font-weight: 500;
  font-size: 24px;
  transition: all 200ms var(--ease);
}
.p-avatar.live {
  border-color: var(--signal);
  color: var(--signal-hot);
  background: linear-gradient(180deg, rgba(242, 169, 59, 0.12), transparent), var(--panel-2);
}

.p-name {
  color: var(--text);
  font-family: var(--font-mono);
  font-size: 13px;
  letter-spacing: 0.06em;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.p-tags {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  justify-content: center;
}
.p-tag {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 8px;
  border: 1px solid var(--line-soft);
  border-radius: 3px;
  color: var(--text-2);
  font-size: 10px;
  font-family: var(--font-mono);
  letter-spacing: 0.06em;
  background: var(--panel);
}
.p-tag.off { color: var(--muted); }
.p-tag.screen { color: var(--cool); border-color: var(--cool-soft); }
.p-tag.dn { color: var(--ok); border-color: rgba(125, 190, 114, 0.28); }
.tag-icon svg { width: 11px; height: 11px; display: block; }

.p-wave {
  height: 28px;
  margin: 0 -4px;
  opacity: 0.9;
}
</style>
