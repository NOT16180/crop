<script lang="ts">
  import type { DrawingRecord, FolderRecord, Rect } from './db'
  import { normalizeText } from './search'
  import Thumb from './Thumb.svelte'
  import Crop from './Crop.svelte'

  export type GalleryItem = {
    key: string
    drawing: DrawingRecord
    box: Rect | null
    label?: string
  }

  type Props = {
    folderDrawings: DrawingRecord[]
    hasFilters: boolean
    items: GalleryItem[]
    pagedItems: GalleryItem[]
    visibleCount: number
    pageSize: number
    searching: boolean
    selectedTagLabels: string[]
    sortMode: 'manual' | 'name' | 'newest' | 'oldest'
    sheetSize: string
    folders: FolderRecord[]
    selectedFolderId: string
    tagSuggestions?: { label: string; count: number }[]
    activeSearchQuery: string
    drawingDisplayName: (drawing: DrawingRecord) => string
    onselectdrawing: (item: GalleryItem) => void
    onrepairdrawing: (drawing: DrawingRecord) => void
    oncopycrop: (blob: Blob, box: Rect | null, name: string) => void
    ondownloadcrop: (blob: Blob, box: Rect | null, baseName: string) => void
    onexportsheet: () => void
    onmovedrawing: (id: string, offset: number) => void
    onswapdrawings: (sourceId: string, targetId: string) => void
    onmoveselected: (folderId: string | undefined, ids: string[]) => void
    ondeleteselected: (ids: string[]) => void
    onbulktag: (tag: string, ids: string[]) => void
    onloadmore: () => void
    onsortchange: (mode: 'manual' | 'name' | 'newest' | 'oldest') => void
    onsheetsizechange: (size: string) => void
    ondragstart?: (id: string) => void
    ondragend?: () => void
  }

  let {
    folderDrawings,
    hasFilters,
    items,
    pagedItems,
    visibleCount,
    pageSize,
    searching,
    selectedTagLabels,
    sortMode,
    sheetSize,
    folders,
    selectedFolderId,
    tagSuggestions = [],
    activeSearchQuery,
    drawingDisplayName,
    onselectdrawing,
    onrepairdrawing,
    oncopycrop,
    ondownloadcrop,
    onexportsheet,
    onmovedrawing,
    onswapdrawings,
    onmoveselected,
    ondeleteselected,
    onbulktag,
    onloadmore,
    onsortchange,
    onsheetsizechange,
    ondragstart,
    ondragend,
  }: Props = $props()

  let selectionMode = $state(false)
  let arrangingDrawings = $state(false)
  let selectedDrawingIds = $state<string[]>([])
  let bulkFolderId = $state('__unfiled__')
  let bulkTagInput = $state('')
  let activeBulkSuggestion = $state(-1)

  const bulkSuggestions = $derived.by(() => {
    const val = normalizeText(bulkTagInput)
    if (!val || !tagSuggestions?.length) return []
    return tagSuggestions
      .filter((entry) => {
        const norm = normalizeText(entry.label)
        return norm !== val && norm.includes(val)
      })
      .slice(0, 6)
  })

  function onBulkSuggestionKeydown(event: KeyboardEvent) {
    if (!bulkSuggestions.length) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      activeBulkSuggestion = event.key === 'ArrowDown'
        ? (activeBulkSuggestion + 1) % bulkSuggestions.length
        : (activeBulkSuggestion <= 0 ? bulkSuggestions.length - 1 : activeBulkSuggestion - 1)
    } else if (event.key === 'Enter' && activeBulkSuggestion >= 0) {
      event.preventDefault()
      bulkTagInput = bulkSuggestions[activeBulkSuggestion].label
      activeBulkSuggestion = -1
    } else if (event.key === 'Escape') {
      event.preventDefault()
      activeBulkSuggestion = -1
    }
  }
  let draggedDrawingId = $state<string | null>(null)
  let suppressCardClick = false

  function toggleDrawingSelection(id: string, checked: boolean) {
    selectedDrawingIds = checked
      ? [...new Set([...selectedDrawingIds, id])]
      : selectedDrawingIds.filter((selected) => selected !== id)
  }

  function selectAllVisible() {
    selectedDrawingIds = [...new Set(items.map((item) => item.drawing.id))]
  }

  function handleMoveSelected() {
    if (selectedDrawingIds.length === 0) return
    const targetFolder = bulkFolderId === '__unfiled__' ? undefined : bulkFolderId
    onmoveselected(targetFolder, selectedDrawingIds)
    selectedDrawingIds = []
    selectionMode = false
  }

  function handleDeleteSelected() {
    if (selectedDrawingIds.length === 0) return
    ondeleteselected(selectedDrawingIds)
    selectedDrawingIds = []
    selectionMode = false
  }

  function handleBulkTag() {
    const label = bulkTagInput.trim()
    if (!label || selectedDrawingIds.length === 0) return
    onbulktag(label, selectedDrawingIds)
    bulkTagInput = ''
  }

  function startDrawingDrag(event: DragEvent, drawingId: string) {
    draggedDrawingId = drawingId
    ondragstart?.(drawingId)
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move'
      event.dataTransfer.setData('text/plain', drawingId)
    }
  }

  function endDrawingDrag() {
    draggedDrawingId = null
    ondragend?.()
  }

  async function dropDrawing(event: DragEvent, targetId: string) {
    event.preventDefault()
    event.stopPropagation()
    const sourceId = draggedDrawingId ?? event.dataTransfer?.getData('text/plain')
    draggedDrawingId = null
    ondragend?.()
    if (!sourceId || sourceId === targetId) return
    suppressCardClick = true
    window.setTimeout(() => (suppressCardClick = false), 0)

    onswapdrawings(sourceId, targetId)
  }

  function openCard(item: GalleryItem) {
    if (suppressCardClick) {
      suppressCardClick = false
      return
    }
    onselectdrawing(item)
  }
</script>

{#if folderDrawings.length === 0 && !hasFilters}
  <p class="results-title">This folder is empty. Add images to it.</p>
{:else if items.length > 0}
  <div class="library-actions">
    {#if !selectionMode}
      <button type="button" onclick={() => { selectionMode = true; arrangingDrawings = false; selectedDrawingIds = []; bulkFolderId = selectedFolderId || '__unfiled__' }}>Select images</button>
    {/if}
    {#if !arrangingDrawings}
      <button type="button" onclick={() => { arrangingDrawings = true; selectionMode = false }}>Arrange images</button>
    {:else}
      <button type="button" onclick={() => (arrangingDrawings = false)}>Done arranging</button>
    {/if}
    <button type="button" onclick={onexportsheet} disabled={items.length === 0} title="Export the images shown as one PNG sheet you can share">Export sheet</button>
    <label>Sheet
      <select value={sheetSize} onchange={(e) => onsheetsizechange(e.currentTarget.value)} aria-label="Number of images on the sheet">
        <option value="6">6 images</option>
        <option value="12">12 images</option>
        <option value="24">24 images</option>
        <option value="48">48 images</option>
        <option value="all">All images ({items.length})</option>
      </select>
    </label>
    <label>Sort
      <select value={sortMode} onchange={(e) => onsortchange(e.currentTarget.value as 'manual' | 'name' | 'newest' | 'oldest')} aria-label="Sort images">
        <option value="manual">Manual order</option>
        <option value="name">Name</option>
        <option value="newest">Newest first</option>
        <option value="oldest">Oldest first</option>
      </select>
    </label>
    {#if selectionMode}
      <span>{selectedDrawingIds.length} selected</span>
      <button type="button" onclick={selectAllVisible}>Select all visible</button>
      <label>Move to
        <select bind:value={bulkFolderId}>
          <option value="__unfiled__">Unfiled</option>
          {#each folders as folder (folder.id)}<option value={folder.id}>{folder.name}</option>{/each}
        </select>
      </label>
      <button type="button" onclick={handleMoveSelected} disabled={selectedDrawingIds.length === 0}>Move selected</button>
      <button type="button" class="danger" onclick={handleDeleteSelected} disabled={selectedDrawingIds.length === 0}>Delete selected</button>
      <button type="button" onclick={() => { selectionMode = false; selectedDrawingIds = [] }}>Cancel</button>
      <form class="bulk-tag-form" onsubmit={(e) => { e.preventDefault(); handleBulkTag() }}>
        <div class="tag-input-wrap">
          <input
            type="text"
            placeholder="Tag selected images…"
            bind:value={bulkTagInput}
            autocomplete="off"
            aria-label="Tag for selected images"
            role="combobox"
            aria-autocomplete="list"
            aria-haspopup="listbox"
            aria-controls="bulk-tag-suggestions"
            aria-expanded={bulkSuggestions.length > 0}
            aria-activedescendant={activeBulkSuggestion >= 0 && bulkSuggestions.length > 0 ? `bulk-tag-${activeBulkSuggestion}` : undefined}
            onkeydown={onBulkSuggestionKeydown}
            oninput={() => (activeBulkSuggestion = -1)}
          />
          {#if bulkSuggestions.length > 0}
            <div class="autocomplete-list" id="bulk-tag-suggestions" role="listbox" aria-label="Tag suggestions">
              {#each bulkSuggestions as entry, index (entry.label)}
                <button
                  type="button"
                  id="bulk-tag-{index}"
                  role="option"
                  aria-selected={activeBulkSuggestion === index}
                  class:active={activeBulkSuggestion === index}
                  onclick={() => { bulkTagInput = entry.label; activeBulkSuggestion = -1 }}
                >
                  {entry.label}<span>{entry.count}</span>
                </button>
              {/each}
            </div>
          {/if}
        </div>
        <button type="submit" disabled={!bulkTagInput.trim() || selectedDrawingIds.length === 0}>Tag selected</button>
      </form>
    {/if}
  </div>
  <ul class="grid">
    {#each pagedItems as item, index (item.key)}
      <li>
        <button
          class="card"
          style:aspect-ratio={item.box ? item.box[2] / item.box[3] : item.drawing.width / item.drawing.height}
          draggable={!searching && selectedTagLabels.length === 0 && sortMode === 'manual'}
          ondragstart={(event) => startDrawingDrag(event, item.drawing.id)}
          ondragend={endDrawingDrag}
          ondragover={(event) => {
            event.preventDefault()
            event.stopPropagation()
          }}
          ondrop={(event) => dropDrawing(event, item.drawing.id)}
          onclick={() => openCard(item)}
          aria-label={`Open ${drawingDisplayName(item.drawing)}`}
          title={activeSearchQuery ? item.drawing.name : `Drag to reorder: ${item.drawing.name}`}
        >
          {#if item.box}
            <Crop
              blob={item.drawing.blob}
              box={item.box}
              width={item.drawing.width}
              height={item.drawing.height}
              alt={item.drawing.name}
            />
            {#if item.label}<span class="badge">{item.label}</span>{/if}
          {:else}
            <Thumb blob={item.drawing.thumb} alt={item.drawing.name} onfail={() => onrepairdrawing(item.drawing)} />
          {/if}
        </button>
        <div class="drawing-meta">
          <span class="drawing-name" title={drawingDisplayName(item.drawing)}>{drawingDisplayName(item.drawing)}</span>
          {#if item.box}
            <div class="crop-actions">
              <button
                type="button"
                class="crop-btn"
                title="Copy crop to clipboard"
                onclick={(event) => { event.stopPropagation(); oncopycrop(item.drawing.blob, item.box, item.label ? `Crop "${item.label}"` : 'Crop') }}
              >Copy</button>
              <button
                type="button"
                class="crop-btn"
                title="Download crop as PNG"
                onclick={(event) => { event.stopPropagation(); ondownloadcrop(item.drawing.blob, item.box, `${item.drawing.name.replace(/\.[^.]+$/, '')}-${item.label ?? 'crop'}`) }}
              >Download</button>
            </div>
          {/if}
          {#if selectionMode}
            <label class="drawing-select">
              <input
                type="checkbox"
                checked={selectedDrawingIds.includes(item.drawing.id)}
                onchange={(event) => toggleDrawingSelection(item.drawing.id, event.currentTarget.checked)}
              />
              Select
            </label>
          {/if}
          {#if arrangingDrawings && !hasFilters && sortMode === 'manual'}
            <div class="reorder-buttons" aria-label="Reorder image {item.drawing.name}">
              <button type="button" disabled={index === 0} onclick={() => onmovedrawing(item.drawing.id, -1)} aria-label="Move image {item.drawing.name} earlier">↑</button>
              <button type="button" disabled={index === folderDrawings.length - 1} onclick={() => onmovedrawing(item.drawing.id, 1)} aria-label="Move image {item.drawing.name} later">↓</button>
            </div>
          {/if}
        </div>
      </li>
    {/each}
  </ul>
  {#if visibleCount < items.length}
    <button type="button" class="load-more" onclick={onloadmore}>Load {Math.min(pageSize, items.length - visibleCount)} more ({items.length - visibleCount} remaining)</button>
  {/if}
{/if}
