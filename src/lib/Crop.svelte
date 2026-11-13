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
    const scale = size / Math.max(w, h)
    const outW = Math.max(1, Math.round(w * scale))
    const outH = Math.max(1, Math.round(h * scale))
    limited(() =>
      createImageBitmap(blob, x, y, w, h, {
        resizeWidth: outW,
        resizeHeight: outH,
        resizeQuality: 'high',
      }),
    )
      .catch(() => createImageBitmap(blob))
      .then((bitmap) => {
        if (cancelled) {
          bitmap.close()
          return
        }
        canvas.width = outW
        canvas.height = outH
        canvas.getContext('2d')?.drawImage(bitmap, 0, 0, outW, outH)
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
