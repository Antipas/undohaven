import { createHash, randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { access, mkdir, readFile, readdir, rm, stat, utimes } from 'node:fs/promises'
import { hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { CdcStream, chunkBuffer } from './cdc.js'
import { CloudClient } from './cloud.js'
import {
  b64,
  chunkEncKey,
  chunkIdKey,
  fromB64,
  hmacChunkId,
  manifestKey,
  open,
  randomId,
  seal,
  sha256,
} from './crypto.js'
import { HouhuiError, bi } from './errors.js'
import { loadConfig, loadDek, loadState, saveState } from './keys.js'
import { assertDshStopped } from './lock.js'
import { runProcess } from './proc.js'
import { safeJoin } from './paths.js'
import { scanRoot } from './scan.js'
import { repairJsonl, repairZstd } from './session.js'
import { snapshotSqlite } from './sqlite.js'
import {
  atomicWrite,
  hasLocalChunk,
  listSnapshotRecords,
  putLocalChunk,
  readLocalChunk,
  readPaddedChunk,
  readSnapshotRecord,
  writeSnapshotRecord,
} from './store.js'
import { isWatchedStorage } from './items.js'
import { loadStorageConfig, padBlob, unpadBlob } from './byo.js'
import { detectDshVersions } from './versions.js'
import { stripRemovedWorkingDirectoryTool } from './compat.js'
import { collectPluginState, savePluginState } from './plugins.js'

const require = createRequire(import.meta.url)
const TOOL_VERSION = require('../package.json').version
const EXPORT_MAGIC = Buffer.from('UHV1')

function inScope(entry, scope, opts = {}) {
  if (scope === 'all') return true
  const rel = entry.rel
  if (scope === 'sessions') return entry.root === 'dsh' && rel.startsWith('sessions/')
  if (scope === 'storages') return entry.root === 'dsh' && rel.startsWith('storages/')
  if (scope === 'tasks') return entry.root === 'dsh' && rel === 'storages/schedule.json'
  if (scope === 'session') {
    if (entry.root !== 'dsh' || !rel.startsWith('sessions/')) return false
    const id = opts.session
    if (!id) return false
    return rel.split('/').includes(id)
  }
  if (scope === 'profile') {
    return entry.root === 'dsh' && /^profiles\/[^/]+\/(?:package\.json|pnpm-lock\.yaml|cordis\.patch\.yml)$/.test(rel)
  }
  if (scope === 'config') {
    if (entry.root === 'agents') return true
    if (entry.root !== 'dsh') return false
    if (rel === 'cordis.patch.yml' || rel.startsWith('skills/') || rel.startsWith('attachments/') || rel.startsWith('profiles/')) {
      return true
    }
    const base = rel.split('/')[0]
    return !['sessions', 'storages', 'profiles', 'skills', 'attachments', 'cache'].includes(base)
  }
  throw new HouhuiError('bad_scope', '范围只能是 sessions、storages、config、profile、tasks、session 或 all', 'Scope must be sessions, storages, config, profile, tasks, session, or all')
}

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

export async function cloudFromConfig(dataDir, override) {
  const config = await loadConfig(dataDir)
  const apiBase = override?.apiBase || config.apiBase
  const token = override?.token || config.accessToken
  if (!apiBase || !token) return { config, cloud: null }
  return { config, cloud: new CloudClient({ apiBase, token }) }
}

async function readBackupSource(file) {
  if (file.bytes) {
    return { buffer: file.bytes, cleanup: async () => {}, repaired: false, sqlite: false }
  }
  if (file.sqlite) {
    const snap = await snapshotSqlite(file.abs)
    return { path: snap.path, cleanup: snap.cleanup, repaired: false, sqlite: true }
  }
  if (file.session && (file.rel.endsWith('.zstd') || file.rel.endsWith('.zst'))) {
    const buf = await readFile(file.abs)
    const repaired = repairZstd(buf)
    return { buffer: repaired.bytes, cleanup: async () => {}, repaired: repaired.repaired, sqlite: false }
  }
  if (file.session && file.rel.endsWith('.jsonl')) {
    const buf = await readFile(file.abs)
    const repaired = repairJsonl(buf)
    return { buffer: repaired.bytes, cleanup: async () => {}, repaired: repaired.repaired, sqlite: false }
  }
  return { path: file.abs, cleanup: async () => {}, repaired: false, sqlite: false }
}

async function sealPieces(dataDir, pieces, dek) {
  const idKey = chunkIdKey(dek)
  const encKey = chunkEncKey(dek)
  const hash = createHash('sha256')
  const ids = []
  let stored = 0
  const unique = new Map()
  for (const piece of pieces) {
    hash.update(piece)
    const id = hmacChunkId(idKey, piece)
    if (!unique.has(id)) {
      const sealed = seal(encKey, piece)
      await putLocalChunk(dataDir, id, sealed)
      unique.set(id, padBlob(sealed).length)
      stored += sealed.length
    }
    ids.push(id)
  }
  return { ids, sha256: hash.digest('hex'), stored, unique }
}

async function piecesFromSource(source) {
  if (source.buffer) {
    const parts = chunkBuffer(source.buffer)
    return parts.length > 0 ? parts : [Buffer.alloc(0)]
  }
  const cdc = new CdcStream()
  const pieces = []
  const stream = createReadStream(source.path, { highWaterMark: 1024 * 1024 })
  for await (const block of stream) pieces.push(...cdc.push(block))
  pieces.push(...cdc.finish())
  if (pieces.length === 0) pieces.push(Buffer.alloc(0))
  return pieces
}

export async function createSnapshot(opts) {
  const dataDir = opts.dataDir
  const { dek } = opts.dek ? { dek: opts.dek } : await loadDek(dataDir)
  const includeCredentials = !!opts.includeCredentials
  const versions = await detectDshVersions({ dshHome: opts.dshHome, dshPrefix: opts.dshPrefix, env: opts.env })
  let files = [
    ...(await scanRoot(opts.dshHome, 'dsh', { includeCredentials })),
    ...(opts.agentsHome ? await scanRoot(opts.agentsHome, 'agents', { includeCredentials }) : []),
  ]
  if (typeof opts.select === 'function') files = files.filter((file) => opts.select(file))
  for (const extra of opts.extraFiles || []) {
    files.push({
      root: extra.root || 'dsh',
      rel: extra.rel,
      abs: extra.abs,
      bytes: extra.bytes,
      mtimeMs: extra.mtimeMs || Date.now(),
      mode: extra.mode || 0o600,
      size: extra.bytes ? extra.bytes.length : 0,
      sqlite: false,
      session: false,
    })
  }
  const entries = []
  const unique = new Map()
  const warnings = []
  for (const file of files) {
    const source = await readBackupSource(file)
    try {
      const pieces = await piecesFromSource(source)
      const sealed = await sealPieces(dataDir, pieces, dek)
      for (const [id, size] of sealed.unique) unique.set(id, size)
      const storedStat = source.buffer ? source.buffer.length : (await stat(source.path)).size
      entries.push({
        root: file.root,
        rel: file.rel,
        mtimeMs: file.mtimeMs,
        mode: file.mode,
        size: storedStat,
        chunks: sealed.ids,
        sha256: sealed.sha256,
        sqlite: file.sqlite,
        repaired: source.repaired,
      })
      if (source.repaired) {
        warnings.push({ rel: file.rel, zh: '已在快照里修掉截断的尾部', en: 'Truncated tail repaired inside the snapshot' })
      }
    } finally {
      await source.cleanup()
    }
  }
  const id = randomId('snap_')
  const createdAt = new Date().toISOString()
  const kind = opts.kind || 'manual'
  const tags = [...new Set([kind, ...(opts.tags || [])])]
  const manifest = {
    v: 1,
    id,
    createdAt,
    kind,
    tags,
    dshVersion: versions.dshVersion,
    dshBaseVersion: versions.dshBaseVersion,
    tool: 'undohaven',
    toolVersion: TOOL_VERSION,
    hostname: hostname(),
    platform: process.platform,
    includeCredentials,
    entries,
  }
  let plugins = null
  try {
    plugins = await collectPluginState(opts.dshHome)
    await savePluginState(dataDir, plugins)
  } catch {
    plugins = null
  }
  manifest.plugins = plugins
  const encrypted = padBlob(seal(manifestKey(dek), Buffer.from(JSON.stringify(manifest))))
  let bytes = encrypted.length
  for (const size of unique.values()) bytes += size
  const record = {
    id,
    createdAt,
    kind,
    tags,
    bytes,
    chunkCount: unique.size,
    fileCount: entries.length,
    dshVersion: versions.dshVersion,
    dshBaseVersion: versions.dshBaseVersion,
    includesCredentials: includeCredentials,
    encryptedManifest: b64(encrypted),
    chunkIds: [...unique.keys()],
    pinned: kind === 'pre-upgrade',
    cloud: false,
    plugins,
  }
  if (plugins) {
    try {
      const { notePluginPoints } = await import('./guard.js')
      await notePluginPoints(dataDir, id, plugins)
    } catch {
      /* the snapshot still has the plugin list if the history index cannot be written */
    }
  }
  await writeSnapshotRecord(dataDir, record)
  let cloudError = null
  if (opts.cloud) {
    try {
      await publishSnapshot(dataDir, record, opts.cloud)
    } catch (error) {
      cloudError = error
    }
  }
  return { ...record, warnings, cloudError, manifest }
}

export async function publishSnapshot(dataDir, record, cloud) {
  if (!cloud || record.cloud) return record
  if (record.includesCredentials) {
    const account = await cloud.account()
    if (!account.features?.credentialBackup) {
      throw new HouhuiError('credentials_not_allowed', '当前套餐不能备份凭据', 'This plan cannot back up credentials', { exitCode: 4 })
    }
  }
  const storage = await loadStorageConfig(dataDir)
  const byo = storage.mode === 's3' || storage.mode === 'dir'
  const created = byo
    ? await cloud.createSnapshot({
      id: record.id,
      createdAt: record.createdAt,
      kind: record.kind,
      bytes: record.bytes,
      chunkIds: [],
      byo: true,
      dshVersion: record.dshVersion,
      includesCredentials: !!record.includesCredentials,
      encryptedManifest: record.encryptedManifest,
      pinned: !!record.pinned,
    })
    : await (async () => {
      const missing = await cloud.missing(record.chunkIds || [])
      for (const chunkId of missing) {
        await cloud.uploadChunk(chunkId, await readPaddedChunk(dataDir, chunkId))
      }
      return cloud.createSnapshot({
        id: record.id,
        createdAt: record.createdAt,
        kind: record.kind,
        bytes: record.bytes,
        chunkIds: record.chunkIds,
        dshVersion: record.dshVersion,
        includesCredentials: !!record.includesCredentials,
        encryptedManifest: record.encryptedManifest,
        pinned: !!record.pinned,
      })
    })()
  record.pruned = Number(created?.pruned || 0)
  record.plan = created?.plan || null
  record.cloud = true
  await writeSnapshotRecord(dataDir, record)
  return record
}

export async function uploadPendingLocal(opts) {
  const records = await listSnapshotRecords(opts.dataDir)
  const uploaded = []
  for (const record of records) {
    if (record.cloud || record.includesCredentials) continue
    if (!(record.tags || []).includes('pre-change')) continue
    await publishSnapshot(opts.dataDir, record, opts.cloud)
    uploaded.push(record.id)
  }
  return uploaded
}

async function accountIsPro(cloud) {
  if (!cloud?.account) return false
  try {
    const account = await cloud.account()
    return account.plan === 'pro' || !!account.features?.guardRealtime || !!account.features?.machineMigration
  } catch {
    return false
  }
}

export function decryptManifest(record, dek) {
  const stored = unpadBlob(fromB64(record.encryptedManifest))
  const json = open(manifestKey(dek), stored).toString('utf8')
  return JSON.parse(json)
}

export async function listSnapshots(opts) {
  const local = await listSnapshotRecords(opts.dataDir)
  const byId = new Map(local.map((record) => [record.id, record]))
  if (opts.cloud) {
    try {
      const remote = await opts.cloud.listSnapshots()
      for (const item of remote) {
        const createdAt = typeof item.createdAt === 'number' ? new Date(item.createdAt).toISOString() : item.createdAt
        if (!byId.has(item.id)) {
          byId.set(item.id, {
            id: item.id,
            createdAt,
            kind: item.kind,
            bytes: item.bytes,
            chunkCount: item.chunkCount,
            encryptedManifest: item.encryptedManifest,
            pinned: !!item.pinned,
            cloud: true,
            remoteOnly: true,
            includesCredentials: !!item.includesCredentials,
            dshVersion: item.dshVersion,
          })
        } else {
          const row = byId.get(item.id)
          row.cloud = true
          row.pinned = row.pinned || !!item.pinned
          if (item.kind) row.kind = item.kind
        }
      }
    } catch (error) {
      if (!opts.allowCloudFailure) throw error
    }
  }
  let dek = opts.dek ?? null
  if (!dek) {
    try {
      dek = (await loadDek(opts.dataDir)).dek
    } catch {
      dek = null
    }
  }
  const rows = [...byId.values()].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
  return rows.map((record) => {
    let manifest = null
    if (dek && record.encryptedManifest) {
      try {
        manifest = decryptManifest(record, dek)
      } catch {
        manifest = null
      }
    }
    return {
      id: record.id,
      createdAt: record.createdAt,
      kind: manifest?.kind || record.kind,
      bytes: record.bytes,
      tags: manifest?.tags || record.tags || [],
      dshVersion: manifest?.dshVersion || record.dshVersion || null,
      dshBaseVersion: manifest?.dshBaseVersion || record.dshBaseVersion || null,
      files: manifest?.entries?.length ?? record.fileCount ?? null,
      pinned: !!(record.pinned || manifest?.kind === 'pre-upgrade'),
      cloud: !!record.cloud,
      remoteOnly: !!record.remoteOnly,
      locked: !manifest,
    }
  })
}

async function materializeRecord(opts, id, purpose) {
  let record = await readSnapshotRecord(opts.dataDir, id)
  if ((!record || !record.encryptedManifest) && opts.cloud) {
    const remote = await opts.cloud.getSnapshot(id, purpose)
    record = {
      id: remote.id,
      createdAt: typeof remote.createdAt === 'number' ? new Date(remote.createdAt).toISOString() : remote.createdAt,
      kind: remote.kind,
      bytes: remote.bytes,
      encryptedManifest: remote.encryptedManifest,
      chunkIds: remote.chunkIds,
      pinned: !!remote.pinned,
      cloud: true,
      includesCredentials: !!remote.includesCredentials,
    }
    await writeSnapshotRecord(opts.dataDir, record)
  }
  if (!record?.encryptedManifest) {
    throw new HouhuiError('snapshot_missing', `没有快照 ${id}`, `Snapshot ${id} was not found`)
  }
  const dek = opts.dek || (await loadDek(opts.dataDir)).dek
  const manifest = decryptManifest(record, dek)
  const needed = [...new Set(manifest.entries.flatMap((entry) => entry.chunks))]
  for (const chunkId of needed) {
    if (await hasLocalChunk(opts.dataDir, chunkId)) continue
    if (!opts.cloud) {
      throw new HouhuiError('chunk_missing', `本地缺少分块 ${chunkId}`, `Local chunk store is missing ${chunkId}`)
    }
    const bytes = await opts.cloud.downloadChunk(chunkId, purpose)
    await putLocalChunk(opts.dataDir, chunkId, bytes)
  }
  return { record, manifest, dek }
}

async function readPlain(dataDir, entry, dek) {
  const encKey = chunkEncKey(dek)
  const idKey = chunkIdKey(dek)
  const parts = []
  for (const chunkId of entry.chunks) {
    const plain = open(encKey, await readLocalChunk(dataDir, chunkId))
    if (hmacChunkId(idKey, plain) !== chunkId) {
      throw new HouhuiError('chunk_mismatch', `分块 ${chunkId} 和内容对不上`, `Chunk ${chunkId} does not match its plaintext`)
    }
    parts.push(plain)
  }
  const bytes = Buffer.concat(parts)
  if (sha256(bytes) !== entry.sha256) {
    throw new HouhuiError('checksum_mismatch', `文件校验失败：${entry.rel}`, `Checksum mismatch for ${entry.rel}`)
  }
  return bytes
}

async function writeEntry(dataDir, entry, dek, roots) {
  const encKey = chunkEncKey(dek)
  const idKey = chunkIdKey(dek)
  const parts = []
  for (const chunkId of entry.chunks) {
    const plain = open(encKey, await readLocalChunk(dataDir, chunkId))
    if (hmacChunkId(idKey, plain) !== chunkId) {
      throw new HouhuiError('chunk_mismatch', `分块 ${chunkId} 和内容对不上`, `Chunk ${chunkId} does not match its plaintext`)
    }
    parts.push(plain)
  }
  const bytes = Buffer.concat(parts)
  if (sha256(bytes) !== entry.sha256) {
    throw new HouhuiError('checksum_mismatch', `文件校验失败：${entry.rel}`, `Checksum mismatch for ${entry.rel}`)
  }
  const root = entry.root === 'agents' ? roots.agents : roots.dsh
  if (!root) return
  const abs = safeJoin(root, entry.rel)
  await mkdir(dirname(abs), { recursive: true })
  const tmp = `${abs}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`
  const { writeFile, rename, chmod } = await import('node:fs/promises')
  await writeFile(tmp, bytes)
  await rename(tmp, abs)
  try {
    await chmod(abs, entry.mode & 0o777)
  } catch {
    /* platform may reject the mode */
  }
  const when = new Date(entry.mtimeMs)
  try {
    await utimes(abs, when, when)
  } catch {
    /* best effort */
  }
  if (entry.sqlite) {
    await rm(`${abs}-wal`, { force: true })
    await rm(`${abs}-shm`, { force: true })
  }
}

async function deleteExtras(roots, manifestEntries, scope) {
  const wanted = new Set(manifestEntries.filter((entry) => inScope(entry, scope)).map((entry) => `${entry.root}:${entry.rel}`))
  const current = [
    ...(await scanRoot(roots.dsh, 'dsh', { includeCredentials: false })),
    ...(roots.agents ? await scanRoot(roots.agents, 'agents', { includeCredentials: false }) : []),
  ]
  for (const file of current) {
    if (!inScope(file, scope)) continue
    if (wanted.has(`${file.root}:${file.rel}`)) continue
    await rm(file.abs, { force: true })
  }
}

export async function restoreSnapshot(opts) {
  const scope = opts.scope || 'all'
  if (scope === 'session' && !/^[\w.-]{1,128}$/.test(opts.session || '')) {
    throw new HouhuiError('need_session', '请提供会话编号', 'Pass a session id')
  }
  if (!opts.skipLockCheck) await assertDshStopped(opts.dshHome, opts.env)
  const purpose = opts.purpose
  let safety = null
  const present = await scanRoot(opts.dshHome, 'dsh', { includeCredentials: false })
  if (present.length > 0 && !opts.skipSafety) {
    safety = await createSnapshot({
      ...opts,
      kind: 'safety',
      tags: ['safety', 'before-restore'],
      includeCredentials: false,
      select: undefined,
      extraFiles: undefined,
    })
    if (safety.cloudError && opts.cloud) {
      /* local safety snapshot still exists; cloud failure is reported */
    }
  }
  const { manifest, dek } = await materializeRecord(opts, opts.id, purpose)
  if (scope === 'tasks') {
    const entry = manifest.entries.find((item) => inScope(item, 'tasks'))
    if (!entry) {
      throw new HouhuiError('no_tasks', '这份快照里没有定时任务', 'This snapshot has no scheduled tasks')
    }
    const saved = JSON.parse((await readPlain(opts.dataDir, entry, dek)).toString('utf8'))
    const { mergeScheduleDocument } = await import('./items.js')
    const merged = await mergeScheduleDocument(opts.dshHome, saved)
    return {
      id: manifest.id,
      files: 1,
      scope,
      tasks: merged.restored,
      safetyId: safety?.id ?? null,
      safetyCloudError: safety?.cloudError ?? null,
      compat: [],
    }
  }
  const selected = manifest.entries.filter((entry) => inScope(entry, scope, opts))
  if (scope === 'session' && selected.length === 0) {
    throw new HouhuiError('no_session', '这份快照里没有这个会话', `This snapshot has no session ${opts.session}`)
  }
  if (scope !== 'session') {
    await deleteExtras({ dsh: opts.dshHome, agents: opts.agentsHome }, manifest.entries, scope)
  }
  for (const entry of selected) {
    await writeEntry(opts.dataDir, entry, dek, { dsh: opts.dshHome, agents: opts.agentsHome })
  }
  let listed = []
  if (scope === 'session') {
    const workspace = manifest.entries.find((entry) => entry.root === 'dsh' && entry.rel === 'storages/workspace.json')
    if (workspace) {
      const saved = JSON.parse((await readPlain(opts.dataDir, workspace, dek)).toString('utf8'))
      const { mergeSessionListing } = await import('./items.js')
      listed = await mergeSessionListing(opts.dshHome, saved, opts.session)
    }
  }
  let compat = []
  if (scope === 'all' || scope === 'config') {
    compat = await stripRemovedWorkingDirectoryTool(opts.dshHome)
  }
  return {
    id: manifest.id,
    files: selected.length,
    scope,
    session: opts.session || null,
    listed,
    safetyId: safety?.id ?? null,
    safetyCloudError: safety?.cloudError ?? null,
    compat,
  }
}

export async function pinSnapshot(opts, id) {
  const { dek } = opts.dek ? { dek: opts.dek } : await loadDek(opts.dataDir)
  let record = await readSnapshotRecord(opts.dataDir, id)
  if (!record && opts.cloud) {
    const remote = await opts.cloud.getSnapshot(id)
    record = {
      id: remote.id,
      createdAt: typeof remote.createdAt === 'number' ? new Date(remote.createdAt).toISOString() : remote.createdAt,
      kind: remote.kind,
      bytes: remote.bytes,
      encryptedManifest: remote.encryptedManifest,
      chunkIds: remote.chunkIds,
      cloud: true,
    }
  }
  if (!record) throw new HouhuiError('snapshot_missing', `没有快照 ${id}`, `Snapshot ${id} was not found`)
  const manifest = decryptManifest(record, dek)
  if (!manifest.tags.includes('pre-upgrade')) manifest.tags.push('pre-upgrade')
  manifest.kind = 'pre-upgrade'
  record.kind = 'pre-upgrade'
  record.tags = manifest.tags
  record.pinned = true
  record.encryptedManifest = b64(padBlob(seal(manifestKey(dek), Buffer.from(JSON.stringify(manifest)))))
  await writeSnapshotRecord(opts.dataDir, record)
  if (opts.cloud) {
    await opts.cloud.pinSnapshot(id, {
      op: 'pin',
      kind: 'pre-upgrade',
      encryptedManifest: record.encryptedManifest,
    })
    record.cloud = true
    await writeSnapshotRecord(opts.dataDir, record)
  }
  const state = await loadState(opts.dataDir)
  state.pins = state.pins || {}
  if (manifest.dshBaseVersion) state.pins[manifest.dshBaseVersion] = id
  await saveState(opts.dataDir, state)
  return record
}

export async function onRuntimeStart(opts) {
  const versions = await detectDshVersions({ dshHome: opts.dshHome, dshPrefix: opts.dshPrefix, env: opts.env })
  const state = await loadState(opts.dataDir)
  const previousBaseVersion = state.lastBaseVersion || null
  const previousDshVersion = state.lastDshVersion || null
  let prechange = null
  try {
    const { captureStorageChanges } = await import('./watch.js')
    prechange = await captureStorageChanges({ ...opts, cloud: null, includeCredentials: false })
  } catch {
    prechange = null
  }
  let pinned = null
  let versionSnapshot = null
  if (state.lastBaseVersion && state.lastBaseVersion !== versions.dshBaseVersion) {
    const rows = await listSnapshots({ dataDir: opts.dataDir, cloud: opts.cloud, dek: opts.dek, allowCloudFailure: true })
    const previous = rows.filter((row) => row.dshBaseVersion === state.lastBaseVersion)
    const target = previous.at(-1)
    if (target && target.kind !== 'pre-upgrade') pinned = await pinSnapshot(opts, target.id)
    else if (target) pinned = target
    const paid = (await accountIsPro(opts.cloud)) ? opts.cloud : null
    versionSnapshot = await createSnapshot({
      ...opts,
      cloud: paid,
      kind: 'pre-upgrade',
      tags: ['startup', 'version-change', state.lastBaseVersion || ''],
      includeCredentials: false,
      select: (file) => isWatchedStorage(file.rel),
    })
  }
  const today = new Date().toISOString().slice(0, 10)
  const rows = await listSnapshots({ dataDir: opts.dataDir, dek: opts.dek, allowCloudFailure: true })
  const hasDaily = rows.some((row) => row.kind === 'daily' && String(row.createdAt).startsWith(today))
  const kind = opts.kind || (hasDaily ? 'rolling' : 'daily')
  const snapshot = await createSnapshot({ ...opts, kind, tags: ['startup', kind] })
  const runtimeChanged = Boolean(
    (previousBaseVersion && previousBaseVersion !== versions.dshBaseVersion)
    || (previousDshVersion && previousDshVersion !== versions.dshVersion),
  )
  state.lastBaseVersion = versions.dshBaseVersion
  state.lastDshVersion = versions.dshVersion
  await saveState(opts.dataDir, state)
  return { snapshot, pinned, versions, versionSnapshot, prechange, previousBaseVersion, previousDshVersion, runtimeChanged }
}

export async function exportArchive(file, opts) {
  const snap = await createSnapshot({ ...opts, cloud: null, kind: opts.kind || 'manual', tags: ['export'] })
  const keys = opts.keys
  if (!keys?.wrappedDek) {
    throw new HouhuiError('no_keys', '导出前需要本地密钥', 'Local keys are required before export')
  }
  const chunkIds = snap.chunkIds
  const blobs = []
  const listed = []
  let cursor = 0
  for (const chunkId of chunkIds) {
    const bytes = await readLocalChunk(opts.dataDir, chunkId)
    listed.push({ id: chunkId, offset: cursor, length: bytes.length })
    blobs.push(bytes)
    cursor += bytes.length
  }
  const header = {
    v: 1,
    id: snap.id,
    salt: b64(keys.salt),
    kdf: keys.kdf,
    wrappedDek: b64(keys.wrappedDek),
    wrappedDekRecovery: b64(keys.wrappedDekRecovery),
    encryptedManifest: snap.encryptedManifest,
    chunks: listed,
  }
  const headerBytes = Buffer.from(JSON.stringify(header))
  const len = Buffer.alloc(4)
  len.writeUInt32LE(headerBytes.length)
  await mkdir(dirname(file), { recursive: true })
  const { writeFile } = await import('node:fs/promises')
  await writeFile(file, Buffer.concat([EXPORT_MAGIC, len, headerBytes, ...blobs]), { mode: 0o600 })
  return { id: snap.id, file, bytes: snap.bytes }
}

export async function readArchive(file) {
  const buf = await readFile(file)
  if (!buf.subarray(0, 4).equals(EXPORT_MAGIC)) {
    throw new HouhuiError('bad_export', '这不是 UndoHaven 导出文件', 'This is not an UndoHaven export file')
  }
  const headerLen = buf.readUInt32LE(4)
  const header = JSON.parse(buf.subarray(8, 8 + headerLen).toString('utf8'))
  const body = buf.subarray(8 + headerLen)
  return { header, body }
}

export async function importArchive(file, opts) {
  const { header, body } = await readArchive(file)
  for (const chunk of header.chunks) {
    const bytes = body.subarray(chunk.offset, chunk.offset + chunk.length)
    await putLocalChunk(opts.dataDir, chunk.id, bytes)
  }
  const record = {
    id: header.id,
    createdAt: new Date().toISOString(),
    kind: 'manual',
    tags: ['export'],
    bytes: body.length,
    encryptedManifest: header.encryptedManifest,
    chunkIds: header.chunks.map((chunk) => chunk.id),
    cloud: false,
    pinned: false,
  }
  await writeSnapshotRecord(opts.dataDir, record)
  return { header, record }
}

const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.]+)?$/

export async function upgradeRuntime(version, opts) {
  if (!VERSION_RE.test(version)) {
    throw new HouhuiError('bad_version', '版本号不合法', `Version ${version} is not a safe version string`)
  }
  const snapshot = await createSnapshot({ ...opts, kind: 'pre-upgrade', tags: ['upgrade', version] })
  const npm = opts.env?.UNDOHAVEN_NPM || process.env.UNDOHAVEN_NPM || 'npm'
  try {
    await runProcess(npm, ['install', '-g', `@deepseek-ai/dsh@${version}`], { stdio: opts.stdio ?? 'inherit' })
  } catch (error) {
    throw new HouhuiError(
      'upgrade_failed',
      `安装 @deepseek-ai/dsh@${version} 失败。升级前快照是 ${snapshot.id}`,
      `Installing @deepseek-ai/dsh@${version} failed. The pre-upgrade snapshot is ${snapshot.id}. ${error.message}`,
    )
  }
  return snapshot
}

export async function reinstallProfiles(dshHome, env = process.env) {
  const root = join(dshHome, 'profiles')
  let names = []
  try {
    names = await readdir(root)
  } catch {
    return []
  }
  const ran = []
  for (const name of names) {
    const dir = join(root, name)
    let st
    try {
      st = await stat(dir)
    } catch {
      continue
    }
    if (!st.isDirectory()) continue
    if (await exists(join(dir, 'pnpm-lock.yaml'))) {
      const cmd = env.UNDOHAVEN_PNPM || 'pnpm'
      await runProcess(cmd, ['install', '--frozen-lockfile'], { cwd: dir, stdio: 'inherit' })
      ran.push({ profile: name, tool: 'pnpm' })
    } else if (await exists(join(dir, 'package.json'))) {
      const cmd = env.UNDOHAVEN_NPM || 'npm'
      await runProcess(cmd, ['install'], { cwd: dir, stdio: 'inherit' })
      ran.push({ profile: name, tool: 'npm' })
    }
  }
  return ran
}

export async function migrateMachine(opts) {
  if (!opts.cloud) {
    throw new HouhuiError('login_required', '迁移机器需要先登录', 'Machine migration requires login')
  }
  await opts.cloud.migrationGrant()
  const restored = await restoreSnapshot({ ...opts, purpose: 'migrate', scope: opts.scope || 'all' })
  const reinstalled = await reinstallProfiles(opts.dshHome, opts.env)
  return { restored, reinstalled }
}

export { bi }
