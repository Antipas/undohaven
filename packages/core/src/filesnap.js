import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { hostname } from 'node:os'
import { CdcStream, chunkBuffer } from './cdc.js'
import { b64, chunkEncKey, chunkIdKey, hmacChunkId, manifestKey, open, randomId, seal, sha256 } from './crypto.js'
import { padBlob, unpadBlob } from './byo.js'
import { HouhuiError } from './errors.js'
import { safeJoin } from './paths.js'
import { putLocalChunk, readLocalChunk, readSnapshotRecord, writeSnapshotRecord, listSnapshotRecords } from './store.js'

const TOOL_VERSION = '0.1.16'

async function piecesOf(abs) {
  const cdc = new CdcStream()
  const pieces = []
  const stream = createReadStream(abs, { highWaterMark: 1024 * 1024 })
  for await (const block of stream) pieces.push(...cdc.push(block))
  pieces.push(...cdc.finish())
  return pieces.length ? pieces : [Buffer.alloc(0)]
}

async function sealPieces(dataDir, pieces, dek) {
  const idKey = chunkIdKey(dek)
  const encKey = chunkEncKey(dek)
  const hash = createHash('sha256')
  const ids = []
  const unique = new Map()
  for (const piece of pieces) {
    hash.update(piece)
    const id = hmacChunkId(idKey, piece)
    if (!unique.has(id)) {
      const sealed = seal(encKey, piece)
      await putLocalChunk(dataDir, id, sealed)
      unique.set(id, padBlob(sealed).length)
    }
    ids.push(id)
  }
  return { ids, sha256: hash.digest('hex'), unique }
}

export async function createFileSnapshot(opts) {
  const dek = opts.dek
  if (!dek) throw new HouhuiError('no_keys', '还没有本地密钥', 'Local keys are required')
  const entries = []
  const unique = new Map()
  for (const file of opts.files) {
    let pieces
    if (file.bytes) {
      const parts = chunkBuffer(file.bytes)
      pieces = parts.length ? parts : [Buffer.alloc(0)]
    } else {
      pieces = await piecesOf(file.abs)
    }
    const sealed = await sealPieces(opts.dataDir, pieces, dek)
    for (const [id, size] of sealed.unique) unique.set(id, size)
    entries.push({
      root: file.root,
      rel: file.rel,
      mtimeMs: file.mtimeMs || Date.now(),
      mode: file.mode || 0o600,
      size: piecesByteLength(pieces),
      chunks: sealed.ids,
      sha256: sealed.sha256,
    })
  }
  const id = randomId('snap_')
  const createdAt = new Date().toISOString()
  const kind = opts.kind || 'manual'
  const manifest = {
    v: 1,
    id,
    createdAt,
    kind,
    tags: [...new Set([kind, ...(opts.tags || [])])],
    tool: opts.tool || 'undohaven',
    toolVersion: TOOL_VERSION,
    hostname: hostname(),
    platform: process.platform,
    includeCredentials: false,
    entries,
  }
  const encrypted = padBlob(seal(manifestKey(dek), Buffer.from(JSON.stringify(manifest))))
  let bytes = encrypted.length
  for (const size of unique.values()) bytes += size
  const record = {
    id,
    createdAt,
    kind,
    tags: manifest.tags,
    bytes,
    chunkCount: unique.size,
    fileCount: entries.length,
    includesCredentials: false,
    encryptedManifest: b64(encrypted),
    chunkIds: [...unique.keys()],
    pinned: false,
    cloud: false,
    tool: manifest.tool,
  }
  await writeSnapshotRecord(opts.dataDir, record)
  if (opts.cloud) {
    try {
      const missing = await opts.cloud.missing(record.chunkIds)
      for (const chunkId of missing) {
        await opts.cloud.uploadChunk(chunkId, await readPadded(opts.dataDir, chunkId))
      }
      await opts.cloud.createSnapshot({
        id,
        createdAt,
        kind,
        bytes,
        chunkIds: record.chunkIds,
        dshVersion: null,
        includesCredentials: false,
        encryptedManifest: record.encryptedManifest,
        pinned: false,
      })
      record.cloud = true
      await writeSnapshotRecord(opts.dataDir, record)
    } catch (error) {
      record.cloudError = error.message || String(error)
    }
  }
  return record
}

function piecesByteLength(pieces) {
  return pieces.reduce((sum, piece) => sum + piece.length, 0)
}

async function readPadded(dataDir, id) {
  const { readPaddedChunk } = await import('./store.js')
  return readPaddedChunk(dataDir, id)
}

export async function readFileManifest(dataDir, dek, id) {
  const record = await readSnapshotRecord(dataDir, id)
  if (!record?.encryptedManifest) throw new HouhuiError('no_snapshot', '没有这份快照', `No snapshot ${id}`)
  const { fromB64 } = await import('./crypto.js')
  const manifest = JSON.parse(open(manifestKey(dek), unpadBlob(fromB64(record.encryptedManifest))).toString('utf8'))
  return { record, manifest }
}

export async function restoreFileSnapshot(opts) {
  const { manifest } = await readFileManifest(opts.dataDir, opts.dek, opts.id)
  const wanted = opts.paths ? new Set(opts.paths) : null
  const written = []
  const encKey = chunkEncKey(opts.dek)
  for (const entry of manifest.entries) {
    const key = `${entry.root}:${entry.rel}`
    if (wanted && !wanted.has(entry.rel) && !wanted.has(key)) continue
    const destRoot = opts.dest[entry.root]
    if (!destRoot) continue
    const parts = []
    const hash = createHash('sha256')
    for (const chunkId of entry.chunks) {
      const plain = open(encKey, await readLocalChunk(opts.dataDir, chunkId))
      if (hmacChunkId(chunkIdKey(opts.dek), plain) !== chunkId) {
        throw new HouhuiError('chunk_mismatch', '分块和内容对不上', `Chunk ${chunkId} does not match`)
      }
      hash.update(plain)
      parts.push(plain)
    }
    const bytes = Buffer.concat(parts)
    if (sha256(bytes) !== entry.sha256) throw new HouhuiError('checksum_mismatch', '文件校验失败', `Checksum mismatch for ${entry.rel}`)
    const abs = safeJoin(destRoot, entry.rel)
    await mkdir(dirname(abs), { recursive: true })
    await writeFile(abs, bytes, { mode: entry.mode & 0o777 })
    written.push(key)
  }
  return { id: opts.id, files: written }
}

export async function listFileSnapshots(dataDir) {
  const rows = await listSnapshotRecords(dataDir)
  return rows.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
}

export async function removeTree(path) {
  await rm(path, { recursive: true, force: true })
}

export async function readText(path) {
  return readFile(path, 'utf8')
}
