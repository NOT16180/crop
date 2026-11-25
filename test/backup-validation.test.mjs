import assert from 'node:assert/strict'
import test from 'node:test'
import { isValidBackupDrawing } from '../src/lib/backup-validation.ts'
import { findTagged, normalizeText } from '../src/lib/search.ts'
import { isAcceptedImage } from '../src/lib/image-validation.ts'

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
