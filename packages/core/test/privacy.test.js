import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { b64, fromB64 } from '../src/crypto.js'
import { decryptManifest, createSnapshot, establishKeys, listSnapshots, restoreSnapshot, unpadBlob } from '../src/index.js'
import { loadKeyFile } from '../src/keys.js'
import { assertDshStopped, collectLockFiles } from '../src/lock.js'
import { doctor } from '../src/doctor.js'
import { saveStorageConfig } from '../src/byo.js'
import { classifyDsh, escapesTree, scanRoot } from '../src/scan.js'
import { readSnapshotRecord } from '../src/store.js'

const PASS = 'correct horse battery'

async function listen(host) {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, host, resolve)
  })
  return server
}

test('a BYO record keeps only the sealed index and still reads the old shape', async () => {
  const root = await mkdtemp(join(tmpdir(), 'uh-byo-'))
  const dsh = join(root, 'dsh')
  const data = join(root, 'data')
  const bucket = join(root, 'bucket')
  const skill = join(dsh, 'skills', 'SKILL.md')
  await mkdir(join(dsh, 'skills'), { recursive: true })
  await writeFile(skill, 'keep-local')
  await establishKeys(data, PASS)
  await saveStorageConfig(data, { mode: 'dir', dir: bucket })
  const keys = await loadKeyFile(data)
  const seen = []
  const uploaded = []
  const cloud = {
    account: async () => ({ plan: 'pro', features: {} }),
    missing: async (ids) => ids,
    uploadChunk: async (_id, bytes) => uploaded.push(bytes.length),
    createSnapshot: async (body) => {
      seen.push(body)
      return { pruned: 0, plan: 'pro' }
    },
  }
  const snap = await createSnapshot({
    dataDir: data,
    dshHome: dsh,
    agentsHome: join(root, 'agents'),
    dek: keys.dek,
    cloud,
  })
  const remote = JSON.parse(await readFile(join(bucket, 'snapshots', `${snap.id}.json`), 'utf8'))
  assert.deepEqual(Object.keys(remote).sort(), ['chunkIds', 'createdAt', 'encryptedManifest', 'id'])
  assert.equal(remote.plugins, undefined)
  assert.equal(remote.fileCount, undefined)
  const stored = fromB64(remote.encryptedManifest)
  assert.equal(stored.subarray(0, 4).toString(), 'UHVP')
  assert.equal(stored.length % (64 * 1024), 0)
  assert.equal(snap.bytes % (64 * 1024), 0)
  assert.equal(seen[0].bytes, snap.bytes)
  assert.ok(seen[0].bytes > stored.length)
  assert.equal(uploaded.length, 0)
  await saveStorageConfig(data, { mode: 'local' })
  const hosted = []
  let hostedBody = null
  const second = await createSnapshot({
    dataDir: data,
    dshHome: dsh,
    agentsHome: join(root, 'agents'),
    dek: keys.dek,
    cloud: {
      missing: async (ids) => ids,
      uploadChunk: async (_id, bytes) => hosted.push(bytes.length),
      createSnapshot: async (body) => {
        hostedBody = body
        return {}
      },
    },
  })
  const hostedManifest = fromB64(second.encryptedManifest).length
  assert.equal(hosted.length > 0, true)
  assert.equal(hosted.every((size) => size % (64 * 1024) === 0), true)
  assert.equal(hostedBody.bytes, hostedManifest + hosted.reduce((sum, size) => sum + size, 0))
  await saveStorageConfig(data, { mode: 'dir', dir: bucket })
  const manifest = decryptManifest(snap, keys.dek)
  assert.ok('plugins' in manifest)
  const legacy = {
    id: snap.id,
    createdAt: snap.createdAt,
    kind: 'manual',
    plugins: [{ name: 'kept-from-old-record' }],
    fileCount: manifest.entries.length,
    bytes: 12,
    chunkIds: remote.chunkIds,
    encryptedManifest: b64(unpadBlob(stored)),
  }
  await writeFile(join(bucket, 'snapshots', `${snap.id}.json`), JSON.stringify(legacy))
  await rm(join(data, 'snapshots', `${snap.id}.json`))
  const loaded = await readSnapshotRecord(data, snap.id)
  assert.equal(loaded.plugins[0].name, 'kept-from-old-record')
  assert.equal(decryptManifest(loaded, keys.dek).entries.length, manifest.entries.length)
  const rows = await listSnapshots({ dataDir: data, dek: keys.dek, cloud: null })
  assert.equal(rows.find((row) => row.id === snap.id).files, manifest.entries.length)
  await writeFile(skill, 'gone')
  await restoreSnapshot({
    dataDir: data,
    dshHome: dsh,
    agentsHome: join(root, 'agents'),
    id: snap.id,
    dek: keys.dek,
    skipLockCheck: true,
    skipSafety: true,
    cloud: null,
  })
  assert.equal(await readFile(skill, 'utf8'), 'keep-local')
  await rm(root, { recursive: true, force: true })
})

test('lock walk does not follow a linked directory and doctor checks loopback ports', async () => {
  const root = await mkdtemp(join(tmpdir(), 'uh-lock-'))
  const dsh = join(root, 'dsh')
  const outside = join(root, 'outside', 'nested')
  await mkdir(join(dsh, 'sessions'), { recursive: true })
  await mkdir(outside, { recursive: true })
  await writeFile(join(outside, 'session.lock'), 'held')
  await symlink(join(root, 'outside'), join(dsh, 'sessions', 'linked'), 'dir')
  const locks = await collectLockFiles(dsh)
  assert.equal(locks.some((file) => file.includes('outside') || file.includes('linked')), false)
  const stopped = await assertDshStopped(dsh, {})
  assert.equal(stopped.running, false)

  const v4 = await listen('127.0.0.1')
  const port = v4.address().port
  const report = await doctor(dsh, { UNDOHAVEN_DSH_PORT: String(port) })
  assert.ok(report.findings.some((item) => item.code === 'dsh_running' && item.path === `127.0.0.1:${port}`))
  v4.close()

  let v6 = null
  try {
    v6 = await listen('::1')
  } catch {
    v6 = null
  }
  if (v6) {
    const v6port = v6.address().port
    const again = await doctor(dsh, { UNDOHAVEN_DSH_PORT: String(v6port) })
    assert.ok(again.findings.some((item) => item.code === 'dsh_running' && item.path === `::1:${v6port}`))
    v6.close()
  }
  await rm(root, { recursive: true, force: true })
})

test('escapesTree requires the child realpath to be the parent plus its name', async () => {
  const root = await mkdtemp(join(tmpdir(), 'uh-escape-'))
  const parent = join(root, 'parent')
  const outside = join(root, 'outside')
  await mkdir(join(parent, 'child'), { recursive: true })
  await mkdir(outside, { recursive: true })
  assert.equal(await escapesTree(parent, join(parent, 'child')), false)
  await symlink(outside, join(parent, 'link'), 'dir')
  assert.equal(await escapesTree(parent, join(parent, 'link')), true)
  await rm(root, { recursive: true, force: true })
})

test('auth.json, key files, and private keys stay out even when credentials are included', async () => {
  assert.equal(classifyDsh('skills/auth.json', { includeCredentials: true }), 'exclude')
  assert.equal(classifyDsh('skills/id_rsa', { includeCredentials: true }), 'exclude')
  assert.equal(classifyDsh('skills/id_ed25519', { includeCredentials: true }), 'exclude')
  assert.equal(classifyDsh('skills/tls.pem', { includeCredentials: true }), 'exclude')
  assert.equal(classifyDsh('skills/device.key', { includeCredentials: true }), 'exclude')
  assert.equal(classifyDsh('.env', { includeCredentials: true }), 'include')
  assert.equal(classifyDsh('.credentials.yaml', { includeCredentials: false }), 'exclude')
  const root = await mkdtemp(join(tmpdir(), 'uh-cred-'))
  const dsh = join(root, 'dsh')
  await mkdir(join(dsh, 'skills'), { recursive: true })
  await writeFile(join(dsh, 'skills', 'auth.json'), '{}')
  await writeFile(join(dsh, 'skills', 'id_rsa'), 'private')
  await writeFile(join(dsh, 'skills', 'ok.md'), 'keep')
  const files = await scanRoot(dsh, 'dsh', { includeCredentials: true })
  const rels = files.map((file) => file.rel)
  assert.deepEqual(rels, ['skills/ok.md'])
  await rm(root, { recursive: true, force: true })
})
