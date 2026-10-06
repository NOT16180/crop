<script lang="ts">
  import { onMount, tick } from 'svelte'
  import { db, removeLegacyAnalysisData, requestPersistence, type DrawingRecord, type FolderRecord, type Rect, type Tag } from './lib/db'
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
  let folders = $state.raw<FolderRecord[]>([])
  let selectedFolderId = $state('')
  let selectedTagLabels = $state<string[]>([])
  let tagMatchMode = $state<'all' | 'any'>('all')
  let sortMode = $state<'manual' | 'name' | 'newest' | 'oldest'>('manual')
  let selectionMode = $state(false)
  let arrangingDrawings = $state(false)
  let selectedDrawingIds = $state<string[]>([])
  let bulkFolderId = $state('__unfiled__')
  let pendingDelete = $state<DrawingRecord | null>(null)
  let notice = $state('')
  let draggedDrawingId = $state<string | null>(null)
  let suppressCardClick = false
  let query = $state('')
  let dragging = $state(false)
  let error = $state('')
  let theme = $state<'dark' | 'light'>('dark')
  let showHelp = $state(false)
  let showTagOverlays = $state(true)
  let visibleTagIds = $state<string[]>([])
  let zoom = $state(1)

  let viewerId = $state<string | null>(null)
  let viewerBox = $state.raw<Rect | null>(null)
  let viewerUrl = $state('')
  let selection = $state<Selection | null>(null)
  let resizing = $state<ResizeSession | null>(null)
  let tagInput = $state('')
  let dragStart: { x: number; y: number } | null = null
  let imageBox: HTMLDivElement | undefined = $state()
  let fileInput: HTMLInputElement
  let backupInput: HTMLInputElement
  let viewerDialog: HTMLDivElement | undefined = $state()
  let returnFocusTarget: HTMLElement | null = null
  let deleteTimer: ReturnType<typeof setTimeout> | undefined

  const byId = $derived(new Map(drawings.map((d) => [d.id, d])))
  const viewer = $derived(viewerId ? (byId.get(viewerId) ?? null) : null)
  const viewerTagGroups = $derived.by(() => {
    const groups = new Map<string, { label: string; tags: Tag[] }>()
    for (const tag of viewer?.tags ?? []) {
      const key = normalizeText(tag.label)
      const group = groups.get(key)
      if (group) group.tags.push(tag)
      else groups.set(key, { label: tag.label, tags: [tag] })
    }
    return [...groups.values()].sort((a, b) => a.label.localeCompare(b.label))
  })
  const folderDrawings = $derived((selectedFolderId
    ? drawings.filter((drawing) => drawing.folderId === selectedFolderId)
    : drawings).toSorted((a, b) => (a.position ?? 0) - (b.position ?? 0)))
  const sortedFolderDrawings = $derived(folderDrawings.toSorted((a, b) => {
    if (sortMode === 'name') return a.name.localeCompare(b.name) || (a.position ?? 0) - (b.position ?? 0)
    if (sortMode === 'newest') return b.createdAt - a.createdAt
    if (sortMode === 'oldest') return a.createdAt - b.createdAt
    return (a.position ?? 0) - (b.position ?? 0)
  }))
  const filteredDrawings = $derived(sortedFolderDrawings.filter((drawing) => {
    if (selectedTagLabels.length === 0) return true
    const labels = new Set(drawing.tags.map((tag) => normalizeText(tag.label)))
    return tagMatchMode === 'all'
      ? selectedTagLabels.every((label) => labels.has(label))
      : selectedTagLabels.some((label) => labels.has(label))
  }))
  const sortedDrawings = $derived(filteredDrawings)
  const searching = $derived(query.trim().length > 0)
  const hasFilters = $derived(searching || selectedTagLabels.length > 0)
  const activeSearchQuery = $derived(searching ? query : selectedTagLabels.length === 1 ? selectedTagLabels[0] : '')
  const searchCandidates = $derived(!searching && selectedTagLabels.length === 1 ? sortedFolderDrawings : sortedDrawings)
  const items = $derived<Item[]>(
    activeSearchQuery
      ? findTagged(activeSearchQuery, searchCandidates).map((hit, i) => ({
          key: `${hit.drawing.id}:${i}`,
          drawing: hit.drawing,
          box: hit.box,
          label: hit.label,
        }))
      : sortedDrawings.map((d) => ({ key: d.id, drawing: d, box: null })),
  )
  const tagList = $derived.by(() => {
    const counts = new Map<string, { label: string; count: number }>()
    for (const d of folderDrawings) {
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
    let nextPosition = Math.max(-1, ...all.map((drawing) => drawing.position ?? -1)) + 1
    const unpositioned = all.filter((drawing) => drawing.position === undefined)
    const hasSavedOrder = all.some((drawing) => drawing.position !== undefined)
    const initialPositions = new Map<string, number>()
    for (const drawing of unpositioned) {
      initialPositions.set(drawing.id, hasSavedOrder ? nextPosition++ : initialPositions.size)
    }
    if (initialPositions.size) {
      await Promise.all([...initialPositions].map(([id, position]) => db.drawings.update(id, { position })))
    }
    drawings = all.map((drawing) => ({
      ...drawing,
      position: initialPositions.get(drawing.id) ?? drawing.position,
      tags: drawing.tags ?? [],
    })).sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    folders = await db.folders.orderBy('name').toArray()
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
    const imported = await importFiles(valid)
    let position = drawings.reduce((max, drawing) => Math.max(max, drawing.position ?? -1), -1) + 1
    await Promise.all(imported.map((drawing) => db.drawings.update(drawing.id, {
      ...(selectedFolderId ? { folderId: selectedFolderId } : {}),
      position: position++,
    })))
    await reload()
  }

  function startDrawingDrag(event: DragEvent, drawingId: string) {
    draggedDrawingId = drawingId
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move'
      event.dataTransfer.setData('text/plain', drawingId)
    }
  }

  async function dropDrawing(event: DragEvent, targetId: string) {
    event.preventDefault()
    event.stopPropagation()
    const sourceId = draggedDrawingId ?? event.dataTransfer?.getData('text/plain')
    draggedDrawingId = null
    if (!sourceId || sourceId === targetId) return
    suppressCardClick = true
    window.setTimeout(() => (suppressCardClick = false), 0)

    await swapDrawings(sourceId, targetId)
  }

  async function swapDrawings(sourceId: string, targetId: string) {
    const arranged = [...drawings].sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    const visible = [...folderDrawings]
    const sourceIndex = visible.findIndex((drawing) => drawing.id === sourceId)
    const targetIndex = visible.findIndex((drawing) => drawing.id === targetId)
    if (sourceIndex < 0 || targetIndex < 0) return
    ;[visible[sourceIndex], visible[targetIndex]] = [visible[targetIndex], visible[sourceIndex]]

    const visibleIds = new Set(visible.map((drawing) => drawing.id))
    const replacement = new Map(visible.map((drawing) => [drawing.id, drawing]))
    const slots = arranged.map((drawing, index) => visibleIds.has(drawing.id) ? index : -1).filter((index) => index >= 0)
    for (let index = 0; index < slots.length; index++) {
      arranged[slots[index]] = replacement.get(visible[index].id)!
    }
    const updates = arranged.map((drawing, position) => ({ id: drawing.id, position }))
    await Promise.all(updates.map(({ id, position }) => db.drawings.update(id, { position })))
    drawings = arranged.map((drawing, position) => ({ ...drawing, position }))
  }

  async function moveDrawing(id: string, offset: number) {
    if (searching || selectedTagLabels.length) return
    const index = folderDrawings.findIndex((drawing) => drawing.id === id)
    const target = folderDrawings[index + offset]
    if (index < 0 || !target) return
    await swapDrawings(id, target.id)
  }

  function openCard(item: Item) {
    if (suppressCardClick) {
      suppressCardClick = false
      return
    }
    openViewer(item)
  }

  function drawingDisplayName(drawing: DrawingRecord) {
    const duplicate = drawings.some((candidate) => candidate.id !== drawing.id && candidate.name === drawing.name)
    if (!duplicate) return drawing.name
    const date = new Date(drawing.createdAt)
    return `${drawing.name} · ${date.toLocaleDateString()} ${date.toLocaleTimeString()} · ${drawing.id.slice(0, 4)}`
  }

  async function createFolder() {
    const name = prompt('Folder name:')?.trim()
    if (!name) return
    const existing = folders.find((folder) => normalizeText(folder.name) === normalizeText(name))
    if (existing) {
      selectedFolderId = existing.id
      return
    }
    const folder = { id: crypto.randomUUID(), name }
    await db.folders.add(folder)
    folders = [...folders, folder].sort((a, b) => a.name.localeCompare(b.name))
    selectedFolderId = folder.id
    query = ''
  }

  async function renameFolder(folder: FolderRecord) {
    const name = prompt('New folder name:', folder.name)?.trim()
    if (!name || normalizeText(name) === normalizeText(folder.name)) return
    if (folders.some((candidate) => candidate.id !== folder.id && normalizeText(candidate.name) === normalizeText(name))) {
      error = 'A folder with that name already exists.'
      return
    }
    await db.folders.update(folder.id, { name })
    folders = folders.map((candidate) => candidate.id === folder.id ? { ...candidate, name } : candidate)
  }

  async function deleteFolder(folder: FolderRecord) {
    const count = drawings.filter((drawing) => drawing.folderId === folder.id).length
    if (!confirm(`Delete folder “${folder.name}”? ${count} image${count === 1 ? '' : 's'} will become unfiled.`)) return
    await Promise.all(drawings
      .filter((drawing) => drawing.folderId === folder.id)
      .map((drawing) => db.drawings.update(drawing.id, { folderId: undefined })))
    await db.folders.delete(folder.id)
    drawings = drawings.map((drawing) => drawing.folderId === folder.id
      ? { ...drawing, folderId: undefined }
      : drawing)
    folders = folders.filter((candidate) => candidate.id !== folder.id)
    if (selectedFolderId === folder.id) selectedFolderId = ''
  }

  function toggleDrawingSelection(id: string, checked: boolean) {
    selectedDrawingIds = checked
      ? [...new Set([...selectedDrawingIds, id])]
      : selectedDrawingIds.filter((selected) => selected !== id)
  }

  function selectAllVisible() {
    selectedDrawingIds = [...new Set(items.map((item) => item.drawing.id))]
  }

  async function moveSelectedDrawings() {
    if (selectedDrawingIds.length === 0) return
    const folderId = bulkFolderId === '__unfiled__' ? undefined : bulkFolderId
    await Promise.all(selectedDrawingIds.map((id) => db.drawings.update(id, { folderId })))
    const selected = new Set(selectedDrawingIds)
    drawings = drawings.map((drawing) => selected.has(drawing.id) ? { ...drawing, folderId } : drawing)
    selectedDrawingIds = []
    selectionMode = false
    notice = `Moved images to ${folders.find((folder) => folder.id === folderId)?.name ?? 'Unfiled'}.`
  }

  async function backupLibrary() {
    try {
      const { downloadBackup } = await import('./lib/backup')
      await downloadBackup()
      notice = 'Backup downloaded.'
      error = ''
    } catch {
      error = 'Could not create the backup. Check available device storage and try again.'
    }
  }

  async function restoreLibrary(file: File) {
    if (!confirm('Import this backup into Crop? Its images will be added to your current library.')) return
    try {
      const { restoreBackup } = await import('./lib/backup')
      const result = await restoreBackup(file)
      await reload()
      notice = `Restored ${result.drawings} image${result.drawings === 1 ? '' : 's'} and ${result.folders} folder${result.folders === 1 ? '' : 's'}.`
      error = ''
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Could not restore this backup.'
    }
  }

  async function moveToFolder(drawing: DrawingRecord, folderId: string) {
    await db.drawings.update(drawing.id, { folderId: folderId || undefined })
    drawings = drawings.map((item) => item.id === drawing.id
      ? { ...item, folderId: folderId || undefined }
      : item)
  }

  function onDrop(event: DragEvent) {
    event.preventDefault()
    dragging = false
    addFiles([...(event.dataTransfer?.files ?? [])])
  }

  async function onPaste(event: ClipboardEvent) {
    const files = [...(event.clipboardData?.items ?? [])]
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null)
    if (!files.length) return
    event.preventDefault()
    await addFiles(files)
    if (!error) notice = `Pasted ${files.length} image${files.length === 1 ? '' : 's'} from the clipboard.`
  }

  function toggleTagFilter(label: string, checked: boolean) {
    const key = normalizeText(label)
    selectedTagLabels = checked
      ? [...new Set([...selectedTagLabels, key])]
      : selectedTagLabels.filter((selected) => selected !== key)
  }

  async function saveTags(id: string, tags: Tag[]) {
    await db.drawings.update(id, { tags, visibleTagIds })
    drawings = drawings.map((d) => (d.id === id ? { ...d, tags, visibleTagIds } : d))
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
    const tag: Tag = { id: crypto.randomUUID(), label, box }
    error = ''
    try {
      const nextVisibleTagIds = [...new Set([...visibleTagIds, tag.id])]
      await db.drawings.update(drawing.id, { tags: [...drawing.tags, tag], visibleTagIds: nextVisibleTagIds })
      visibleTagIds = nextVisibleTagIds
      drawings = drawings.map((item) => item.id === drawing.id
        ? { ...item, tags: [...drawing.tags, tag], visibleTagIds: nextVisibleTagIds }
        : item)
      tagInput = ''
      selection = null
    } catch (cause) {
      console.error('Could not save tag', cause)
      error = 'Could not save the tag. Check that browser storage is available, then try again.'
    }
  }

  async function removeTag(drawing: DrawingRecord, tagId: string) {
    visibleTagIds = visibleTagIds.filter((id) => id !== tagId)
    await saveTags(drawing.id, drawing.tags.filter((t) => t.id !== tagId))
  }

  async function toggleTagVisibility(tagId: string, visible: boolean) {
    visibleTagIds = visible
      ? [...new Set([...visibleTagIds, tagId])]
      : visibleTagIds.filter((id) => id !== tagId)
    if (!viewer) return
    await db.drawings.update(viewer.id, { visibleTagIds })
    drawings = drawings.map((drawing) => drawing.id === viewer!.id
      ? { ...drawing, visibleTagIds }
      : drawing)
  }

  async function toggleTagGroupVisibility(tagIds: string[], visible: boolean) {
    const ids = new Set(tagIds)
    visibleTagIds = visible
      ? [...new Set([...visibleTagIds, ...tagIds])]
      : visibleTagIds.filter((id) => !ids.has(id))
    if (!viewer) return
    await db.drawings.update(viewer.id, { visibleTagIds })
    drawings = drawings.map((drawing) => drawing.id === viewer!.id
      ? { ...drawing, visibleTagIds }
      : drawing)
  }

  async function remove(drawing: DrawingRecord) {
    if (!confirm(`Delete “${drawing.name}”?`)) return
    await deleteDrawings([drawing.id])
    if (deleteTimer) clearTimeout(deleteTimer)
    pendingDelete = drawing
    deleteTimer = window.setTimeout(() => {
      pendingDelete = null
      deleteTimer = undefined
    }, 8000)
    drawings = drawings.filter((item) => item.id !== drawing.id)
    selectedDrawingIds = selectedDrawingIds.filter((id) => id !== drawing.id)
    closeViewer()
    notice = `“${drawing.name}” deleted.`
  }

  async function undoDelete() {
    if (!pendingDelete) return
    const drawingToRestore = pendingDelete
    if (deleteTimer) clearTimeout(deleteTimer)
    deleteTimer = undefined
    const restored = drawingToRestore.folderId && !folders.some((folder) => folder.id === drawingToRestore.folderId)
      ? { ...drawingToRestore, folderId: undefined }
      : drawingToRestore
    await db.drawings.add(restored)
    pendingDelete = null
    await reload()
    notice = 'Image restored.'
  }

  function openViewer(item: Item) {
    returnFocusTarget = document.activeElement instanceof HTMLElement ? document.activeElement : null
    closeViewer()
    showTagOverlays = true
    visibleTagIds = item.drawing.visibleTagIds ?? item.drawing.tags.map((tag) => tag.id)
    zoom = 1
    viewerId = item.drawing.id
    viewerBox = item.box
    viewerUrl = URL.createObjectURL(item.drawing.blob)
    void tick().then(() => viewerDialog?.querySelector<HTMLElement>('.zoom-controls button:not([disabled])')?.focus())
  }

  function closeViewer() {
    const shouldRestoreFocus = Boolean(viewerId)
    if (viewerUrl) URL.revokeObjectURL(viewerUrl)
    viewerUrl = ''
    zoom = 1
    viewerId = null
    viewerBox = null
    selection = null
    resizing = null
    tagInput = ''
    dragStart = null
    if (shouldRestoreFocus) void tick().then(() => {
      if (returnFocusTarget?.isConnected) returnFocusTarget.focus()
      returnFocusTarget = null
    })
  }

  function changeZoom(amount: number) {
    zoom = Math.min(4, Math.max(0.5, Math.round((zoom + amount) * 100) / 100))
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      if (selection) selection = null
      else if (viewer) closeViewer()
      return
    }
    if (e.key !== 'Tab' || !viewerDialog) return
    const focusable = [...viewerDialog.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), summary, [tabindex="0"]')]
      .filter((element) => element.getClientRects().length > 0)
    if (!focusable.length) return
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (e.shiftKey && (document.activeElement === first || !viewerDialog.contains(document.activeElement))) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first.focus()
    }
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
  onpaste={onPaste}
  ondragover={(e) => {
    if (e.dataTransfer?.types.includes('Files')) {
      e.preventDefault()
      dragging = true
    }
  }}
  ondragleave={(e) => {
    if (!e.relatedTarget) dragging = false
  }}
  ondrop={onDrop}
/>

<header>
  <a class="brand-link" href="/" onclick={(event) => {
    event.preventDefault()
    showHelp = false
    selectedFolderId = ''
    selectedTagLabels = []
    query = ''
  }}><h1>CROP</h1></a>
  <form class="search-form" onsubmit={(e) => e.preventDefault()}>
    <div class="search-control">
      <input
        type="search"
        placeholder="Search images by tag (e.g. face, hands, landscape)…"
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
            <button type="button" role="option" aria-selected="false" onclick={() => (query = entry.label)}>
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
  <button type="button" aria-pressed={showHelp} onclick={() => (showHelp = !showHelp)}>{showHelp ? 'Back to library' : 'How to use'}</button>
  <button onclick={() => fileInput.click()} title="You can also paste a screenshot with Ctrl+V or ⌘V">Add</button>
  <button type="button" onclick={backupLibrary}>Backup</button>
  <button type="button" onclick={() => backupInput.click()}>Restore</button>
  <a class="support-link" href="https://ko-fi.com/not1618033" target="_blank" rel="noopener noreferrer">Coffee</a>
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
  <input
    bind:this={backupInput}
    type="file"
    accept=".zip,application/zip"
    hidden
    onchange={(event) => {
      const file = event.currentTarget.files?.[0]
      if (file) restoreLibrary(file)
      event.currentTarget.value = ''
    }}
  />
</header>

<nav class="folder-list" aria-label="Folders">
  <details class="folder-menu">
    <summary>
      Folder: {folders.find((folder) => folder.id === selectedFolderId)?.name ?? 'All images'}
      ({selectedFolderId
        ? drawings.filter((drawing) => drawing.folderId === selectedFolderId).length
        : drawings.length})
    </summary>
    <div class="folder-menu-content">
      <button aria-pressed={!selectedFolderId} onclick={() => { selectedFolderId = ''; query = '' }}>All images ({drawings.length})</button>
      {#each folders as folder (folder.id)}
        <div class="folder-entry">
          <button class="folder-select" aria-pressed={selectedFolderId === folder.id} onclick={() => { selectedFolderId = folder.id; query = '' }}>
            {folder.name} ({drawings.filter((drawing) => drawing.folderId === folder.id).length})
          </button>
          <button type="button" class="folder-action" onclick={() => renameFolder(folder)} aria-label="Rename {folder.name}">Rename</button>
          <button type="button" class="folder-action" onclick={() => deleteFolder(folder)} aria-label="Delete {folder.name}">Delete</button>
        </div>
      {/each}
      <button type="button" onclick={createFolder}>＋ New folder</button>
    </div>
  </details>
</nav>

{#if tagList.length > 0}
  <nav class="tag-list" aria-label="Tags">
    <details class="tag-filter-menu">
      <summary>Tags{searching ? ` · ${query.trim()}` : ''} ({tagList.length})</summary>
      <div class="tag-filter-content">
        <fieldset class="tag-filter-mode">
          <legend>Match</legend>
          <label><input type="radio" name="tag-match" checked={tagMatchMode === 'all'} onchange={() => (tagMatchMode = 'all')} /> All selected</label>
          <label><input type="radio" name="tag-match" checked={tagMatchMode === 'any'} onchange={() => (tagMatchMode = 'any')} /> Any selected</label>
        </fieldset>
        {#if selectedTagLabels.length}<button type="button" class="clear-tag-filters" onclick={() => (selectedTagLabels = [])}>Clear selected tags</button>{/if}
        {#each tagList as entry (entry.label)}
          <label class="tag-filter-option">
            <input type="checkbox" checked={selectedTagLabels.includes(normalizeText(entry.label))} onchange={(event) => toggleTagFilter(entry.label, event.currentTarget.checked)} />
            {entry.label}<span>{entry.count}</span>
          </label>
        {/each}
      </div>
    </details>
  </nav>
{/if}

{#if error}<p class="status error">{error}</p>{/if}
{#if notice}
  <p class="status notice">
    {notice}
    {#if pendingDelete}<button type="button" onclick={undoDelete}>Undo</button>{/if}
    <button type="button" onclick={() => (notice = '')} aria-label="Dismiss notification">×</button>
  </p>
{/if}

<main>
  {#if showHelp}
    <article class="help-page">
      <h2>How to use the image library</h2>
      <p>Add PNG, JPG, or WebP images with <strong>Add</strong>, by dropping files onto the page, or by pasting a screenshot.</p>

      <h3>Find images with tags</h3>
      <p>Type a tag in the search box to find matching images. Select a tag from the Tags menu to get the same results, including any tagged area. Select multiple tags to filter images that have all or any of those tags.</p>

      <h3>Add and manage tags</h3>
      <p>Open an image to add tags. Type a tag for the whole image, or drag over an area first to tag just that part. Use the Tags menu in the viewer to show, hide, or remove tags.</p>

      <h3>Organize your library</h3>
      <p>Create folders from the Folders menu and move images using the folder control in the viewer or the bulk selection tools. Sort by name or date, or arrange images manually.</p>

      <h3>Backups and display</h3>
      <p>Use <strong>Backup</strong> to download a copy of your library and <strong>Restore</strong> to import one. Switch between light and dark mode with the theme button.</p>

      <h3>Support this app</h3>
      <p>If you enjoy using the app, you can <a href="https://ko-fi.com/not1618033" target="_blank" rel="noopener noreferrer">support me on Ko-fi</a>. Donations are entirely optional.</p>
    </article>
  {:else}
  {#if drawings.length === 0}
    <section class="empty">
      <h2>Your library is empty</h2>
      <p>Drop images here (PNG, JPG, WebP), or click “Add images”.</p>
      <p>Your library stays on this device.</p>
    </section>
  {:else}
    {#if hasFilters}
      <p class="results-title">{items.length} {items.length === 1 ? 'image' : 'images'} match{activeSearchQuery ? ` “${activeSearchQuery.trim()}”` : ''}{selectedTagLabels.length > (activeSearchQuery && !searching ? 1 : 0) ? ` · ${selectedTagLabels.length} tags (${tagMatchMode === 'all' ? 'all' : 'any'})` : ''}.</p>
    {/if}
    {#if hasFilters && items.length === 0}
      <p class="results-title">No images match these filters.</p>
    {/if}
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
        <label>Sort
          <select bind:value={sortMode} aria-label="Sort images">
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
          <button type="button" onclick={moveSelectedDrawings} disabled={selectedDrawingIds.length === 0}>Move selected</button>
          <button type="button" onclick={() => { selectionMode = false; selectedDrawingIds = [] }}>Cancel</button>
        {/if}
      </div>
      <ul class="grid">
        {#each items as item, index (item.key)}
          <li>
            <button
              class="card"
              style:aspect-ratio={item.box ? item.box[2] / item.box[3] : item.drawing.width / item.drawing.height}
              draggable={!searching && selectedTagLabels.length === 0 && sortMode === 'manual'}
            ondragstart={(event) => startDrawingDrag(event, item.drawing.id)}
            ondragend={() => (draggedDrawingId = null)}
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
                <Crop blob={item.drawing.blob} box={item.box} alt={item.drawing.name} />
                {#if item.label}<span class="badge">{item.label}</span>{/if}
              {:else}
                <Thumb blob={item.drawing.thumb} alt={item.drawing.name} />
              {/if}
            </button>
            <div class="drawing-meta">
              <span class="drawing-name" title={drawingDisplayName(item.drawing)}>{drawingDisplayName(item.drawing)}</span>
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
                  <button type="button" disabled={index === 0} onclick={() => moveDrawing(item.drawing.id, -1)} aria-label="Move image {item.drawing.name} earlier">↑</button>
                  <button type="button" disabled={index === folderDrawings.length - 1} onclick={() => moveDrawing(item.drawing.id, 1)} aria-label="Move image {item.drawing.name} later">↓</button>
                </div>
              {/if}
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
  {/if}
</main>

{#if dragging}
  <div class="drop-overlay">Drop images here to add them</div>
{/if}

{#if viewer}
  <div class="viewer" bind:this={viewerDialog} role="dialog" aria-modal="true" aria-label={viewer.name} tabindex="-1">
    <button class="viewer-backdrop" onclick={closeViewer} aria-label="Close viewer"></button>
    <figure style="max-height: calc(100dvh - 24px); overflow: auto" aria-label="Image and tag controls">
      <div class="viewer-toolbar">
      <div class="zoom-controls" aria-label="Image zoom controls">
        <button type="button" onclick={() => changeZoom(-0.25)} disabled={zoom <= 0.5} aria-label="Zoom out" title="Zoom out">−</button>
        <span aria-live="polite">{Math.round(zoom * 100)}%</span>
        <button type="button" onclick={() => changeZoom(0.25)} disabled={zoom >= 4} aria-label="Zoom in" title="Zoom in">+</button>
        <button type="button" onclick={() => (zoom = 1)} disabled={zoom === 1} title="Reset zoom">Reset</button>
      </div>
      </div>
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        class="viewer-image"
        bind:this={imageBox}
        onpointerdown={startSelection}
        onpointermove={moveSelection}
        onpointerup={endSelection}
        onpointercancel={endSelection}
      >
        <img
          src={viewerUrl}
          alt={viewer.name}
          draggable="false"
          style:max-width={`calc((100vw - 32px) * ${zoom})`}
          style:max-height={`calc((100dvh - 260px) * ${zoom})`}
        />
        {#if showTagOverlays}
          {#each viewer.tags as tag (tag.id)}
            {#if tag.box && visibleTagIds.includes(tag.id)}
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
          <div class="whole-tags" aria-label="Whole image tags">
            {#each viewer.tags.filter((tag) => !tag.box && visibleTagIds.includes(tag.id)) as tag (tag.id)}
              <span>{tag.label}</span>
            {/each}
          </div>
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
            placeholder={selection ? 'Tag the selected area' : 'Tag the whole image (or drag to select an area)'}
            bind:value={tagInput}
            aria-label="New tag"
            autocomplete="off"
          />
          {#if tagSuggestions.length > 0}
            <div class="autocomplete-list" role="listbox" aria-label="Existing tags">
              {#each tagSuggestions as entry (entry.label)}
                <button type="button" role="option" aria-selected="false" onclick={() => (tagInput = entry.label)}>
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
        {#if error}<p class="status error" role="alert">{error}</p>{/if}
      </form>

      <label class="drawing-folder">Folder
        <select value={viewer.folderId ?? ''} onchange={(event) => moveToFolder(viewer!, event.currentTarget.value)}>
          <option value="">Unfiled</option>
          {#each folders as folder (folder.id)}
            <option value={folder.id}>{folder.name}</option>
          {/each}
        </select>
      </label>

      {#if viewer.tags.length > 0}
        <details class="tag-menu">
          <summary>Tags ({visibleTagIds.filter((id) => viewer.tags.some((tag) => tag.id === id)).length}/{viewer.tags.length} visible)</summary>
          <div class="tag-menu-content">
            {#each viewerTagGroups as group (normalizeText(group.label))}
              <section class="tag-group">
                <label class="tag-group-title">
                  <input
                    type="checkbox"
                    checked={group.tags.every((tag) => visibleTagIds.includes(tag.id))}
                    onchange={(event) => toggleTagGroupVisibility(group.tags.map((tag) => tag.id), event.currentTarget.checked)}
                  />
                  <strong>{group.label}</strong><span>({group.tags.length})</span>
                </label>
                {#each group.tags as tag (tag.id)}
                  <div class="tag-entry">
                    <label>
                      <input
                        type="checkbox"
                        checked={visibleTagIds.includes(tag.id)}
                        onchange={(event) => toggleTagVisibility(tag.id, event.currentTarget.checked)}
                      />
                      {tag.box ? 'Area' : 'Whole image'}
                    </label>
                    <button type="button" onclick={() => viewer && removeTag(viewer, tag.id)} aria-label="Remove {tag.label} tag">Remove</button>
                  </div>
                {/each}
              </section>
            {/each}
          </div>
        </details>
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
          <button onclick={() => viewer && remove(viewer)}>Delete image</button>
          <button onclick={closeViewer}>Close</button>
        </span>
      </figcaption>
    </figure>
  </div>
{/if}
