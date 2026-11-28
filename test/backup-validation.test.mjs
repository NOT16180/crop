import assert from 'node:assert/strict'
import test from 'node:test'
import { isValidBackupDrawing } from '../src/lib/backup-validation.ts'
import {
  SAMPLE_DRAWINGS,
  SAMPLE_FOLDER_ID,
} from '../src/lib/sample-data.ts'
import {
  detectLocale,
  formatMessage,
  MESSAGES,
  SUPPORTED_LOCALES,
} from '../src/lib/i18n-dict.ts'
import { findTagged, normalizeText } from '../src/lib/search.ts'
import {
  computeScaledDimensions,
  isAcceptedImage,
  rescaleTagBoxes,
  shouldAcceptReencode,
  shouldSkipFallbackFormat,
  syncFilenameExtension,
} from '../src/lib/image-validation.ts'
import {
  createStreamingZip,
  decodeUtf8,
  encodeUtf8,
  extractStreamingZip,
  resolveRestoredImageMime,
} from '../src/lib/backup-archive.ts'
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

test('shouldAcceptReencode prevents generation loss while accepting format changes, downscales, and big savings', () => {
  // Tiny 3% drop on already-WebP image at same size -> reject (prevents generation loss on repeated clicks)
  assert.equal(shouldAcceptReencode({
    originalMime: 'image/webp',
    targetMime: 'image/webp',
    originalSize: 500_000,
    newSize: 485_000,
    originalWidth: 2000,
    originalHeight: 1500,
    newWidth: 2000,
    newHeight: 1500,
  }), false)

  // Huge savings (>15% and >16 KB) on bloated JPEG at same size -> accept
  assert.equal(shouldAcceptReencode({
    originalMime: 'image/jpeg',
    targetMime: 'image/jpeg',
    originalSize: 2_000_000,
    newSize: 600_000,
    originalWidth: 2000,
    originalHeight: 1500,
    newWidth: 2000,
    newHeight: 1500,
  }), true)

  // Format change PNG -> WebP with any size reduction -> accept
  assert.equal(shouldAcceptReencode({
    originalMime: 'image/png',
    targetMime: 'image/webp',
    originalSize: 40_000,
    newSize: 38_000,
    originalWidth: 800,
    originalHeight: 600,
    newWidth: 800,
    newHeight: 600,
  }), true)

  // Dimension downscale -> accept if smaller
  assert.equal(shouldAcceptReencode({
    originalMime: 'image/jpeg',
    targetMime: 'image/jpeg',
    originalSize: 500_000,
    newSize: 450_000,
    originalWidth: 4000,
    originalHeight: 3000,
    newWidth: 2400,
    newHeight: 1800,
  }), true)

  // Never accept larger or empty output
  assert.equal(shouldAcceptReencode({
    originalMime: 'image/png',
    targetMime: 'image/webp',
    originalSize: 100_000,
    newSize: 105_000,
    originalWidth: 1000,
    originalHeight: 1000,
    newWidth: 1000,
    newHeight: 1000,
  }), false)
})

test('syncFilenameExtension aligns downloaded filename extension with real image MIME type', () => {
  assert.equal(syncFilenameExtension('sketch.png', 'image/webp'), 'sketch.webp')
  assert.equal(syncFilenameExtension('photo.JPEG', 'image/webp'), 'photo.webp')
  assert.equal(syncFilenameExtension('study.png', 'image/jpeg'), 'study.jpg')
  assert.equal(syncFilenameExtension('untitled', 'image/webp'), 'untitled.webp')
  assert.equal(syncFilenameExtension('drawing.png', 'application/octet-stream'), 'drawing.png')
})

test('streaming ZIP backup round-trips deflated JSON and stored binary images accurately', async () => {
  const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8])
  const webpBytes = new Uint8Array([
    0x52, 0x49, 0x46, 0x46, 0x10, 0x00, 0x00, 0x00,
    0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20,
  ])
  const manifest = JSON.stringify({ format: 'crop-backup', version: 1, folders: [], drawings: [] })

  const chunks = await createStreamingZip([
    { name: 'manifest.json', data: encodeUtf8(manifest), compress: true },
    { name: 'drawings/a.image', data: pngBytes, compress: false },
    { name: 'drawings/b.image', data: webpBytes, compress: false },
  ])
  const totalLen = chunks.reduce((sum, c) => sum + c.byteLength, 0)
  const merged = new Uint8Array(totalLen)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }

  const extracted = await extractStreamingZip(merged)
  assert.equal(decodeUtf8(extracted.get('manifest.json')), manifest)
  assert.deepEqual(extracted.get('drawings/a.image'), pngBytes)
  assert.deepEqual(extracted.get('drawings/b.image'), webpBytes)
  assert.equal(resolveRestoredImageMime(extracted.get('drawings/a.image')), 'image/png')
  assert.equal(resolveRestoredImageMime(extracted.get('drawings/b.image')), 'image/webp')
  assert.equal(resolveRestoredImageMime(encodeUtf8('<html>not an image</html>')), null)
})

test('extractStreamingZip enforces real decompressed size limits and rejects corrupt archives', async () => {
  // Zip bomb simulation: 200 KB of zeros compresses tiny, but exceeds 50 KB safety limit
  const bombData = new Uint8Array(200_000)
  const bombChunks = await createStreamingZip([
    { name: 'manifest.json', data: bombData, compress: true },
  ])
  const bombArchive = new Uint8Array(bombChunks.reduce((s, c) => s + c.byteLength, 0))
  let pos = 0
  for (const c of bombChunks) {
    bombArchive.set(c, pos)
    pos += c.byteLength
  }

  await assert.rejects(
    () => extractStreamingZip(bombArchive, { maxUncompressedBytes: 50_000 }),
    /browser safety limit/,
  )

  // Non-ZIP / corrupt data rejected cleanly
  await assert.rejects(
    () => extractStreamingZip(encodeUtf8('not a zip file at all 1234567890')),
    /not a valid Crop backup/,
  )
})

test('all bundled sample drawings have valid dimensions, unique tag IDs, and in-bounds crop boxes', () => {
  const sampleFolders = new Set([SAMPLE_FOLDER_ID])
  assert.ok(SAMPLE_DRAWINGS.length >= 3)
  for (const sample of SAMPLE_DRAWINGS) {
    assert.equal(
      isValidBackupDrawing({ ...sample, folderId: SAMPLE_FOLDER_ID }, sampleFolders),
      true,
      `Invalid sample drawing: ${sample.id}`,
    )
  }
})

test('all 5 locales (en, fr, es, ja, zh) have complete, non-empty keys and matching placeholders', () => {
  assert.deepEqual([...SUPPORTED_LOCALES], ['en', 'fr', 'es', 'ja', 'zh'])
  const baseKeys = Object.keys(MESSAGES.en).sort()
  const extractVars = (str) => [...str.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()

  for (const locale of SUPPORTED_LOCALES) {
    const dict = MESSAGES[locale]
    assert.deepEqual(Object.keys(dict).sort(), baseKeys, `Key mismatch in locale ${locale}`)
    for (const key of baseKeys) {
      assert.ok(dict[key].trim().length > 0, `Empty translation for ${locale}.${key}`)
      assert.deepEqual(
        extractVars(dict[key]),
        extractVars(MESSAGES.en[key]),
        `Placeholder mismatch for ${locale}.${key}`,
      )
    }
  }

  assert.equal(detectLocale(['fr-FR', 'en-US']), 'fr')
  assert.equal(detectLocale(['es-MX']), 'es')
  assert.equal(detectLocale(['ja-JP']), 'ja')
  assert.equal(detectLocale(['zh-CN']), 'zh')
  assert.equal(detectLocale(['de-DE']), 'en')
  assert.equal(formatMessage('fr', 'toast.undo', { count: 3 }), 'Annuler (3)')
})
