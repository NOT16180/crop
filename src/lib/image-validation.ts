const ACCEPTED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/avif'])

export function isAcceptedImage(file: Pick<File, 'type'>): boolean {
  return ACCEPTED_IMAGE_TYPES.has(file.type)
}

export function computeScaledDimensions(
  width: number,
  height: number,
  maxDimension: number,
): { width: number; height: number } {
  if (width <= 0 || height <= 0 || maxDimension <= 0) return { width, height }
  const longest = Math.max(width, height)
  if (longest <= maxDimension) return { width, height }
  const scale = maxDimension / longest
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

const MIME_EXTENSION: Record<string, string> = {
  'image/webp': '.webp',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/avif': '.avif',
}

export function syncFilenameExtension(name: string, mime: string): string {
  const ext = MIME_EXTENSION[mime]
  if (!ext) return name
  const cleaned = name.replace(/\.(png|jpe?g|webp|avif|gif)$/i, '')
  return `${cleaned || 'image'}${ext}`
}

export function shouldSkipFallbackFormat(
  originalMime: string,
  targetMime: string,
  width: number,
  height: number,
  maxDimension: number,
): boolean {
  if (targetMime !== 'image/jpeg') return false
  if (originalMime !== 'image/webp' && originalMime !== 'image/avif') return false
  return Math.max(width, height) <= maxDimension
}

export interface ReencodeCheck {
  originalMime: string
  targetMime: string
  originalSize: number
  newSize: number
  originalWidth: number
  originalHeight: number
  newWidth: number
  newHeight: number
}

/**
 * Decide whether a re-encoded candidate should replace the original blob.
 * Prevents generation loss on repeated compression runs: if both format and
 * dimensions are unchanged, require a meaningful size reduction (>= 15% and >= 16 KB).
 */
export function shouldAcceptReencode(check: ReencodeCheck): boolean {
  if (check.newSize <= 0 || check.newSize >= check.originalSize) return false
  const resized = check.newWidth < check.originalWidth || check.newHeight < check.originalHeight
  const formatChanged = Boolean(check.originalMime) && check.originalMime !== check.targetMime
  if (resized || formatChanged) return true
  const saved = check.originalSize - check.newSize
  return saved >= 16_384 && check.newSize <= check.originalSize * 0.85
}

export function rescaleTagBoxes<T extends { box: [number, number, number, number] | null }>(
  tags: T[],
  oldWidth: number,
  oldHeight: number,
  newWidth: number,
  newHeight: number,
): T[] {
  if (oldWidth <= 0 || oldHeight <= 0 || newWidth <= 0 || newHeight <= 0) return tags
  if (oldWidth === newWidth && oldHeight === newHeight) return tags
  const sx = newWidth / oldWidth
  const sy = newHeight / oldHeight
  return tags.map((tag) => {
    if (!tag.box) return tag
    const left = Math.min(Math.max(0, Math.round(tag.box[0] * sx)), Math.max(0, newWidth - 1))
    const top = Math.min(Math.max(0, Math.round(tag.box[1] * sy)), Math.max(0, newHeight - 1))
    const width = Math.max(1, Math.min(newWidth - left, Math.round(tag.box[2] * sx)))
    const height = Math.max(1, Math.min(newHeight - top, Math.round(tag.box[3] * sy)))
    return { ...tag, box: [left, top, width, height] as [number, number, number, number] }
  })
}
