<script lang="ts">
  import { onMount, tick } from 'svelte'
  import { db, removeLegacyAnalysisData, requestPersistence, type DrawingRecord, type FolderRecord, type Rect, type Tag } from './lib/db'
  import { importFiles, deleteDrawings, isAcceptedImage, clampBox, rebuildThumbnail, copyCropToClipboard, downloadCrop, compressExistingDrawings, detectCompressionFormat, type CompressionFormat } from './lib/images'
  import { loadSampleDrawings, removeSampleDrawings, SAMPLE_QUICK_TAGS } from './lib/samples'
  import { findTagged, normalizeText } from './lib/search'
  import { authClient } from './lib/auth-client'
  import { getAuthCallbackErrorMessage } from './lib/auth-config'
  import { formatStorageBytes } from './lib/sync-protocol'
  import {
    deleteAccountAndCloudData,
    getSyncSnapshot,
    queueDrawingDeletes,
    queueDrawingUpsert,
    queueDrawingUpserts,
    queueFolderDelete,
    queueFolderUpsert,
    scheduleSync,
    syncNow,
    type SyncSnapshot,
  } from './lib/sync'
  import Toolbar from './lib/Toolbar.svelte'
  import Sidebar from './lib/Sidebar.svelte'
  import AccountModal from './lib/AccountModal.svelte'
  import TagManagerModal from './lib/TagManagerModal.svelte'
  import Gallery, { type GalleryItem } from './lib/Gallery.svelte'
  import { computeTagStats, renameOrMergeTag, deleteTagGlobally, deduplicateTags } from './lib/tags'
  import { getLocale, LOCALE_LABELS, setLocale, SUPPORTED_LOCALES, t, type Locale } from './lib/i18n.svelte'

  type Item = GalleryItem
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
  let pendingDeletedDrawings = $state<DrawingRecord[]>([])
  let notice = $state('')
  let draggedDrawingId = $state<string | null>(null)
  let query = $state('')
  let dragging = $state(false)
  let error = $state('')
  let theme = $state<'dark' | 'light'>('light')
  let compressWebp = $state(false)
  let compressionFormat = $state<CompressionFormat>('webp')
  let loadingSamples = $state(false)
  let showHelp = $state(false)
  let menuOpen = $state(false)
  let showAccount = $state(false)
  let accountMessage = $state('')
  let showTagManager = $state(false)
  let accountSession = $state<{ user: { id: string; email: string; name: string } } | null>(null)
  let syncState = $state<SyncSnapshot | null>(null)
  let showTagOverlays = $state(true)
  let visibleTagIds = $state<string[]>([])
  let zoom = $state(1)

  let viewerId = $state<string | null>(null)
  let viewerBox = $state.raw<Rect | null>(null)
  let viewerUrl = $state('')
  let viewerRetried = false
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
  const repairedIds = new Set<string>()

  const PAGE_SIZE = 80
  const FEEDBACK_URL = 'https://github.com/NOT16180/crop/issues/new?template=feedback.yml'
  let visibleCount = $state(PAGE_SIZE)
  let persistenceWarning = $state(false)
  let storageUsage = $state<{ usage: number; quota: number } | null>(null)
  /** How many images the reference sheet should hold: a number, or every result. */
  let sheetSize = $state('6')
  let installEvent = $state<{ prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> } | null>(null)
  let installed = $state(false)
  let dragOverFolderId = $state<string | null>(null)
  let activeTagSuggestion = $state(-1)


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
  const pagedItems = $derived(items.slice(0, visibleCount))
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
  const allTagStats = $derived(computeTagStats(drawings))
  const sampleCount = $derived(drawings.filter((d) => d.isSample).length)
  let localOnlyDrawingIds = $derived(new Set(syncState?.localOnlyIds ?? []))
  let viewerNavItems = $derived.by(() => {
    const seen = new Set<string>()
    return items.filter((item) => {
      if (seen.has(item.drawing.id)) return false
      seen.add(item.drawing.id)
      return true
    })
  })
  let viewerNavIndex = $derived(viewerId ? viewerNavItems.findIndex((item) => item.drawing.id === viewerId) : -1)
  let quickTags = $derived.by(() => {
    if (!viewer) return []
    const existingWhole = new Set(
      viewer.tags.filter((tag) => !tag.box).map((tag) => normalizeText(tag.label)),
    )
    return tagList
      .filter((entry) => selection || !existingWhole.has(normalizeText(entry.label)))
      .slice(0, 8)
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

  function onTagSuggestionKeydown(event: KeyboardEvent) {
    if (!tagSuggestions.length) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const next = event.key === 'ArrowDown'
        ? (activeTagSuggestion + 1) % tagSuggestions.length
        : (activeTagSuggestion <= 0 ? tagSuggestions.length - 1 : activeTagSuggestion - 1)
      activeTagSuggestion = next
    } else if (event.key === 'Enter' && activeTagSuggestion >= 0) {
      event.preventDefault()
      tagInput = tagSuggestions[activeTagSuggestion].label
      activeTagSuggestion = -1
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      activeTagSuggestion = -1
    }
  }

  $effect(() => {
    void items
    visibleCount = PAGE_SIZE
  })


  $effect(() => {
    const isOpen = Boolean(viewer) || showAccount || showTagManager
    const app = document.getElementById('app')
    const background = [...(app?.children ?? [])].filter((element) =>
      !element.classList.contains('viewer') && !element.classList.contains('account-layer') && !element.classList.contains('tag-manager-layer'))
    for (const element of background) (element as HTMLElement).inert = isOpen
    return () => {
      for (const element of background) (element as HTMLElement).inert = false
    }
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
    void refreshAccountSession()
    void detectCompressionFormat().then((fmt) => { compressionFormat = fmt })
    const authParams = new URLSearchParams(window.location.search)
    const authError = getAuthCallbackErrorMessage(authParams.get('error'))
    if (authError) {
      accountMessage = authError
      showAccount = true
      authParams.delete('error')
      authParams.delete('error_description')
      const cleanQuery = authParams.toString()
      const cleanUrl = `${window.location.pathname}${cleanQuery ? `?${cleanQuery}` : ''}${window.location.hash}`
      window.history.replaceState({}, '', cleanUrl)
    }
    try {
      theme = window.localStorage.getItem('drawing-library-theme') === 'dark' ? 'dark' : 'light'
      compressWebp = window.localStorage.getItem('crop-compress-webp') === '1'
    } catch {
      theme = 'light'
      compressWebp = false
    }
    document.documentElement.dataset.theme = theme
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#212121' : '#ffffff')
    const persisted = await requestPersistence()
    if (!persisted) persistenceWarning = true
    // A browser only grants persistent storage to an app it trusts; installing
    // Crop is what unlocks it, so ask again when that happens.
    window.addEventListener('appinstalled', () => { void persistIfPossible() })
    try {
      installed = window.matchMedia('(display-mode: standalone)').matches ||
        (navigator as unknown as { standalone?: boolean }).standalone === true
    } catch {
      installed = false
    }
    window.addEventListener('beforeinstallprompt', (event) => {
      event.preventDefault()
      installEvent = event as unknown as typeof installEvent
    })
    window.addEventListener('online', () => {
      if (accountSession) void runAccountSync()
    })
    window.addEventListener('pagehide', () => {
      if (pendingDeletedDrawings.length) {
        const committed = pendingDeletedDrawings
        pendingDeletedDrawings = []
        if (deleteTimer) {
          clearTimeout(deleteTimer)
          deleteTimer = undefined
        }
        commitPendingDeletes(committed)
      }
    })
    try {
      await removeLegacyAnalysisData()
    } catch {
      // Cleanup is optional.
    }
    await reload()
    await refreshStorageUsage()
  })

  function syncCallbacks() {
    return {
      onStateChange: (snapshot: SyncSnapshot) => {
        syncState = snapshot
      },
      onRemoteApplied: async () => {
        await reload()
        await refreshStorageUsage()
      },
    }
  }

  async function runAccountSync(mode?: 'merge' | 'replace') {
    if (!accountSession) return
    syncState = await syncNow(accountSession.user, {
      accountSwitchMode: mode,
      ...syncCallbacks(),
    })
  }

  function triggerScheduledSync() {
    if (!accountSession) return
    void getSyncSnapshot(syncState?.phase ?? 'idle').then((snap) => { syncState = snap })
    scheduleSync(accountSession.user, syncCallbacks())
  }

  function markDrawingChanged(id: string, needsBlobUpload = false) {
    void queueDrawingUpsert(id, { needsBlobUpload }).then(() => triggerScheduledSync())
  }

  function markDrawingsChanged(ids: string[], needsBlobUpload = false) {
    if (!ids.length) return
    void queueDrawingUpserts(ids, { needsBlobUpload }).then(() => triggerScheduledSync())
  }

  function markFolderChanged(id: string) {
    void queueFolderUpsert(id).then(() => triggerScheduledSync())
  }

  function markFolderDeleted(id: string) {
    void queueFolderDelete(id).then(() => triggerScheduledSync())
  }

  function commitPendingDeletes(toCommit: DrawingRecord[]) {
    const syncable = toCommit.filter((d) => !d.isSample)
    if (!syncable.length) return
    void queueDrawingDeletes(syncable.map((d) => d.id)).then(() => triggerScheduledSync())
  }

  async function handleLoadSamples() {
    if (loadingSamples) return
    loadingSamples = true
    error = ''
    try {
      const { added } = await loadSampleDrawings()
      await reload()
      await refreshStorageUsage()
      notice = added > 0
        ? t('samples.loadedNotice', { count: added })
        : t('samples.alreadyLoaded')
    } catch (cause) {
      error = cause instanceof Error ? cause.message : t('samples.loadError')
    } finally {
      loadingSamples = false
    }
  }

  async function handleRemoveSamples() {
    error = ''
    try {
      const { removed } = await removeSampleDrawings()
      if (viewer?.isSample) closeViewer()
      selectedFolderId = ''
      selectedTagLabels = []
      query = ''
      await reload()
      await refreshStorageUsage()
      if (removed > 0) {
        notice = t('samples.removedNotice', { count: removed })
      }
    } catch {
      error = t('samples.removeError')
    }
  }

  async function refreshAccountSession() {
    try {
      const { data } = await authClient.getSession()
      accountSession = data?.user
        ? { user: { id: data.user.id, email: data.user.email, name: data.user.name } }
        : null
      if (accountSession) {
        syncState = await getSyncSnapshot(syncState?.phase ?? 'idle')
        void runAccountSync()
      } else {
        syncState = null
      }
    } catch {
      accountSession = null
      syncState = null
    }
  }

  async function openAccount() {
    menuOpen = false
    accountMessage = ''
    showAccount = true
    await refreshAccountSession()
  }

  function closeAccount() {
    showAccount = false
    accountMessage = ''
  }

  async function signOut(): Promise<boolean> {
    try {
      const { error: signOutError } = await authClient.signOut()
      if (signOutError) return false
      accountSession = null
      syncState = null
      return true
    } catch {
      return false
    }
  }

  async function handleDeleteAccount(): Promise<boolean> {
    try {
      const ok = await deleteAccountAndCloudData()
      if (!ok) return false
      accountSession = null
      syncState = null
      return true
    } catch {
      return false
    }
  }

  function toggleWebpCompression() {
    compressWebp = !compressWebp
    try {
      window.localStorage.setItem('crop-compress-webp', compressWebp ? '1' : '0')
    } catch {
      // Keep the preference in memory for this session if storage is unavailable.
    }
  }

  async function handleCompressExistingLibrary(onProgress: (done: number, total: number) => void) {
    const result = await compressExistingDrawings(onProgress)
    if (result.compressedIds.length) {
      await queueDrawingUpserts(result.compressedIds, { needsBlobUpload: true })
      await reload()
      await refreshStorageUsage()
      if (accountSession) {
        try {
          await runAccountSync()
        } catch (cause) {
          console.error('Post-compression sync failed', cause)
        }
      }
    }
    return {
      total: result.total,
      compressedCount: result.compressedIds.length,
      savedBytes: result.savedBytes,
      skippedCount: result.skippedCount,
      format: result.format,
    }
  }

  function toggleTheme() {
    theme = theme === 'dark' ? 'light' : 'dark'
    document.documentElement.dataset.theme = theme
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#212121' : '#ffffff')
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
      error = 'Unsupported file format. Use PNG, JPG, WebP, or AVIF.'
      return
    }
    try {
      const result = await importFiles(valid, { compressWebp })
      let position = drawings.reduce((max, drawing) => Math.max(max, drawing.position ?? -1), -1) + 1
      await Promise.all(result.created.map((drawing) => db.drawings.update(drawing.id, {
        ...(selectedFolderId ? { folderId: selectedFolderId } : {}),
        position: position++,
      })))
      markDrawingsChanged(result.created.map((drawing) => drawing.id), true)
      await reload()
      if (result.failures.length) {
        const details = result.failures.slice(0, 3).map((failure) => `${failure.name}: ${failure.reason}`).join(' · ')
        const extra = result.failures.length > 3 ? ` · and ${result.failures.length - 3} more` : ''
        error = `Imported ${result.created.length} of ${valid.length} images. ${details}${extra}`
      } else if (result.created.length) {
        notice = `Imported ${result.created.length} image${result.created.length === 1 ? '' : 's'}.`
      }
      // Use is the signal browsers look for before granting persistence.
      if (result.created.length) await persistIfPossible()
      await refreshStorageUsage()
    } catch {
      error = 'Could not save imported images. Check available browser storage and try again.'
      try { await reload() } catch { /* Keep the import error visible. */ }
      await refreshStorageUsage()
    }
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
    markDrawingsChanged(updates.map(({ id }) => id))
    drawings = arranged.map((drawing, position) => ({ ...drawing, position }))
  }

  async function moveDrawing(id: string, offset: number) {
    if (searching || selectedTagLabels.length) return
    const index = folderDrawings.findIndex((drawing) => drawing.id === id)
    const target = folderDrawings[index + offset]
    if (index < 0 || !target) return
    await swapDrawings(id, target.id)
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
    markFolderChanged(folder.id)
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
    markFolderChanged(folder.id)
    folders = folders.map((candidate) => candidate.id === folder.id ? { ...candidate, name } : candidate)
  }

  async function deleteFolder(folder: FolderRecord) {
    const count = drawings.filter((drawing) => drawing.folderId === folder.id).length
    if (!confirm(`Delete the folder “${folder.name}”? This removes only the folder. Its ${count} image${count === 1 ? '' : 's'} and tags will be kept in All images as unfiled.`)) return
    const affectedDrawingIds = drawings
      .filter((drawing) => drawing.folderId === folder.id)
      .map((drawing) => drawing.id)
    await Promise.all(affectedDrawingIds.map((id) => db.drawings.update(id, { folderId: undefined })))
    await db.folders.delete(folder.id)
    markDrawingsChanged(affectedDrawingIds)
    markFolderDeleted(folder.id)
    drawings = drawings.map((drawing) => drawing.folderId === folder.id
      ? { ...drawing, folderId: undefined }
      : drawing)
    folders = folders.filter((candidate) => candidate.id !== folder.id)
    if (selectedFolderId === folder.id) selectedFolderId = ''
  }

  async function moveSelectedDrawings(folderId: string | undefined, selectedIds: string[]) {
    if (selectedIds.length === 0) return
    await Promise.all(selectedIds.map((id) => db.drawings.update(id, { folderId })))
    markDrawingsChanged(selectedIds)
    const selected = new Set(selectedIds)
    drawings = drawings.map((drawing) => selected.has(drawing.id) ? { ...drawing, folderId } : drawing)
    notice = `Moved images to ${folders.find((folder) => folder.id === folderId)?.name ?? 'Unfiled'}.`
  }

  async function backupLibrary() {
    error = ''
    notice = 'Preparing backup ZIP…'
    try {
      const { downloadBackup } = await import('./lib/backup')
      await downloadBackup()
      notice = 'Backup downloaded.'
      error = ''
    } catch (cause) {
      console.error('Could not create backup', cause)
      notice = ''
      error = cause instanceof Error && cause.message
        ? `Could not create the backup (${cause.message}).`
        : 'Could not create the backup. Check available device storage and try again.'
    }
  }

  async function restoreLibrary(file: File) {
    if (!confirm('Merge this backup into your current library? Its images and folders will be added; existing images will stay. Make a Backup first if you may want to undo this, because Restore cannot be undone.')) return
    error = ''
    notice = 'Restoring backup…'
    try {
      const { restoreBackup } = await import('./lib/backup')
      const result = await restoreBackup(file)
      for (const id of result.folderIds) markFolderChanged(id)
      markDrawingsChanged(result.drawingIds, true)
      await reload()
      await refreshStorageUsage()
      notice = `Restored ${result.drawings} image${result.drawings === 1 ? '' : 's'} and ${result.folders} folder${result.folders === 1 ? '' : 's'}.`
      error = ''
    } catch (cause) {
      notice = ''
      error = cause instanceof Error ? cause.message : 'Could not restore this backup.'
    }
  }

  async function moveToFolder(drawing: DrawingRecord, folderId: string) {
    await db.drawings.update(drawing.id, { folderId: folderId || undefined })
    markDrawingChanged(drawing.id)
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

  function plainTags(tags: Tag[]): Tag[] {
    return tags.map((tag) => ({
      id: tag.id,
      label: tag.label,
      box: tag.box ? ([tag.box[0], tag.box[1], tag.box[2], tag.box[3]] as Rect) : null,
    }))
  }

  function plainIds(ids: string[] | undefined): string[] | undefined {
    return ids ? [...ids] : undefined
  }

  async function saveTags(id: string, tags: Tag[]) {
    try {
      const nextTags = plainTags(tags)
      const nextVisible = [...visibleTagIds]
      await db.drawings.update(id, { tags: nextTags, visibleTagIds: nextVisible })
      markDrawingChanged(id)
      drawings = drawings.map((d) => (d.id === id ? { ...d, tags: nextTags, visibleTagIds: nextVisible } : d))
      error = ''
    } catch (cause) {
      console.error('Could not save the tag', cause)
      error = 'Could not save the tag. Check that browser storage is available, then try again.'
    }
  }

  async function addTag(explicitLabel?: string) {
    const drawing = viewer
    const label = (explicitLabel ?? tagInput).trim()
    if (!drawing || !label) return
    const box: Rect | null = selection
      ? clampBox([
          Math.round(selection.x * drawing.width),
          Math.round(selection.y * drawing.height),
          Math.max(1, Math.round(selection.w * drawing.width)),
          Math.max(1, Math.round(selection.h * drawing.height)),
        ], drawing.width, drawing.height)
      : null
    const tag: Tag = { id: crypto.randomUUID(), label, box }
    error = ''
    try {
      const nextTags = [...plainTags(drawing.tags), tag]
      const nextVisibleTagIds = [...new Set([...visibleTagIds, tag.id])]
      await db.drawings.update(drawing.id, { tags: nextTags, visibleTagIds: nextVisibleTagIds })
      markDrawingChanged(drawing.id)
      visibleTagIds = nextVisibleTagIds
      drawings = drawings.map((item) => item.id === drawing.id
        ? { ...item, tags: nextTags, visibleTagIds: nextVisibleTagIds }
        : item)
      tagInput = ''
      selection = null
    } catch (cause) {
      console.error('Could not save tag', cause)
      error = 'Could not save the tag. Check that browser storage is available, then try again.'
    }
  }

  async function removeTag(drawing: DrawingRecord, tagId: string) {
    const tags = plainTags(drawing.tags.filter((tag) => tag.id !== tagId))
    if (tags.length === drawing.tags.length) return
    const nextVisibleTagIds = [...(drawing.visibleTagIds ?? drawing.tags.map((tag) => tag.id))
      .filter((id) => id !== tagId)]
    try {
      await db.drawings.update(drawing.id, { tags, visibleTagIds: nextVisibleTagIds })
      markDrawingChanged(drawing.id)
      drawings = drawings.map((item) => item.id === drawing.id
        ? { ...item, tags, visibleTagIds: nextVisibleTagIds }
        : item)
      if (viewerId === drawing.id) visibleTagIds = nextVisibleTagIds
      error = ''
    } catch {
      error = 'Could not delete this tag. Check that browser storage is available, then try again.'
    }
  }

  async function handleRenameOrMerge(oldLabel: string, newLabel: string) {
    const oldKey = normalizeText(oldLabel)
    const newKey = normalizeText(newLabel)
    if (!oldKey || !newKey || oldKey === newKey) return
    const { changedDrawings, affectedCount } = renameOrMergeTag(drawings, oldLabel, newLabel)
    if (affectedCount === 0) return

    try {
      const updatedIds: string[] = []
      await db.transaction('rw', db.drawings, async () => {
        for (const drawing of changedDrawings) {
          const original = drawings.find((d) => d.id === drawing.id)
          if (original && (original.tags !== drawing.tags || original.visibleTagIds !== drawing.visibleTagIds)) {
            updatedIds.push(drawing.id)
            await db.drawings.update(drawing.id, {
              tags: plainTags(drawing.tags),
              visibleTagIds: plainIds(drawing.visibleTagIds),
            })
          }
        }
      })
      markDrawingsChanged(updatedIds)
      const updateById = new Map(changedDrawings.map((d) => [d.id, d]))
      drawings = changedDrawings
      if (viewerId) {
        const updatedViewer = updateById.get(viewerId)
        if (updatedViewer) visibleTagIds = updatedViewer.visibleTagIds ?? []
      }
      selectedTagLabels = [...new Set(selectedTagLabels.map((selected) => (selected === oldKey ? newKey : selected)))]
      notice = oldKey === newKey
        ? `Renamed “${oldLabel}” to “${newLabel}” throughout the library.`
        : `Merged “${oldLabel}” into “${newLabel}” across ${affectedCount} image${affectedCount === 1 ? '' : 's'}.`
      error = ''
    } catch {
      error = 'Could not update tags. Check that browser storage is available, then try again.'
    }
  }

  async function handleDeleteTagGroup(label: string) {
    const key = normalizeText(label)
    if (!key) return
    const { changedDrawings, affectedCount } = deleteTagGlobally(drawings, label)
    if (affectedCount === 0) return

    try {
      const updatedIds: string[] = []
      await db.transaction('rw', db.drawings, async () => {
        for (const drawing of changedDrawings) {
          const original = drawings.find((d) => d.id === drawing.id)
          if (original && original.tags.length !== drawing.tags.length) {
            updatedIds.push(drawing.id)
            await db.drawings.update(drawing.id, {
              tags: plainTags(drawing.tags),
              visibleTagIds: plainIds(drawing.visibleTagIds),
            })
          }
        }
      })
      markDrawingsChanged(updatedIds)
      const updateById = new Map(changedDrawings.map((d) => [d.id, d]))
      drawings = changedDrawings
      if (viewerId) {
        const updatedViewer = updateById.get(viewerId)
        if (updatedViewer) visibleTagIds = updatedViewer.visibleTagIds ?? []
      }
      selectedTagLabels = selectedTagLabels.filter((selected) => selected !== key)
      notice = `Deleted “${label}” from ${affectedCount} image${affectedCount === 1 ? '' : 's'}.`
      error = ''
    } catch {
      error = 'Could not delete the tag. Check that browser storage is available, then try again.'
    }
  }

  async function renameTagGroup(label: string) {
    const nextLabel = prompt(`Rename “${label}” everywhere in your library:`, label)?.trim()
    if (!nextLabel || nextLabel === label) return
    await handleRenameOrMerge(label, nextLabel)
  }

  async function mergeTagGroup(label: string) {
    const target = prompt(`Merge “${label}” into which existing tag?`)?.trim()
    if (!target || normalizeText(target) === normalizeText(label)) return
    if (!confirm(`Merge all occurrences of “${label}” into “${target}”? Duplicate tags on the same image will be combined cleanly.`)) return
    await handleRenameOrMerge(label, target)
  }

  async function deleteTagGroup(label: string) {
    const key = normalizeText(label)
    const matches = drawings.filter((drawing) => drawing.tags.some((tag) => normalizeText(tag.label) === key))
    if (!matches.length || !confirm(`Delete “${label}” from all ${matches.length} image${matches.length === 1 ? '' : 's'}? This cannot be undone.`)) return
    await handleDeleteTagGroup(label)
  }

  async function toggleTagVisibility(tagId: string, visible: boolean) {
    visibleTagIds = visible
      ? [...new Set([...visibleTagIds, tagId])]
      : visibleTagIds.filter((id) => id !== tagId)
    if (!viewer) return
    const nextVisible = [...visibleTagIds]
    await db.drawings.update(viewer.id, { visibleTagIds: nextVisible })
    markDrawingChanged(viewer.id)
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
    const nextVisible = [...visibleTagIds]
    await db.drawings.update(viewer.id, { visibleTagIds: nextVisible })
    markDrawingChanged(viewer.id)
    drawings = drawings.map((drawing) => drawing.id === viewer!.id
      ? { ...drawing, visibleTagIds }
      : drawing)
  }

  async function remove(drawing: DrawingRecord) {
    if (!confirm(`Delete “${drawing.name}”?`)) return
    await deleteDrawings([drawing.id])
    if (deleteTimer) clearTimeout(deleteTimer)
    pendingDeletedDrawings = [...pendingDeletedDrawings, drawing]
    deleteTimer = window.setTimeout(() => {
      const committed = pendingDeletedDrawings
      pendingDeletedDrawings = []
      deleteTimer = undefined
      commitPendingDeletes(committed)
    }, 8000)
    drawings = drawings.filter((item) => item.id !== drawing.id)
    closeViewer()
    notice = `“${drawing.name}” deleted.`
    void refreshStorageUsage()
  }

  async function undoDelete() {
    if (!pendingDeletedDrawings.length) return
    const drawingsToRestore = pendingDeletedDrawings
    if (deleteTimer) clearTimeout(deleteTimer)
    deleteTimer = undefined
    const restored: DrawingRecord[] = drawingsToRestore.map((drawing) => ({
      id: drawing.id,
      name: drawing.name,
      createdAt: drawing.createdAt,
      updatedAt: drawing.updatedAt,
      width: drawing.width,
      height: drawing.height,
      blob: drawing.blob,
      thumb: drawing.thumb,
      tags: plainTags(drawing.tags),
      folderId: drawing.folderId && !folders.some((folder) => folder.id === drawing.folderId)
        ? undefined
        : drawing.folderId,
      position: drawing.position,
      visibleTagIds: plainIds(drawing.visibleTagIds),
    }))
    await db.drawings.bulkAdd(restored)
    pendingDeletedDrawings = []
    await reload()
    notice = `${restored.length} image${restored.length === 1 ? '' : 's'} restored.`
    void refreshStorageUsage()
  }

  function openViewer(item: Item) {
    returnFocusTarget = document.activeElement instanceof HTMLElement ? document.activeElement : null
    closeViewer()
    showTagOverlays = true
    visibleTagIds = item.drawing.visibleTagIds ?? item.drawing.tags.map((tag) => tag.id)
    zoom = 1
    viewerId = item.drawing.id
    viewerBox = item.box
    viewerRetried = false
    viewerUrl = URL.createObjectURL(item.drawing.blob)
    void tick().then(() => viewerDialog?.querySelector<HTMLElement>('.zoom-controls button:not([disabled])')?.focus())
  }

  async function retryViewerImage() {
    if (!viewer || viewerRetried) return
    viewerRetried = true
    try {
      const buffer = await viewer.blob.arrayBuffer()
      const nextUrl = URL.createObjectURL(new Blob([buffer], { type: viewer.blob.type || 'image/jpeg' }))
      if (viewerUrl) URL.revokeObjectURL(viewerUrl)
      viewerUrl = nextUrl
    } catch {
      // Keep current state if the blob is genuinely unreadable.
    }
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
      if (showAccount) closeAccount()
      else if (showTagManager) showTagManager = false
      else if (selection) selection = null
      else if (viewer) closeViewer()
      return
    }
    if (viewer) {
      const target = e.target as HTMLElement
      const typing = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT'
      if (!typing) {
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          e.preventDefault()
          navigateViewer(e.key === 'ArrowLeft' ? -1 : 1)
          return
        }
        if (e.key === '+' || e.key === '=') {
          e.preventDefault()
          changeZoom(0.25)
          return
        }
        if (e.key === '-') {
          e.preventDefault()
          changeZoom(-0.25)
          return
        }
        if (e.key === '0') {
          e.preventDefault()
          zoom = 1
          return
        }
      }
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
    // A pointer capture can be refused (pointer already gone, some touch
    // stacks): losing it must not abort the selection, or tagging an area
    // becomes impossible.
    try {
      imageBox!.setPointerCapture(e.pointerId)
    } catch {
      // Selection still works without the capture.
    }
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
    try {
      imageBox.setPointerCapture(e.pointerId)
    } catch {
      // Resizing still works without the capture.
    }
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

  function formatFileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
  }

  /** Report how much room the library takes, so a full browser store is not a surprise. */
  async function refreshStorageUsage() {
    try {
      const estimate = await navigator.storage?.estimate?.()
      if (estimate?.usage !== undefined && estimate.quota) {
        storageUsage = { usage: estimate.usage, quota: estimate.quota }
      }
    } catch {
      // Informational only: the app works without an estimate.
    }
  }

  /** Ask again for persistent storage; browsers grant it once the app is used or installed. */
  async function persistIfPossible() {
    if (!persistenceWarning) return
    if (await requestPersistence()) persistenceWarning = false
  }

  /** Run the browser's own install prompt when it offered one. */
  async function installApp() {
    const event = installEvent
    if (!event) return
    installEvent = null
    await event.prompt()
    const choice = await event.userChoice
    installed = choice.outcome === 'accepted'
    if (installed) {
      notice = 'Crop installed. It now opens without a network.'
      await persistIfPossible()
    }
  }

  /**
   * A thumbnail that cannot be displayed is rebuilt from the original file, so a
   * library written by an unluckier build repairs itself silently.
   */
  async function repairDrawing(drawing: DrawingRecord) {
    if (repairedIds.has(drawing.id)) return
    repairedIds.add(drawing.id)
    const fixed = await rebuildThumbnail(drawing)
    if (fixed) {
      drawings = drawings.map((item) => (item.id === fixed.id ? fixed : item))
      notice = `Rebuilt the preview of “${fixed.name}”.`
    } else {
      repairedIds.delete(drawing.id)
    }
  }

  async function exportSheet() {
    if (items.length === 0) return
    error = ''
    try {
      const { downloadSheet } = await import('./lib/sheet')
      const wanted = sheetSize === 'all' ? items.length : Math.min(Number(sheetSize), items.length)
      const exported = await downloadSheet({
        entries: items.slice(0, wanted).map((item) => ({ drawing: item.drawing, box: item.box, label: item.label })),
        title: activeSearchQuery ? `#${activeSearchQuery}` : (folders.find((folder) => folder.id === selectedFolderId)?.name
          ? `References · ${folders.find((folder) => folder.id === selectedFolderId)!.name}`
          : 'My references'),
        subtitle: `${items.length} image${items.length === 1 ? '' : 's'}${selectedTagLabels.length > 1 ? ` · tags: ${selectedTagLabels.join(', ')}` : ''}`,
        origin: new URL(import.meta.env.BASE_URL, location.origin).href,
        total: items.length,
      })
      notice = `Reference sheet exported with ${exported} image${exported === 1 ? '' : 's'}.`
    } catch (cause) {
      console.error('Could not export the reference sheet', cause)
      error = 'Could not export the reference sheet.'
    }
  }

  async function renameDrawing(drawing: DrawingRecord) {
    const name = prompt('New name:', drawing.name)?.trim()
    if (!name || name === drawing.name) return
    await db.drawings.update(drawing.id, { name })
    markDrawingChanged(drawing.id)
    drawings = drawings.map((d) => d.id === drawing.id ? { ...d, name } : d)
  }

  async function handleCopyCrop(blob: Blob, box: Rect | null, name = 'Crop') {
    try {
      await copyCropToClipboard(blob, box)
      notice = `${name} copied to clipboard.`
      error = ''
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Could not copy image to clipboard.'
    }
  }

  async function handleDownloadCrop(blob: Blob, box: Rect | null, baseName: string) {
    try {
      await downloadCrop(blob, box, baseName)
      notice = `${baseName} downloaded.`
      error = ''
    } catch {
      error = 'Could not export the image.'
    }
  }

  function navigateViewer(offset: number) {
    if (viewerNavIndex < 0) return
    const next = viewerNavItems[viewerNavIndex + offset]
    if (!next) return
    openViewer(next)
  }

  async function deleteSelectedDrawings(selectedIds: string[]) {
    if (selectedIds.length === 0) return
    if (!confirm(`Delete ${selectedIds.length} image${selectedIds.length === 1 ? '' : 's'}? You can undo this for 8 seconds.`)) return
    await deleteDrawings(selectedIds)
    const deleted = new Set(selectedIds)
    const removed = drawings.filter((drawing) => deleted.has(drawing.id))
    pendingDeletedDrawings = [...pendingDeletedDrawings, ...removed]
    if (deleteTimer) clearTimeout(deleteTimer)
    deleteTimer = window.setTimeout(() => {
      const committed = pendingDeletedDrawings
      pendingDeletedDrawings = []
      deleteTimer = undefined
      commitPendingDeletes(committed)
    }, 8000)
    drawings = drawings.filter((d) => !deleted.has(d.id))
    notice = `${deleted.size} image${deleted.size === 1 ? '' : 's'} deleted. Undo is available for 8 seconds.`
    void refreshStorageUsage()
  }

  async function bulkAddTag(label: string, selectedIds: string[]) {
    if (!label || selectedIds.length === 0) return
    const updates = selectedIds.map((id) => {
      const drawing = byId.get(id)
      if (!drawing) return null
      const tag: Tag = { id: crypto.randomUUID(), label, box: null }
      const rawTags = [...drawing.tags, tag]
      const { tags, visibleTagIds } = deduplicateTags(rawTags, [
        ...new Set([...(drawing.visibleTagIds ?? drawing.tags.map((item) => item.id)), tag.id]),
      ])
      return { id, tags, visibleTagIds }
    }).filter((u): u is { id: string; tags: Tag[]; visibleTagIds: string[] } => u !== null)
    if (!updates.length) return
    await Promise.all(updates.map(({ id, tags, visibleTagIds }) => db.drawings.update(id, { tags: plainTags(tags), visibleTagIds: plainIds(visibleTagIds) })))
    markDrawingsChanged(updates.map(({ id }) => id))
    const tagMap = new Map(updates.map((u) => [u.id, u.tags]))
    const visibleMap = new Map(updates.map((u) => [u.id, u.visibleTagIds]))
    drawings = drawings.map((d) => tagMap.has(d.id)
      ? { ...d, tags: tagMap.get(d.id)!, visibleTagIds: visibleMap.get(d.id) }
      : d)
    notice = `Tag "${label}" added to ${updates.length} image${updates.length === 1 ? '' : 's'}.`
  }

  function onFolderDragOver(event: DragEvent, folderId: string) {
    if (!draggedDrawingId) return
    event.preventDefault()
    dragOverFolderId = folderId
  }

  async function onFolderDrop(event: DragEvent, folderId: string) {
    event.preventDefault()
    dragOverFolderId = null
    const sourceId = draggedDrawingId
    draggedDrawingId = null
    if (!sourceId) return
    const drawing = byId.get(sourceId)
    if (drawing) await moveToFolder(drawing, folderId)
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

<Toolbar
  {menuOpen}
  {theme}
  ontogglemenu={() => (menuOpen = !menuOpen)}
  ontoggletheme={toggleTheme}
  onresetview={() => {
    showHelp = false
    selectedFolderId = ''
    selectedTagLabels = []
    query = ''
  }}
  {query}
  onquerychange={(q) => (query = q)}
  {searchSuggestions}
  onaddimages={() => fileInput.click()}
/>

<Sidebar
  {menuOpen}
  {compressWebp}
  {compressionFormat}
  {showHelp}
  {accountSession}
  {syncState}
  feedbackUrl={FEEDBACK_URL}
  onclose={() => (menuOpen = false)}
  ontogglewebp={toggleWebpCompression}
  ontogglehelp={() => (showHelp = !showHelp)}
  onopenaccount={openAccount}
  onopentagmanager={() => (showTagManager = true)}
  onbackup={backupLibrary}
  onrestore={() => backupInput.click()}
/>

<input
  bind:this={fileInput}
  type="file"
  accept="image/png,image/jpeg,image/webp,image/avif"
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

<AccountModal
  open={showAccount}
  session={accountSession}
  {syncState}
  {compressWebp}
  {compressionFormat}
  drawingCount={drawings.length}
  initialMessage={accountMessage}
  onclose={closeAccount}
  onsignout={signOut}
  ondeleteaccount={handleDeleteAccount}
  onsyncnow={runAccountSync}
  ontogglewebp={toggleWebpCompression}
  oncompressexisting={handleCompressExistingLibrary}
/>

<TagManagerModal
  open={showTagManager}
  tags={allTagStats}
  onclose={() => (showTagManager = false)}
  onrenametag={handleRenameOrMerge}
  onmergetag={handleRenameOrMerge}
  ondeletetag={handleDeleteTagGroup}
/>

<details class="data-warning">
  <summary>
    <span class="summary-main">
      {#if accountSession}
        <strong>{t('summary.cloudSync')}</strong>
        {#if syncState && syncState.phase !== 'unavailable'}
          · {formatStorageBytes(syncState.usedBytes)} / {formatStorageBytes(syncState.quotaBytes)}
        {/if}
      {:else}
        <strong>{t('summary.localMode')}</strong>{#if storageUsage} · {formatFileSize(storageUsage.usage)}{/if}
      {/if}
    </span>
    <span class="summary-actions">
      <button
        type="button"
        class="summary-btn"
        onclick={(event) => { event.preventDefault(); event.stopPropagation(); void openAccount() }}
      >{accountSession ? t('menu.accountStorage') : t('summary.signIn')}</button>
      {#if !installed && installEvent}
        <button
          type="button"
          class="summary-btn"
          onclick={(event) => { event.preventDefault(); event.stopPropagation(); installApp() }}
        >{t('summary.installApp')}</button>
      {/if}
    </span>
  </summary>
  {#if accountSession}
    <p>{t('summary.cloudDesc')}{#if storageUsage} {t('summary.localStorage', { size: formatFileSize(storageUsage.usage) })}{/if}</p>
    <p>{t('summary.cloudQuotaNote')}</p>
  {:else}
    <p>{t('summary.localDesc')}</p>
  {/if}
  {#if !installed}
    <p>{t('summary.installNote')}</p>
  {/if}
  {#if persistenceWarning}
    <p>{t('summary.persistenceWarning')}</p>
  {/if}
</details>

<nav class="library-nav" aria-label={t('nav.aria')}>
  <details class="folder-menu">
    <summary>
      {t('nav.folder')}: {folders.find((folder) => folder.id === selectedFolderId)?.name ?? t('nav.allImages')}
      ({selectedFolderId
        ? drawings.filter((drawing) => drawing.folderId === selectedFolderId).length
        : drawings.length})
    </summary>
    <div class="folder-menu-content">
      <button
        aria-pressed={!selectedFolderId}
        class:folder-drag-over={dragOverFolderId === ''}
        onclick={() => { selectedFolderId = ''; query = '' }}
        ondragover={(event) => onFolderDragOver(event, '')}
        ondragleave={() => { if (dragOverFolderId === '') dragOverFolderId = null }}
        ondrop={(event) => onFolderDrop(event, '')}
      >{t('nav.allImages')} ({drawings.length})</button>
      {#each folders as folder (folder.id)}
        <div class="folder-entry">
          <button
            class="folder-select"
            class:folder-drag-over={dragOverFolderId === folder.id}
            aria-pressed={selectedFolderId === folder.id}
            onclick={() => { selectedFolderId = folder.id; query = '' }}
            ondragover={(event) => onFolderDragOver(event, folder.id)}
            ondragleave={() => { if (dragOverFolderId === folder.id) dragOverFolderId = null }}
            ondrop={(event) => onFolderDrop(event, folder.id)}
          >
            {folder.name} ({drawings.filter((drawing) => drawing.folderId === folder.id).length})
          </button>
          <button type="button" class="folder-action" onclick={() => renameFolder(folder)} aria-label="{t('nav.rename')} {folder.name}">{t('nav.rename')}</button>
          <button type="button" class="folder-action" onclick={() => deleteFolder(folder)} aria-label="{t('nav.delete')} {folder.name}">{t('nav.delete')}</button>
        </div>
      {/each}
      <button type="button" onclick={createFolder}>{t('nav.newFolder')}</button>
    </div>
  </details>

  {#if tagList.length > 0}
    <details class="tag-filter-menu">
      <summary>{t('nav.tags')}{searching ? ` · ${query.trim()}` : ''} ({tagList.length})</summary>
      <div class="tag-filter-content">
        <fieldset class="tag-filter-mode">
          <legend>{t('nav.match')}</legend>
          <label><input type="radio" name="tag-match" checked={tagMatchMode === 'all'} onchange={() => (tagMatchMode = 'all')} /> {t('nav.matchAll')}</label>
          <label><input type="radio" name="tag-match" checked={tagMatchMode === 'any'} onchange={() => (tagMatchMode = 'any')} /> {t('nav.matchAny')}</label>
        </fieldset>
        {#if selectedTagLabels.length}<button type="button" class="clear-tag-filters" onclick={() => (selectedTagLabels = [])}>{t('nav.clearTags')}</button>{/if}
        {#each tagList as entry (entry.label)}
          <label class="tag-filter-option">
            <input type="checkbox" checked={selectedTagLabels.includes(normalizeText(entry.label))} onchange={(event) => toggleTagFilter(entry.label, event.currentTarget.checked)} />
            {entry.label}<span>{entry.count}</span>
          </label>
        {/each}
      </div>
    </details>
  {/if}

  <button type="button" class="tag-manager-nav-btn" onclick={() => (showTagManager = true)}>{t('nav.manageTags')}</button>
</nav>

{#if selectedFolderId || query.trim() || selectedTagLabels.length}
  <div class="active-filters" aria-label={t('filters.aria')}>
    {#if selectedFolderId}
      <button type="button" class="filter-chip" onclick={() => (selectedFolderId = '')}>
        {t('filters.folder', { name: folders.find((f) => f.id === selectedFolderId)?.name ?? t('nav.folder') })} ×
      </button>
    {/if}
    {#if query.trim()}
      <button type="button" class="filter-chip" onclick={() => (query = '')}>
        {t('filters.search', { query: query.trim() })} ×
      </button>
    {/if}
    {#each selectedTagLabels as tagKey (tagKey)}
      {@const display = tagList.find((item) => normalizeText(item.label) === tagKey)?.label ?? tagKey}
      <button type="button" class="filter-chip" onclick={() => toggleTagFilter(display, false)}>
        #{display} ×
      </button>
    {/each}
    <button
      type="button"
      class="filter-chip clear-all-chip"
      onclick={() => { selectedFolderId = ''; query = ''; selectedTagLabels = [] }}
    >{t('filters.clearAll')}</button>
  </div>
{/if}

{#if error || notice}
  <div class="toast-stack" aria-live="polite">
    {#if error}
      <p class="status error toast" role="alert" aria-live="assertive">
        <span>{error}</span>
        <button type="button" onclick={() => (error = '')} aria-label={t('toast.dismissError')}>×</button>
      </p>
    {/if}
    {#if notice}
      <p class="status notice toast">
        <span>{notice}</span>
        {#if pendingDeletedDrawings.length}<button type="button" onclick={undoDelete}>{t('toast.undo', { count: pendingDeletedDrawings.length })}</button>{/if}
        <button type="button" onclick={() => (notice = '')} aria-label={t('toast.dismissNotice')}>×</button>
      </p>
    {/if}
  </div>
{/if}

<main>
  {#if showHelp}
    <article class="help-page">
      <h2>{t('help.title')}</h2>
      <p>{t('help.intro')}</p>

      <h3>{t('help.s1Title')}</h3>
      <p>{t('help.s1Body')}</p>

      <h3>{t('help.s2Title')}</h3>
      <p>{t('help.s2Body')}</p>

      <h3>{t('help.s3Title')}</h3>
      <p>{t('help.s3Body')}</p>

      <h3>{t('help.s4Title')}</h3>
      <p>{t('help.s4Body')}</p>

      <h3>{t('help.s5Title')}</h3>
      <p>{t('help.s5Body')}</p>

      <h3>{t('help.s6Title')}</h3>
      <p>{t('help.s6Body')}</p>

      <h3>{t('help.s7Title')}</h3>
      <p>{t('help.s7Body')}</p>

      <h3>{t('help.feedbackTitle')}</h3>
      <p>{t('help.feedbackBody')} <a href={FEEDBACK_URL} target="_blank" rel="noopener noreferrer">{t('help.feedbackLink')}</a> · <a href="https://ko-fi.com/not1618033" target="_blank" rel="noopener noreferrer">{t('help.kofiLink')}</a></p>
    </article>
  {:else}
  {#if drawings.length === 0}
    <section class="empty">
      <h2>{t('empty.title')}</h2>
      <p>{t('empty.subtitle')}</p>
      <div class="empty-actions">
        <button type="button" class="add-image-button" onclick={() => fileInput.click()}>{t('toolbar.addImages')}</button>
        <button type="button" onclick={handleLoadSamples} disabled={loadingSamples}>
          {loadingSamples ? t('empty.loadingSamples') : t('empty.loadSamples')}
        </button>
      </div>
      {#if !installed && installEvent}
        <p class="empty-install"><button type="button" onclick={installApp}>{t('empty.installCrop')}</button></p>
      {/if}
      {#if accountSession}
        <p>{t('empty.signedInDesc', { email: accountSession.user.email })}</p>
      {:else}
        <p>{t('empty.localDesc')}</p>
      {/if}
    </section>
  {:else}
    {#if sampleCount > 0}
      <div class="sample-bar" role="region" aria-label={t('samples.regionAria')}>
        <span class="sample-bar-label">{t('samples.barLabel')}</span>
        <div class="sample-bar-tags">
          {#each SAMPLE_QUICK_TAGS as tag (tag)}
            <button
              type="button"
              class="sample-tag-btn"
              class:active={normalizeText(query) === tag}
              onclick={() => (query = normalizeText(query) === tag ? '' : tag)}
            >{tag}</button>
          {/each}
        </div>
        <button type="button" class="sample-remove-btn" onclick={handleRemoveSamples}>{t('samples.remove')}</button>
      </div>
    {/if}
    {#if hasFilters}
      <p class="results-title">{activeSearchQuery ? t('results.matchQuery', { count: items.length, query: activeSearchQuery.trim() }) : t('results.match', { count: items.length })}{selectedTagLabels.length > (activeSearchQuery && !searching ? 1 : 0) ? (tagMatchMode === 'all' ? t('results.tagsSuffixAll', { count: selectedTagLabels.length }) : t('results.tagsSuffixAny', { count: selectedTagLabels.length })) : ''}.</p>
    {/if}
    {#if hasFilters && items.length === 0}
      <p class="results-title">{t('results.none')}</p>
    {/if}
    <Gallery
      {folderDrawings}
      {hasFilters}
      {items}
      {pagedItems}
      {visibleCount}
      pageSize={PAGE_SIZE}
      {searching}
      {selectedTagLabels}
      {sortMode}
      {sheetSize}
      {folders}
      {selectedFolderId}
      localOnlyIds={localOnlyDrawingIds}
      tagSuggestions={tagList}
      {activeSearchQuery}
      {drawingDisplayName}
      onselectdrawing={openViewer}
      onrepairdrawing={repairDrawing}
      oncopycrop={handleCopyCrop}
      ondownloadcrop={handleDownloadCrop}
      onexportsheet={exportSheet}
      onmovedrawing={moveDrawing}
      onswapdrawings={swapDrawings}
      onmoveselected={moveSelectedDrawings}
      ondeleteselected={deleteSelectedDrawings}
      onbulktag={bulkAddTag}
      onloadmore={() => (visibleCount += PAGE_SIZE)}
      onsortchange={(mode) => (sortMode = mode)}
      onsheetsizechange={(size) => (sheetSize = size)}
      ondragstart={(id) => (draggedDrawingId = id)}
      ondragend={() => (draggedDrawingId = null)}
    />
    {/if}
  {/if}
</main>

<footer class="site-footer">
  <span>Crop</span>
  <span aria-hidden="true">·</span>
  <a href="https://notgalerie.com/" target="_blank" rel="noopener noreferrer">notgalerie.com</a>
  <span aria-hidden="true">·</span>
  <a href="https://ko-fi.com/not1618033" target="_blank" rel="noopener noreferrer">{t('menu.coffee')}</a>
  <span aria-hidden="true">·</span>
  <select
    class="footer-lang"
    aria-label={t('menu.language')}
    value={getLocale()}
    onchange={(event) => setLocale(event.currentTarget.value as Locale)}
  >
    {#each SUPPORTED_LOCALES as loc (loc)}
      <option value={loc}>{LOCALE_LABELS[loc]}</option>
    {/each}
  </select>
</footer>

  {#if dragging}
  <div class="drop-overlay">{t('drop.overlay')}</div>
{/if}

{#if viewer}
  <div class="viewer" bind:this={viewerDialog} role="dialog" aria-modal="true" aria-label={viewer.name} tabindex="-1">
    <button class="viewer-backdrop" onclick={closeViewer} aria-label={t('viewer.closeAria')}></button>
    <figure aria-label={t('viewer.controlsAria')}>
      <div class="viewer-toolbar">
        <div class="zoom-controls" aria-label={t('viewer.zoomAria')}>
          <button type="button" onclick={() => changeZoom(-0.25)} disabled={zoom <= 0.5} aria-label={t('viewer.zoomOut')} title="{t('viewer.zoomOut')} (-)">−</button>
          <span aria-live="polite">{Math.round(zoom * 100)}%</span>
          <button type="button" onclick={() => changeZoom(0.25)} disabled={zoom >= 4} aria-label={t('viewer.zoomIn')} title="{t('viewer.zoomIn')} (+)">+</button>
          <button type="button" onclick={() => (zoom = 1)} disabled={zoom === 1} title={t('viewer.resetTitle')}>{t('viewer.reset')}</button>
          {#if viewerNavItems.length > 1 && viewerNavIndex >= 0}
            <div class="viewer-nav" aria-label={t('viewer.browseAria')}>
              <button type="button" onclick={() => navigateViewer(-1)} disabled={viewerNavIndex <= 0} aria-label={t('viewer.prev')} title="{t('viewer.prev')} (←)">‹</button>
              <span class="viewer-nav-count">{viewerNavIndex + 1}/{viewerNavItems.length}</span>
              <button type="button" onclick={() => navigateViewer(1)} disabled={viewerNavIndex >= viewerNavItems.length - 1} aria-label={t('viewer.next')} title="{t('viewer.next')} (→)">›</button>
            </div>
          {/if}
          <button type="button" class="viewer-close-btn" onclick={closeViewer} aria-label={t('viewer.closeAria')} title="{t('viewer.closeAria')} (Esc)">×</button>
        </div>
        {#if viewerBox}
          <div class="viewer-active-crop" aria-label={t('viewer.focusedCrop')}>
            <span class="active-crop-label">{t('viewer.focusedCrop')}</span>
            <button type="button" onclick={() => viewer && viewerBox && handleCopyCrop(viewer.blob, viewerBox, 'Focused crop')} title={t('gallery.copyCropTitle')}>{t('gallery.copy')}</button>
            <button type="button" onclick={() => viewer && viewerBox && handleDownloadCrop(viewer.blob, viewerBox, `${viewer.name.replace(/\.[^.]+$/, '')}-crop`)} title={t('gallery.downloadCropTitle')}>{t('gallery.download')}</button>
            <button type="button" class="clear-crop-btn" onclick={() => (viewerBox = null)} title={t('viewer.clearFocus')}>×</button>
          </div>
        {/if}
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
          onerror={retryViewerImage}
          style:max-width={`calc((100vw - 24px) * ${zoom})`}
          style:max-height={`calc(max(220px, 100dvh - 240px) * ${zoom})`}
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
                <em>
                  <span class="tag-label">{tag.label}</span>
                  <button
                    type="button"
                    class="tag-copy-btn"
                    aria-label="{t('gallery.copy')} {tag.label}"
                    title={t('gallery.copyCropTitle')}
                    onpointerdown={(event) => event.stopPropagation()}
                    onclick={(event) => { event.stopPropagation(); if (viewer && tag.box) handleCopyCrop(viewer.blob, tag.box, `Crop "${tag.label}"`) }}
                  >📋</button>
                  <button
                    type="button"
                    aria-label="{t('nav.delete')} {tag.label}"
                    title={t('viewer.removeTagTitle')}
                    onpointerdown={(event) => event.stopPropagation()}
                    onclick={(event) => { event.stopPropagation(); removeTag(viewer, tag.id) }}
                  >×</button>
                </em>
                <button type="button" class="resize-handle nw" aria-label="{tag.label} NW" onpointerdown={(event) => startResize(event, tag, 'nw')}></button>
                <button type="button" class="resize-handle ne" aria-label="{tag.label} NE" onpointerdown={(event) => startResize(event, tag, 'ne')}></button>
                <button type="button" class="resize-handle sw" aria-label="{tag.label} SW" onpointerdown={(event) => startResize(event, tag, 'sw')}></button>
                <button type="button" class="resize-handle se" aria-label="{tag.label} SE" onpointerdown={(event) => startResize(event, tag, 'se')}></button>
              </span>
            {/if}
          {/each}
          <div class="whole-tags" aria-label={t('viewer.wholeTagsAria')}>
            {#each viewer.tags.filter((tag) => !tag.box && visibleTagIds.includes(tag.id)) as tag (tag.id)}
              <span><span class="tag-label">{tag.label}</span><button
                type="button"
                aria-label="{t('nav.delete')} {tag.label}"
                title={t('viewer.removeTagTitle')}
                onpointerdown={(event) => event.stopPropagation()}
                onclick={(event) => { event.stopPropagation(); removeTag(viewer, tag.id) }}
              >×</button></span>
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
            placeholder={selection ? t('viewer.tagAreaPlaceholder') : t('viewer.tagWholePlaceholder')}
            bind:value={tagInput}
            aria-label={t('viewer.newTagAria')}
            role="combobox"
            aria-autocomplete="list"
            aria-haspopup="listbox"
            aria-controls="tag-suggestions"
            aria-expanded={tagSuggestions.length > 0}
            aria-activedescendant={activeTagSuggestion >= 0 && tagSuggestions.length > 0 ? `tag-suggestion-${activeTagSuggestion}` : undefined}
            onkeydown={onTagSuggestionKeydown}
            oninput={() => (activeTagSuggestion = -1)}
            autocomplete="off"
          />
          {#if tagSuggestions.length > 0}
            <div class="autocomplete-list" id="tag-suggestions" role="listbox" aria-label={t('viewer.existingTagsAria')}>
              {#each tagSuggestions as entry, index (entry.label)}
                <button type="button" id="tag-suggestion-{index}" role="option" aria-selected={activeTagSuggestion === index} class:active={activeTagSuggestion === index} onclick={() => { tagInput = entry.label; activeTagSuggestion = -1 }}>
                  {entry.label}<span>{entry.count}</span>
                </button>
              {/each}
            </div>
          {/if}
        </div>
        <button type="submit" disabled={!tagInput.trim()}>{t('viewer.addTag')}</button>
        {#if selection && viewer}
          {@const selBox: Rect = [
            Math.round(selection.x * viewer.width),
            Math.round(selection.y * viewer.height),
            Math.max(1, Math.round(selection.w * viewer.width)),
            Math.max(1, Math.round(selection.h * viewer.height)),
          ]}
          <button type="button" onclick={() => viewer && handleCopyCrop(viewer.blob, selBox, 'Selected area')} title={t('gallery.copyCropTitle')}>{t('viewer.copyCrop')}</button>
          <button type="button" onclick={() => viewer && handleDownloadCrop(viewer.blob, selBox, viewer.name)} title={t('gallery.downloadCropTitle')}>{t('viewer.downloadCrop')}</button>
          <button type="button" onclick={() => (selection = null)}>{t('viewer.cancelSelection')}</button>
        {/if}
        {#if error}<p class="status error" role="alert" aria-live="assertive">{error}</p>{/if}
      </form>

      {#if quickTags.length > 0}
        <div class="quick-tags" aria-label={t('viewer.quickTagsAria')}>
          {#each quickTags as entry (entry.label)}
            <button
              type="button"
              class="quick-tag-chip"
              onclick={() => addTag(entry.label)}
            >+ {entry.label}</button>
          {/each}
        </div>
      {/if}

      <label class="drawing-folder">{t('nav.folder')}
        <select value={viewer.folderId ?? ''} onchange={(event) => moveToFolder(viewer!, event.currentTarget.value)}>
          <option value="">{t('gallery.unfiled')}</option>
          {#each folders as folder (folder.id)}
            <option value={folder.id}>{folder.name}</option>
          {/each}
        </select>
      </label>

      {#if viewer.tags.length > 0}
        <details class="tag-menu">
          <summary>{t('viewer.tagsVisible', { visible: visibleTagIds.filter((id) => viewer.tags.some((tag) => tag.id === id)).length, total: viewer.tags.length })}</summary>
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
                <div class="tag-group-actions">
                  <button type="button" class="rename-tag" onclick={() => renameTagGroup(group.label)}>{t('viewer.renameEverywhere')}</button>
                  <button type="button" class="merge-tag" onclick={() => mergeTagGroup(group.label)}>{t('viewer.mergeInto')}</button>
                  <button type="button" class="delete-tag" onclick={() => deleteTagGroup(group.label)}>{t('viewer.deleteEverywhere')}</button>
                </div>
                {#each group.tags as tag (tag.id)}
                  <div class="tag-entry">
                    <label>
                      <input
                        type="checkbox"
                        checked={visibleTagIds.includes(tag.id)}
                        onchange={(event) => toggleTagVisibility(tag.id, event.currentTarget.checked)}
                      />
                      {tag.box ? t('viewer.area') : t('viewer.wholeImage')}
                    </label>
                    <span class="tag-entry-actions">
                      {#if tag.box}
                        <button type="button" onclick={() => viewer && handleCopyCrop(viewer.blob, tag.box, `Crop "${tag.label}"`)} title={t('gallery.copyCropTitle')}>{t('gallery.copy')}</button>
                        <button type="button" onclick={() => viewer && handleDownloadCrop(viewer.blob, tag.box, `${viewer.name.replace(/\.[^.]+$/, '')}-${tag.label}`)} title={t('gallery.downloadCropTitle')}>{t('gallery.download')}</button>
                      {/if}
                      <button
                        type="button"
                        onclick={() => viewer && removeTag(viewer, tag.id)}
                      >{tag.box ? t('viewer.deleteCrop') : t('viewer.deleteFromImage')}</button>
                    </span>
                  </div>
                {/each}
              </section>
            {/each}
          </div>
        </details>
      {/if}

      <figcaption>
        <span class="viewer-meta">{viewer.name} · {viewer.width}×{viewer.height} · {formatFileSize(viewer.blob.size)}</span>
        <span class="viewer-actions">
          <button type="button" onclick={() => viewer && renameDrawing(viewer)}>{t('nav.rename')}</button>
          <button type="button" onclick={() => viewer && handleCopyCrop(viewer.blob, null, 'Original image')} title={t('viewer.copyImageTitle')}>{t('viewer.copyImage')}</button>
          <button type="button" onclick={() => viewer && handleDownloadCrop(viewer.blob, null, viewer.name)} title={t('viewer.downloadImageTitle')}>{t('gallery.download')}</button>
          <button
            type="button"
            onclick={() => (showTagOverlays = !showTagOverlays)}
            aria-pressed={showTagOverlays}
            title={showTagOverlays ? t('viewer.hideTagsTitle') : t('viewer.showTagsTitle')}
          >{showTagOverlays ? t('viewer.hideTags') : t('viewer.showTags')}</button>
          <button onclick={() => viewer && remove(viewer)}>{t('viewer.deleteImage')}</button>
          <button onclick={closeViewer}>{t('viewer.close')}</button>
        </span>
      </figcaption>
    </figure>
  </div>
{/if}
