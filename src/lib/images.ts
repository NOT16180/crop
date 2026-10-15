import { db, type DrawingRecord } from './db'

const THUMB_SIZE = 480
const ACCEPTED = ['image/png', 'image/jpeg', 'image/webp', 'image/avif']

export function isAcceptedImage(file: File): boolean {
  return ACCEPTED.includes(file.type)
}

async function makeThumbnail(
  bitmap: ImageBitmap,
): Promise<{ thumb: Blob; width: number; height: number }> {
  const { width, height } = bitmap
  const scale = Math.min(1, THUMB_SIZE / Math.max(width, height))
  const w = Math.max(1, Math.round(width * scale))
  const h = Math.max(1, Math.round(height * scale))
  const canvas = new OffscreenCanvas(w, h)
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(bitmap, 0, 0, w, h)
  const thumb = await canvas.convertToBlob({ type: 'image/webp', quality: 0.82 })
  return { thumb, width, height }
}

/** Add files to the library and return the created records. */
export async function importFiles(files: File[]): Promise<DrawingRecord[]> {
  const created: DrawingRecord[] = []
  for (const file of files.filter(isAcceptedImage)) {
    const bitmap = await createImageBitmap(file)
    const { thumb, width, height } = await makeThumbnail(bitmap)
    bitmap.close()
    const record: DrawingRecord = {
      id: crypto.randomUUID(),
      name: file.name,
      createdAt: Date.now(),
      width,
      height,
      blob: file,
      thumb,
      tags: [],
    }
    await db.drawings.add(record)
    created.push(record)
  }
  return created
}

export async function deleteDrawings(ids: string[]): Promise<void> {
  await db.drawings.bulkDelete(ids)
}
