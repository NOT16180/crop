import type { Rect, Tag } from './db'

export interface BackupDrawingRecord {
  id: string
  name: string
  width: number
  height: number
  folderId?: string
  tags: Tag[]
  visibleTagIds?: string[]
}

export function isValidBackupDrawing(
  value: unknown,
  folderIds: ReadonlySet<string>,
): value is BackupDrawingRecord {
  if (!value || typeof value !== 'object') return false
  const record = value as Partial<BackupDrawingRecord>
  if (typeof record.id !== 'string' || typeof record.name !== 'string' ||
      !Number.isSafeInteger(record.width) || (record.width ?? 0) <= 0 ||
      !Number.isSafeInteger(record.height) || (record.height ?? 0) <= 0 ||
      (record.folderId !== undefined && (typeof record.folderId !== 'string' || !folderIds.has(record.folderId))) ||
      !Array.isArray(record.tags) ||
      (record.visibleTagIds !== undefined && (!Array.isArray(record.visibleTagIds) ||
        !record.visibleTagIds.every((id) => typeof id === 'string')))) return false

  const tagIds = new Set<string>()
  return record.tags.every((tag) => {
    if (!tag || typeof tag.id !== 'string' || typeof tag.label !== 'string') return false
    if (!tag.id || tagIds.has(tag.id)) return false
    tagIds.add(tag.id)
    if (tag.box === null) return true
    const box = tag.box as Rect | undefined
    return Array.isArray(box) && box.length === 4 && box.every(Number.isSafeInteger) &&
      box[0] >= 0 && box[1] >= 0 && box[2] > 0 && box[3] > 0 &&
      box[0] + box[2] <= record.width! && box[1] + box[3] <= record.height!
  })
}
