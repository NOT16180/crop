import type { DrawingRecord, Rect, Tag } from './db'

/** Normalize case and accents so “Face” and “face” match. */
export function normalizeText(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim()
}

/** Check if two bounding boxes are identical or both null (whole image). */
export function areBoxesEqual(a: Rect | null, b: Rect | null): boolean {
  if (a === null && b === null) return true
  if (a === null || b === null) return false
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3]
}

/**
 * Deduplicate tags on an image.
 * Two tags are duplicates if they have the same normalized label AND identical box (or both whole image).
 * Preserves visibleTagIds so no ghost tag IDs remain.
 */
export function deduplicateTags(
  tags: Tag[],
  visibleTagIds?: string[],
): { tags: Tag[]; visibleTagIds?: string[] } {
  const result: Tag[] = []
  const replacedWith = new Map<string, string>() // duplicateId -> keptId

  for (const tag of tags) {
    const norm = normalizeText(tag.label)
    const existing = result.find(
      (t) => normalizeText(t.label) === norm && areBoxesEqual(t.box, tag.box),
    )
    if (existing) {
      replacedWith.set(tag.id, existing.id)
    } else {
      result.push(tag)
    }
  }

  let nextVisible = visibleTagIds
  if (visibleTagIds) {
    const visibleSet = new Set(visibleTagIds)
    for (const [removedId, keptId] of replacedWith.entries()) {
      if (visibleSet.has(removedId)) {
        visibleSet.add(keptId)
      }
    }
    const validIds = new Set(result.map((t) => t.id))
    nextVisible = [...visibleSet].filter((id) => validIds.has(id))
  }

  return { tags: result, visibleTagIds: nextVisible }
}

export interface TagStats {
  label: string
  normalized: string
  count: number // total occurrences of this tag
  imageCount: number // number of distinct images bearing this tag
}

/**
 * Compute tag statistics across drawings.
 */
export function computeTagStats(drawings: DrawingRecord[]): TagStats[] {
  const map = new Map<string, { label: string; count: number; imageIds: Set<string> }>()
  for (const drawing of drawings) {
    for (const tag of drawing.tags) {
      const key = normalizeText(tag.label)
      if (!key) continue
      const entry = map.get(key)
      if (entry) {
        entry.count++
        entry.imageIds.add(drawing.id)
      } else {
        map.set(key, { label: tag.label, count: 1, imageIds: new Set([drawing.id]) })
      }
    }
  }
  return [...map.entries()]
    .map(([normalized, data]) => ({
      label: data.label,
      normalized,
      count: data.count,
      imageCount: data.imageIds.size,
    }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
}

/**
 * Rename or merge a tag group everywhere across all drawings.
 * Renames all tags matching oldLabel to newLabel, then deduplicates tags on each image.
 * Returns the modified drawings and count of affected drawings.
 */
export function renameOrMergeTag(
  drawings: DrawingRecord[],
  oldLabel: string,
  newLabel: string,
): { changedDrawings: DrawingRecord[]; affectedCount: number } {
  const oldKey = normalizeText(oldLabel)
  const newKey = normalizeText(newLabel)
  if (!oldKey || !newKey || oldKey === newKey) {
    return { changedDrawings: drawings, affectedCount: 0 }
  }

  let affectedCount = 0
  const changedDrawings = drawings.map((drawing) => {
    const hasTag = drawing.tags.some((t) => normalizeText(t.label) === oldKey)
    if (!hasTag) return drawing

    affectedCount++
    const updatedTags = drawing.tags.map((t) =>
      normalizeText(t.label) === oldKey ? { ...t, label: newLabel } : t,
    )
    const { tags: dedupedTags, visibleTagIds: dedupedVisible } = deduplicateTags(
      updatedTags,
      drawing.visibleTagIds,
    )

    return {
      ...drawing,
      tags: dedupedTags,
      visibleTagIds: dedupedVisible,
    }
  })

  return { changedDrawings, affectedCount }
}

/**
 * Delete a tag everywhere across all drawings.
 */
export function deleteTagGlobally(
  drawings: DrawingRecord[],
  label: string,
): { changedDrawings: DrawingRecord[]; affectedCount: number } {
  const key = normalizeText(label)
  if (!key) return { changedDrawings: drawings, affectedCount: 0 }

  let affectedCount = 0
  const changedDrawings = drawings.map((drawing) => {
    const filtered = drawing.tags.filter((t) => normalizeText(t.label) !== key)
    if (filtered.length === drawing.tags.length) return drawing

    affectedCount++
    const remainingIds = new Set(filtered.map((t) => t.id))
    const nextVisible = drawing.visibleTagIds?.filter((id) => remainingIds.has(id))

    return {
      ...drawing,
      tags: filtered,
      visibleTagIds: nextVisible,
    }
  })

  return { changedDrawings, affectedCount }
}
