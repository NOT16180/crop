import { db, type DrawingRecord, type Rect } from './db'
import { computeScaledDimensions, isAcceptedImage } from './image-validation'
export { computeScaledDimensions, isAcceptedImage } from './image-validation'

const THUMB_SIZE = 480
export const WEBP_MAX_DIMENSION = 2400
const WEBP_QUALITY = 0.86

export interface ImportFailure {
  name: string
  reason: string
}

export interface ImportResult {
  created: DrawingRecord[]
  failures: ImportFailure[]
}

export interface ImportOptions {
  compressWebp?: boolean
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

async function encodeCanvasBlob(
  bitmap: ImageBitmap,
  width: number,
  height: number,
  type: string,
  quality: number,
): Promise<Blob> {
  const canvas: OffscreenCanvas | HTMLCanvasElement = typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(width, height)
    : Object.assign(document.createElement('canvas'), { width, height })
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Image canvas is unavailable')
  context.drawImage(bitmap, 0, 0, width, height)
  return typeof OffscreenCanvas !== 'undefined' && canvas instanceof OffscreenCanvas
    ? await canvas.convertToBlob({ type, quality })
    : await new Promise<Blob>((resolve, reject) => (canvas as HTMLCanvasElement).toBlob(
        (blob) => blob ? resolve(blob) : reject(new Error('Could not encode image')),
        type, quality,
      ))
}

/**
 * Encode a thumbnail and check that the result can actually be decoded again.
 * A browser can hand back an encoded blob the renderer then refuses to read;
 * storing that leaves a permanently blank tile in the grid, so verify here and
 * fall back to PNG rather than trusting the requested format.
 */
async function encodeThumb(bitmap: ImageBitmap, width: number, height: number): Promise<Blob> {
  for (const type of ['image/webp', 'image/png']) {
    try {
      const candidate = await encodeCanvasBlob(bitmap, width, height, type, 0.82)
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

/**
 * Re-encode an imported image to high-quality WebP (capped at 2400 px on the
 * longest side) when it actually saves space and decodes cleanly. Otherwise
 * keep the original file untouched.
 */
async function optimizeAsWebp(
  bitmap: ImageBitmap,
  original: File,
): Promise<{ blob: Blob; width: number; height: number }> {
  const target = computeScaledDimensions(bitmap.width, bitmap.height, WEBP_MAX_DIMENSION)
  try {
    const candidate = await encodeCanvasBlob(bitmap, target.width, target.height, 'image/webp', WEBP_QUALITY)
    if (candidate.size >= original.size) {
      return { blob: original, width: bitmap.width, height: bitmap.height }
    }
    const bytes = new Uint8Array(await candidate.slice(0, 16).arrayBuffer())
    if (sniffImageType(bytes) !== 'image/webp') {
      return { blob: original, width: bitmap.width, height: bitmap.height }
    }
    const check = await createImageBitmap(candidate)
    check.close()
    return { blob: candidate, width: target.width, height: target.height }
  } catch {
    return { blob: original, width: bitmap.width, height: bitmap.height }
  }
}

/** Add files to the library and return the created records. */
export async function importFiles(files: File[], options: ImportOptions = {}): Promise<ImportResult> {
  const created: DrawingRecord[] = []
  const failures: ImportFailure[] = []
  for (const file of files.filter(isAcceptedImage)) {
    let bitmap: ImageBitmap | undefined
    try {
      bitmap = await createImageBitmap(file)
      const { thumb } = await makeThumbnail(bitmap)
      const stored = options.compressWebp
        ? await optimizeAsWebp(bitmap, file)
        : { blob: file, width: bitmap.width, height: bitmap.height }
      const record: DrawingRecord = {
        id: crypto.randomUUID(),
        name: file.name,
        createdAt: Date.now(),
        width: stored.width,
        height: stored.height,
        blob: stored.blob,
        thumb,
        tags: [],
      }
      await db.drawings.add(record)
      created.push(record)
    } catch (cause) {
      failures.push({
        name: file.name,
        reason: cause instanceof Error ? cause.message : 'Image could not be imported',
      })
    } finally {
      bitmap?.close()
    }
  }
  return { created, failures }
}

/**
 * Rebuild a drawing's thumbnail from its original file. Called when a stored
 * thumbnail cannot be displayed, so a library written by an unluckier build
 * heals itself instead of showing an empty tile forever.
 */
export async function rebuildThumbnail(drawing: DrawingRecord): Promise<DrawingRecord | null> {
  let bitmap: ImageBitmap | undefined
  try {
    bitmap = await createImageBitmap(drawing.blob)
    const { thumb, width, height } = await makeThumbnail(bitmap)
    await db.drawings.update(drawing.id, { thumb, width, height })
    return { ...drawing, thumb, width, height }
  } catch {
    return null
  } finally {
    bitmap?.close()
  }
}

export async function deleteDrawings(ids: string[]): Promise<void> {
  await db.drawings.bulkDelete(ids)
}

/**
 * Extract a crop from an image blob as a PNG blob.
 * If box is null, converts the full image to PNG (required by Clipboard API).
 */
export async function getCropAsPngBlob(blob: Blob, box: Rect | null): Promise<Blob> {
  let bitmap: ImageBitmap
  if (box) {
    const cropX = Math.max(0, Math.round(box[0]))
    const cropY = Math.max(0, Math.round(box[1]))
    const cropW = Math.max(1, Math.round(box[2]))
    const cropH = Math.max(1, Math.round(box[3]))
    bitmap = await createImageBitmap(blob, cropX, cropY, cropW, cropH)
  } else {
    bitmap = await createImageBitmap(blob)
  }
  try {
    const width = bitmap.width
    const height = bitmap.height
    const canvas: OffscreenCanvas | HTMLCanvasElement = typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(width, height)
      : Object.assign(document.createElement('canvas'), { width, height })
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Canvas is unavailable')
    context.drawImage(bitmap, 0, 0)
    return typeof OffscreenCanvas !== 'undefined' && canvas instanceof OffscreenCanvas
      ? await canvas.convertToBlob({ type: 'image/png' })
      : await new Promise<Blob>((resolve, reject) => (canvas as HTMLCanvasElement).toBlob(
          (result) => result ? resolve(result) : reject(new Error('Could not export crop')),
          'image/png',
        ))
  } finally {
    bitmap.close()
  }
}

/**
 * Copy a crop or image directly to the system clipboard as a PNG image.
 */
export async function copyCropToClipboard(blob: Blob, box: Rect | null): Promise<void> {
  if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) {
    throw new Error('Clipboard image writing is not supported by this browser.')
  }
  const pngBlob = await getCropAsPngBlob(blob, box)
  await navigator.clipboard.write([
    new ClipboardItem({ 'image/png': pngBlob }),
  ])
}

/**
 * Trigger browser download for a crop or full image.
 */
export async function downloadCrop(blob: Blob, box: Rect | null, baseName: string): Promise<void> {
  let resultBlob: Blob
  let fileName: string
  if (box) {
    resultBlob = await getCropAsPngBlob(blob, box)
    fileName = `${baseName.replace(/\.[^.]+$/, '')}-crop.png`
  } else {
    resultBlob = blob
    fileName = baseName
  }
  const url = URL.createObjectURL(resultBlob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}
