import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  createSnapshot,
  establishKeys,
  loadStorageConfig,
  padBlob,
  restoreSnapshot,
  saveStorageConfig,
  unpadBlob,
} from '../src/index.js'
import { runCli } from '../../../test/harness.js'

const PASS = 'correct horse battery'

async function tinyHome(root) {
  const dsh = join(root, 'dsh')
  const agents = join(root, 'agents')
  const data = join(dsh, 'undohaven')
  await mkdir(join(dsh, 'skills'), { recursive: true })
  await mkdir(agents, { recursive: true })
  await writeFile(join(dsh, 'skills', 'SKILL.md'), 'keep-local')
  return { dsh, agents, data }
}

test('chunk padding hides the exact plaintext length', () => {
  const padded = padBlob(Buffer.from('abc'))
  assert.equal(padded.length % (64 * 1024), 0)
  assert.deepEqual(unpadBlob(padded), Buffer.from('abc'))
})

test('directory storage restores without our cloud', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hhy-dir-'))
  const { dsh, agents, data } = await tinyHome(root)
  const bucket = join(root, 'nas')
  await establishKeys(data, PASS)
  await saveStorageConfig(data, { mode: 'dir', dir: bucket })
  const keys = await (await import('../src/keys.js')).loadKeyFile(data)
  const snap = await createSnapshot({ dataDir: data, dshHome: dsh, agentsHome: agents, dek: keys.dek, cloud: null })
  assert.equal(await readFile(join(bucket, 'snapshots', `${snap.id}.json`), 'utf8').then((text) => JSON.parse(text).id), snap.id)
  await writeFile(join(dsh, 'skills', 'SKILL.md'), 'gone')
  await rm(join(data, 'chunks'), { recursive: true, force: true })
  await restoreSnapshot({ dataDir: data, dshHome: dsh, agentsHome: agents, id: snap.id, dek: keys.dek, skipLockCheck: true, skipSafety: true, cloud: null })
  assert.equal(await readFile(join(dsh, 'skills', 'SKILL.md'), 'utf8'), 'keep-local')
  await rm(root, { recursive: true, force: true })
})

test('offline CLI restore needs no account', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hhy-off-'))
  const dsh = join(root, 'dsh')
  await mkdir(join(dsh, 'skills'), { recursive: true })
  await mkdir(join(root, 'agents'), { recursive: true })
  await writeFile(join(dsh, 'skills', 'SKILL.md'), 'offline-ok')
  const env = { ...process.env, DSH_HOME: dsh, DSH_AGENTS_HOME: join(root, 'agents'), UNDOHAVEN_PASSPHRASE: PASS }
  delete env.UNDOHAVEN_API
  delete env.UNDOHAVEN_HOME
  const snap = await runCli(['snapshot', '--json'], env).exited
  assert.equal(snap.code, 0, snap.err + snap.out)
  const id = snap.out.split('\n').map((line) => line.trim()).filter((line) => line.startsWith('{')).map((line) => JSON.parse(line)).find((row) => row.id)?.id
  assert.ok(id)
  await writeFile(join(dsh, 'skills', 'SKILL.md'), 'wiped')
  const restored = await runCli(['restore', '--to', id, '--json'], env).exited
  assert.equal(restored.code, 0, restored.err + restored.out)
  assert.match(restored.err, /first rollback|第一次回滚/)
  assert.equal(await readFile(join(dsh, 'skills', 'SKILL.md'), 'utf8'), 'offline-ok')
  const denied = await runCli(['storage', 'set', 'dir', join(root, 'nope')], env).exited
  assert.notEqual(denied.code, 0)
  await rm(root, { recursive: true, force: true })
})

test('S3-compatible bucket stores chunks and restores', async () => {
  let S3rver
  try {
    const mod = await import('s3rver')
    S3rver = mod.default || mod.S3rver
  } catch {
    return
  }
  const root = await mkdtemp(join(tmpdir(), 'hhy-s3-'))
  const directory = join(root, 's3')
  await mkdir(directory, { recursive: true })
  const server = new S3rver({
    port: 0,
    address: '127.0.0.1',
    silent: true,
    directory,
    configureBuckets: [{ name: 'undohaven-test' }],
  })
  const { port } = await server.run()
  try {
    const { dsh, agents, data } = await tinyHome(root)
    const cfg = {
      endpoint: `http://127.0.0.1:${port}`,
      bucket: 'undohaven-test',
      region: 'us-east-1',
      accessKeyId: 'S3RVER',
      secretAccessKey: 'S3RVER',
      prefix: 'undohaven',
      forcePathStyle: true,
    }
    await establishKeys(data, PASS)
    await saveStorageConfig(data, { mode: 's3', s3: cfg })
    assert.equal((await loadStorageConfig(data)).mode, 's3')
    const keys = await (await import('../src/keys.js')).loadKeyFile(data)
    const snap = await createSnapshot({ dataDir: data, dshHome: dsh, agentsHome: agents, dek: keys.dek, cloud: null })
    await writeFile(join(dsh, 'skills', 'SKILL.md'), 'cloud-gone')
    await rm(join(data, 'snapshots'), { recursive: true, force: true })
    await restoreSnapshot({ dataDir: data, dshHome: dsh, agentsHome: agents, id: snap.id, dek: keys.dek, skipLockCheck: true, skipSafety: true, cloud: null })
    assert.equal(await readFile(join(dsh, 'skills', 'SKILL.md'), 'utf8'), 'keep-local')
  } finally {
    await server.close()
    await rm(root, { recursive: true, force: true })
  }
})
