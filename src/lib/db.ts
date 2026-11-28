import Dexie, { type Table } from 'dexie'

/** Rectangle: x, y, width, and height in original-image pixels. */
export type Rect = [number, number, number, number]

/** A manually assigned tag for a region or the whole drawing (box = null). */
export interface Tag {
  id: string
  label: string
  box: Rect | null
}

export interface DrawingRecord {
  id: string
  name: string
  createdAt: number
  updatedAt?: number
  width: number
  height: number
  blob: Blob
  thumb: Blob
  tags: Tag[]
  folderId?: string
  position?: number
  visibleTagIds?: string[]
  isSample?: boolean
}

export interface FolderRecord {
  id: string
  name: string
  updatedAt?: number
  isSample?: boolean
}

export interface SyncOutboxRecord {
  key: string
  entity: 'folder' | 'drawing'
  id: string
  deleted: boolean
  needsBlobUpload: boolean
  updatedAt: number
  blockedReason?: 'quota' | 'too_large'
}

export interface SyncMetaRecord {
  key: 'state'
  userId: string
  userEmail: string
  lastSeq: number
  lastSyncAt: number | null
  usedBytes: number
  quotaBytes: number
}

class LibraryDB extends Dexie {
  drawings!: Table<DrawingRecord, string>
  folders!: Table<FolderRecord, string>
  syncOutbox!: Table<SyncOutboxRecord, string>
  syncMeta!: Table<SyncMetaRecord, string>

  constructor() {
    super('drawing-library')
    this.version(1).stores({
      drawings: 'id, createdAt, name',
    })
    this.version(2).stores({
      drawings: 'id, createdAt, name, folderId',
      folders: 'id, name',
    })
    this.version(3).stores({
      drawings: 'id, createdAt, name, folderId, position',
      folders: 'id, name',
    })
    this.version(4).stores({
      drawings: 'id, createdAt, name, folderId, position',
      folders: 'id, name',
      syncOutbox: 'key, entity, id, updatedAt',
      syncMeta: 'key',
    })
  }
}

export const db = new LibraryDB()

/** Ask the browser to preserve this data when storage is under pressure. */
export async function requestPersistence(): Promise<boolean> {
  try {
    if (navigator.storage?.persist) return await navigator.storage.persist()
  } catch {
    // Intentionally ignored: persistence is a best-effort enhancement.
  }
  return false
}

const LEGACY_FLAG = 'legacy-analysis-removed'

/**
 * Earlier versions stored automatic analysis data (region embeddings).
 * Remove it once: it is no longer used and takes up space.
 */
export async function removeLegacyAnalysisData(): Promise<void> {
  try {
    if (localStorage.getItem(LEGACY_FLAG)) return
  } catch {
    // localStorage is unavailable; continue cleanup anyway.
  }
  await db.drawings.toCollection().modify((drawing) => {
    const record = drawing as unknown as Record<string, unknown>
    delete record.regions
    delete record.embedding
    if (Array.isArray(record.tags)) {
      for (const tag of record.tags as Record<string, unknown>[]) delete tag.embedding
    }
  })
  try {
    localStorage.setItem(LEGACY_FLAG, '1')
  } catch {
    // Intentionally ignored.
  }
}
