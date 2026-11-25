const ACCEPTED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/avif'])

export function isAcceptedImage(file: Pick<File, 'type'>): boolean {
  return ACCEPTED_IMAGE_TYPES.has(file.type)
}
