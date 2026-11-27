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

function asciiAt(bytes: Uint8Array, offset: number, length: number): string {
  let out = ''
  for (let i = 0; i < length; i++) {
    out += String.fromCharCode(bytes[offset + i] ?? 0)
  }
  return out
}

/**
 * Inspect the leading magic bytes of an uploaded buffer to confirm it is
 * genuinely a PNG, JPEG, WebP, or AVIF image rather than a spoofed file.
 */
export function detectImageMime(bytes: Uint8Array): string | null {
  if (bytes.byteLength >= 8 &&
      bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
      bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    return 'image/png'
  }

  if (bytes.byteLength >= 3 &&
      bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg'
  }

  if (bytes.byteLength >= 12 &&
      asciiAt(bytes, 0, 4) === 'RIFF' &&
      asciiAt(bytes, 8, 4) === 'WEBP') {
    return 'image/webp'
  }

  if (bytes.byteLength >= 12 && asciiAt(bytes, 4, 4) === 'ftyp') {
    const major = asciiAt(bytes, 8, 4)
    if (major === 'avif' || major === 'avis') return 'image/avif'
    if (major === 'mif1' || major === 'msf1') {
      const boxSize = ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0
      const limit = Math.min(bytes.byteLength, boxSize || bytes.byteLength, 128)
      for (let offset = 16; offset + 4 <= limit; offset += 4) {
        const brand = asciiAt(bytes, offset, 4)
        if (brand === 'avif' || brand === 'avis') return 'image/avif'
      }
    }
  }

  return null
}
