<script lang="ts">
  let { blob, alt = '' }: { blob: Blob; alt?: string } = $props()

  let url = $state('')

  $effect(() => {
    const objectUrl = URL.createObjectURL(blob)
    url = objectUrl
    return () => URL.revokeObjectURL(objectUrl)
  })
</script>

{#if url}
  <img src={url} {alt} loading="lazy" decoding="async" draggable="false" />
{/if}

<style>
  img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: contain;
  }
</style>
