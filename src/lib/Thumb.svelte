<script lang="ts">
  let { blob, alt = '', onfail }: { blob: Blob; alt?: string; onfail?: () => void } = $props()

  let url = $state('')
  let image: HTMLImageElement | undefined = $state()
  let reported = false

  $effect(() => {
    const objectUrl = URL.createObjectURL(blob)
    url = objectUrl
    reported = false
    return () => URL.revokeObjectURL(objectUrl)
  })

  // A stored thumbnail can be unreadable; ask the app to rebuild it rather than
  // leave a broken image in the grid. Bound as a listener because `onerror` is
  // not part of the typed props of an <img>.
  $effect(() => {
    const node = image
    if (!node) return
    const handler = () => {
      if (reported) return
      reported = true
      onfail?.()
    }
    node.addEventListener('error', handler)
    return () => node.removeEventListener('error', handler)
  })
</script>

{#if url}
  <img bind:this={image} src={url} {alt} loading="lazy" decoding="async" draggable="false" />
{/if}

<style>
  img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: contain;
  }
</style>
