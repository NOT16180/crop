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
  width: number
  height: number
  blob: Blob
  thumb: Blob
  tags: Tag[]
}

class LibraryDB extends Dexie {
  drawings!: Table<DrawingRecord, string>

  constructor() {
    super('drawing-library')
    this.version(1).stores({
      drawings: 'id, createdAt, name',
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
