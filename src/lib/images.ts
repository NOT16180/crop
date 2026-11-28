import { db, type DrawingRecord, type Rect } from './db'
import {
  computeScaledDimensions,
  isAcceptedImage,
  rescaleTagBoxes,
  shouldAcceptReencode,
  shouldSkipFallbackFormat,
  syncFilenameExtension,
} from './image-validation'
import { detectImageMime } from './sync-protocol'
export {
  computeScaledDimensions,
  isAcceptedImage,
  rescaleTagBoxes,
  shouldAcceptReencode,
  shouldSkipFallbackFormat,
  syncFilenameExtension,
} from './image-validation'

export type CompressionFormat = 'webp' | 'jpeg'

export const THUMB_SIZE = 960
export const WEBP_MAX_DIMENSION = 2400
const WEBP_QUALITY = 0.84
const JPEG_QUALITY = 0.82
const THUMB_QUALITY = 0.88

interface DecodedImage {
  source: CanvasImageSource
  width: number
  height: number
  close: () => void
}

let detectedFormatPromise: Promise<CompressionFormat> | null = null

async function sniffBlobMime(blob: Blob): Promise<string> {
  try {
    const head = new Uint8Array(await blob.slice(0, 16).arrayBuffer())
    return detectImageMime(head) ?? ''
  } catch {
    return ''
  }
}

/**
 * Decode an image blob with automatic fallback from createImageBitmap to
 * HTMLImageElement (handles Safari/iOS WebKit edge cases & EXIF orientation).
 */
async function decodeImage(blob: Blob): Promise<DecodedImage> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(blob)
      if (bitmap.width > 0 && bitmap.height > 0) {
        return {
          source: bitmap,
          width: bitmap.width,
          height: bitmap.height,
          close: () => bitmap.close(),
        }
      }
      bitmap.close()
    } catch {
      // Fall back to HTMLImageElement below.
    }
  }

  const url = URL.createObjectURL(blob)
  try {
    const img = new Image()
    img.decoding = 'async'
    img.src = url
    if (typeof img.decode === 'function') {
      await img.decode()
    } else {
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve()
        img.onerror = () => reject(new Error('Image could not be decoded'))
      })
    }
    const width = img.naturalWidth
    const height = img.naturalHeight
    if (!width || !height) {
      throw new Error('Image has invalid dimensions')
    }
    return {
      source: img,
      width,
      height,
      close: () => {
        img.src = ''
        URL.revokeObjectURL(url)
      },
    }
  } catch (cause) {
    URL.revokeObjectURL(url)
    throw cause
  }
}

/**
 * Encode a decoded image onto a canvas with OffscreenCanvas -> HTMLCanvasElement
 * fallback and immediate GPU backing-store cleanup (critical on mobile Safari).
 */
async function encodeCanvasBlob(
  source: CanvasImageSource,
  width: number,
  height: number,
  type: string,
  quality?: number,
  fillBackground?: string,
): Promise<Blob> {
  if (typeof OffscreenCanvas !== 'undefined' && typeof OffscreenCanvas.prototype.convertToBlob === 'function') {
    const offscreen = new OffscreenCanvas(width, height)
    try {
      const ctx = offscreen.getContext('2d')
      if (ctx) {
        if (fillBackground) {
          ctx.fillStyle = fillBackground
          ctx.fillRect(0, 0, width, height)
        }
        ctx.imageSmoothingEnabled = true
        ctx.imageSmoothingQuality = 'high'
        ctx.drawImage(source, 0, 0, width, height)
        const blob = await offscreen.convertToBlob(quality === undefined ? { type } : { type, quality })
        if (blob && blob.size > 0) return blob
      }
    } catch {
      // Fall through to HTMLCanvasElement.
    } finally {
      offscreen.width = 0
      offscreen.height = 0
    }
  }

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  try {
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Image canvas is unavailable')
    if (fillBackground) {
      ctx.fillStyle = fillBackground
      ctx.fillRect(0, 0, width, height)
    }
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(source, 0, 0, width, height)
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (result) => (result && result.size > 0 ? resolve(result) : reject(new Error('Could not encode image'))),
        type,
        quality,
      ),
    )
    return blob
  } finally {
    canvas.width = 0
    canvas.height = 0
  }
}

/**
 * Fast alpha-channel probe on a tiny 64×64 canvas (< 1 ms) so Safari/iOS JPEG
 * fallback never destroys transparent PNG/WebP lineart.
 */
function hasTransparency(decoded: DecodedImage): boolean {
  const probeW = Math.min(64, Math.max(1, decoded.width))
  const probeH = Math.min(64, Math.max(1, decoded.height))
  const canvas = document.createElement('canvas')
  canvas.width = probeW
  canvas.height = probeH
  try {
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return false
    ctx.clearRect(0, 0, probeW, probeH)
    ctx.drawImage(decoded.source, 0, 0, probeW, probeH)
    const data = ctx.getImageData(0, 0, probeW, probeH).data
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] < 250) return true
    }
    return false
  } catch {
    return false
  } finally {
    canvas.width = 0
    canvas.height = 0
  }
}

/** Probe once whether this browser can genuinely encode WebP via canvas (Safari/iOS falls back to JPEG). */
export function detectCompressionFormat(): Promise<CompressionFormat> {
  if (detectedFormatPromise) return detectedFormatPromise
  detectedFormatPromise = (async (): Promise<CompressionFormat> => {
    try {
      const probe = document.createElement('canvas')
      probe.width = 2
      probe.height = 2
      try {
        const ctx = probe.getContext('2d')
        if (!ctx) return 'jpeg'
        ctx.fillStyle = '#000'
        ctx.fillRect(0, 0, 2, 2)
        const blob = await new Promise<Blob | null>((resolve) => probe.toBlob(resolve, 'image/webp', 0.8))
        if (!blob || blob.size === 0) return 'jpeg'
        return (await sniffBlobMime(blob)) === 'image/webp' ? 'webp' : 'jpeg'
      } finally {
        probe.width = 0
        probe.height = 0
      }
    } catch {
      return 'jpeg'
    }
  })()
  return detectedFormatPromise
}

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

/**
 * Encode a thumbnail and verify both its magic bytes and that it decodes cleanly.
 * Uses WebP first, then JPEG for opaque images (small on Safari/iOS), then PNG.
 */
async function encodeThumb(decoded: DecodedImage, width: number, height: number, transparent: boolean): Promise<Blob> {
  const candidates: Array<{ type: string; quality?: number; fillBackground?: string }> = transparent
    ? [
        { type: 'image/webp', quality: THUMB_QUALITY },
        { type: 'image/png' },
      ]
    : [
        { type: 'image/webp', quality: THUMB_QUALITY },
        { type: 'image/jpeg', quality: THUMB_QUALITY, fillBackground: '#ffffff' },
        { type: 'image/png' },
      ]

  for (const fmt of candidates) {
    try {
      const candidate = await encodeCanvasBlob(decoded.source, width, height, fmt.type, fmt.quality, fmt.fillBackground)
      if ((await sniffBlobMime(candidate)) !== fmt.type) continue
      const check = await decodeImage(candidate)
      check.close()
      return candidate
    } catch {
      // Try the next format.
    }
  }
  throw new Error('Could not encode a thumbnail')
}

async function makeThumbnail(
  decoded: DecodedImage,
  transparent = false,
): Promise<{ thumb: Blob; width: number; height: number }> {
  const { width, height } = decoded
  const scale = Math.min(1, THUMB_SIZE / Math.max(width, height))
  const w = Math.max(1, Math.round(width * scale))
  const h = Math.max(1, Math.round(height * scale))
  const thumb = await encodeThumb(decoded, w, h, transparent)
  return { thumb, width, height }
}

/**
 * Re-encode an image to WebP (capped at 2400 px), falling back to JPEG on
 * Safari/iOS for opaque images or resized PNG for transparent images.
 * Verifies magic bytes, round-trip decodability, and guards against generation loss.
 */
async function optimizeImage(
  decoded: DecodedImage,
  original: Blob,
  transparent: boolean,
): Promise<{ blob: Blob; width: number; height: number; changed: boolean }> {
  const target = computeScaledDimensions(decoded.width, decoded.height, WEBP_MAX_DIMENSION)
  const originalMime = (await sniffBlobMime(original)) || original.type || ''
  const resized = target.width < decoded.width || target.height < decoded.height

  const formats: Array<{ type: string; quality?: number; fillBackground?: string }> = [
    { type: 'image/webp', quality: WEBP_QUALITY },
  ]
  if (transparent) {
    // On browsers without WebP encoding, never flatten transparent artwork to JPEG;
    // only downscale oversized transparent images as lossless PNG.
    if (resized) formats.push({ type: 'image/png' })
  } else {
    formats.push({ type: 'image/jpeg', quality: JPEG_QUALITY, fillBackground: '#ffffff' })
  }

  for (const fmt of formats) {
    if (shouldSkipFallbackFormat(originalMime, fmt.type, decoded.width, decoded.height, WEBP_MAX_DIMENSION)) {
      return { blob: original, width: decoded.width, height: decoded.height, changed: false }
    }
    try {
      const candidate = await encodeCanvasBlob(
        decoded.source,
        target.width,
        target.height,
        fmt.type,
        fmt.quality,
        fmt.fillBackground,
      )
      if ((await sniffBlobMime(candidate)) !== fmt.type) continue
      const accepted = shouldAcceptReencode({
        originalMime,
        targetMime: fmt.type,
        originalSize: original.size,
        newSize: candidate.size,
        originalWidth: decoded.width,
        originalHeight: decoded.height,
        newWidth: target.width,
        newHeight: target.height,
      })
      if (!accepted) {
        // Browser supports this format, and original is already compact enough.
        return { blob: original, width: decoded.width, height: decoded.height, changed: false }
      }
      const check = await decodeImage(candidate)
      check.close()
      return { blob: candidate, width: target.width, height: target.height, changed: true }
    } catch {
      // Try next format.
    }
  }

  return { blob: original, width: decoded.width, height: decoded.height, changed: false }
}

/** Add files to the library and return the created records. */
export async function importFiles(files: File[], options: ImportOptions = {}): Promise<ImportResult> {
  const created: DrawingRecord[] = []
  const failures: ImportFailure[] = []
  for (const file of files.filter(isAcceptedImage)) {
    let decoded: DecodedImage | undefined
    try {
      decoded = await decodeImage(file)
      const mime = (await sniffBlobMime(file)) || file.type
      const transparent = mime !== 'image/jpeg' && hasTransparency(decoded)
      const { thumb } = await makeThumbnail(decoded, transparent)
      const stored = options.compressWebp
        ? await optimizeImage(decoded, file, transparent)
        : { blob: file, width: decoded.width, height: decoded.height, changed: false }
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
      decoded?.close()
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
  let decoded: DecodedImage | undefined
  try {
    decoded = await decodeImage(drawing.blob)
    const mime = (await sniffBlobMime(drawing.blob)) || drawing.blob.type
    const transparent = mime !== 'image/jpeg' && hasTransparency(decoded)
    const { thumb, width, height } = await makeThumbnail(decoded, transparent)
    await db.drawings.update(drawing.id, { thumb, width, height })
    return { ...drawing, thumb, width, height }
  } catch {
    return null
  } finally {
    decoded?.close()
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
  const decoded = await decodeImage(blob)
  try {
    const sx = box ? Math.max(0, Math.round(box[0])) : 0
    const sy = box ? Math.max(0, Math.round(box[1])) : 0
    const sw = box ? Math.max(1, Math.min(decoded.width - sx, Math.round(box[2]))) : decoded.width
    const sh = box ? Math.max(1, Math.min(decoded.height - sy, Math.round(box[3]))) : decoded.height

    const canvas = document.createElement('canvas')
    canvas.width = sw
    canvas.height = sh
    try {
      const context = canvas.getContext('2d')
      if (!context) throw new Error('Canvas is unavailable')
      context.drawImage(decoded.source, sx, sy, sw, sh, 0, 0, sw, sh)
      return await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (result) => (result && result.size > 0 ? resolve(result) : reject(new Error('Could not export crop'))),
          'image/png',
        ),
      )
    } finally {
      canvas.width = 0
      canvas.height = 0
    }
  } finally {
    decoded.close()
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
 * Ensures the file extension matches the real image format (e.g. .webp after compression).
 */
export async function downloadCrop(blob: Blob, box: Rect | null, baseName: string): Promise<void> {
  let resultBlob: Blob
  let fileName: string
  if (box) {
    resultBlob = await getCropAsPngBlob(blob, box)
    fileName = `${baseName.replace(/\.(png|jpe?g|webp|avif|gif)$/i, '')}-crop.png`
  } else {
    resultBlob = blob
    const realMime = (await sniffBlobMime(blob)) || blob.type
    fileName = syncFilenameExtension(baseName, realMime)
  }
  const url = URL.createObjectURL(resultBlob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

export interface CompressLibraryResult {
  total: number
  compressedIds: string[]
  savedBytes: number
  skippedCount: number
  format: CompressionFormat
}

/**
 * Re-encode existing drawings in IndexedDB one at a time (to keep peak RAM low
 * on mobile Safari) to WebP or JPEG fallback (max 2400 px), rescaling any crop
 * tag boxes proportionally and healing missing/corrupt thumbnails along the way.
 */
export async function compressExistingDrawings(
  onProgress?: (done: number, total: number) => void,
): Promise<CompressLibraryResult> {
  const format = await detectCompressionFormat()
  const ids = (await db.drawings.toCollection().primaryKeys()) as string[]
  const compressedIds: string[] = []
  let savedBytes = 0
  let skippedCount = 0

  for (let i = 0; i < ids.length; i++) {
    let decoded: DecodedImage | undefined
    try {
      const drawing = await db.drawings.get(ids[i])
      if (!drawing || !drawing.blob || drawing.blob.size === 0) {
        skippedCount++
        continue
      }
      decoded = await decodeImage(drawing.blob)
      const mime = (await sniffBlobMime(drawing.blob)) || drawing.blob.type
      const transparent = mime !== 'image/jpeg' && hasTransparency(decoded)
      const optimized = await optimizeImage(decoded, drawing.blob, transparent)

      let thumbNeedsRebuild = !drawing.thumb || drawing.thumb.size === 0
      if (!thumbNeedsRebuild) {
        try {
          const check = await decodeImage(drawing.thumb)
          const expectedLongEdge = Math.min(THUMB_SIZE, Math.max(optimized.width, optimized.height))
          if (Math.max(check.width, check.height) < expectedLongEdge - 40) {
            thumbNeedsRebuild = true
          }
          check.close()
        } catch {
          thumbNeedsRebuild = true
        }
      }

      if (optimized.changed || thumbNeedsRebuild) {
        let nextThumb = drawing.thumb
        if (optimized.changed || thumbNeedsRebuild) {
          try {
            const rebuilt = await makeThumbnail(decoded, transparent)
            nextThumb = rebuilt.thumb
          } catch {
            // Keep existing thumb if thumbnail regeneration fails.
          }
        }
        const rescaledTags = rescaleTagBoxes(
          drawing.tags ?? [],
          drawing.width || decoded.width,
          drawing.height || decoded.height,
          optimized.width,
          optimized.height,
        ).map((tag) => ({
          id: tag.id,
          label: tag.label,
          box: tag.box ? ([tag.box[0], tag.box[1], tag.box[2], tag.box[3]] as Rect) : null,
        }))
        const saved = Math.max(0, drawing.blob.size - optimized.blob.size)
        await db.drawings.update(drawing.id, {
          blob: optimized.blob,
          thumb: nextThumb,
          width: optimized.width,
          height: optimized.height,
          tags: rescaledTags,
          updatedAt: Date.now(),
        })
        if (optimized.changed) {
          compressedIds.push(drawing.id)
          savedBytes += saved
        }
      }
    } catch {
      skippedCount++
    } finally {
      decoded?.close()
      onProgress?.(i + 1, ids.length)
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
  }

  return { total: ids.length, compressedIds, savedBytes, skippedCount, format }
}

/**
 * Background one-by-one thumbnail upgrade for existing drawings whose stored
 * thumbnails were generated at the legacy 480px cap. Keeps peak memory low on
 * mobile Safari by processing one record at a time with short yields.
 */
export async function upgradeLowResThumbnails(): Promise<string[]> {
  const ids = (await db.drawings.toCollection().primaryKeys()) as string[]
  const upgradedIds: string[] = []

  for (const id of ids) {
    let decoded: DecodedImage | undefined
    try {
      const drawing = await db.drawings.get(id)
      if (!drawing || drawing.isSample || !drawing.blob || drawing.blob.size === 0) continue

      const origLongEdge = Math.max(drawing.width || 0, drawing.height || 0)
      if (origLongEdge > 0 && origLongEdge <= 520) continue

      let needsUpgrade = !drawing.thumb || drawing.thumb.size === 0
      if (!needsUpgrade) {
        try {
          const thumbInfo = await decodeImage(drawing.thumb)
          const targetLongEdge = origLongEdge > 0 ? Math.min(THUMB_SIZE, origLongEdge) : THUMB_SIZE
          if (Math.max(thumbInfo.width, thumbInfo.height) < targetLongEdge - 40) {
            needsUpgrade = true
          }
          thumbInfo.close()
        } catch {
          needsUpgrade = true
        }
      }
      if (!needsUpgrade) continue

      decoded = await decodeImage(drawing.blob)
      const realLongEdge = Math.max(decoded.width, decoded.height)
      if (realLongEdge <= 520) continue

      const mime = (await sniffBlobMime(drawing.blob)) || drawing.blob.type
      const transparent = mime !== 'image/jpeg' && hasTransparency(decoded)
      const { thumb } = await makeThumbnail(decoded, transparent)
      await db.drawings.update(drawing.id, {
        thumb,
        updatedAt: Date.now(),
      })
      upgradedIds.push(drawing.id)
    } catch {
      // Skip any single drawing that cannot be upgraded right now.
    } finally {
      decoded?.close()
      await new Promise((resolve) => setTimeout(resolve, 16))
    }
  }

  return upgradedIds
}
