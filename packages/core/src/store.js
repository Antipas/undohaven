import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { hasBlob, putBlob, readBlob, readByoRecord, writeByoRecord } from './byo.js'
import { HouhuiError } from './errors.js'

const CHUNK_ID = /^[0-9a-f]{64}$/

export function assertChunkId(id) {
  if (!CHUNK_ID.test(id)) throw new HouhuiError('bad_chunk_id', '分块编号不合法', `Invalid chunk id ${id}`)
}

export function chunkPath(dataDir, id) {
  assertChunkId(id)
  return join(dataDir, 'chunks', id.slice(0, 2), id)
}

export async function putLocalChunk(dataDir, id, bytes) {
  await putBlob(dataDir, id, bytes)
}

export async function hasLocalChunk(dataDir, id) {
  return hasBlob(dataDir, id)
}

export async function readLocalChunk(dataDir, id) {
  return readBlob(dataDir, id, { padded: false })
}

export async function readPaddedChunk(dataDir, id) {
  return readBlob(dataDir, id, { padded: true })
}

export function snapshotPath(dataDir, id) {
  if (!/^snap_[0-9a-f]{32}$/.test(id)) {
    throw new HouhuiError('bad_snapshot_id', '快照编号不合法', `Invalid snapshot id ${id}`)
  }
  return join(dataDir, 'snapshots', `${id}.json`)
}

export async function atomicWrite(file, data, mode = 0o600) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  await writeFile(tmp, data, { mode })
  const { rename } = await import('node:fs/promises')
  await rename(tmp, file)
}

export async function writeSnapshotRecord(dataDir, record) {
  await atomicWrite(snapshotPath(dataDir, record.id), JSON.stringify(record))
  await writeByoRecord(dataDir, record)
}

export async function readSnapshotRecord(dataDir, id) {
  try {
    return JSON.parse(await readFile(snapshotPath(dataDir, id), 'utf8'))
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const remote = await readByoRecord(dataDir, id)
  if (remote) {
    await atomicWrite(snapshotPath(dataDir, id), JSON.stringify(remote))
    return remote
  }
  return null
}

export async function listSnapshotRecords(dataDir) {
  const dir = join(dataDir, 'snapshots')
  let names = []
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const records = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    try {
      records.push(JSON.parse(await readFile(join(dir, name), 'utf8')))
    } catch {
      /* skip unreadable */
    }
  }
  records.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
  return records
}
