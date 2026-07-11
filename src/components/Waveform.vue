<script setup>
import { ref, onMounted, onUnmounted, watch } from 'vue'

const props = defineProps({
  active: { type: Boolean, default: false },
  amplitude: { type: Number, default: 0 }, // 0-1, live audio level
  bars: { type: Number, default: 56 }
})

const canvas = ref(null)
let ctx = null
let raf = null
let t = 0
let dpr = 1

function draw() {
  if (!ctx || !canvas.value) return
  const el = canvas.value
  const w = el.width
  const h = el.height
  ctx.clearRect(0, 0, w, h)

  const barGap = 3 * dpr
  const barW = Math.max(2 * dpr, (w - barGap * (props.bars - 1)) / props.bars)
  const cy = h / 2
  const baseAmp = props.active ? 0.32 : 0.14
  const liveBoost = Math.max(baseAmp, props.amplitude)

  for (let i = 0; i < props.bars; i++) {
    // pseudo waveform: overlapping sines + subtle noise
    const p = i / props.bars
    const sway = Math.sin(t * 0.9 + p * 6.28) * 0.5 + 0.5
    const shimmer = Math.sin(t * 2.3 + p * 3.14) * 0.5 + 0.5
    const carrier = Math.sin(t * 0.4 + p * 12) * 0.5 + 0.5
    let mag = (sway * 0.55 + shimmer * 0.25 + carrier * 0.2) * liveBoost

    // taper the ends for a nice envelope
    const edge = Math.sin(p * Math.PI)
    mag *= 0.35 + 0.65 * edge

    const barH = Math.max(2 * dpr, mag * h)
    const x = i * (barW + barGap)
    const y = cy - barH / 2

    const alpha = props.active ? 0.75 + shimmer * 0.25 : 0.35 + shimmer * 0.35
    ctx.fillStyle = props.active
      ? `rgba(242, 169, 59, ${alpha})`
      : `rgba(168, 165, 151, ${alpha * 0.55})`
    ctx.fillRect(x, y, barW, barH)
  }

  // baseline
  ctx.strokeStyle = props.active ? 'rgba(242, 169, 59, 0.15)' : 'rgba(107, 104, 98, 0.18)'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(0, cy)
  ctx.lineTo(w, cy)
  ctx.stroke()

  t += 0.03
  raf = requestAnimationFrame(draw)
}

function resize() {
  const el = canvas.value
  if (!el) return
  dpr = window.devicePixelRatio || 1
  const rect = el.getBoundingClientRect()
  el.width = Math.max(1, Math.floor(rect.width * dpr))
  el.height = Math.max(1, Math.floor(rect.height * dpr))
}

onMounted(() => {
  ctx = canvas.value.getContext('2d')
  resize()
  window.addEventListener('resize', resize)
  raf = requestAnimationFrame(draw)
})

onUnmounted(() => {
  cancelAnimationFrame(raf)
  window.removeEventListener('resize', resize)
})

watch(() => props.active, () => {
  // small nudge so the transition feels responsive
  t += 0.5
})
</script>

<template>
  <canvas ref="canvas" class="wave-canvas" aria-hidden="true"></canvas>
</template>

<style scoped>
.wave-canvas {
  display: block;
  width: 100%;
  height: 100%;
}
</style>
