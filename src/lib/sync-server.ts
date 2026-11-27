import {
  DEFAULT_QUOTA_BYTES,
  MAX_ORIGINAL_BLOB_BYTES,
  MAX_PULL_LIMIT,
  MAX_PUSH_ITEMS,
  MAX_THUMB_BLOB_BYTES,
  detectImageMime,
  isValidBlobKind,
  isValidSyncId,
  normalizeImageMime,
  r2BlobKey,
  type SyncBlobKind,
  type SyncDrawingPayload,
  type SyncFolderPayload,
  type SyncPullResponse,
  type SyncPushRejection,
  type SyncPushRequest,
  type SyncPushResponse,
  type SyncStatusResponse,
  type SyncTagPayload,
} from './sync-protocol.ts'

export interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike
  first<T = Record<string, unknown>>(): Promise<T | null>
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>
  run(): Promise<unknown>
}

export interface D1DatabaseLike {
  prepare(sql: string): D1PreparedStatementLike
}

export interface R2ObjectLike {
  body: ReadableStream | ArrayBuffer | Uint8Array | null
  size?: number
  httpMetadata?: { contentType?: string }
  arrayBuffer(): Promise<ArrayBuffer>
}

export interface R2BucketLike {
  put(
    key: string,
    value: ArrayBuffer | Uint8Array | ReadableStream,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<unknown>
  get(key: string): Promise<R2ObjectLike | null>
  delete(keys: string | string[]): Promise<unknown>
}

export interface SyncHandlerDeps {
  db: D1DatabaseLike
  blobs: R2BucketLike
  userId: string
  now?: () => number
}

interface UserStorageRow {
  user_id: string
  used_bytes: number
  quota_bytes: number
  sync_seq: number
}

interface SyncFolderRow {
  id: string
  name: string
  updated_at: number
  server_seq: number
  deleted_at: number | null
}

interface SyncDrawingRow {
  id: string
  name: string
  created_at: number
  width: number
  height: number
  folder_id: string | null
  position: number | null
  tags_json: string
  visible_tag_ids_json: string | null
  updated_at: number
  server_seq: number
  deleted_at: number | null
}

function jsonNoStore(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  })
}

async function ensureUserStorage(db: D1DatabaseLike, userId: string, now: number): Promise<UserStorageRow> {
  await db
    .prepare(
      'INSERT OR IGNORE INTO user_storage (user_id, used_bytes, quota_bytes, sync_seq, updated_at) VALUES (?, 0, ?, 0, ?)',
    )
    .bind(userId, DEFAULT_QUOTA_BYTES, now)
    .run()

  const row = await db
    .prepare('SELECT user_id, used_bytes, quota_bytes, sync_seq FROM user_storage WHERE user_id = ?')
    .bind(userId)
    .first<UserStorageRow>()

  if (!row) {
    throw new Error('Could not initialize user storage row')
  }
  return row
}

async function recalculateUsedBytes(db: D1DatabaseLike, userId: string, now: number): Promise<number> {
  const sumRow = await db
    .prepare('SELECT COALESCE(SUM(size), 0) AS total FROM sync_blob WHERE user_id = ?')
    .bind(userId)
    .first<{ total: number }>()
  const usedBytes = Number(sumRow?.total ?? 0)
  await db
    .prepare('UPDATE user_storage SET used_bytes = ?, updated_at = ? WHERE user_id = ?')
    .bind(usedBytes, now, userId)
    .run()
  return usedBytes
}

async function nextServerSeq(db: D1DatabaseLike, userId: string, now: number): Promise<number> {
  await db
    .prepare('UPDATE user_storage SET sync_seq = sync_seq + 1, updated_at = ? WHERE user_id = ?')
    .bind(now, userId)
    .run()
  const row = await db
    .prepare('SELECT sync_seq FROM user_storage WHERE user_id = ?')
    .bind(userId)
    .first<{ sync_seq: number }>()
  return Number(row?.sync_seq ?? 0)
}

function isValidTag(value: unknown): value is SyncTagPayload {
  if (!value || typeof value !== 'object') return false
  const tag = value as Record<string, unknown>
  if (!isValidSyncId(tag.id)) return false
  if (typeof tag.label !== 'string' || !tag.label.trim() || tag.label.length > 200) return false
  if (tag.box === null) return true
  if (!Array.isArray(tag.box) || tag.box.length !== 4) return false
  return tag.box.every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0)
}

function isValidFolderPayload(value: unknown): value is SyncFolderPayload {
  if (!value || typeof value !== 'object') return false
  const f = value as Record<string, unknown>
  if (!isValidSyncId(f.id)) return false
  if (typeof f.name !== 'string' || f.name.length > 200) return false
  if (typeof f.updatedAt !== 'number' || !Number.isFinite(f.updatedAt) || f.updatedAt < 0) return false
  if (f.deletedAt !== null && (typeof f.deletedAt !== 'number' || !Number.isFinite(f.deletedAt))) return false
  return true
}

function isValidDrawingPayload(value: unknown): value is SyncDrawingPayload {
  if (!value || typeof value !== 'object') return false
  const d = value as Record<string, unknown>
  if (!isValidSyncId(d.id)) return false
  if (typeof d.name !== 'string' || d.name.length > 300) return false
  if (typeof d.createdAt !== 'number' || !Number.isFinite(d.createdAt) || d.createdAt < 0) return false
  if (typeof d.updatedAt !== 'number' || !Number.isFinite(d.updatedAt) || d.updatedAt < 0) return false
  if (d.deletedAt !== null && (typeof d.deletedAt !== 'number' || !Number.isFinite(d.deletedAt))) return false
  if (d.deletedAt === null) {
    if (typeof d.width !== 'number' || !Number.isInteger(d.width) || d.width <= 0) return false
    if (typeof d.height !== 'number' || !Number.isInteger(d.height) || d.height <= 0) return false
  }
  if (d.folderId !== null && !isValidSyncId(d.folderId)) return false
  if (d.position !== null && (typeof d.position !== 'number' || !Number.isFinite(d.position))) return false
  if (!Array.isArray(d.tags) || d.tags.length > 500 || !d.tags.every(isValidTag)) return false
  if (
    d.visibleTagIds !== null &&
    (!Array.isArray(d.visibleTagIds) || !d.visibleTagIds.every((id) => isValidSyncId(id)))
  ) {
    return false
  }
  return true
}

async function handleStatus(deps: SyncHandlerDeps): Promise<Response> {
  const now = (deps.now ?? Date.now)()
  const storage = await ensureUserStorage(deps.db, deps.userId, now)
  const payload: SyncStatusResponse = {
    usedBytes: Number(storage.used_bytes),
    quotaBytes: Number(storage.quota_bytes),
    serverSeq: Number(storage.sync_seq),
    maxBlobBytes: MAX_ORIGINAL_BLOB_BYTES,
  }
  return jsonNoStore(payload)
}

async function handlePutBlob(
  request: Request,
  deps: SyncHandlerDeps,
  drawingId: string,
  kind: SyncBlobKind,
): Promise<Response> {
  const now = (deps.now ?? Date.now)()
  const mime = normalizeImageMime(request.headers.get('Content-Type'))
  if (!mime) {
    return jsonNoStore({ error: 'Unsupported image content type', code: 'UNSUPPORTED_MEDIA_TYPE' }, 415)
  }

  const maxBytes = kind === 'original' ? MAX_ORIGINAL_BLOB_BYTES : MAX_THUMB_BLOB_BYTES
  const contentLengthHeader = request.headers.get('Content-Length')
  if (contentLengthHeader) {
    const declared = Number(contentLengthHeader)
    if (Number.isFinite(declared) && declared > maxBytes) {
      return jsonNoStore({ error: 'Image exceeds maximum allowed size', code: 'FILE_TOO_LARGE', maxBytes }, 413)
    }
  }

  const bytes = await request.arrayBuffer()
  if (bytes.byteLength === 0) {
    return jsonNoStore({ error: 'Empty image payload', code: 'INVALID_PAYLOAD' }, 400)
  }
  if (bytes.byteLength > maxBytes) {
    return jsonNoStore({ error: 'Image exceeds maximum allowed size', code: 'FILE_TOO_LARGE', maxBytes }, 413)
  }

  const detectedMime = detectImageMime(new Uint8Array(bytes))
  if (!detectedMime) {
    return jsonNoStore({ error: 'File content is not a valid supported image', code: 'INVALID_IMAGE_SIGNATURE' }, 415)
  }

  const storage = await ensureUserStorage(deps.db, deps.userId, now)
  const existingBlob = await deps.db
    .prepare('SELECT size FROM sync_blob WHERE user_id = ? AND drawing_id = ? AND kind = ?')
    .bind(deps.userId, drawingId, kind)
    .first<{ size: number }>()

  const previousSize = Number(existingBlob?.size ?? 0)
  const currentUsed = Number(storage.used_bytes)
  const quotaBytes = Number(storage.quota_bytes)
  const projectedUsed = currentUsed - previousSize + bytes.byteLength

  if (projectedUsed > quotaBytes) {
    return jsonNoStore(
      {
        error: 'Cloud storage quota exceeded',
        code: 'QUOTA_EXCEEDED',
        usedBytes: currentUsed,
        quotaBytes,
      },
      413,
    )
  }

  const key = r2BlobKey(deps.userId, drawingId, kind)
  await deps.blobs.put(key, bytes, { httpMetadata: { contentType: detectedMime } })
  await deps.db
    .prepare(
      `INSERT INTO sync_blob (user_id, drawing_id, kind, size, mime, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, drawing_id, kind)
       DO UPDATE SET size = excluded.size, mime = excluded.mime, updated_at = excluded.updated_at`,
    )
    .bind(deps.userId, drawingId, kind, bytes.byteLength, detectedMime, now)
    .run()

  const finalUsed = await recalculateUsedBytes(deps.db, deps.userId, now)
  // Guard against concurrent uploads pushing total storage past quota.
  if (finalUsed > quotaBytes && !existingBlob) {
    await deps.blobs.delete(key)
    await deps.db
      .prepare('DELETE FROM sync_blob WHERE user_id = ? AND drawing_id = ? AND kind = ?')
      .bind(deps.userId, drawingId, kind)
      .run()
    const rolledBackUsed = await recalculateUsedBytes(deps.db, deps.userId, now)
    return jsonNoStore(
      {
        error: 'Cloud storage quota exceeded',
        code: 'QUOTA_EXCEEDED',
        usedBytes: rolledBackUsed,
        quotaBytes,
      },
      413,
    )
  }

  return jsonNoStore({
    ok: true,
    drawingId,
    kind,
    size: bytes.byteLength,
    usedBytes: finalUsed,
    quotaBytes,
  })
}

async function handleGetBlob(
  deps: SyncHandlerDeps,
  drawingId: string,
  kind: SyncBlobKind,
): Promise<Response> {
  const key = r2BlobKey(deps.userId, drawingId, kind)
  const object = await deps.blobs.get(key)
  if (!object || !object.body) {
    return jsonNoStore({ error: 'Blob not found', code: 'NOT_FOUND' }, 404)
  }
  const contentType = object.httpMetadata?.contentType || 'application/octet-stream'
  return new Response(object.body as BodyInit, {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'private, max-age=31536000, immutable',
    },
  })
}

async function handlePush(request: Request, deps: SyncHandlerDeps): Promise<Response> {
  const now = (deps.now ?? Date.now)()
  let body: SyncPushRequest
  try {
    body = (await request.json()) as SyncPushRequest
  } catch {
    return jsonNoStore({ error: 'Invalid JSON body', code: 'INVALID_PAYLOAD' }, 400)
  }

  const folders = Array.isArray(body?.folders) ? body.folders : []
  const drawings = Array.isArray(body?.drawings) ? body.drawings : []
  if (folders.length + drawings.length > MAX_PUSH_ITEMS) {
    return jsonNoStore({ error: `Batch exceeds ${MAX_PUSH_ITEMS} items`, code: 'BATCH_TOO_LARGE' }, 400)
  }

  let storage = await ensureUserStorage(deps.db, deps.userId, now)
  const acceptedFolders: string[] = []
  const acceptedDrawings: string[] = []
  const rejected: SyncPushRejection[] = []
  let blobsDeleted = false

  for (const rawFolder of folders) {
    if (!isValidFolderPayload(rawFolder)) {
      const id = rawFolder && typeof (rawFolder as { id?: unknown }).id === 'string'
        ? (rawFolder as { id: string }).id
        : 'unknown'
      rejected.push({ entity: 'folder', id, code: 'INVALID_PAYLOAD' })
      continue
    }

    const existing = await deps.db
      .prepare('SELECT updated_at FROM sync_folder WHERE user_id = ? AND id = ?')
      .bind(deps.userId, rawFolder.id)
      .first<{ updated_at: number }>()

    if (existing && Number(existing.updated_at) > rawFolder.updatedAt) {
      rejected.push({ entity: 'folder', id: rawFolder.id, code: 'STALE' })
      continue
    }

    const seq = await nextServerSeq(deps.db, deps.userId, now)
    await deps.db
      .prepare(
        `INSERT INTO sync_folder (user_id, id, name, updated_at, server_seq, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, id)
         DO UPDATE SET
           name = excluded.name,
           updated_at = excluded.updated_at,
           server_seq = excluded.server_seq,
           deleted_at = excluded.deleted_at`,
      )
      .bind(deps.userId, rawFolder.id, rawFolder.name, rawFolder.updatedAt, seq, rawFolder.deletedAt)
      .run()
    acceptedFolders.push(rawFolder.id)
  }

  for (const rawDrawing of drawings) {
    if (!isValidDrawingPayload(rawDrawing)) {
      const id = rawDrawing && typeof (rawDrawing as { id?: unknown }).id === 'string'
        ? (rawDrawing as { id: string }).id
        : 'unknown'
      rejected.push({ entity: 'drawing', id, code: 'INVALID_PAYLOAD' })
      continue
    }

    const existing = await deps.db
      .prepare('SELECT updated_at FROM sync_drawing WHERE user_id = ? AND id = ?')
      .bind(deps.userId, rawDrawing.id)
      .first<{ updated_at: number }>()

    if (existing && Number(existing.updated_at) > rawDrawing.updatedAt) {
      rejected.push({ entity: 'drawing', id: rawDrawing.id, code: 'STALE' })
      continue
    }

    if (rawDrawing.deletedAt === null) {
      const origBlob = await deps.db
        .prepare('SELECT size FROM sync_blob WHERE user_id = ? AND drawing_id = ? AND kind = ?')
        .bind(deps.userId, rawDrawing.id, 'original')
        .first<{ size: number }>()
      if (!origBlob) {
        rejected.push({ entity: 'drawing', id: rawDrawing.id, code: 'MISSING_BLOB' })
        continue
      }
    }

    const seq = await nextServerSeq(deps.db, deps.userId, now)
    await deps.db
      .prepare(
        `INSERT INTO sync_drawing (
           user_id, id, name, created_at, width, height, folder_id, position,
           tags_json, visible_tag_ids_json, updated_at, server_seq, deleted_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, id)
         DO UPDATE SET
           name = excluded.name,
           created_at = excluded.created_at,
           width = excluded.width,
           height = excluded.height,
           folder_id = excluded.folder_id,
           position = excluded.position,
           tags_json = excluded.tags_json,
           visible_tag_ids_json = excluded.visible_tag_ids_json,
           updated_at = excluded.updated_at,
           server_seq = excluded.server_seq,
           deleted_at = excluded.deleted_at`,
      )
      .bind(
        deps.userId,
        rawDrawing.id,
        rawDrawing.name,
        rawDrawing.createdAt,
        rawDrawing.width,
        rawDrawing.height,
        rawDrawing.folderId,
        rawDrawing.position,
        JSON.stringify(rawDrawing.tags),
        rawDrawing.visibleTagIds ? JSON.stringify(rawDrawing.visibleTagIds) : null,
        rawDrawing.updatedAt,
        seq,
        rawDrawing.deletedAt,
      )
      .run()

    if (rawDrawing.deletedAt !== null) {
      await deps.blobs.delete([
        r2BlobKey(deps.userId, rawDrawing.id, 'original'),
        r2BlobKey(deps.userId, rawDrawing.id, 'thumb'),
      ])
      await deps.db
        .prepare('DELETE FROM sync_blob WHERE user_id = ? AND drawing_id = ?')
        .bind(deps.userId, rawDrawing.id)
        .run()
      blobsDeleted = true
    }

    acceptedDrawings.push(rawDrawing.id)
  }

  if (blobsDeleted) {
    await recalculateUsedBytes(deps.db, deps.userId, now)
  }
  storage = await ensureUserStorage(deps.db, deps.userId, now)

  const response: SyncPushResponse = {
    serverSeq: Number(storage.sync_seq),
    usedBytes: Number(storage.used_bytes),
    quotaBytes: Number(storage.quota_bytes),
    acceptedFolders,
    acceptedDrawings,
    rejected,
  }
  return jsonNoStore(response)
}

async function handlePull(request: Request, deps: SyncHandlerDeps): Promise<Response> {
  const now = (deps.now ?? Date.now)()
  const url = new URL(request.url)
  const rawSince = Number(url.searchParams.get('since') ?? '0')
  const since = Number.isInteger(rawSince) && rawSince >= 0 ? rawSince : 0
  const rawLimit = Number(url.searchParams.get('limit') ?? String(MAX_PULL_LIMIT))
  const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, MAX_PULL_LIMIT) : MAX_PULL_LIMIT

  const storage = await ensureUserStorage(deps.db, deps.userId, now)

  const folderRes = await deps.db
    .prepare(
      `SELECT id, name, updated_at, server_seq, deleted_at
       FROM sync_folder
       WHERE user_id = ? AND server_seq > ?
       ORDER BY server_seq ASC
       LIMIT ?`,
    )
    .bind(deps.userId, since, limit + 1)
    .all<SyncFolderRow>()

  const drawingRes = await deps.db
    .prepare(
      `SELECT id, name, created_at, width, height, folder_id, position,
              tags_json, visible_tag_ids_json, updated_at, server_seq, deleted_at
       FROM sync_drawing
       WHERE user_id = ? AND server_seq > ?
       ORDER BY server_seq ASC
       LIMIT ?`,
    )
    .bind(deps.userId, since, limit + 1)
    .all<SyncDrawingRow>()

  const hasMoreFolders = folderRes.results.length > limit
  const hasMoreDrawings = drawingRes.results.length > limit

  let folderRows = folderRes.results.slice(0, limit)
  let drawingRows = drawingRes.results.slice(0, limit)

  const cutoffSeq = Math.min(
    hasMoreFolders && folderRows.length ? Number(folderRows[folderRows.length - 1].server_seq) : Number.POSITIVE_INFINITY,
    hasMoreDrawings && drawingRows.length ? Number(drawingRows[drawingRows.length - 1].server_seq) : Number.POSITIVE_INFINITY,
  )
  if (Number.isFinite(cutoffSeq)) {
    folderRows = folderRows.filter((row) => Number(row.server_seq) <= cutoffSeq)
    drawingRows = drawingRows.filter((row) => Number(row.server_seq) <= cutoffSeq)
  }

  const folders: SyncFolderPayload[] = folderRows.map((row) => ({
    id: row.id,
    name: row.name,
    updatedAt: Number(row.updated_at),
    deletedAt: row.deleted_at === null ? null : Number(row.deleted_at),
    serverSeq: Number(row.server_seq),
  }))

  const drawings: SyncDrawingPayload[] = drawingRows.map((row) => ({
    id: row.id,
    name: row.name,
    createdAt: Number(row.created_at),
    width: Number(row.width),
    height: Number(row.height),
    folderId: row.folder_id,
    position: row.position === null ? null : Number(row.position),
    tags: JSON.parse(row.tags_json || '[]') as SyncTagPayload[],
    visibleTagIds: row.visible_tag_ids_json ? (JSON.parse(row.visible_tag_ids_json) as string[]) : null,
    updatedAt: Number(row.updated_at),
    deletedAt: row.deleted_at === null ? null : Number(row.deleted_at),
    serverSeq: Number(row.server_seq),
  }))

  const hasMore = hasMoreFolders || hasMoreDrawings
  const maxReturnedSeq = Math.max(
    since,
    ...folders.map((f) => f.serverSeq ?? since),
    ...drawings.map((d) => d.serverSeq ?? since),
  )

  const response: SyncPullResponse = {
    folders,
    drawings,
    serverSeq: hasMore ? (Number.isFinite(cutoffSeq) ? cutoffSeq : maxReturnedSeq) : Number(storage.sync_seq),
    hasMore,
    usedBytes: Number(storage.used_bytes),
    quotaBytes: Number(storage.quota_bytes),
  }
  return jsonNoStore(response)
}

export async function handleSyncRequest(request: Request, deps: SyncHandlerDeps): Promise<Response> {
  const url = new URL(request.url)
  const path = url.pathname

  if (path === '/api/sync/status' && request.method === 'GET') {
    return handleStatus(deps)
  }
  if (path === '/api/sync/push' && request.method === 'POST') {
    return handlePush(request, deps)
  }
  if (path === '/api/sync/pull' && request.method === 'GET') {
    return handlePull(request, deps)
  }

  const blobMatch = path.match(/^\/api\/sync\/blobs\/([^/]+)\/([^/]+)$/)
  if (blobMatch) {
    const [, drawingId, kind] = blobMatch
    if (!isValidSyncId(drawingId) || !isValidBlobKind(kind)) {
      return jsonNoStore({ error: 'Invalid blob path', code: 'INVALID_PAYLOAD' }, 400)
    }
    if (request.method === 'PUT') return handlePutBlob(request, deps, drawingId, kind)
    if (request.method === 'GET') return handleGetBlob(deps, drawingId, kind)
    return jsonNoStore({ error: 'Method not allowed' }, 405)
  }

  return jsonNoStore({ error: 'Not found' }, 404)
}
