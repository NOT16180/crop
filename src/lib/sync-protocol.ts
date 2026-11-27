export const DEFAULT_QUOTA_BYTES = 100 * 1024 * 1024 // 100 MiB
export const MAX_ORIGINAL_BLOB_BYTES = 20 * 1024 * 1024 // 20 MiB
export const MAX_THUMB_BLOB_BYTES = 2 * 1024 * 1024 // 2 MiB
export const MAX_PUSH_ITEMS = 100
export const MAX_PULL_LIMIT = 100

export const ALLOWED_SYNC_IMAGE_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/avif',
])

export type SyncBlobKind = 'original' | 'thumb'

export interface SyncTagPayload {
  id: string
  label: string
  box: [number, number, number, number] | null
}

export interface SyncFolderPayload {
  id: string
  name: string
  updatedAt: number
  deletedAt: number | null
  serverSeq?: number
}

export interface SyncDrawingPayload {
  id: string
  name: string
  createdAt: number
  width: number
  height: number
  folderId: string | null
  position: number | null
  tags: SyncTagPayload[]
  visibleTagIds: string[] | null
  updatedAt: number
  deletedAt: number | null
  serverSeq?: number
}

export interface SyncStatusResponse {
  usedBytes: number
  quotaBytes: number
  serverSeq: number
  maxBlobBytes: number
}

export interface SyncPushRequest {
  folders?: SyncFolderPayload[]
  drawings?: SyncDrawingPayload[]
}

export interface SyncPushRejection {
  entity: 'folder' | 'drawing'
  id: string
  code: 'INVALID_PAYLOAD' | 'MISSING_BLOB' | 'STALE'
}

export interface SyncPushResponse {
  serverSeq: number
  usedBytes: number
  quotaBytes: number
  acceptedFolders: string[]
  acceptedDrawings: string[]
  rejected: SyncPushRejection[]
}

export interface SyncPullResponse {
  folders: SyncFolderPayload[]
  drawings: SyncDrawingPayload[]
  serverSeq: number
  hasMore: boolean
  usedBytes: number
  quotaBytes: number
}

const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/

export function isValidSyncId(value: unknown): value is string {
  return typeof value === 'string' && SAFE_ID_RE.test(value)
}

export function isValidBlobKind(value: unknown): value is SyncBlobKind {
  return value === 'original' || value === 'thumb'
}

export function normalizeImageMime(raw: string | null): string | null {
  if (!raw) return null
  const mime = raw.split(';', 1)[0].trim().toLowerCase()
  return ALLOWED_SYNC_IMAGE_MIMES.has(mime) ? mime : null
}

export function r2BlobKey(userId: string, drawingId: string, kind: SyncBlobKind): string {
  return `users/${userId}/drawings/${drawingId}/${kind}`
}

export function formatStorageBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${Math.round(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
