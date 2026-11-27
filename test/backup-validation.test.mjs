import assert from 'node:assert/strict'
import test from 'node:test'
import { isValidBackupDrawing } from '../src/lib/backup-validation.ts'
import { findTagged, normalizeText } from '../src/lib/search.ts'
import { computeScaledDimensions, isAcceptedImage, rescaleTagBoxes, shouldSkipFallbackFormat } from '../src/lib/image-validation.ts'
import { deduplicateTags, renameOrMergeTag, computeTagStats, areBoxesEqual } from '../src/lib/tags.ts'

const folders = new Set(['folder-1'])
const drawing = {
  id: 'drawing-1',
  name: 'study.png',
  width: 100,
  height: 80,
  folderId: 'folder-1',
  tags: [
    { id: 'tag-1', label: 'face', box: [10, 5, 40, 30] },
    { id: 'tag-2', label: 'portrait', box: null },
  ],
}

test('accepts valid drawing records and whole-image tags', () => {
  assert.equal(isValidBackupDrawing(drawing, folders), true)
})

test('rejects invalid dimensions and crop rectangles outside the image', () => {
  assert.equal(isValidBackupDrawing({ ...drawing, width: 0 }, folders), false)
  assert.equal(isValidBackupDrawing({
    ...drawing,
    tags: [{ id: 'tag-1', label: 'face', box: [90, 5, 20, 30] }],
  }, folders), false)
})

test('rejects references to folders not present in the backup', () => {
  assert.equal(isValidBackupDrawing({ ...drawing, folderId: 'missing' }, folders), false)
})

test('rejects malformed tag visibility and duplicate tag IDs', () => {
  assert.equal(isValidBackupDrawing({ ...drawing, visibleTagIds: [null] }, folders), false)
  assert.equal(isValidBackupDrawing({
    ...drawing,
    tags: [drawing.tags[0], { ...drawing.tags[1], id: drawing.tags[0].id }],
  }, folders), false)
})

test('search matches tag accents and preserves the matching crop', () => {
  const image = {
    id: 'drawing-2', name: 'portrait.png', createdAt: 1, width: 100, height: 80,
    blob: new Blob(), thumb: new Blob(),
    tags: [{ id: 'tag-3', label: 'Été', box: [5, 6, 20, 30] }],
  }
  assert.equal(normalizeText('ÉTÉ'), 'ete')
  const [hit] = findTagged('ete', [image])
  assert.deepEqual(hit.box, [5, 6, 20, 30])
  assert.equal(findTagged('x', [image]).length, 0)
})

test('accepts the advertised image formats and rejects other MIME types', () => {
  assert.equal(isAcceptedImage(new File(['data'], 'study.avif', { type: 'image/avif' })), true)
  assert.equal(isAcceptedImage(new File(['data'], 'notes.txt', { type: 'text/plain' })), false)
})

test('deduplicates whole image tags with same label', () => {
  const tags = [
    { id: '1', label: 'lumiere', box: null },
    { id: '2', label: 'LUMIERE', box: null },
    { id: '3', label: 'tete', box: null },
  ]
  const deduped = deduplicateTags(tags, ['1', '2'])
  assert.equal(deduped.tags.length, 2)
  assert.deepEqual(deduped.tags.map((t) => t.label), ['lumiere', 'tete'])
  assert.deepEqual(deduped.visibleTagIds, ['1'])
})

test('deduplicates identical box tags but preserves distinct box tags', () => {
  const tags = [
    { id: '1', label: 'visage', box: [10, 10, 50, 50] },
    { id: '2', label: 'visage', box: [10, 10, 50, 50] },
    { id: '3', label: 'visage', box: [20, 20, 30, 30] },
  ]
  const deduped = deduplicateTags(tags)
  assert.equal(deduped.tags.length, 2)
  assert.deepEqual(deduped.tags.map((t) => t.id), ['1', '3'])
})

test('renaming or merging a tag into an existing tag deduplicates properly', () => {
  // Scenario from QA report: an image has both 'lumiere' and 'tete' as whole image tags.
  // Renaming 'tete' to 'lumiere' should result in a single 'lumiere' tag!
  const drawings = [
    {
      id: 'd1', name: 'img1.png', createdAt: 1, width: 100, height: 100,
      blob: new Blob(), thumb: new Blob(),
      tags: [
        { id: 't1', label: 'lumiere', box: null },
        { id: 't2', label: 'tete', box: null },
      ],
      visibleTagIds: ['t1', 't2'],
    },
    {
      id: 'd2', name: 'img2.png', createdAt: 2, width: 100, height: 100,
      blob: new Blob(), thumb: new Blob(),
      tags: [
        { id: 't3', label: 'tete', box: null },
      ],
      visibleTagIds: ['t3'],
    },
  ]

  const { changedDrawings, affectedCount } = renameOrMergeTag(drawings, 'tete', 'lumiere')
  assert.equal(affectedCount, 2)
  assert.equal(changedDrawings[0].tags.length, 1)
  assert.equal(changedDrawings[0].tags[0].label, 'lumiere')
  assert.deepEqual(changedDrawings[0].visibleTagIds, ['t1'])

  assert.equal(changedDrawings[1].tags.length, 1)
  assert.equal(changedDrawings[1].tags[0].label, 'lumiere')

  const stats = computeTagStats(changedDrawings)
  assert.equal(stats.length, 1)
  assert.equal(stats[0].label, 'lumiere')
  assert.equal(stats[0].count, 2) // exactly 2, not 3!
  assert.equal(stats[0].imageCount, 2)
})

test('computeScaledDimensions preserves small images and scales oversized images proportionally', () => {
  assert.deepEqual(computeScaledDimensions(1200, 800, 2400), { width: 1200, height: 800 })
  assert.deepEqual(computeScaledDimensions(4800, 2400, 2400), { width: 2400, height: 1200 })
  assert.deepEqual(computeScaledDimensions(1200, 4800, 2400), { width: 600, height: 2400 })
})

test('rescaleTagBoxes scales crop rectangles proportionally and leaves whole-image tags intact', () => {
  const tags = [
    { id: 't1', label: 'hand', box: [400, 1000, 800, 600] },
    { id: 't2', label: 'lineart', box: null },
  ]
  const rescaled = rescaleTagBoxes(tags, 4000, 5000, 1920, 2400)
  assert.deepEqual(rescaled[0].box, [192, 480, 384, 288])
  assert.equal(rescaled[1].box, null)
})

test('shouldSkipFallbackFormat avoids re-encoding compact WebP/AVIF to JPEG on Safari/iOS', () => {
  assert.equal(shouldSkipFallbackFormat('image/webp', 'image/jpeg', 2400, 1800, 2400), true)
  assert.equal(shouldSkipFallbackFormat('image/avif', 'image/jpeg', 1200, 900, 2400), true)
  assert.equal(shouldSkipFallbackFormat('image/webp', 'image/jpeg', 4000, 3000, 2400), false)
  assert.equal(shouldSkipFallbackFormat('image/png', 'image/jpeg', 1200, 900, 2400), false)
  assert.equal(shouldSkipFallbackFormat('image/webp', 'image/webp', 2400, 1800, 2400), false)
})
