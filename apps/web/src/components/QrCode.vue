<script setup lang="ts">
import { computed } from 'vue'
import QRCode from 'qrcode'

/**
 * A QR code as SVG, drawn from the module matrix rather than embedded as an
 * image.
 *
 * It costs one `computed` and gives three things a data URL cannot: it scales
 * without blurring on any display, it takes its colour from the design system,
 * and it stays a handful of DOM nodes instead of a base64 blob in the markup.
 */
const props = withDefaults(
  defineProps<{
    value: string
    /** Rendered edge length in px. The matrix decides its own resolution. */
    size?: number
    label?: string
  }>(),
  { size: 240, label: 'QR-Code' },
)

/**
 * Four modules of margin, because that is what the spec asks for and what
 * scanners look for. Less works on paper and starts failing on a screen next
 * to other dark interface.
 */
const QUIET = 4

const code = computed(() => {
  if (!props.value) return null

  // Level M: a quarter of the code may be obscured and still read. Higher
  // levels make the matrix denser, which hurts more than it helps on a screen
  // held at arm's length.
  const { modules } = QRCode.create(props.value, { errorCorrectionLevel: 'M' })
  const { size, data } = modules

  // One path for the whole matrix. A thousand <rect> elements render the same
  // and cost a thousand nodes.
  let d = ''
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (data[y * size + x]) d += `M${x + QUIET} ${y + QUIET}h1v1h-1z`
    }
  }

  return { extent: size + QUIET * 2, d }
})
</script>

<template>
  <svg
    v-if="code"
    :width="size"
    :height="size"
    :viewBox="`0 0 ${code.extent} ${code.extent}`"
    role="img"
    :aria-label="label"
    shape-rendering="crispEdges"
  >
    <rect :width="code.extent" :height="code.extent" fill="#fff" />
    <path :d="code.d" fill="#171714" />
  </svg>
</template>
