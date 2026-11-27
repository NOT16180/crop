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
