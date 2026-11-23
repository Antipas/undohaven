import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  captureStorageChanges,
  createSnapshot,
  establishKeys,
  listSnapshots,
  onRuntimeStart,
  restoreSnapshot,
  uploadPendingLocal,
  watchStorages,
} from '../src/index.js'

const PASSPHRASE = 'correct horse battery'

function schedule(tasks) {
  return `${JSON.stringify({ unit: { name: 'schedule', version: 2 }, tables: { tasks } })}\n`
}

function task(id, sessionId) {
  return {
    target: { kind: 'session', sessionId },
    status: 'active',
    record: { id, title: id, prompt: 'remind-the-owner' },
  }
}

async function tree() {
  const root = await mkdtemp(join(tmpdir(), 'hhy-watch-'))
  const dsh = join(root, 'dsh')
  const data = join(root, 'data')
  await mkdir(join(dsh, 'storages'), { recursive: true })
  await mkdir(join(dsh, 'skills', 'demo'), { recursive: true })
  await writeFile(join(dsh, 'skills', 'demo', 'SKILL.md'), 'skill-body')
  const keys = await establishKeys(data, PASSPHRASE)
  return { root, dsh, data, dek: keys.dek }
}

async function plaintext(dir) {
  const parts = []
  async function walk(path) {
    let names = []
    try { names = await readdir(path, { withFileTypes: true }) } catch { return }
    for (const name of names) {
      const abs = join(path, name.name)
      if (name.isDirectory()) await walk(abs)
      else parts.push(await readFile(abs))
    }
  }
  await walk(dir)
  return Buffer.concat(parts).toString('utf8')
}

test('a storage change keeps the previous json locally and leaves secrets out', async () => {
  const { root, dsh, data, dek } = await tree()
  const file = join(dsh, 'storages', 'schedule.json')
  await writeFile(file, schedule({ a: task('a', 'sess-a'), b: task('b', 'sess-b') }))
  await writeFile(join(dsh, 'storages', '.env'), 'SECRET_TOKEN=do-not-copy\n')
  await writeFile(join(dsh, 'storages', 'auth.json'), '{"token":"plain-secret"}\n')
  await writeFile(join(dsh, 'storages', 'id_rsa.pem'), 'KEYMATERIAL\n')
  const seeded = await captureStorageChanges({ dataDir: data, dshHome: dsh, dek })
  assert.equal(seeded.snapshot, null)
  assert.equal(seeded.seeded, true)
  const mirror = await readFile(join(data, 'storage-mirror.json'), 'utf8')
  assert.equal(mirror.includes('remind-the-owner'), false)
  assert.equal(mirror.includes('SECRET_TOKEN'), false)
  assert.equal(mirror.includes('plain-secret'), false)
  await writeFile(file, '{')
  const torn = await captureStorageChanges({ dataDir: data, dshHome: dsh, dek })
  assert.equal(torn.snapshot, null)
  await writeFile(file, schedule({ b: task('b', 'sess-b'), c: task('c', 'sess-c') }))
  const changed = await captureStorageChanges({ dataDir: data, dshHome: dsh, dek, cloud: { createSnapshot() { throw new Error('free upload') } } })
  assert.equal(changed.snapshot.cloud, false)
  assert.equal(changed.snapshot.includesCredentials, false)
  assert.ok(changed.snapshot.tags.includes('pre-change'))
  assert.deepEqual(changed.snapshot.manifest.entries.map((entry) => entry.rel), ['storages/schedule.json'])
  const stored = await plaintext(data)
  assert.equal(stored.includes('SECRET_TOKEN'), false)
  assert.equal(stored.includes('plain-secret'), false)
  assert.equal(stored.includes('KEYMATERIAL'), false)
  const restored = await restoreSnapshot({
    dataDir: data,
    dshHome: dsh,
    dek,
    id: changed.snapshot.id,
    scope: 'tasks',
    skipLockCheck: true,
    skipSafety: true,
  })
  assert.deepEqual(restored.tasks.sort(), ['a', 'b'])
  const live = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(live.tables.tasks.a.record.id, 'a')
  assert.equal(live.tables.tasks.c.record.id, 'c')
  assert.equal(live.tables.tasks.b.target.sessionId, 'sess-b')
  await rm(root, { recursive: true, force: true })
})

test('the watcher notices a rewrite without a session-stop event', async () => {
  const { root, dsh, data, dek } = await tree()
  const file = join(dsh, 'storages', 'schedule.json')
  await writeFile(file, schedule({ a: task('a', 'sess-a') }))
  const handle = watchStorages({ dataDir: data, dshHome: dsh, dek, pollMs: 30 })
  await new Promise((resolve) => setTimeout(resolve, 80))
  await writeFile(file, schedule({}))
  let found = null
  for (let i = 0; i < 20 && !found; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 40))
    const rows = await listSnapshots({ dataDir: data, dek })
    found = rows.find((row) => (row.tags || []).includes('pre-change'))
  }
  handle.stop()
  assert.ok(found)
  assert.equal(found.kind, 'safety')
  await rm(root, { recursive: true, force: true })
})

test('a version change snapshots storage json only, and pro uploads the local copy later', async () => {
  const { root, dsh, data, dek } = await tree()
  await writeFile(join(dsh, 'storages', 'schedule.json'), schedule({ a: task('a', 'sess-a') }))
  await writeFile(join(dsh, 'storages', 'auth.json'), '{"token":"plain-secret"}\n')
  const env = { UNDOHAVEN_DSH_BASE_VERSION: '0.2.2-rc.3' }
  await onRuntimeStart({ dataDir: data, dshHome: dsh, dek, env })
  env.UNDOHAVEN_DSH_BASE_VERSION = '0.2.2-rc.5'
  const started = await onRuntimeStart({ dataDir: data, dshHome: dsh, dek, env })
  assert.equal(started.versionSnapshot.kind, 'pre-upgrade')
  assert.equal(started.versionSnapshot.includesCredentials, false)
  assert.equal(started.versionSnapshot.cloud, false)
  const rels = started.versionSnapshot.manifest.entries.map((entry) => entry.rel)
  assert.ok(rels.includes('storages/schedule.json'))
  assert.equal(rels.includes('storages/auth.json'), false)
  assert.equal(rels.some((rel) => rel.startsWith('skills/')), false)
  await writeFile(join(dsh, 'storages', 'schedule.json'), schedule({}))
  const changed = await captureStorageChanges({ dataDir: data, dshHome: dsh, dek })
  const uploaded = []
  const cloud = {
    async missing(ids) { return ids },
    async uploadChunk() {},
    async createSnapshot(body) { uploaded.push(body); return body },
  }
  const ids = await uploadPendingLocal({ dataDir: data, cloud })
  assert.deepEqual(ids, [changed.snapshot.id])
  assert.equal(uploaded[0].includesCredentials, false)
  assert.equal(uploaded[0].kind, 'safety')
  const again = await uploadPendingLocal({ dataDir: data, cloud })
  assert.deepEqual(again, [])
  await rm(root, { recursive: true, force: true })
})

test('restore can put one session back and leave the other session alone', async () => {
  const { root, dsh, data, dek } = await tree()
  await mkdir(join(dsh, 'sessions', 'proj', 'sess-a'), { recursive: true })
  await mkdir(join(dsh, 'sessions', 'proj', 'keep-me'), { recursive: true })
  await writeFile(join(dsh, 'sessions', 'proj', 'sess-a', 'session.v3.jsonl'), 'alpha-session\n')
  await writeFile(join(dsh, 'sessions', 'proj', 'keep-me', 'session.v3.jsonl'), 'keep-session\n')
  await writeFile(join(dsh, 'storages', 'workspace.json'), JSON.stringify({
    unit: { name: 'workspace', version: 2 },
    tables: { workspaces: { ws1: { sessionIds: ['sess-a', 'keep-me'], archivedSessionIds: [] } } },
  }))
  const snap = await createSnapshot({ dataDir: data, dshHome: dsh, dek, kind: 'manual', includeCredentials: false })
  await rm(join(dsh, 'sessions', 'proj', 'sess-a'), { recursive: true, force: true })
  await writeFile(join(dsh, 'sessions', 'proj', 'keep-me', 'session.v3.jsonl'), 'changed-session\n')
  await writeFile(join(dsh, 'storages', 'workspace.json'), JSON.stringify({
    unit: { name: 'workspace', version: 2 },
    tables: { workspaces: { ws1: { sessionIds: ['keep-me'], archivedSessionIds: ['sess-a'] } } },
  }))
  const restored = await restoreSnapshot({
    dataDir: data,
    dshHome: dsh,
    dek,
    id: snap.id,
    scope: 'session',
    session: 'sess-a',
    skipLockCheck: true,
    skipSafety: true,
  })
  assert.equal(restored.files, 1)
  assert.deepEqual(restored.listed, ['ws1'])
  assert.equal(await readFile(join(dsh, 'sessions', 'proj', 'sess-a', 'session.v3.jsonl'), 'utf8'), 'alpha-session\n')
  assert.equal(await readFile(join(dsh, 'sessions', 'proj', 'keep-me', 'session.v3.jsonl'), 'utf8'), 'changed-session\n')
  const workspace = JSON.parse(await readFile(join(dsh, 'storages', 'workspace.json'), 'utf8'))
  assert.ok(workspace.tables.workspaces.ws1.sessionIds.includes('sess-a'))
  assert.equal(workspace.tables.workspaces.ws1.archivedSessionIds.includes('sess-a'), false)
  assert.ok(workspace.tables.workspaces.ws1.sessionIds.includes('keep-me'))
  await rm(root, { recursive: true, force: true })
})
