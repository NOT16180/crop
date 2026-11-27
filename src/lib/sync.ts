import { db, type DrawingRecord, type FolderRecord, type SyncMetaRecord, type SyncOutboxRecord } from './db'
import {
  DEFAULT_QUOTA_BYTES,
  MAX_ORIGINAL_BLOB_BYTES,
  MAX_PUSH_ITEMS,
  type SyncBlobKind,
  type SyncDrawingPayload,
  type SyncFolderPayload,
  type SyncPullResponse,
  type SyncPushResponse,
  type SyncStatusResponse,
} from './sync-protocol'

export type SyncPhase =
  | 'idle'
  | 'syncing'
  | 'synced'
  | 'offline'
  | 'quota_full'
  | 'account_mismatch'
  | 'unavailable'
  | 'error'

export interface SyncSnapshot {
  phase: SyncPhase
  usedBytes: number
  quotaBytes: number
  lastSyncAt: number | null
  pendingCount: number
  quotaBlockedCount: number
  tooLargeCount: number
  localOnlyIds: string[]
  errorMessage: string | null
  previousAccountEmail: string | null
}

export interface SyncUser {
  id: string
  email: string
}

export interface SyncOptions {
  accountSwitchMode?: 'merge' | 'replace'
  onStateChange?: (snapshot: SyncSnapshot) => void
  onRemoteApplied?: () => Promise<void> | void
}

let activeSync: Promise<SyncSnapshot> | null = null
let rerunRequested = false
let debounceTimer: number | undefined

function outboxKey(entity: 'folder' | 'drawing', id: string): string {
  return `${entity}:${id}`
}

export async function queueFolderUpsert(id: string, updatedAt = Date.now()): Promise<void> {
  await db.folders.update(id, { updatedAt })
  await db.syncOutbox.put({
    key: outboxKey('folder', id),
    entity: 'folder',
    id,
    deleted: false,
    needsBlobUpload: false,
    updatedAt,
  })
}

export async function queueFolderDelete(id: string, updatedAt = Date.now()): Promise<void> {
  await db.syncOutbox.put({
    key: outboxKey('folder', id),
    entity: 'folder',
    id,
    deleted: true,
    needsBlobUpload: false,
    updatedAt,
  })
}

export async function queueDrawingUpsert(
  id: string,
  options: { needsBlobUpload?: boolean; updatedAt?: number } = {},
): Promise<void> {
  const updatedAt = options.updatedAt ?? Date.now()
  await db.drawings.update(id, { updatedAt })
  const key = outboxKey('drawing', id)
  const existing = await db.syncOutbox.get(key)
  const needsBlobUpload = Boolean(options.needsBlobUpload || existing?.needsBlobUpload)
  await db.syncOutbox.put({
    key,
    entity: 'drawing',
    id,
    deleted: false,
    needsBlobUpload,
    updatedAt,
    blockedReason: needsBlobUpload ? existing?.blockedReason : undefined,
  })
}

export async function queueDrawingDeletes(ids: string[], updatedAt = Date.now()): Promise<void> {
  if (!ids.length) return
  await db.syncOutbox.bulkPut(
    ids.map((id) => ({
      key: outboxKey('drawing', id),
      entity: 'drawing' as const,
      id,
      deleted: true,
      needsBlobUpload: false,
      updatedAt,
    })),
  )
}

export async function getSyncSnapshot(
  phase: SyncPhase = 'idle',
  overrides: Partial<SyncSnapshot> = {},
): Promise<SyncSnapshot> {
  const [meta, outbox] = await Promise.all([
    db.syncMeta.get('state'),
    db.syncOutbox.toArray(),
  ])
  const quotaBlockedCount = outbox.filter((item) => item.blockedReason === 'quota').length
  const tooLargeCount = outbox.filter((item) => item.blockedReason === 'too_large').length
  const localOnlyIds = outbox
    .filter((item) => item.entity === 'drawing' && !item.deleted && (item.blockedReason === 'quota' || item.blockedReason === 'too_large'))
    .map((item) => item.id)
  return {
    phase,
    usedBytes: meta?.usedBytes ?? 0,
    quotaBytes: meta?.quotaBytes ?? DEFAULT_QUOTA_BYTES,
    lastSyncAt: meta?.lastSyncAt ?? null,
    pendingCount: outbox.length,
    quotaBlockedCount,
    tooLargeCount,
    localOnlyIds,
    errorMessage: null,
    previousAccountEmail: null,
    ...overrides,
  }
}

async function seedOutboxWithLocalLibrary(now: number): Promise<void> {
  const [folders, drawings, existingOutbox] = await Promise.all([
    db.folders.toArray(),
    db.drawings.toArray(),
    db.syncOutbox.toArray(),
  ])
  const existingKeys = new Set(existingOutbox.map((item) => item.key))
  const toPut: SyncOutboxRecord[] = []

  for (const folder of folders) {
    const key = outboxKey('folder', folder.id)
    if (!existingKeys.has(key)) {
      const updatedAt = folder.updatedAt ?? now
      if (!folder.updatedAt) await db.folders.update(folder.id, { updatedAt })
      toPut.push({
        key,
        entity: 'folder',
        id: folder.id,
        deleted: false,
        needsBlobUpload: false,
        updatedAt,
      })
    }
  }

  for (const drawing of drawings) {
    const key = outboxKey('drawing', drawing.id)
    if (!existingKeys.has(key)) {
      const updatedAt = drawing.updatedAt ?? drawing.createdAt ?? now
      if (!drawing.updatedAt) await db.drawings.update(drawing.id, { updatedAt })
      toPut.push({
        key,
        entity: 'drawing',
        id: drawing.id,
        deleted: false,
        needsBlobUpload: true,
        updatedAt,
      })
    }
  }

  if (toPut.length) {
    await db.syncOutbox.bulkPut(toPut)
  }
}

function toFolderPayload(item: SyncOutboxRecord, folder: FolderRecord | undefined): SyncFolderPayload | null {
  if (item.deleted) {
    return {
      id: item.id,
      name: folder?.name ?? '',
      updatedAt: item.updatedAt,
      deletedAt: item.updatedAt,
    }
  }
  if (!folder) return null
  return {
    id: folder.id,
    name: folder.name,
    updatedAt: Math.max(item.updatedAt, folder.updatedAt ?? item.updatedAt),
    deletedAt: null,
  }
}

function toDrawingPayload(item: SyncOutboxRecord, drawing: DrawingRecord | undefined): SyncDrawingPayload | null {
  if (item.deleted) {
    return {
      id: item.id,
      name: drawing?.name ?? '',
      createdAt: drawing?.createdAt ?? item.updatedAt,
      width: drawing?.width ?? 0,
      height: drawing?.height ?? 0,
      folderId: null,
      position: null,
      tags: [],
      visibleTagIds: null,
      updatedAt: item.updatedAt,
      deletedAt: item.updatedAt,
    }
  }
  if (!drawing) return null
  return {
    id: drawing.id,
    name: drawing.name,
    createdAt: drawing.createdAt,
    width: drawing.width,
    height: drawing.height,
    folderId: drawing.folderId ?? null,
    position: drawing.position ?? null,
    tags: drawing.tags ?? [],
    visibleTagIds: drawing.visibleTagIds ?? null,
    updatedAt: Math.max(item.updatedAt, drawing.updatedAt ?? drawing.createdAt),
    deletedAt: null,
  }
}

async function uploadBlob(
  drawingId: string,
  kind: SyncBlobKind,
  blob: Blob,
): Promise<
  | { ok: true; usedBytes: number; quotaBytes: number }
  | { ok: false; code: 'QUOTA_EXCEEDED' | 'FILE_TOO_LARGE' | 'ERROR'; usedBytes?: number; quotaBytes?: number }
> {
  const mime = blob.type || 'image/png'
  const res = await fetch(`/api/sync/blobs/${encodeURIComponent(drawingId)}/${kind}`, {
    method: 'PUT',
    signal: AbortSignal.timeout(30_000),
    headers: { 'Content-Type': mime },
    body: blob,
  })
  if (res.ok) {
    const data = (await res.json()) as { usedBytes: number; quotaBytes: number }
    return { ok: true, usedBytes: data.usedBytes, quotaBytes: data.quotaBytes }
  }
  const errBody = await res.json().catch(() => ({})) as { code?: string; usedBytes?: number; quotaBytes?: number }
  if (errBody.code === 'QUOTA_EXCEEDED') {
    return { ok: false, code: 'QUOTA_EXCEEDED', usedBytes: errBody.usedBytes, quotaBytes: errBody.quotaBytes }
  }
  if (errBody.code === 'FILE_TOO_LARGE') {
    return { ok: false, code: 'FILE_TOO_LARGE' }
  }
  return { ok: false, code: 'ERROR' }
}

async function downloadBlob(drawingId: string, kind: SyncBlobKind): Promise<Blob | null> {
  const res = await fetch(`/api/sync/blobs/${encodeURIComponent(drawingId)}/${kind}`, {
    method: 'GET',
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) return null
  return res.blob()
}

async function pushMetadataItems(
  items: SyncOutboxRecord[],
): Promise<{ usedBytes?: number; quotaBytes?: number; serverSeq?: number }> {
  if (!items.length) return {}
  let latestUsed: number | undefined
  let latestQuota: number | undefined
  let latestSeq: number | undefined

  const chunkSize = Math.min(50, MAX_PUSH_ITEMS)
  for (let i = 0; i < items.length; i += chunkSize) {
    const slice = items.slice(i, i + chunkSize)
    const folders: SyncFolderPayload[] = []
    const drawings: SyncDrawingPayload[] = []
    const obsoleteKeys: string[] = []

    for (const item of slice) {
      if (item.entity === 'folder') {
        const folder = item.deleted ? undefined : await db.folders.get(item.id)
        const payload = toFolderPayload(item, folder)
        if (payload) folders.push(payload)
        else obsoleteKeys.push(item.key)
      } else {
        const drawing = item.deleted ? undefined : await db.drawings.get(item.id)
        const payload = toDrawingPayload(item, drawing)
        if (payload) drawings.push(payload)
        else obsoleteKeys.push(item.key)
      }
    }

    if (obsoleteKeys.length) {
      await db.syncOutbox.bulkDelete(obsoleteKeys)
    }
    if (!folders.length && !drawings.length) continue

    const res = await fetch('/api/sync/push', {
      method: 'POST',
      signal: AbortSignal.timeout(15_000),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folders, drawings }),
    })
    if (!res.ok) {
      throw new Error(`Sync push failed (${res.status})`)
    }
    const data = (await res.json()) as SyncPushResponse
    latestUsed = data.usedBytes
    latestQuota = data.quotaBytes
    latestSeq = data.serverSeq

    const keysToDelete: string[] = [
      ...data.acceptedFolders.map((id) => outboxKey('folder', id)),
      ...data.acceptedDrawings.map((id) => outboxKey('drawing', id)),
      ...data.rejected
        .filter((r) => r.code === 'STALE')
        .map((r) => outboxKey(r.entity, r.id)),
    ]

    for (const rej of data.rejected) {
      if (rej.entity === 'drawing' && rej.code === 'MISSING_BLOB') {
        const key = outboxKey('drawing', rej.id)
        const cur = await db.syncOutbox.get(key)
        if (cur && !cur.deleted) {
          await db.syncOutbox.put({ ...cur, needsBlobUpload: true })
        }
      }
    }

    if (keysToDelete.length) {
      await db.syncOutbox.bulkDelete(keysToDelete)
    }
  }

  return { usedBytes: latestUsed, quotaBytes: latestQuota, serverSeq: latestSeq }
}

async function runSyncCycle(user: SyncUser, options: SyncOptions): Promise<SyncSnapshot> {
  const emit = (snap: SyncSnapshot) => {
    options.onStateChange?.(snap)
    return snap
  }

  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return emit(await getSyncSnapshot('offline'))
  }

  const now = Date.now()
  let meta = await db.syncMeta.get('state')

  if (meta && meta.userId !== user.id) {
    if (!options.accountSwitchMode) {
      return emit(
        await getSyncSnapshot('account_mismatch', {
          previousAccountEmail: meta.userEmail,
        }),
      )
    }
    if (options.accountSwitchMode === 'replace') {
      await db.transaction('rw', db.drawings, db.folders, db.syncOutbox, db.syncMeta, async () => {
        await db.drawings.clear()
        await db.folders.clear()
        await db.syncOutbox.clear()
        await db.syncMeta.delete('state')
      })
      await options.onRemoteApplied?.()
    } else {
      await db.syncMeta.delete('state')
    }
    meta = undefined
  }

  emit(await getSyncSnapshot('syncing'))

  // 1. Check server sync status
  const statusRes = await fetch('/api/sync/status', {
    method: 'GET',
    signal: AbortSignal.timeout(15_000),
  })
  if (statusRes.status === 503) {
    const body = await statusRes.json().catch(() => ({})) as { code?: string }
    if (body.code === 'SYNC_NOT_CONFIGURED') {
      return emit(
        await getSyncSnapshot('unavailable', {
          errorMessage: 'Cloud sync storage is not enabled yet.',
        }),
      )
    }
    return emit(await getSyncSnapshot('error', { errorMessage: 'Cloud sync is temporarily unavailable.' }))
  }
  if (statusRes.status === 401) {
    return emit(await getSyncSnapshot('idle'))
  }
  if (!statusRes.ok) {
    return emit(await getSyncSnapshot('error', { errorMessage: 'Could not reach cloud sync.' }))
  }

  const statusData = (await statusRes.json()) as SyncStatusResponse
  let usedBytes = statusData.usedBytes
  let quotaBytes = statusData.quotaBytes

  if (!meta) {
    meta = {
      key: 'state',
      userId: user.id,
      userEmail: user.email,
      lastSeq: 0,
      lastSyncAt: null,
      usedBytes,
      quotaBytes,
    }
    await db.syncMeta.put(meta)
    await seedOutboxWithLocalLibrary(now)
  }

  // 2. Push deletions, folders, and metadata-only drawing updates first (frees quota before uploading new blobs)
  const allOutbox = await db.syncOutbox.toArray()
  const metadataFirst = allOutbox.filter((item) => item.deleted || !item.needsBlobUpload)
  const firstPush = await pushMetadataItems(metadataFirst)
  if (firstPush.usedBytes !== undefined) usedBytes = firstPush.usedBytes
  if (firstPush.quotaBytes !== undefined) quotaBytes = firstPush.quotaBytes

  // 3. Upload pending blobs (sorted smallest first so small drawings are not blocked behind a huge one)
  const blobItems = (await db.syncOutbox.toArray()).filter(
    (item) => item.entity === 'drawing' && !item.deleted && item.needsBlobUpload && item.blockedReason !== 'too_large',
  )

  const blobCandidates: Array<{ item: SyncOutboxRecord; drawing: DrawingRecord; totalSize: number }> = []
  for (const item of blobItems) {
    const drawing = await db.drawings.get(item.id)
    if (!drawing) {
      await db.syncOutbox.delete(item.key)
      continue
    }
    if (drawing.blob.size > MAX_ORIGINAL_BLOB_BYTES) {
      await db.syncOutbox.put({ ...item, blockedReason: 'too_large' })
      continue
    }
    blobCandidates.push({
      item,
      drawing,
      totalSize: drawing.blob.size + drawing.thumb.size,
    })
  }

  blobCandidates.sort((a, b) => a.totalSize - b.totalSize)

  const uploadedForPush: SyncOutboxRecord[] = []
  for (const { item, drawing } of blobCandidates) {

    const thumbUpload = await uploadBlob(drawing.id, 'thumb', drawing.thumb)
    if (!thumbUpload.ok) {
      if (thumbUpload.code === 'QUOTA_EXCEEDED') {
        if (thumbUpload.usedBytes !== undefined) usedBytes = thumbUpload.usedBytes
        if (thumbUpload.quotaBytes !== undefined) quotaBytes = thumbUpload.quotaBytes
        await db.syncOutbox.put({ ...item, blockedReason: 'quota' })
        continue
      }
      if (thumbUpload.code === 'FILE_TOO_LARGE') {
        await db.syncOutbox.put({ ...item, blockedReason: 'too_large' })
        continue
      }
      throw new Error('Could not upload drawing thumbnail')
    }
    usedBytes = thumbUpload.usedBytes
    quotaBytes = thumbUpload.quotaBytes

    const origUpload = await uploadBlob(drawing.id, 'original', drawing.blob)
    if (!origUpload.ok) {
      if (origUpload.code === 'QUOTA_EXCEEDED') {
        if (origUpload.usedBytes !== undefined) usedBytes = origUpload.usedBytes
        if (origUpload.quotaBytes !== undefined) quotaBytes = origUpload.quotaBytes
        await db.syncOutbox.put({ ...item, blockedReason: 'quota' })
        continue
      }
      if (origUpload.code === 'FILE_TOO_LARGE') {
        await db.syncOutbox.put({ ...item, blockedReason: 'too_large' })
        continue
      }
      throw new Error('Could not upload drawing image')
    }
    usedBytes = origUpload.usedBytes
    quotaBytes = origUpload.quotaBytes

    const readyItem: SyncOutboxRecord = {
      ...item,
      needsBlobUpload: false,
      blockedReason: undefined,
    }
    await db.syncOutbox.put(readyItem)
    uploadedForPush.push(readyItem)
  }

  if (uploadedForPush.length) {
    const secondPush = await pushMetadataItems(uploadedForPush)
    if (secondPush.usedBytes !== undefined) usedBytes = secondPush.usedBytes
    if (secondPush.quotaBytes !== undefined) quotaBytes = secondPush.quotaBytes
  }

  // 4. Pull remote changes incrementally
  let lastSeq = meta.lastSeq
  let remoteChanged = false
  let hasMore = true

  while (hasMore) {
    const pullRes = await fetch(`/api/sync/pull?since=${lastSeq}`, {
      method: 'GET',
      signal: AbortSignal.timeout(15_000),
    })
    if (!pullRes.ok) {
      throw new Error(`Sync pull failed (${pullRes.status})`)
    }
    const pullData = (await pullRes.json()) as SyncPullResponse
    usedBytes = pullData.usedBytes
    quotaBytes = pullData.quotaBytes

    for (const remoteFolder of pullData.folders) {
      const localPending = await db.syncOutbox.get(outboxKey('folder', remoteFolder.id))
      if (localPending && localPending.updatedAt > remoteFolder.updatedAt) continue

      if (remoteFolder.deletedAt !== null) {
        const existed = await db.folders.get(remoteFolder.id)
        if (existed) {
          await db.folders.delete(remoteFolder.id)
          remoteChanged = true
        }
      } else {
        await db.folders.put({
          id: remoteFolder.id,
          name: remoteFolder.name,
          updatedAt: remoteFolder.updatedAt,
        })
        remoteChanged = true
      }
    }

    for (const remoteDrawing of pullData.drawings) {
      const localPending = await db.syncOutbox.get(outboxKey('drawing', remoteDrawing.id))
      if (localPending && localPending.updatedAt > remoteDrawing.updatedAt) continue

      if (remoteDrawing.deletedAt !== null) {
        const existed = await db.drawings.get(remoteDrawing.id)
        if (existed) {
          await db.drawings.delete(remoteDrawing.id)
          remoteChanged = true
        }
        continue
      }

      const existingLocal = await db.drawings.get(remoteDrawing.id)
      if (existingLocal) {
        const dimensionsChanged =
          existingLocal.width !== remoteDrawing.width || existingLocal.height !== remoteDrawing.height
        const refreshedBlob = dimensionsChanged ? await downloadBlob(remoteDrawing.id, 'original') : null
        await db.drawings.put({
          ...existingLocal,
          blob: refreshedBlob ?? existingLocal.blob,
          name: remoteDrawing.name,
          createdAt: remoteDrawing.createdAt,
          updatedAt: remoteDrawing.updatedAt,
          width: remoteDrawing.width,
          height: remoteDrawing.height,
          folderId: remoteDrawing.folderId ?? undefined,
          position: remoteDrawing.position ?? undefined,
          tags: remoteDrawing.tags,
          visibleTagIds: remoteDrawing.visibleTagIds ?? undefined,
        })
        remoteChanged = true
      } else {
        const [origBlob, thumbBlob] = await Promise.all([
          downloadBlob(remoteDrawing.id, 'original'),
          downloadBlob(remoteDrawing.id, 'thumb'),
        ])
        if (!origBlob) continue
        await db.drawings.put({
          id: remoteDrawing.id,
          name: remoteDrawing.name,
          createdAt: remoteDrawing.createdAt,
          updatedAt: remoteDrawing.updatedAt,
          width: remoteDrawing.width,
          height: remoteDrawing.height,
          blob: origBlob,
          thumb: thumbBlob ?? origBlob,
          tags: remoteDrawing.tags,
          folderId: remoteDrawing.folderId ?? undefined,
          position: remoteDrawing.position ?? undefined,
          visibleTagIds: remoteDrawing.visibleTagIds ?? undefined,
        })
        remoteChanged = true
      }
    }

    lastSeq = pullData.serverSeq
    hasMore = pullData.hasMore
  }

  const nextMeta: SyncMetaRecord = {
    key: 'state',
    userId: user.id,
    userEmail: user.email,
    lastSeq,
    lastSyncAt: Date.now(),
    usedBytes,
    quotaBytes,
  }
  await db.syncMeta.put(nextMeta)

  if (remoteChanged) {
    await options.onRemoteApplied?.()
  }

  const finalOutbox = await db.syncOutbox.toArray()
  const hasQuotaBlock = finalOutbox.some((item) => item.blockedReason === 'quota')
  const finalPhase: SyncPhase = hasQuotaBlock ? 'quota_full' : 'synced'

  return emit(await getSyncSnapshot(finalPhase))
}

export function syncNow(user: SyncUser, options: SyncOptions = {}): Promise<SyncSnapshot> {
  if (activeSync) {
    rerunRequested = true
    return activeSync
  }

  const run = async (): Promise<SyncSnapshot> => {
    try {
      let result = await runSyncCycle(user, options)
      while (rerunRequested) {
        rerunRequested = false
        result = await runSyncCycle(user, options)
      }
      return result
    } catch (error) {
      const snap = await getSyncSnapshot('error', {
        errorMessage: error instanceof Error ? error.message : 'Cloud sync failed.',
      })
      options.onStateChange?.(snap)
      return snap
    } finally {
      activeSync = null
    }
  }

  activeSync = run()
  return activeSync
}

export function scheduleSync(user: SyncUser | null, options: SyncOptions = {}, delayMs = 2500): void {
  if (!user) return
  if (debounceTimer) window.clearTimeout(debounceTimer)
  debounceTimer = window.setTimeout(() => {
    debounceTimer = undefined
    void syncNow(user, options)
  }, delayMs)
}

export async function deleteAccountAndCloudData(): Promise<boolean> {
  const res = await fetch('/api/sync/account', {
    method: 'DELETE',
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) return false
  if (debounceTimer) {
    window.clearTimeout(debounceTimer)
    debounceTimer = undefined
  }
  await db.transaction('rw', db.syncMeta, db.syncOutbox, async () => {
    await db.syncMeta.delete('state')
    await db.syncOutbox.clear()
  })
  return true
}
