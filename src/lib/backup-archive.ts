import {
  strFromU8,
  strToU8,
  Unzip,
  UnzipInflate,
  UnzipPassThrough,
  Zip,
  ZipDeflate,
  ZipPassThrough,
} from 'fflate'
import { detectImageMime } from './sync-protocol.ts'

export const MAX_ARCHIVE_BYTES = 600 * 1024 * 1024
export const MAX_UNCOMPRESSED_BYTES = 512 * 1024 * 1024
export const MAX_ENTRY_BYTES = 256 * 1024 * 1024
export const MAX_ARCHIVE_ENTRIES = 10_000
const UNZIP_CHUNK_BYTES = 4 * 1024 * 1024

export interface ZipInputEntry {
  name: string
  data: Uint8Array
  /** Compress text/JSON entries; store already-compressed images at level 0. */
  compress?: boolean
}

/**
 * Build a ZIP archive using streaming ZipDeflate (for JSON) and ZipPassThrough
 * (level 0 Store for already-compressed images) so backups are fast, memory-safe,
 * and never double-compress image bytes.
 */
export async function createStreamingZip(
  entries: AsyncIterable<ZipInputEntry> | Iterable<ZipInputEntry>,
): Promise<Uint8Array[]> {
  const chunks: Uint8Array[] = []
  let streamError: Error | null = null
  let resolveDone!: () => void
  let rejectDone!: (err: Error) => void
  const donePromise = new Promise<void>((resolve, reject) => {
    resolveDone = resolve
    rejectDone = reject
  })

  const zip = new Zip((err, data, final) => {
    if (err) {
      streamError = err instanceof Error ? err : new Error(String(err))
      rejectDone(streamError)
      return
    }
    if (data && data.byteLength > 0) chunks.push(data)
    if (final) resolveDone()
  })

  for await (const entry of entries) {
    if (streamError) throw streamError
    const file = entry.compress ? new ZipDeflate(entry.name, { level: 6 }) : new ZipPassThrough(entry.name)
    zip.add(file)
    file.push(entry.data, true)
    await new Promise((resolve) => setTimeout(resolve, 0))
  }

  zip.end()
  await donePromise
  return chunks
}

/**
 * Extract a ZIP archive in chunks with strict zip-bomb guards on BOTH declared
 * header size AND actual decompressed byte counts, so forged headers cannot OOM
 * the browser.
 */
export async function extractStreamingZip(
  archiveBytes: Uint8Array,
  limits: {
    maxArchiveBytes?: number
    maxUncompressedBytes?: number
    maxEntryBytes?: number
    maxEntries?: number
  } = {},
): Promise<Map<string, Uint8Array>> {
  const maxArchive = limits.maxArchiveBytes ?? MAX_ARCHIVE_BYTES
  const maxUncompressed = limits.maxUncompressedBytes ?? MAX_UNCOMPRESSED_BYTES
  const maxEntry = limits.maxEntryBytes ?? MAX_ENTRY_BYTES
  const maxEntries = limits.maxEntries ?? MAX_ARCHIVE_ENTRIES

  if (archiveBytes.byteLength > maxArchive) {
    throw new Error('This backup is too large to restore in the browser (maximum 600 MB).')
  }
  // Quick ZIP magic check (PK\x03\x04 local header or PK\x05\x06 empty archive).
  if (
    archiveBytes.byteLength < 22 ||
    archiveBytes[0] !== 0x50 ||
    archiveBytes[1] !== 0x4b
  ) {
    throw new Error('This file is not a valid Crop backup.')
  }

  const files = new Map<string, Uint8Array>()
  let entryCount = 0
  let totalUncompressed = 0
  let limitError: Error | null = null
  let decompressError: Error | null = null

  const unzipper = new Unzip((stream) => {
    if (limitError || decompressError) return
    entryCount++
    if (entryCount > maxEntries) {
      limitError = new Error('This backup expands beyond the browser safety limit (too many files).')
      return
    }
    if (typeof stream.originalSize === 'number' && stream.originalSize > maxEntry) {
      limitError = new Error('This backup expands beyond the browser safety limit (512 MB total).')
      return
    }

    const parts: Uint8Array[] = []
    let entryBytes = 0
    stream.ondata = (err, data, final) => {
      if (limitError || decompressError) return
      if (err) {
        decompressError = err instanceof Error ? err : new Error(String(err))
        return
      }
      if (data && data.byteLength > 0) {
        entryBytes += data.byteLength
        totalUncompressed += data.byteLength
        if (entryBytes > maxEntry || totalUncompressed > maxUncompressed) {
          limitError = new Error('This backup expands beyond the browser safety limit (512 MB total).')
          return
        }
        parts.push(data)
      }
      if (final) {
        if (parts.length === 1) {
          files.set(stream.name, parts[0])
        } else {
          const merged = new Uint8Array(entryBytes)
          let offset = 0
          for (const part of parts) {
            merged.set(part, offset)
            offset += part.byteLength
          }
          files.set(stream.name, merged)
        }
      }
    }
    stream.start()
  })

  unzipper.register(UnzipInflate)
  unzipper.register(UnzipPassThrough)

  try {
    for (let offset = 0; offset < archiveBytes.byteLength; offset += UNZIP_CHUNK_BYTES) {
      if (limitError) throw limitError
      if (decompressError) throw decompressError
      const end = Math.min(archiveBytes.byteLength, offset + UNZIP_CHUNK_BYTES)
      const isFinal = end >= archiveBytes.byteLength
      unzipper.push(archiveBytes.subarray(offset, end), isFinal)
      if (!isFinal) {
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
    }
  } catch (cause) {
    if (limitError) throw limitError
    if (cause instanceof Error && cause.message.includes('browser safety limit')) throw cause
    throw new Error('This file is not a valid Crop backup.')
  }

  if (limitError) throw limitError
  if (decompressError) throw new Error('This file is not a valid Crop backup.')

  return files
}

export function decodeUtf8(bytes: Uint8Array): string {
  return strFromU8(bytes)
}

export function encodeUtf8(text: string): Uint8Array {
  return strToU8(text)
}

/**
 * Resolve the true MIME type of an extracted image entry from its magic bytes
 * (falling back to declared type only when magic bytes match an accepted format).
 */
export function resolveRestoredImageMime(bytes: Uint8Array): string | null {
  return detectImageMime(bytes)
}
