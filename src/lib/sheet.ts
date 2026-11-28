import type { DrawingRecord, Rect } from './db'

/** One tile of an exported reference sheet. */
export interface SheetEntry {
  drawing: DrawingRecord
  box: Rect | null
  label?: string
}

export type SheetTheme = 'light' | 'dark'

export interface SheetOptions {
  entries: SheetEntry[]
  title: string
  subtitle?: string
  /** Public address of the app, printed on the sheet so shared copies lead back. */
  origin: string
  total: number
  /** Follows the active app theme: crisp #212121 on white paper, or white on #212121 charcoal. */
  theme?: SheetTheme
}

export interface SheetRenderResult {
  blob: Blob
  exportedCount: number
  width: number
  height: number
}

export interface SheetLayout {
  columns: number
  rows: number
  renderedCount: number
  cellWidth: number
  cellHeight: number
  sheetWidth: number
  sheetHeight: number
}

/** 2× high-resolution reference sheet width so cropped details stay crisp when zoomed in drawing apps. */
const SHEET_WIDTH = 2000
const OUTER_MARGIN = 48
const INNER_PADDING = 44
const HEADER_HEIGHT = 176
const FOOTER_HEIGHT = 98
const GAP = 32
const CAPTION_HEIGHT = 76
/** Tile height as a share of tile width — balanced 4:3 framing for cropped details and full artworks. */
const TILE_RATIO = 0.8
/** Browser-safe canvas height ceiling (16,000 px works reliably on desktop and mobile). */
const MAX_SHEET_HEIGHT = 16000
/** Typography follows notgalerie.com: self-hosted Inconsolata monospace. */
const FONT = '"Inconsolata", "Courier New", monospace'

/** Largest number of tiles a sheet can hold before the canvas gets too tall. */
export const SHEET_CAPACITY = 200

/** Tiles per row: 1 for a single highlight, 2 for a small study, 3–4 for larger boards. */
export function columnsFor(count: number): number {
  if (count <= 1) return 1
  if (count <= 6) return 2
  if (count <= 21) return 3
  return 4
}

/** Pure layout calculator so tests and renderer share identical geometry and height-capping rules. */
export function computeSheetLayout(entryCount: number): SheetLayout {
  const safeCount = Math.max(1, Math.min(entryCount, SHEET_CAPACITY))
  const columns = columnsFor(safeCount)
  const innerWidth = SHEET_WIDTH - OUTER_MARGIN * 2 - INNER_PADDING * 2
  const cellWidth = Math.floor((innerWidth - GAP * (columns - 1)) / columns)
  const cellHeight = Math.round(cellWidth * TILE_RATIO) + CAPTION_HEIGHT

  const rowsFor = (count: number) => Math.max(1, Math.ceil(count / columns))
  const heightFor = (count: number) =>
    OUTER_MARGIN * 2 +
    HEADER_HEIGHT +
    INNER_PADDING +
    rowsFor(count) * cellHeight +
    (rowsFor(count) - 1) * GAP +
    INNER_PADDING +
    FOOTER_HEIGHT

  let renderedCount = safeCount
  while (renderedCount > columns && heightFor(renderedCount) > MAX_SHEET_HEIGHT) {
    renderedCount = Math.max(columns, renderedCount - columns)
  }

  return {
    columns,
    rows: rowsFor(renderedCount),
    renderedCount,
    cellWidth,
    cellHeight,
    sheetWidth: SHEET_WIDTH,
    sheetHeight: heightFor(renderedCount),
  }
}

function upper(text: string): string {
  return text.toUpperCase()
}

function cleanOrigin(origin: string): string {
  return origin.replace(/^https?:\/\//i, '').replace(/\/+$/, '')
}

function fitText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text
  let shortened = text
  while (shortened.length > 1 && ctx.measureText(`${shortened}…`).width > maxWidth) {
    shortened = shortened.slice(0, -1)
  }
  return `${shortened}…`
}

interface DecodedTile {
  source: ImageBitmap
  sx: number
  sy: number
  sw: number
  sh: number
}

/**
 * Decode full-resolution source imagery for one tile, cropping the tagged area when present.
 * Uses full `drawing.blob` (never low-res thumbnails) and falls back safely if the browser
 * does not support sub-rect `createImageBitmap` options (e.g. older Safari).
 */
async function loadTileImage(entry: SheetEntry, maxW: number, maxH: number): Promise<DecodedTile> {
  const { drawing, box } = entry
  const blob = drawing.blob || drawing.thumb
  if (!box) {
    try {
      const scale = Math.min(maxW / Math.max(1, drawing.width), maxH / Math.max(1, drawing.height), 1)
      const bitmap = await createImageBitmap(blob, {
        resizeWidth: Math.max(1, Math.round(drawing.width * scale)),
        resizeHeight: Math.max(1, Math.round(drawing.height * scale)),
        resizeQuality: 'high',
      })
      return { source: bitmap, sx: 0, sy: 0, sw: bitmap.width, sh: bitmap.height }
    } catch {
      const bitmap = await createImageBitmap(blob)
      return { source: bitmap, sx: 0, sy: 0, sw: bitmap.width, sh: bitmap.height }
    }
  }

  const x = Math.max(0, Math.round(box[0]))
  const y = Math.max(0, Math.round(box[1]))
  const width = Math.min(Math.max(1, Math.round(box[2])), Math.max(1, drawing.width - x))
  const height = Math.min(Math.max(1, Math.round(box[3])), Math.max(1, drawing.height - y))
  const scale = Math.min(maxW / width, maxH / height, 1)

  try {
    const bitmap = await createImageBitmap(blob, x, y, width, height, {
      resizeWidth: Math.max(1, Math.round(width * scale)),
      resizeHeight: Math.max(1, Math.round(height * scale)),
      resizeQuality: 'high',
    })
    return { source: bitmap, sx: 0, sy: 0, sw: bitmap.width, sh: bitmap.height }
  } catch {
    const bitmap = await createImageBitmap(blob)
    const sx = Math.max(0, Math.min(bitmap.width - 1, Math.round((x / Math.max(1, drawing.width)) * bitmap.width)))
    const sy = Math.max(0, Math.min(bitmap.height - 1, Math.round((y / Math.max(1, drawing.height)) * bitmap.height)))
    const sw = Math.max(1, Math.min(bitmap.width - sx, Math.round((width / Math.max(1, drawing.width)) * bitmap.width)))
    const sh = Math.max(1, Math.min(bitmap.height - sy, Math.round((height / Math.max(1, drawing.height)) * bitmap.height)))
    return { source: bitmap, sx, sy, sw, sh }
  }
}

/**
 * Draw a 2× HD editorial reference sheet matching the notgalerie.com / Crop design language
 * and return it as a PNG blob alongside the exact exported tile count.
 */
export async function renderSheet(options: SheetOptions): Promise<SheetRenderResult> {
  const layout = computeSheetLayout(options.entries.length)
  const entries = options.entries.slice(0, layout.renderedCount)
  const isDark = options.theme === 'dark'

  const bg = isDark ? '#212121' : '#ffffff'
  const surface = isDark ? '#262626' : '#ffffff'
  const ink = isDark ? '#ffffff' : '#212121'
  const muted = isDark ? 'rgba(255, 255, 255, 0.68)' : 'rgba(33, 33, 33, 0.62)'
  const rule = isDark ? 'rgba(255, 255, 255, 0.24)' : 'rgba(33, 33, 33, 0.22)'

  const canvas = document.createElement('canvas')
  canvas.width = layout.sheetWidth
  canvas.height = layout.sheetHeight
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('No canvas context')

  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'

  // Ensure self-hosted Inconsolata is loaded before drawing text onto the canvas.
  try {
    await Promise.all([
      document.fonts.load(`600 46px ${FONT}`),
      document.fonts.load(`400 34px ${FONT}`),
      document.fonts.load(`400 32px ${FONT}`),
    ])
  } catch {
    // Fallback monospace is acceptable.
  }

  // Full canvas background
  ctx.fillStyle = bg
  ctx.fillRect(0, 0, layout.sheetWidth, layout.sheetHeight)

  // Outer crisp 2px gallery frame (matches Open Graph cards & notgalerie.com DA)
  const frameX0 = OUTER_MARGIN
  const frameY0 = OUTER_MARGIN
  const frameX1 = layout.sheetWidth - OUTER_MARGIN
  const frameY1 = layout.sheetHeight - OUTER_MARGIN
  const frameW = frameX1 - frameX0
  const frameH = frameY1 - frameY0

  ctx.strokeStyle = ink
  ctx.lineWidth = 2
  ctx.strokeRect(frameX0 + 1, frameY0 + 1, frameW - 2, frameH - 2)

  // Header bar divider
  const headerBottom = frameY0 + HEADER_HEIGHT
  ctx.strokeStyle = ink
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(frameX0, headerBottom)
  ctx.lineTo(frameX1, headerBottom)
  ctx.stroke()

  // Square Crop mark + Title on left of header
  const leftX = frameX0 + INNER_PADDING
  const rightX = frameX1 - INNER_PADDING
  const markSize = 30
  const markY = frameY0 + 46
  ctx.strokeStyle = ink
  ctx.lineWidth = 3
  ctx.strokeRect(leftX + 1.5, markY + 1.5, markSize - 3, markSize - 3)

  ctx.fillStyle = ink
  ctx.font = `600 46px ${FONT}`
  ctx.textBaseline = 'alphabetic'
  ctx.textAlign = 'left'
  const dateStr = new Date().toISOString().slice(0, 10)
  const rightMeta = upper(`${entries.length} ${entries.length === 1 ? 'TILE' : 'TILES'} · ${dateStr}`)
  ctx.font = `400 34px ${FONT}`
  const rightMetaW = ctx.measureText(rightMeta).width

  ctx.font = `600 46px ${FONT}`
  const titleMaxW = rightX - (leftX + markSize + 20) - rightMetaW - 32
  ctx.fillText(fitText(ctx, upper(options.title), Math.max(200, titleMaxW)), leftX + markSize + 20, frameY0 + 76)

  // Right-aligned tile count + date in header
  ctx.fillStyle = muted
  ctx.font = `400 34px ${FONT}`
  ctx.textAlign = 'right'
  ctx.fillText(rightMeta, rightX, frameY0 + 74)
  ctx.textAlign = 'left'

  // Optional subtitle line in header
  if (options.subtitle) {
    ctx.fillStyle = muted
    ctx.font = `400 34px ${FONT}`
    ctx.fillText(fitText(ctx, upper(options.subtitle), frameW - INNER_PADDING * 2), leftX, frameY0 + 136)
  }

  // Grid of framed reference tiles
  const gridTop = headerBottom + INNER_PADDING
  const imagePad = 18
  const imageAreaHeight = layout.cellHeight - CAPTION_HEIGHT

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]
    const column = index % layout.columns
    const row = Math.floor(index / layout.columns)
    const x = leftX + column * (layout.cellWidth + GAP)
    const y = gridTop + row * (layout.cellHeight + GAP)

    // Tile background + crisp 2px ink border
    ctx.fillStyle = surface
    ctx.fillRect(x, y, layout.cellWidth, layout.cellHeight)
    ctx.strokeStyle = ink
    ctx.lineWidth = 2
    ctx.strokeRect(x + 1, y + 1, layout.cellWidth - 2, layout.cellHeight - 2)

    // Artwork image centered inside upper area
    const maxW = layout.cellWidth - imagePad * 2
    const maxH = imageAreaHeight - imagePad * 2
    try {
      const tile = await loadTileImage(entry, maxW, maxH)
      try {
        const scale = Math.min(maxW / tile.sw, maxH / tile.sh)
        const drawW = Math.max(1, Math.round(tile.sw * scale))
        const drawH = Math.max(1, Math.round(tile.sh * scale))
        const drawX = Math.round(x + (layout.cellWidth - drawW) / 2)
        const drawY = Math.round(y + imagePad + (maxH - drawH) / 2)
        ctx.drawImage(tile.source, tile.sx, tile.sy, tile.sw, tile.sh, drawX, drawY, drawW, drawH)
      } finally {
        tile.source.close()
      }
    } catch {
      ctx.fillStyle = muted
      ctx.font = `400 32px ${FONT}`
      ctx.fillText('IMAGE UNAVAILABLE', x + imagePad, y + imageAreaHeight / 2)
    }

    // Caption separator rule + numbered label bar
    const captionTop = y + imageAreaHeight
    ctx.strokeStyle = rule
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(x + 1, captionTop + 0.5)
    ctx.lineTo(x + layout.cellWidth - 1, captionTop + 0.5)
    ctx.stroke()

    const num = String(index + 1).padStart(2, '0')
    const captionY = captionTop + Math.round(CAPTION_HEIGHT * 0.66)
    ctx.fillStyle = muted
    ctx.font = `400 34px ${FONT}`
    ctx.fillText(num, x + 18, captionY)

    const captionText = entry.label ? `#${upper(entry.label)}` : entry.drawing.name
    ctx.fillStyle = ink
    ctx.font = `400 34px ${FONT}`
    ctx.fillText(fitText(ctx, captionText, layout.cellWidth - 96), x + 76, captionY)
  }

  // Footer bar
  const footerTop = frameY1 - FOOTER_HEIGHT
  ctx.strokeStyle = ink
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(frameX0, footerTop)
  ctx.lineTo(frameX1, footerTop)
  ctx.stroke()

  const footerTextY = footerTop + Math.round(FOOTER_HEIGHT * 0.63)
  ctx.fillStyle = muted
  ctx.font = `400 32px ${FONT}`
  ctx.textAlign = 'left'
  ctx.fillText(upper(`MADE WITH CROP · ${cleanOrigin(options.origin)}`), leftX, footerTextY)

  if (options.total > entries.length) {
    const more = upper(`+${options.total - entries.length} MORE IN LIBRARY`)
    ctx.textAlign = 'right'
    ctx.fillText(more, rightX, footerTextY)
    ctx.textAlign = 'left'
  }

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((out) => (out ? resolve(out) : reject(new Error('Could not render the sheet'))), 'image/png')
  })

  // Release GPU backing buffer promptly after encoding.
  canvas.width = 0
  canvas.height = 0

  return {
    blob,
    exportedCount: entries.length,
    width: layout.sheetWidth,
    height: layout.sheetHeight,
  }
}

/** Render a reference sheet for the current selection and download it as a crisp PNG. */
export async function downloadSheet(options: SheetOptions): Promise<number> {
  const { blob, exportedCount } = await renderSheet(options)
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
  return exportedCount
}

/** Render a reference sheet and copy the PNG straight to the clipboard for pasting into drawing apps. */
export async function copySheetToClipboard(options: SheetOptions): Promise<number> {
  if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
    throw new Error('CLIPBOARD_UNSUPPORTED')
  }
  const { blob, exportedCount } = await renderSheet(options)
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
  return exportedCount
}
