import type { DrawingRecord, Rect } from './db'

/** One tile of an exported reference sheet. */
export interface SheetEntry {
  drawing: DrawingRecord
  box: Rect | null
  label?: string
}

export interface SheetOptions {
  entries: SheetEntry[]
  title: string
  subtitle?: string
  /** Public address of the app, printed on the sheet so shared copies lead back. */
  origin: string
  total: number
}

const SHEET_WIDTH = 1000
const PADDING = 40
const HEADER_HEIGHT = 150
const FOOTER_HEIGHT = 90
const GAP = 24
/** Tiles per row: a handful reads better in two columns, a large set needs more. */
function columnsFor(count: number): number {
  if (count <= 8) return 2
  if (count <= 24) return 3
  return 4
}

/** Tile height as a share of tile width — close to 4:3, so cropped areas fit with little letterboxing. */
const TILE_RATIO = 0.78
const CAPTION_HEIGHT = 34
/** Browsers refuse very large canvases; a sheet stops here and reports the remainder. */
const MAX_SHEET_HEIGHT = 15000
/** Typography and colours follow notgalerie.com: Inconsolata, black on white. */
const FONT = '"Inconsolata", "Courier New", monospace'

const BACKGROUND = '#ffffff'
const CELL = '#ffffff'
const TEXT = '#000000'
const MUTED = 'rgba(0, 0, 0, 0.62)'

/** Largest number of tiles a sheet can hold before the canvas gets too tall. */
export const SHEET_CAPACITY = 200

/** Site convention: chrome is uppercase. */
function upper(text: string): string {
  return text.toUpperCase()
}

function fitText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text
  let shortened = text
  while (shortened.length > 1 && ctx.measureText(`${shortened}…`).width > maxWidth) {
    shortened = shortened.slice(0, -1)
  }
  return `${shortened}…`
}

function fillRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  ctx.beginPath()
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(x, y, width, height, radius)
  } else {
    ctx.rect(x, y, width, height)
  }
  ctx.fill()
}

/** Decode the picture for one tile, cropping the tagged area when there is one. */
async function loadTileImage(entry: SheetEntry, areaWidth: number, areaHeight: number): Promise<ImageBitmap> {
  const { drawing, box } = entry
  if (!box) return createImageBitmap(drawing.thumb)
  const x = Math.max(0, Math.round(box[0]))
  const y = Math.max(0, Math.round(box[1]))
  const width = Math.min(Math.max(1, Math.round(box[2])), Math.max(1, drawing.width - x))
  const height = Math.min(Math.max(1, Math.round(box[3])), Math.max(1, drawing.height - y))
  const scale = Math.min(areaWidth / width, areaHeight / height, 1)
  return createImageBitmap(drawing.blob, x, y, width, height, {
    resizeWidth: Math.max(1, Math.round(width * scale)),
    resizeHeight: Math.max(1, Math.round(height * scale)),
    resizeQuality: 'high',
  })
}

/**
 * Draw a shareable reference sheet and return it as a PNG blob.
 * Two to four columns of tiles, 1000px wide, as tall as the images need.
 */
export async function renderSheet(options: SheetOptions): Promise<Blob> {
  const columns = columnsFor(options.entries.length)
  const cellWidth = (SHEET_WIDTH - PADDING * 2 - GAP * (columns - 1)) / columns
  const cellHeight = Math.round(cellWidth * TILE_RATIO)
  // The sheet grows with its content, so one tagged detail does not end up
  // stretched across a whole poster-sized page.
  const rowsFor = (count: number) => Math.max(1, Math.ceil(count / columns))
  const heightFor = (count: number) =>
    PADDING + HEADER_HEIGHT + rowsFor(count) * cellHeight + (rowsFor(count) - 1) * GAP + FOOTER_HEIGHT + PADDING
  // No fixed limit on how many images a sheet may hold; the only ceiling is what
  // a canvas can render, and the sheet says so when it hits it.
  let entries = options.entries
  while (entries.length > columns && heightFor(entries.length) > MAX_SHEET_HEIGHT) {
    entries = entries.slice(0, entries.length - columns)
  }
  const rows = rowsFor(entries.length)
  const sheetHeight = heightFor(entries.length)

  const canvas = document.createElement('canvas')
  canvas.width = SHEET_WIDTH
  canvas.height = sheetHeight
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('No canvas context')

  // Canvas does not wait for webfonts; load Inconsolata first so the sheet is
  // not rendered in a fallback face.
  try {
    await document.fonts.load(`600 34px ${FONT}`)
    await document.fonts.load(`400 18px ${FONT}`)
  } catch {
    // Fallback face is acceptable.
  }

  ctx.fillStyle = BACKGROUND
  ctx.fillRect(0, 0, SHEET_WIDTH, sheetHeight)

  // Header
  ctx.fillStyle = TEXT
  ctx.font = `600 34px ${FONT}`
  ctx.textBaseline = 'alphabetic'
  ctx.fillText(fitText(ctx, upper(options.title), SHEET_WIDTH - PADDING * 2), PADDING, PADDING + 42)
  if (options.subtitle) {
    ctx.fillStyle = MUTED
    ctx.font = `400 20px ${FONT}`
    ctx.fillText(fitText(ctx, upper(options.subtitle), SHEET_WIDTH - PADDING * 2), PADDING, PADDING + 74)
  }

  const contentTop = PADDING + HEADER_HEIGHT
  const areaHeight = cellHeight - CAPTION_HEIGHT

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]
    const column = index % columns
    const row = Math.floor(index / columns)
    const x = PADDING + column * (cellWidth + GAP)
    const y = contentTop + row * (cellHeight + GAP)

    ctx.fillStyle = CELL
    fillRoundedRect(ctx, x, y, cellWidth, cellHeight, 0)
    ctx.strokeStyle = TEXT
    ctx.lineWidth = 1
    ctx.strokeRect(x + 0.5, y + 0.5, cellWidth - 1, cellHeight - 1)

    try {
      const bitmap = await loadTileImage(entry, cellWidth - 16, areaHeight - 16)
      const scale = Math.min((cellWidth - 16) / bitmap.width, (areaHeight - 16) / bitmap.height)
      const drawWidth = Math.max(1, Math.round(bitmap.width * scale))
      const drawHeight = Math.max(1, Math.round(bitmap.height * scale))
      ctx.drawImage(
        bitmap,
        x + (cellWidth - drawWidth) / 2,
        y + 8 + (areaHeight - 16 - drawHeight) / 2,
        drawWidth,
        drawHeight,
      )
      bitmap.close()
    } catch {
      ctx.fillStyle = MUTED
      ctx.font = `400 18px ${FONT}`
      ctx.fillText('Image unavailable', x + 16, y + areaHeight / 2)
    }

    // Caption: the tag name when the tile comes from a tag search, the file name otherwise.
    ctx.fillStyle = MUTED
    ctx.font = `400 18px ${FONT}`
    const caption = entry.label ? `#${entry.label}` : entry.drawing.name
    ctx.fillText(fitText(ctx, caption, cellWidth - 24), x + 12, y + cellHeight - 14)
  }

  // Footer: the address that turns a shared sheet into a visit.
  ctx.fillStyle = MUTED
  ctx.font = `400 18px ${FONT}`
  ctx.fillText(upper(`Made with Crop — ${options.origin}`), PADDING, sheetHeight - PADDING - 18)
  if (options.total > entries.length) {
    const more = upper(`+${options.total - entries.length} more in the library`)
    ctx.textAlign = 'right'
    ctx.fillText(more, SHEET_WIDTH - PADDING, sheetHeight - PADDING - 18)
    ctx.textAlign = 'left'
  }

  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Could not render the sheet'))), 'image/png')
  })
}

/** Render a reference sheet for the current selection and download it. */
export async function downloadSheet(options: SheetOptions): Promise<number> {
  const blob = await renderSheet(options)
  const slug = options.title
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'references'
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `crop-${slug}-${new Date().toISOString().slice(0, 10)}.png`
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  return Math.min(options.entries.length, SHEET_CAPACITY)
}
