<script lang="ts">
  import { onMount } from 'svelte'
  import { db, removeLegacyAnalysisData, requestPersistence, type DrawingRecord, type Rect, type Tag } from './lib/db'
  import { importFiles, deleteDrawings, isAcceptedImage } from './lib/images'
  import { findTagged, normalizeText } from './lib/search'
  import Thumb from './lib/Thumb.svelte'
  import Crop from './lib/Crop.svelte'

  type Item = { key: string; drawing: DrawingRecord; box: Rect | null; label?: string }
  type Selection = { x: number; y: number; w: number; h: number }
  type Corner = 'nw' | 'ne' | 'sw' | 'se'
  type ResizeSession = {
    tagId: string
    corner: Corner
    original: Rect
    current: Rect
  }

  let drawings = $state.raw<DrawingRecord[]>([])
  let query = $state('')
  let dragging = $state(false)
  let error = $state('')
  let theme = $state<'dark' | 'light'>('dark')
  let showTagOverlays = $state(true)

  let viewerId = $state<string | null>(null)
  let viewerBox = $state.raw<Rect | null>(null)
  let viewerUrl = $state('')
  let selection = $state<Selection | null>(null)
  let resizing = $state<ResizeSession | null>(null)
  let tagInput = $state('')
  let dragStart: { x: number; y: number } | null = null
  let imageBox: HTMLDivElement | undefined = $state()
  let fileInput: HTMLInputElement

  const byId = $derived(new Map(drawings.map((d) => [d.id, d])))
  const viewer = $derived(viewerId ? (byId.get(viewerId) ?? null) : null)
  const searching = $derived(query.trim().length > 0)
  const items = $derived<Item[]>(
    searching
      ? findTagged(query, drawings).map((hit, i) => ({
          key: `${hit.drawing.id}:${i}`,
          drawing: hit.drawing,
          box: hit.box,
          label: hit.label,
        }))
      : drawings.map((d) => ({ key: d.id, drawing: d, box: null })),
  )
  const tagList = $derived.by(() => {
    const counts = new Map<string, { label: string; count: number }>()
    for (const d of drawings) {
      for (const t of d.tags) {
        const key = normalizeText(t.label)
        const entry = counts.get(key)
        if (entry) entry.count++
        else counts.set(key, { label: t.label, count: 1 })
      }
    }
    return [...counts.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
  })
  const searchSuggestions = $derived.by(() => {
    const value = normalizeText(query)
    if (!value) return []
    return tagList
      .filter((entry) => {
        const label = normalizeText(entry.label)
        return label !== value && label.includes(value)
      })
      .slice(0, 6)
  })
  const tagSuggestions = $derived.by(() => {
    const value = normalizeText(tagInput)
    if (!value) return []
    return tagList
      .filter((entry) => {
        const label = normalizeText(entry.label)
        return label !== value && label.includes(value)
      })
      .slice(0, 6)
  })

  async function reload() {
    const all = await db.drawings.orderBy('createdAt').reverse().toArray()
    drawings = all.map((d) => ({ ...d, tags: d.tags ?? [] }))
  }

  onMount(async () => {
    try {
      theme = window.localStorage.getItem('drawing-library-theme') === 'light' ? 'light' : 'dark'
    } catch {
      theme = 'dark'
    }
    document.documentElement.dataset.theme = theme
    requestPersistence()
    try {
      await removeLegacyAnalysisData()
    } catch {
      // Cleanup is optional.
    }
    await reload()
  })

  function toggleTheme() {
    theme = theme === 'dark' ? 'light' : 'dark'
    document.documentElement.dataset.theme = theme
    try {
      window.localStorage.setItem('drawing-library-theme', theme)
    } catch {
      // The theme remains active for this session if storage is unavailable.
    }
  }

  async function addFiles(files: File[]) {
    error = ''
    const valid = files.filter(isAcceptedImage)
    if (valid.length === 0) {
      error = 'Unsupported file format. Use PNG, JPG, or WebP.'
      return
    }
    await importFiles(valid)
    await reload()
  }

  function onDrop(event: DragEvent) {
    event.preventDefault()
    dragging = false
    addFiles([...(event.dataTransfer?.files ?? [])])
  }

  async function saveTags(id: string, tags: Tag[]) {
    await db.drawings.update(id, { tags })
    drawings = drawings.map((d) => (d.id === id ? { ...d, tags } : d))
  }

  async function addTag() {
    const drawing = viewer
    const label = tagInput.trim()
    if (!drawing || !label) return
    const box: Rect | null = selection
      ? [
          Math.round(selection.x * drawing.width),
          Math.round(selection.y * drawing.height),
          Math.max(1, Math.round(selection.w * drawing.width)),
          Math.max(1, Math.round(selection.h * drawing.height)),
        ]
      : null
    tagInput = ''
    selection = null
    await saveTags(drawing.id, [...drawing.tags, { id: crypto.randomUUID(), label, box }])
  }

  async function removeTag(drawing: DrawingRecord, tagId: string) {
    await saveTags(drawing.id, drawing.tags.filter((t) => t.id !== tagId))
  }

  async function remove(drawing: DrawingRecord) {
    if (!confirm(`Delete “${drawing.name}”?`)) return
    await deleteDrawings([drawing.id])
    closeViewer()
    await reload()
  }

  function openViewer(item: Item) {
    closeViewer()
    showTagOverlays = true
    viewerId = item.drawing.id
    viewerBox = item.box
    viewerUrl = URL.createObjectURL(item.drawing.blob)
  }

  function closeViewer() {
    if (viewerUrl) URL.revokeObjectURL(viewerUrl)
    viewerUrl = ''
    viewerId = null
    viewerBox = null
    selection = null
    resizing = null
    tagInput = ''
    dragStart = null
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key !== 'Escape') return
    if (selection) selection = null
    else closeViewer()
  }

  function pointOnImage(e: PointerEvent) {
    const r = imageBox!.getBoundingClientRect()
    const clamp = (v: number) => Math.min(1, Math.max(0, v))
    return { x: clamp((e.clientX - r.left) / r.width), y: clamp((e.clientY - r.top) / r.height) }
  }

  function startSelection(e: PointerEvent) {
    if (e.button !== 0 || resizing) return
    imageBox!.setPointerCapture(e.pointerId)
    dragStart = pointOnImage(e)
    selection = null
  }

  function moveSelection(e: PointerEvent) {
    const p = pointOnImage(e)
    if (resizing && viewer) {
      resizing = { ...resizing, current: resizeRect(resizing, p, viewer) }
      return
    }
    if (!dragStart) return
    selection = {
      x: Math.min(dragStart.x, p.x),
      y: Math.min(dragStart.y, p.y),
      w: Math.abs(p.x - dragStart.x),
      h: Math.abs(p.y - dragStart.y),
    }
  }

  function startResize(e: PointerEvent, tag: Tag, corner: Corner) {
    if (e.button !== 0 || !tag.box || !viewer || !imageBox) return
    e.preventDefault()
    e.stopPropagation()
    imageBox.setPointerCapture(e.pointerId)
    resizing = {
      tagId: tag.id,
      corner,
      original: [...tag.box] as Rect,
      current: [...tag.box] as Rect,
    }
    selection = null
    dragStart = null
  }

  function resizeRect(session: ResizeSession, point: { x: number; y: number }, drawing: DrawingRecord): Rect {
    const [x, y, width, height] = session.original
    let left = x
    let top = y
    let right = x + width
    let bottom = y + height
    const pointerX = Math.round(Math.max(0, Math.min(1, point.x)) * drawing.width)
    const pointerY = Math.round(Math.max(0, Math.min(1, point.y)) * drawing.height)

    if (session.corner.includes('w')) left = Math.min(pointerX, right - 1)
    if (session.corner.includes('e')) right = Math.max(pointerX, left + 1)
    if (session.corner.includes('n')) top = Math.min(pointerY, bottom - 1)
    if (session.corner.includes('s')) bottom = Math.max(pointerY, top + 1)

    left = Math.max(0, left)
    top = Math.max(0, top)
    right = Math.min(drawing.width, right)
    bottom = Math.min(drawing.height, bottom)
    return [left, top, Math.max(1, right - left), Math.max(1, bottom - top)]
  }

  function displayedBox(tag: Tag): Rect {
    if (resizing?.tagId === tag.id) return resizing.current
    return tag.box ?? [0, 0, 1, 1]
  }

  async function endSelection(e?: PointerEvent) {
    if (resizing && viewer) {
      if (e) resizing = { ...resizing, current: resizeRect(resizing, pointOnImage(e), viewer) }
      const session = resizing
      const tags = viewer.tags.map((tag) =>
        tag.id === session.tagId ? { ...tag, box: session.current } : tag,
      )
      resizing = null
      await saveTags(viewer.id, tags)
      return
    }
    if (!dragStart) return
    dragStart = null
    // A click or a tiny drag does not count as a selection.
    if (selection && (selection.w < 0.02 || selection.h < 0.02)) selection = null
  }

  const pct = (value: number, total: number) => `${(value / total) * 100}%`
</script>

<svelte:window
  onkeydown={onKeydown}
  ondragover={(e) => {
    e.preventDefault()
    dragging = true
  }}
  ondragleave={(e) => {
    if (!e.relatedTarget) dragging = false
  }}
  ondrop={onDrop}
/>

<header>
  <h1>Cropart</h1>
  <form class="search-form" onsubmit={(e) => e.preventDefault()}>
    <div class="search-control">
      <input
        type="search"
        placeholder="Search tags: face, hands, landscape…"
        bind:value={query}
        aria-label="Search tags"
        autocomplete="off"
      />
      {#if searching}
        <button type="button" class="clear-search" onclick={() => (query = '')} aria-label="Clear search" title="Clear search">×</button>
      {/if}
      {#if searchSuggestions.length > 0}
        <div class="autocomplete-list" role="listbox" aria-label="Tag suggestions">
          {#each searchSuggestions as entry (entry.label)}
            <button type="button" role="option" onclick={() => (query = entry.label)}>
              {entry.label}<span>{entry.count}</span>
            </button>
          {/each}
        </div>
      {/if}
    </div>
  </form>
  <button
    class="theme-toggle"
    onclick={toggleTheme}
    aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
    aria-pressed={theme === 'light'}
    title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
  >{theme === 'dark' ? 'Light mode' : 'Dark mode'}</button>
  <button onclick={() => fileInput.click()}>Add</button>
  <input
    bind:this={fileInput}
    type="file"
    accept="image/png,image/jpeg,image/webp"
    multiple
    hidden
    onchange={(e) => {
      addFiles([...(e.currentTarget.files ?? [])])
      e.currentTarget.value = ''
    }}
  />
</header>

{#if tagList.length > 0}
  <nav class="tag-list" aria-label="Tags">
    {#each tagList as entry (entry.label)}
      <button onclick={() => (query = entry.label)}>{entry.label} ({entry.count})</button>
    {/each}
  </nav>
{/if}

{#if error}<p class="status error">{error}</p>{/if}

<main>
  {#if drawings.length === 0}
    <section class="empty">
      <h2>Your library is empty</h2>
      <p>Drop drawings here (PNG, JPG, WebP), or click “Add drawings”.</p>
      <p>Your library stays on this device.</p>
    </section>
  {:else}
    {#if searching}
      <p class="results-title">{items.length} {items.length === 1 ? 'result' : 'results'} for “{query.trim()}”</p>
    {/if}
    {#if searching && items.length === 0}
      <p class="results-title">No drawings match this tag. Open a drawing to add it.</p>
    {/if}
    <ul class="grid">
      {#each items as item (item.key)}
        <li>
          <button
            class="card"
            style:aspect-ratio={item.box ? item.box[2] / item.box[3] : item.drawing.width / item.drawing.height}
            onclick={() => openViewer(item)}
            title={item.drawing.name}
          >
            {#if item.box}
              <Crop blob={item.drawing.blob} box={item.box} alt={item.drawing.name} />
              {#if item.label}<span class="badge">{item.label}</span>{/if}
            {:else}
              <Thumb blob={item.drawing.thumb} alt={item.drawing.name} />
            {/if}
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</main>

{#if dragging}
  <div class="drop-overlay">Drop drawings here to add them</div>
{/if}

{#if viewer}
  <div class="viewer" role="dialog" aria-modal="true" aria-label={viewer.name}>
    <button class="viewer-backdrop" onclick={closeViewer} aria-label="Close viewer"></button>
    <figure style="max-height: calc(100vh - 32px); overflow-y: auto" tabindex="0" aria-label="Drawing and tag controls">
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        class="viewer-image"
        bind:this={imageBox}
        onpointerdown={startSelection}
        onpointermove={moveSelection}
        onpointerup={endSelection}
        onpointercancel={endSelection}
      >
        <img src={viewerUrl} alt={viewer.name} draggable="false" />
        {#if showTagOverlays}
          {#each viewer.tags as tag (tag.id)}
            {#if tag.box}
              {@const box = displayedBox(tag)}
              <span
                class:resizing={resizing?.tagId === tag.id}
                class="tag-box"
                style:left={pct(box[0], viewer.width)}
                style:top={pct(box[1], viewer.height)}
                style:width={pct(box[2], viewer.width)}
                style:height={pct(box[3], viewer.height)}
              >
                <em>{tag.label}</em>
                <button type="button" class="resize-handle nw" aria-label="Resize {tag.label}, top-left corner" onpointerdown={(event) => startResize(event, tag, 'nw')}></button>
                <button type="button" class="resize-handle ne" aria-label="Resize {tag.label}, top-right corner" onpointerdown={(event) => startResize(event, tag, 'ne')}></button>
                <button type="button" class="resize-handle sw" aria-label="Resize {tag.label}, bottom-left corner" onpointerdown={(event) => startResize(event, tag, 'sw')}></button>
                <button type="button" class="resize-handle se" aria-label="Resize {tag.label}, bottom-right corner" onpointerdown={(event) => startResize(event, tag, 'se')}></button>
              </span>
            {/if}
          {/each}
        {/if}
        {#if viewerBox && showTagOverlays}
          <span
            class="region"
            style:left={pct(viewerBox[0], viewer.width)}
            style:top={pct(viewerBox[1], viewer.height)}
            style:width={pct(viewerBox[2], viewer.width)}
            style:height={pct(viewerBox[3], viewer.height)}
          ></span>
        {/if}
        {#if selection}
          <span
            class="selection"
            style:left="{selection.x * 100}%"
            style:top="{selection.y * 100}%"
            style:width="{selection.w * 100}%"
            style:height="{selection.h * 100}%"
          ></span>
        {/if}
      </div>

      <form
        class="tag-form"
        onsubmit={(e) => {
          e.preventDefault()
          addTag()
        }}
      >
        <div class="tag-input-wrap">
          <input
            type="text"
            placeholder={selection ? 'Tag the selected area' : 'Tag the whole drawing (or drag to select an area)'}
            bind:value={tagInput}
            aria-label="New tag"
            autocomplete="off"
          />
          {#if tagSuggestions.length > 0}
            <div class="autocomplete-list" role="listbox" aria-label="Existing tags">
              {#each tagSuggestions as entry (entry.label)}
                <button type="button" role="option" onclick={() => (tagInput = entry.label)}>
                  {entry.label}<span>{entry.count}</span>
                </button>
              {/each}
            </div>
          {/if}
        </div>
        <button type="submit" disabled={!tagInput.trim()}>Add tag</button>
        {#if selection}
          <button type="button" onclick={() => (selection = null)}>Cancel selection</button>
        {/if}
      </form>

      {#if viewer.tags.length > 0}
        <ul class="tags">
          {#each viewer.tags as tag (tag.id)}
            <li>
              {tag.label}{tag.box ? ' (area)' : ''}
              <button onclick={() => viewer && removeTag(viewer, tag.id)} aria-label="Remove tag {tag.label}">×</button>
            </li>
          {/each}
        </ul>
      {/if}

      <figcaption>
        <span>{viewer.name} · {viewer.width}×{viewer.height}</span>
        <span>
          <button
            type="button"
            onclick={() => (showTagOverlays = !showTagOverlays)}
            aria-pressed={showTagOverlays}
            title={showTagOverlays ? 'Hide tag overlays without deleting tags' : 'Show tag overlays'}
          >{showTagOverlays ? 'Hide tags' : 'Show tags'}</button>
          <button onclick={() => viewer && remove(viewer)}>Delete drawing</button>
          <button onclick={closeViewer}>Close</button>
        </span>
      </figcaption>
    </figure>
  </div>
{/if}
