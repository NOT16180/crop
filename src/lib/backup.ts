import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { db, type DrawingRecord, type FolderRecord } from './db'

interface BackupManifest {
  format: 'crop-backup'
  version: 1
  folders: FolderRecord[]
  drawings: (Omit<DrawingRecord, 'blob' | 'thumb'> & {
    blobType: string
    thumbType: string
  })[]
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

export async function downloadBackup(): Promise<void> {
  const [drawings, folders] = await Promise.all([
    db.drawings.toArray(),
    db.folders.toArray(),
  ])
  const manifest: BackupManifest = {
    format: 'crop-backup',
    version: 1,
    folders,
    drawings: drawings.map(({ blob, thumb, ...record }) => ({
      ...record,
      blobType: blob.type,
      thumbType: thumb.type,
    })),
  }
  const files: Record<string, Uint8Array> = {
    'manifest.json': strToU8(JSON.stringify(manifest)),
  }
  for (const drawing of drawings) {
    files[`drawings/${drawing.id}.image`] = new Uint8Array(await drawing.blob.arrayBuffer())
    files[`drawings/${drawing.id}.thumb`] = new Uint8Array(await drawing.thumb.arrayBuffer())
  }

  const archive = zipSync(files, { level: 1 })
  const url = URL.createObjectURL(new Blob([toArrayBuffer(archive)], { type: 'application/zip' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `crop-backup-${new Date().toISOString().slice(0, 10)}.zip`
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export async function restoreBackup(file: File): Promise<{ drawings: number; folders: number }> {
  let manifest: BackupManifest
  let files: ReturnType<typeof unzipSync>
  try {
    files = unzipSync(new Uint8Array(await file.arrayBuffer()))
    const manifestBytes = files['manifest.json']
    if (!manifestBytes) throw new Error('Missing manifest')
    manifest = JSON.parse(strFromU8(manifestBytes)) as BackupManifest
  } catch {
    throw new Error('This file is not a valid Crop backup.')
  }
  if (manifest.format !== 'crop-backup' || manifest.version !== 1 ||
      !Array.isArray(manifest.drawings) || !Array.isArray(manifest.folders)) {
    throw new Error('This file is not a supported Crop backup.')
  }

  const existingFolders = await db.folders.toArray()
  const folderIds = new Map<string, string>()
  const foldersToAdd: FolderRecord[] = []
  for (const folder of manifest.folders) {
    if (!folder || typeof folder.id !== 'string' || typeof folder.name !== 'string') {
      throw new Error('The backup contains an invalid folder.')
    }
    const existing = existingFolders.find((candidate) =>
      candidate.name.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase() ===
      folder.name.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase())
    const id = existing?.id ?? crypto.randomUUID()
    folderIds.set(folder.id, id)
    if (!existing) {
      foldersToAdd.push({ id, name: folder.name })
      existingFolders.push({ id, name: folder.name })
    }
  }

  const existingDrawings = await db.drawings.toArray()
  let position = existingDrawings.reduce((max, drawing) => Math.max(max, drawing.position ?? -1), -1) + 1
  const drawingsToAdd: DrawingRecord[] = manifest.drawings.map((record) => {
    if (!record || typeof record.id !== 'string' || typeof record.name !== 'string' ||
        !Number.isFinite(record.width) || !Number.isFinite(record.height) ||
        !Array.isArray(record.tags)) {
      throw new Error('The backup contains an invalid drawing record.')
    }
    const image = files[`drawings/${record.id}.image`]
    const thumb = files[`drawings/${record.id}.thumb`]
    if (!image || !thumb) throw new Error(`The backup is missing image data for “${record.name}”.`)
    return {
      id: crypto.randomUUID(),
      name: record.name,
      createdAt: Number.isFinite(record.createdAt) ? record.createdAt : Date.now(),
      width: record.width,
      height: record.height,
      blob: new Blob([toArrayBuffer(image)], { type: record.blobType || 'application/octet-stream' }),
      thumb: new Blob([toArrayBuffer(thumb)], { type: record.thumbType || 'application/octet-stream' }),
      tags: record.tags,
      visibleTagIds: record.visibleTagIds,
      folderId: record.folderId ? folderIds.get(record.folderId) : undefined,
      position: position++,
    }
  })

  await db.transaction('rw', db.folders, db.drawings, async () => {
    await db.folders.bulkAdd(foldersToAdd)
    await db.drawings.bulkAdd(drawingsToAdd)
  })
  return { drawings: drawingsToAdd.length, folders: foldersToAdd.length }
}
