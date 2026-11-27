import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { handleSyncRequest } from '../src/lib/sync-server.ts'
import { formatStorageBytes, isValidSyncId, r2BlobKey } from '../src/lib/sync-protocol.ts'

function createD1Adapter(sqlite) {
  return {
    prepare(sql) {
      let params = []
      const stmt = {
        bind(...values) {
          params = values
          return stmt
        },
        async first() {
          const row = sqlite.prepare(sql).get(...params)
          return row ?? null
        },
        async all() {
          const results = sqlite.prepare(sql).all(...params)
          return { results }
        },
        async run() {
          return sqlite.prepare(sql).run(...params)
        },
      }
      return stmt
    },
  }
}

function createMemoryR2() {
  const store = new Map()
  return {
    store,
    async put(key, value, options) {
      const bytes = value instanceof Uint8Array ? new Uint8Array(value) : new Uint8Array(value)
      store.set(key, { bytes, contentType: options?.httpMetadata?.contentType })
    },
    async get(key) {
      const entry = store.get(key)
      if (!entry) return null
      return {
        body: entry.bytes,
        size: entry.bytes.byteLength,
        httpMetadata: { contentType: entry.contentType },
        async arrayBuffer() {
          return entry.bytes.buffer.slice(entry.bytes.byteOffset, entry.bytes.byteOffset + entry.bytes.byteLength)
        },
      }
    },
    async delete(keys) {
      const list = Array.isArray(keys) ? keys : [keys]
      for (const key of list) store.delete(key)
    },
  }
}

function setupSyncTestEnv() {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA foreign_keys = ON;')
  sqlite.exec(readFileSync(new URL('../migrations/0001_accounts.sql', import.meta.url), 'utf8'))
  sqlite.exec(readFileSync(new URL('../migrations/0003_library_sync.sql', import.meta.url), 'utf8'))

  sqlite.prepare('INSERT INTO user (id, name, email, email_verified) VALUES (?, ?, ?, 1)').run('user-a', 'Alice', 'alice@example.com')
  sqlite.prepare('INSERT INTO user (id, name, email, email_verified) VALUES (?, ?, ?, 1)').run('user-b', 'Bob', 'bob@example.com')

  const db = createD1Adapter(sqlite)
  const blobs = createMemoryR2()
  return { sqlite, db, blobs }
}

test('sync-protocol helpers validate IDs, R2 keys and byte formatting', () => {
  assert.equal(isValidSyncId('abc_123-XYZ'), true)
  assert.equal(isValidSyncId('../escape'), false)
  assert.equal(isValidSyncId('a/b'), false)
  assert.equal(r2BlobKey('u1', 'd1', 'original'), 'users/u1/drawings/d1/original')
  assert.equal(formatStorageBytes(0), '0 B')
  assert.equal(formatStorageBytes(2048), '2.0 KB')
  assert.equal(formatStorageBytes(100 * 1024 * 1024), '100.0 MB')
})

test('full sync flow: blob upload, push, pull, LWW conflict, tombstone delete and quota release', async () => {
  const { sqlite, db, blobs } = setupSyncTestEnv()
  const base = 'https://crop.example.com'

  // Lower user-a quota to 200 bytes to test quota enforcement deterministically
  sqlite.prepare('INSERT INTO user_storage (user_id, used_bytes, quota_bytes, sync_seq, updated_at) VALUES (?, 0, 200, 0, 1000)').run('user-a')

  const statusRes = await handleSyncRequest(new Request(`${base}/api/sync/status`), { db, blobs, userId: 'user-a' })
  assert.equal(statusRes.status, 200)
  const status = await statusRes.json()
  assert.equal(status.usedBytes, 0)
  assert.equal(status.quotaBytes, 200)

  // Reject unsupported MIME
  const badMimeRes = await handleSyncRequest(
    new Request(`${base}/api/sync/blobs/draw-1/original`, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain' },
      body: new Uint8Array(10),
    }),
    { db, blobs, userId: 'user-a' },
  )
  assert.equal(badMimeRes.status, 415)

  // Upload thumb (40 bytes) + original (120 bytes) -> total 160 / 200 bytes
  const putThumb = await handleSyncRequest(
    new Request(`${base}/api/sync/blobs/draw-1/thumb`, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/webp' },
      body: new Uint8Array(40).fill(1),
    }),
    { db, blobs, userId: 'user-a' },
  )
  assert.equal(putThumb.status, 200)

  const putOrig = await handleSyncRequest(
    new Request(`${base}/api/sync/blobs/draw-1/original`, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/png' },
      body: new Uint8Array(120).fill(2),
    }),
    { db, blobs, userId: 'user-a' },
  )
  assert.equal(putOrig.status, 200)
  assert.equal((await putOrig.json()).usedBytes, 160)

  // Second drawing (80 bytes) exceeds 200-byte quota -> 413 QUOTA_EXCEEDED
  const overQuota = await handleSyncRequest(
    new Request(`${base}/api/sync/blobs/draw-2/original`, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/png' },
      body: new Uint8Array(80).fill(3),
    }),
    { db, blobs, userId: 'user-a' },
  )
  assert.equal(overQuota.status, 413)
  assert.equal((await overQuota.json()).code, 'QUOTA_EXCEEDED')
  assert.equal(blobs.store.has('users/user-a/drawings/draw-2/original'), false)

  // Smaller third drawing (30 bytes) still fits (160 + 30 = 190 <= 200) -> no head-of-line blocking
  const smallFits = await handleSyncRequest(
    new Request(`${base}/api/sync/blobs/draw-3/original`, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/png' },
      body: new Uint8Array(30).fill(4),
    }),
    { db, blobs, userId: 'user-a' },
  )
  assert.equal(smallFits.status, 200)
  assert.equal((await smallFits.json()).usedBytes, 190)

  // Push folder + draw-1 + draw-2 (missing blob) -> draw-1 accepted, draw-2 rejected with MISSING_BLOB
  const pushRes = await handleSyncRequest(
    new Request(`${base}/api/sync/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        folders: [{ id: 'folder-1', name: 'Hands', updatedAt: 2000, deletedAt: null }],
        drawings: [
          {
            id: 'draw-1',
            name: 'hand.png',
            createdAt: 1500,
            width: 800,
            height: 600,
            folderId: 'folder-1',
            position: 0,
            tags: [{ id: 'tag-1', label: 'anatomy', box: [10, 20, 100, 100] }],
            visibleTagIds: ['tag-1'],
            updatedAt: 2000,
            deletedAt: null,
          },
          {
            id: 'draw-2',
            name: 'blocked.png',
            createdAt: 1600,
            width: 800,
            height: 600,
            folderId: null,
            position: 1,
            tags: [],
            visibleTagIds: null,
            updatedAt: 2000,
            deletedAt: null,
          },
        ],
      }),
    }),
    { db, blobs, userId: 'user-a' },
  )
  assert.equal(pushRes.status, 200)
  const pushData = await pushRes.json()
  assert.deepEqual(pushData.acceptedFolders, ['folder-1'])
  assert.deepEqual(pushData.acceptedDrawings, ['draw-1'])
  assert.deepEqual(pushData.rejected, [{ entity: 'drawing', id: 'draw-2', code: 'MISSING_BLOB' }])

  // Stale update (older updatedAt) is rejected by Last-Write-Wins
  const staleRes = await handleSyncRequest(
    new Request(`${base}/api/sync/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        folders: [{ id: 'folder-1', name: 'Old Name', updatedAt: 1000, deletedAt: null }],
      }),
    }),
    { db, blobs, userId: 'user-a' },
  )
  const staleData = await staleRes.json()
  assert.deepEqual(staleData.rejected, [{ entity: 'folder', id: 'folder-1', code: 'STALE' }])

  // Pull from another device returns folder-1 and draw-1
  const pullRes = await handleSyncRequest(new Request(`${base}/api/sync/pull?since=0`), { db, blobs, userId: 'user-a' })
  assert.equal(pullRes.status, 200)
  const pullData = await pullRes.json()
  assert.equal(pullData.folders.length, 1)
  assert.equal(pullData.folders[0].name, 'Hands')
  assert.equal(pullData.drawings.length, 1)
  assert.equal(pullData.drawings[0].tags[0].label, 'anatomy')

  // Tombstone delete of draw-1 removes its R2 blobs and frees 160 bytes (190 -> 30)
  const deleteRes = await handleSyncRequest(
    new Request(`${base}/api/sync/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        drawings: [
          {
            id: 'draw-1',
            name: 'hand.png',
            createdAt: 1500,
            width: 800,
            height: 600,
            folderId: null,
            position: null,
            tags: [],
            visibleTagIds: null,
            updatedAt: 3000,
            deletedAt: 3000,
          },
        ],
      }),
    }),
    { db, blobs, userId: 'user-a' },
  )
  assert.equal(deleteRes.status, 200)
  const deleteData = await deleteRes.json()
  assert.equal(deleteData.usedBytes, 30)
  assert.equal(blobs.store.has('users/user-a/drawings/draw-1/original'), false)
  assert.equal(blobs.store.has('users/user-a/drawings/draw-1/thumb'), false)

  // Now draw-2 (80 bytes) succeeds because quota was freed (30 + 80 = 110 <= 200)
  const retryOrig = await handleSyncRequest(
    new Request(`${base}/api/sync/blobs/draw-2/original`, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/png' },
      body: new Uint8Array(80).fill(3),
    }),
    { db, blobs, userId: 'user-a' },
  )
  assert.equal(retryOrig.status, 200)
  assert.equal((await retryOrig.json()).usedBytes, 110)

  // Incremental pull after previous seq only returns the draw-1 tombstone
  const deltaRes = await handleSyncRequest(
    new Request(`${base}/api/sync/pull?since=${pullData.serverSeq}`),
    { db, blobs, userId: 'user-a' },
  )
  const delta = await deltaRes.json()
  assert.equal(delta.folders.length, 0)
  assert.equal(delta.drawings.length, 1)
  assert.equal(delta.drawings[0].id, 'draw-1')
  assert.equal(delta.drawings[0].deletedAt, 3000)

  sqlite.close()
})

test('strict multi-user isolation and mixed pagination never leak or skip records', async () => {
  const { sqlite, db, blobs } = setupSyncTestEnv()
  const base = 'https://crop.example.com'

  // User A uploads a blob and 3 folders + 1 drawing
  await handleSyncRequest(
    new Request(`${base}/api/sync/blobs/shared-id/original`, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/png' },
      body: new Uint8Array([9, 8, 7, 6]),
    }),
    { db, blobs, userId: 'user-a' },
  )
  await handleSyncRequest(
    new Request(`${base}/api/sync/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        folders: [
          { id: 'f1', name: 'One', updatedAt: 1000, deletedAt: null },
          { id: 'f2', name: 'Two', updatedAt: 1001, deletedAt: null },
          { id: 'f3', name: 'Three', updatedAt: 1002, deletedAt: null },
        ],
        drawings: [
          {
            id: 'shared-id',
            name: 'secret.png',
            createdAt: 1000,
            width: 100,
            height: 100,
            folderId: 'f1',
            position: 0,
            tags: [],
            visibleTagIds: null,
            updatedAt: 1003,
            deletedAt: null,
          },
        ],
      }),
    }),
    { db, blobs, userId: 'user-a' },
  )

  // User B cannot read User A's blob or metadata
  const bobBlob = await handleSyncRequest(
    new Request(`${base}/api/sync/blobs/shared-id/original`),
    { db, blobs, userId: 'user-b' },
  )
  assert.equal(bobBlob.status, 404)

  const bobPull = await handleSyncRequest(
    new Request(`${base}/api/sync/pull?since=0`),
    { db, blobs, userId: 'user-b' },
  )
  const bobData = await bobPull.json()
  assert.equal(bobData.folders.length, 0)
  assert.equal(bobData.drawings.length, 0)

  // Paginated pull for User A with limit=2 across 3 folders + 1 drawing never skips f3
  const seenFolders = []
  const seenDrawings = []
  let cursor = 0
  let guard = 0
  while (guard++ < 10) {
    const res = await handleSyncRequest(
      new Request(`${base}/api/sync/pull?since=${cursor}&limit=2`),
      { db, blobs, userId: 'user-a' },
    )
    const page = await res.json()
    seenFolders.push(...page.folders.map((f) => f.id))
    seenDrawings.push(...page.drawings.map((d) => d.id))
    cursor = page.serverSeq
    if (!page.hasMore) break
  }

  assert.deepEqual(seenFolders, ['f1', 'f2', 'f3'])
  assert.deepEqual(seenDrawings, ['shared-id'])

  sqlite.close()
})
