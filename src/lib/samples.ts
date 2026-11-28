import { db, type DrawingRecord, type FolderRecord, type Rect } from './db'
import {
  SAMPLE_DRAWINGS,
  SAMPLE_FOLDER_ID,
  SAMPLE_FOLDER_NAME,
  SAMPLE_QUICK_TAGS,
} from './sample-data'

export { SAMPLE_QUICK_TAGS }

/**
 * Load the bundled sample illustrations locally into IndexedDB.
 * Marked with isSample=true so they stay local-only (never consume cloud quota)
 * and can be removed in one click without touching the user's own drawings.
 */
export async function loadSampleDrawings(): Promise<{ added: number }> {
  const existing = await db.drawings.toArray()
  const existingIds = new Set(existing.map((d) => d.id))
  const missing = SAMPLE_DRAWINGS.filter((spec) => !existingIds.has(spec.id))
  if (missing.length === 0) return { added: 0 }

  const fetched = await Promise.all(
    missing.map(async (spec) => {
      const response = await fetch(spec.url)
      if (!response.ok) throw new Error(`Could not load sample image (${spec.name})`)
      const buffer = await response.arrayBuffer()
      const blob = new Blob([buffer], { type: 'image/webp' })
      return { spec, blob }
    }),
  )

  const existingFolder = await db.folders.get(SAMPLE_FOLDER_ID)
  const now = Date.now()
  let position = existing.reduce((max, d) => Math.max(max, d.position ?? -1), -1) + 1

  const records: DrawingRecord[] = fetched.map(({ spec, blob }, idx) => ({
    id: spec.id,
    name: spec.name,
    createdAt: now - (fetched.length - idx) * 1000,
    updatedAt: now,
    width: spec.width,
    height: spec.height,
    blob,
    thumb: blob,
    tags: spec.tags.map((tag) => ({
      id: tag.id,
      label: tag.label,
      box: tag.box ? ([tag.box[0], tag.box[1], tag.box[2], tag.box[3]] as Rect) : null,
    })),
    visibleTagIds: spec.tags.map((tag) => tag.id),
    folderId: SAMPLE_FOLDER_ID,
    position: position++,
    isSample: true,
  }))

  await db.transaction('rw', db.folders, db.drawings, async () => {
    if (!existingFolder) {
      const folder: FolderRecord = {
        id: SAMPLE_FOLDER_ID,
        name: SAMPLE_FOLDER_NAME,
        updatedAt: now,
        isSample: true,
      }
      await db.folders.put(folder)
    }
    await db.drawings.bulkPut(records)
  })

  return { added: records.length }
}

/**
 * Remove only the local demo sample drawings (and the sample folder if empty),
 * leaving any artwork imported by the user completely untouched.
 */
export async function removeSampleDrawings(): Promise<{ removed: number }> {
  const allDrawings = await db.drawings.toArray()
  const sampleIds = allDrawings.filter((d) => d.isSample).map((d) => d.id)
  const remainingInSampleFolder = allDrawings.some(
    (d) => !d.isSample && d.folderId === SAMPLE_FOLDER_ID,
  )

  await db.transaction('rw', db.drawings, db.folders, async () => {
    if (sampleIds.length) {
      await db.drawings.bulkDelete(sampleIds)
    }
    if (!remainingInSampleFolder) {
      const folder = await db.folders.get(SAMPLE_FOLDER_ID)
      if (folder?.isSample) {
        await db.folders.delete(SAMPLE_FOLDER_ID)
      }
    }
  })

  return { removed: sampleIds.length }
}
