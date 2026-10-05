import type { DrawingRecord, Rect, Tag } from './db'

export interface SearchHit {
  drawing: DrawingRecord
  box: Rect
  label: string
}

/** Normalize case and accents so “Face” and “face” match. */
export function normalizeText(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim()
}

function tagMatches(label: string, query: string): boolean {
  const tag = normalizeText(label)
  if (!tag || !query) return false
  if (tag === query) return true
  // A one-letter query should not return half the library.
  return query.length >= 2 && tag.includes(query)
}

/** Return matching regions (or full drawings) in library order. */
export function findTagged(text: string, drawings: DrawingRecord[]): SearchHit[] {
  const query = normalizeText(text)
  const hits: SearchHit[] = []
  for (const drawing of drawings) {
    for (const tag of drawing.tags) {
      if (tagMatches(tag.label, query)) hits.push(toHit(drawing, tag))
    }
  }
  return hits
}

function toHit(drawing: DrawingRecord, tag: Tag): SearchHit {
  return {
    drawing,
    box: tag.box ?? [0, 0, drawing.width, drawing.height],
    label: tag.label,
  }
}
