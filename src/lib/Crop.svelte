<script module lang="ts">
  // Decoding too many large images at once can exhaust memory, so process only a few concurrently.
  const MAX_CONCURRENT = 3
  let running = 0
  const waiting: (() => void)[] = []

  async function limited<T>(task: () => Promise<T>): Promise<T> {
    if (running >= MAX_CONCURRENT) await new Promise<void>((resolve) => waiting.push(resolve))
    running++
    try {
      return await task()
    } finally {
      running--
      waiting.shift()?.()
    }
  }
</script>

<script lang="ts">
  import { clampBox } from './images'
  import type { Rect } from './db'

  let { blob, box, size = 360, alt = '', width = 0, height = 0 }: {
    blob: Blob
    box: Rect
    size?: number
    alt?: string
    width?: number
    height?: number
  } = $props()

  let canvas: HTMLCanvasElement

  $effect(() => {
    let cancelled = false
    // A drag can land a fraction outside the picture; clamping here keeps the
    // crop decodable instead of leaving an empty tile.
    const safe = width > 0 && height > 0 ? clampBox(box, width, height) : box
    const x = Math.max(0, Math.round(safe[0]))
    const y = Math.max(0, Math.round(safe[1]))
    const w = Math.max(1, Math.round(safe[2]))
    const h = Math.max(1, Math.round(safe[3]))
    // Render up to 2x device pixel ratio so cropped tiles stay crisp on Retina/HiDPI screens
    // without needlessly upscaling beyond the crop's native resolution too aggressively.
    const dpr = typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, 2) : 1
    const targetSize = Math.round(size * dpr)
    const scale = targetSize / Math.max(w, h)
    const outW = Math.max(1, Math.round(w * scale))
    const outH = Math.max(1, Math.round(h * scale))
    limited(async () => {
      try {
        const bitmap = await createImageBitmap(blob, x, y, w, h, {
          resizeWidth: outW,
          resizeHeight: outH,
          resizeQuality: 'high',
        })
        return { bitmap, cropped: true }
      } catch {
        const bitmap = await createImageBitmap(blob)
        return { bitmap, cropped: false }
      }
    })
      .then(({ bitmap, cropped }) => {
        if (cancelled) {
          bitmap.close()
          return
        }
        canvas.width = outW
        canvas.height = outH
        const ctx = canvas.getContext('2d')
        if (ctx) {
          ctx.imageSmoothingEnabled = true
          ctx.imageSmoothingQuality = 'high'
          if (cropped) {
            ctx.drawImage(bitmap, 0, 0, outW, outH)
          } else {
            ctx.drawImage(bitmap, x, y, w, h, 0, 0, outW, outH)
          }
        }
        bitmap.close()
      })
      .catch((cause) => {
        if (!cancelled) console.warn('Could not display this crop', cause)
      })
    return () => {
      cancelled = true
    }
  })
</script>

<canvas bind:this={canvas}>{alt}</canvas>

<style>
  canvas {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: contain;
  }
</style>
