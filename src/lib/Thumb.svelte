<script lang="ts">
  import { detectImageMime } from './sync-protocol'

  let {
    blob,
    fallbackBlob,
    alt = '',
    onfail,
  }: {
    blob: Blob
    fallbackBlob?: Blob
    alt?: string
    onfail?: () => void
  } = $props()

  let container = $state<HTMLSpanElement | undefined>()
  let nearViewport = $state(typeof IntersectionObserver === 'undefined')
  let url = $state('')
  let attempt = $state(0)
  let reported = false

  $effect(() => {
    const node = container
    if (!node || typeof IntersectionObserver === 'undefined') {
      nearViewport = true
      return
    }
    if (nearViewport) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          nearViewport = true
          observer.disconnect()
        }
      },
      { rootMargin: '500px 0px' },
    )
    observer.observe(node)
    return () => observer.disconnect()
  })

  // Materialize IndexedDB-backed blobs into pure in-memory Blobs before creating
  // an object URL. iOS Safari / WebKit drops file-backed IDB blob handles under
  // scrolling or loading="lazy", producing broken blue "?" tiles.
  $effect(() => {
    const primary = blob
    const fallback = fallbackBlob
    const currentAttempt = attempt
    if (!nearViewport) return

    let cancelled = false
    let activeUrl = ''

    const source = currentAttempt === 0 ? primary : (fallback ?? primary)
    reported = currentAttempt > 0

    void (async () => {
      try {
        if (!source || source.size === 0) throw new Error('Empty blob')
        const buffer = await source.arrayBuffer()
        if (cancelled) return
        const mime = detectImageMime(new Uint8Array(buffer)) ?? (source.type || 'image/jpeg')
        const memBlob = new Blob([buffer], { type: mime })
        activeUrl = URL.createObjectURL(memBlob)
        url = activeUrl
      } catch {
        if (cancelled) return
        if (currentAttempt === 0 && fallback && fallback !== primary) {
          attempt = 1
          if (!reported) {
            reported = true
            onfail?.()
          }
        }
      }
    })()

    return () => {
      cancelled = true
      if (activeUrl) {
        if (url === activeUrl) url = ''
        URL.revokeObjectURL(activeUrl)
      }
    }
  })

  // Reset attempt counter when a fresh blob prop arrives (e.g. after repair).
  $effect(() => {
    void blob
    attempt = 0
    reported = false
  })

  function handleError() {
    if (!reported) {
      reported = true
      onfail?.()
    }
    if (attempt === 0 && fallbackBlob) {
      attempt = 1
    } else if (attempt < 2) {
      window.setTimeout(() => {
        attempt += 1
      }, 250)
    }
  }
</script>

<span class="thumb-frame" bind:this={container}>
  {#if url}
    <img src={url} {alt} decoding="async" draggable="false" onerror={handleError} />
  {/if}
</span>

<style>
  .thumb-frame {
    display: block;
    width: 100%;
    height: 100%;
  }

  img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: contain;
  }
</style>
