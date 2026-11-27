import { db, type DrawingRecord, type FolderRecord } from './db'
import { isValidBackupDrawing } from './backup-validation'
import {
  createStreamingZip,
  decodeUtf8,
  encodeUtf8,
  extractStreamingZip,
  MAX_ARCHIVE_BYTES,
  resolveRestoredImageMime,
  type ZipInputEntry,
} from './backup-archive'

interface BackupManifest {
  format: 'crop-backup'
  version: 1
  folders: FolderRecord[]
  drawings: (Omit<DrawingRecord, 'blob' | 'thumb'> & {
    blobType: string
    thumbType: string
  })[]
}

const RESTORE_BATCH_SIZE = 10

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

export async function downloadBackup(): Promise<void> {
  const [folders, ids] = await Promise.all([
    db.folders.toArray(),
    db.drawings.toCollection().primaryKeys() as Promise<string[]>,
  ])

  // Read lightweight metadata first (one record at a time without retaining blobs)
  // so the manifest stays in manual gallery order while keeping RAM low on mobile.
  const metaList: Array<{
    id: string
    record: Omit<DrawingRecord, 'blob' | 'thumb'>
    blobType: string
    thumbType: string
  }> = []

  for (const id of ids) {
    const drawing = await db.drawings.get(id)
    if (!drawing || !drawing.blob || drawing.blob.size === 0) continue
    const { blob, thumb, ...record } = drawing
    const blobHead = new Uint8Array(await blob.slice(0, 16).arrayBuffer())
    const thumbHead = thumb && thumb.size > 0
      ? new Uint8Array(await thumb.slice(0, 16).arrayBuffer())
      : blobHead
    metaList.push({
      id: drawing.id,
      record,
      blobType: resolveRestoredImageMime(blobHead) ?? blob.type ?? 'application/octet-stream',
      thumbType: resolveRestoredImageMime(thumbHead) ?? thumb?.type ?? blob.type ?? 'application/octet-stream',
    })
  }

  metaList.sort(
    (a, b) =>
      (a.record.position ?? 0) - (b.record.position ?? 0) ||
      a.record.createdAt - b.record.createdAt,
  )

  const manifest: BackupManifest = {
    format: 'crop-backup',
    version: 1,
    folders,
    drawings: metaList.map(({ record, blobType, thumbType }) => ({
      ...record,
      blobType,
      thumbType,
    })),
  }

  async function* generateEntries(): AsyncGenerator<ZipInputEntry> {
    yield {
      name: 'manifest.json',
      data: encodeUtf8(JSON.stringify(manifest)),
      compress: true,
    }
    for (const item of metaList) {
      const drawing = await db.drawings.get(item.id)
      if (!drawing || !drawing.blob) continue
      const imageBytes = new Uint8Array(await drawing.blob.arrayBuffer())
      yield {
        name: `drawings/${drawing.id}.image`,
        data: imageBytes,
        compress: false,
      }
      const thumbBytes = drawing.thumb && drawing.thumb.size > 0
        ? new Uint8Array(await drawing.thumb.arrayBuffer())
        : imageBytes
      yield {
        name: `drawings/${drawing.id}.thumb`,
        data: thumbBytes,
        compress: false,
      }
    }
  }

  const chunks = await createStreamingZip(generateEntries())
  const blobParts: BlobPart[] = chunks.map((chunk) => toArrayBuffer(chunk))
  const url = URL.createObjectURL(new Blob(blobParts, { type: 'application/zip' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `crop-backup-${new Date().toISOString().slice(0, 10)}.zip`
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

export async function restoreBackup(
  file: File,
): Promise<{ drawings: number; folders: number; drawingIds: string[]; folderIds: string[] }> {
  if (file.size > MAX_ARCHIVE_BYTES) {
    throw new Error('This backup is too large to restore in the browser (maximum 600 MB).')
  }

  const archiveBytes = new Uint8Array(await file.arrayBuffer())
  const files = await extractStreamingZip(archiveBytes)

  let manifest: BackupManifest
  try {
    const manifestBytes = files.get('manifest.json')
    if (!manifestBytes) throw new Error('Missing manifest')
    manifest = JSON.parse(decodeUtf8(manifestBytes)) as BackupManifest
  } catch {
    throw new Error('This file is not a valid Crop backup.')
  }

  if (
    manifest.format !== 'crop-backup' ||
    manifest.version !== 1 ||
    !Array.isArray(manifest.drawings) ||
    !Array.isArray(manifest.folders)
  ) {
    throw new Error('This file is not a supported Crop backup.')
  }

  const existingFolders = await db.folders.toArray()
  const folderIds = new Map<string, string>()
  const foldersToAdd: FolderRecord[] = []
  for (const folder of manifest.folders) {
    if (!folder || typeof folder.id !== 'string' || typeof folder.name !== 'string') {
      throw new Error('The backup contains an invalid folder.')
    }
    const existing = existingFolders.find(
      (candidate) =>
        candidate.name.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase() ===
        folder.name.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase(),
    )
    const id = existing?.id ?? crypto.randomUUID()
    folderIds.set(folder.id, id)
    if (!existing) {
      foldersToAdd.push({ id, name: folder.name })
      existingFolders.push({ id, name: folder.name })
    }
  }

  // Compute next position without loading existing blobs into RAM.
  let maxPosition = -1
  await db.drawings.each((drawing) => {
    if (typeof drawing.position === 'number' && drawing.position > maxPosition) {
      maxPosition = drawing.position
    }
  })
  let position = maxPosition + 1

  const orderedDrawings = manifest.drawings.toSorted(
    (a, b) =>
      (Number.isFinite(a.position) ? (a.position as number) : Number.MAX_SAFE_INTEGER) -
        (Number.isFinite(b.position) ? (b.position as number) : Number.MAX_SAFE_INTEGER) ||
      (Number.isFinite(a.createdAt) ? a.createdAt : 0) -
        (Number.isFinite(b.createdAt) ? b.createdAt : 0),
  )

  const validFolderIds = new Set(folderIds.keys())
  const drawingsToAdd: DrawingRecord[] = orderedDrawings.map((record) => {
    if (!isValidBackupDrawing(record, validFolderIds)) {
      throw new Error('The backup contains an invalid drawing record.')
    }
    const image = files.get(`drawings/${record.id}.image`)
    const thumb = files.get(`drawings/${record.id}.thumb`)
    if (!image || image.byteLength === 0) {
      throw new Error(`The backup is missing image data for “${record.name}”.`)
    }
    const imageMime = resolveRestoredImageMime(image)
    if (!imageMime) {
      throw new Error(`The backup contains corrupted or unsupported image data for “${record.name}”.`)
    }
    const validThumb = thumb && thumb.byteLength > 0 ? resolveRestoredImageMime(thumb) : null
    const thumbBytes = validThumb && thumb ? thumb : image
    const thumbMime = validThumb ?? imageMime

    return {
      id: crypto.randomUUID(),
      name: record.name,
      createdAt: Number.isFinite(record.createdAt) ? record.createdAt : Date.now(),
      width: record.width,
      height: record.height,
      blob: new Blob([toArrayBuffer(image)], { type: imageMime }),
      thumb: new Blob([toArrayBuffer(thumbBytes)], { type: thumbMime }),
      tags: record.tags.map((tag) => ({
        id: tag.id,
        label: tag.label,
        box: tag.box ? ([tag.box[0], tag.box[1], tag.box[2], tag.box[3]] as [number, number, number, number]) : null,
      })),
      visibleTagIds: record.visibleTagIds ? [...record.visibleTagIds] : undefined,
      folderId: record.folderId ? folderIds.get(record.folderId) : undefined,
      position: position++,
    }
  })

  if (foldersToAdd.length) {
    await db.folders.bulkAdd(foldersToAdd)
  }
  for (let i = 0; i < drawingsToAdd.length; i += RESTORE_BATCH_SIZE) {
    await db.drawings.bulkAdd(drawingsToAdd.slice(i, i + RESTORE_BATCH_SIZE))
  }

  return {
    drawings: drawingsToAdd.length,
    folders: foldersToAdd.length,
    drawingIds: drawingsToAdd.map((d) => d.id),
    folderIds: foldersToAdd.map((f) => f.id),
  }
}
