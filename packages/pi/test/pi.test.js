import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { readdir } from 'node:fs/promises'
import { diagnosePi, readFileManifest, restorePi, safetySnapshot, snapshotPi, toggleExclude } from '../src/index.js'
import { loadDek } from 'undohaven-core'

async function tree(root) {
  await mkdir(join(root, 'sessions'), { recursive: true })
  await mkdir(join(root, 'extensions', 'demo'), { recursive: true })
  await writeFile(join(root, 'settings.json'), '{"packages":[]}\n')
  await writeFile(join(root, 'sessions', 'one.jsonl'), '{"type":"session"}\n')
  await writeFile(join(root, 'sessions', 'skip.jsonl'), '{"type":"skip"}\n')
  await writeFile(join(root, 'extensions', 'demo', 'index.js'), 'export default function () {}\n')
  await writeFile(join(root, '.env'), 'SECRET_TOKEN=do-not-upload\n')
  await writeFile(join(root, 'auth.json'), '{"token":"plain-secret"}\n')
}

async function chunkText(dataDir) {
  const parts = []
  async function walk(dir) {
    let names = []
    try { names = await readdir(dir, { withFileTypes: true }) } catch { return }
    for (const name of names) {
      const abs = join(dir, name.name)
      if (name.isDirectory()) await walk(abs)
      else parts.push(await readFile(abs))
    }
  }
  await walk(join(dataDir, 'chunks'))
  return Buffer.concat(parts).toString('utf8')
}

test('pi snapshots stay encrypted, skip secrets, and restore one file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-uh-'))
  const agent = join(root, 'agent')
  const dataDir = join(root, 'data')
  await tree(agent)
  const env = { UNDOHAVEN_PASSPHRASE: 'correct horse battery', UNDOHAVEN_HOME: dataDir }
  const toggled = await toggleExclude(dataDir, 'sessions/skip.jsonl')
  assert.equal(toggled.enabled, true)
  const record = await snapshotPi({ agentDir: agent, dataDir, env, cloud: false })
  assert.equal(record.local, true)
  assert.equal(record.cloud, false)
  assert.ok(record.skipped.includes('.env'))
  assert.ok(record.skipped.includes('auth.json'))
  const { manifest } = await readFileManifest(dataDir, (await loadDek(dataDir)).dek, record.id)
  const rels = manifest.entries.map((entry) => entry.rel)
  assert.ok(rels.includes('sessions/one.jsonl'))
  assert.ok(rels.includes('settings.json'))
  assert.ok(rels.includes('extensions/demo/index.js'))
  assert.equal(rels.includes('.env'), false)
  assert.equal(rels.includes('auth.json'), false)
  assert.equal(rels.includes('sessions/skip.jsonl'), false)
  assert.equal((await chunkText(dataDir)).includes('SECRET_TOKEN'), false)
  assert.equal((await chunkText(dataDir)).includes('plain-secret'), false)
  const dest = join(root, 'restored')
  await mkdir(dest, { recursive: true })
  const restored = await restorePi({ agentDir: agent, dataDir, env, id: record.id, paths: ['sessions/one.jsonl'], destAgent: dest })
  assert.deepEqual(restored.files, ['agent:sessions/one.jsonl'])
  assert.equal(await readFile(join(dest, 'sessions', 'one.jsonl'), 'utf8'), '{"type":"session"}\n')
  await assert.rejects(readFile(join(dest, 'settings.json'), 'utf8'))
  const again = await toggleExclude(dataDir, 'sessions/skip.jsonl')
  assert.equal(again.enabled, false)
  const second = await snapshotPi({ agentDir: agent, dataDir, env, cloud: false })
  const secondManifest = await readFileManifest(dataDir, (await loadDek(dataDir)).dek, second.id)
  assert.ok(secondManifest.manifest.entries.some((entry) => entry.rel === 'sessions/skip.jsonl'))
  const safety = await safetySnapshot({ agentDir: agent, dataDir, env, reason: 'pi-update' })
  const reused = await safetySnapshot({ agentDir: agent, dataDir, env, reason: 'pi-update' })
  assert.equal(reused.reused, true)
  assert.equal(reused.id, safety.id)
  const report = await diagnosePi({ agentDir: agent, dataDir, env })
  assert.equal(report.plan, 'free')
  assert.equal(report.cloudHistory, false)
  assert.ok(report.skippedSecrets.includes('.env'))
})

test('the extension registers session hooks and /undohaven', async () => {
  const events = []
  const commands = []
  const pi = {
    on(name) { events.push(name) },
    registerCommand(name) { commands.push(name) },
  }
  const mod = await import('../extensions/index.js')
  mod.default(pi)
  assert.deepEqual(events, ['session_before_compact', 'session_before_tree', 'session_before_switch', 'session_before_fork'])
  assert.deepEqual(commands, ['undohaven'])
})

test('pro cloud upload uses the same account gate and free does not', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-cloud-'))
  const agent = join(root, 'agent')
  const dataDir = join(root, 'data')
  await tree(agent)
  const env = { UNDOHAVEN_PASSPHRASE: 'correct horse battery', UNDOHAVEN_HOME: dataDir }
  const uploaded = []
  const cloudClient = {
    async missing(ids) { return ids },
    async uploadChunk(id, bytes) { uploaded.push({ id, bytes }) },
    async createSnapshot(body) { uploaded.push(body); return body },
  }
  const record = await snapshotPi({ agentDir: agent, dataDir, env, cloudClient })
  assert.equal(record.cloud, true)
  assert.ok(uploaded.some((item) => item.id === record.id && item.includesCredentials === false))
  const sealed = Buffer.concat(uploaded.filter((item) => Buffer.isBuffer(item.bytes)).map((item) => item.bytes))
  assert.equal(sealed.includes(Buffer.from('SECRET_TOKEN')), false)
})
