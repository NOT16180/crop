import { db, type DrawingRecord, type Rect } from './db'

const THUMB_SIZE = 480
const ACCEPTED = ['image/png', 'image/jpeg', 'image/webp', 'image/avif']

export function isAcceptedImage(file: File): boolean {
  return ACCEPTED.includes(file.type)
}

/** Keep a box inside the picture: a rounded drag can otherwise land one pixel outside. */
export function clampBox(box: Rect, width: number, height: number): Rect {
  const right = Math.min(width, Math.max(1, box[0] + box[2]))
  const bottom = Math.min(height, Math.max(1, box[1] + box[3]))
  const left = Math.min(Math.max(0, box[0]), right - 1)
  const top = Math.min(Math.max(0, box[1]), bottom - 1)
  return [left, top, Math.max(1, right - left), Math.max(1, bottom - top)]
}

function sniffImageType(bytes: Uint8Array): string {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg'
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[8] === 0x57) return 'image/webp'
  if (bytes[0] === 0x47 && bytes[1] === 0x49) return 'image/gif'
  return ''
}

/**
 * Encode a thumbnail and check that the result can actually be decoded again.
 * A browser can hand back an encoded blob the renderer then refuses to read;
 * storing that leaves a permanently blank tile in the grid, so verify here and
 * fall back to PNG rather than trusting the requested format.
 */
async function encodeThumb(bitmap: ImageBitmap, width: number, height: number): Promise<Blob> {
  const canvas = new OffscreenCanvas(width, height)
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, width, height)
  for (const type of ['image/webp', 'image/png']) {
    try {
      const candidate = await canvas.convertToBlob({ type, quality: 0.82 })
      const bytes = new Uint8Array(await candidate.slice(0, 16).arrayBuffer())
      if (sniffImageType(bytes) !== type) continue
      const check = await createImageBitmap(candidate)
      check.close()
      return candidate
    } catch {
      // Try the next format.
    }
  }
  throw new Error('Could not encode a thumbnail')
}

async function makeThumbnail(
  bitmap: ImageBitmap,
): Promise<{ thumb: Blob; width: number; height: number }> {
  const { width, height } = bitmap
  const scale = Math.min(1, THUMB_SIZE / Math.max(width, height))
  const w = Math.max(1, Math.round(width * scale))
  const h = Math.max(1, Math.round(height * scale))
  const thumb = await encodeThumb(bitmap, w, h)
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

/**
 * Rebuild a drawing's thumbnail from its original file. Called when a stored
 * thumbnail cannot be displayed, so a library written by an unluckier build
 * heals itself instead of showing an empty tile forever.
 */
export async function rebuildThumbnail(drawing: DrawingRecord): Promise<DrawingRecord | null> {
  try {
    const bitmap = await createImageBitmap(drawing.blob)
    const { thumb, width, height } = await makeThumbnail(bitmap)
    bitmap.close()
    await db.drawings.update(drawing.id, { thumb, width, height })
    return { ...drawing, thumb, width, height }
  } catch {
    return null
  }
}

export async function deleteDrawings(ids: string[]): Promise<void> {
  await db.drawings.bulkDelete(ids)
}
