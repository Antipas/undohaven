import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { main } from '../../cli/src/main.js'
import { declaredFromManifest, listPluginHistory, rollbackGuard, scanGuard } from '../src/guard.js'
import { restoreOnePlugin } from '../src/plugins.js'
import { createSnapshot, establishKeys } from '../src/index.js'
import { scanRoot } from '../src/scan.js'

const PASS = 'correct horse battery'

test('the snapshot walk skips links, model weights, and oversized files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'uh-walk-'))
  const dsh = join(root, 'dsh')
  const outside = join(root, 'outside')
  await mkdir(join(dsh, 'skills'), { recursive: true })
  await mkdir(outside, { recursive: true })
  await writeFile(join(outside, 'SKILL.md'), 'outside-skill')
  await symlink(outside, join(dsh, 'skills', 'linked'), 'dir')
  await symlink(join(outside, 'SKILL.md'), join(dsh, 'skills', 'alias.md'))
  await writeFile(join(dsh, 'skills', 'ok.md'), 'keep-me')
  await writeFile(join(dsh, 'skills', 'model.safetensors'), 'weights')
  await writeFile(join(dsh, 'skills', 'pytorch_model.bin'), 'weights')
  await writeFile(join(dsh, 'skills', 'big.txt'), 'x'.repeat(40))
  const files = await scanRoot(dsh, 'dsh', { maxFileBytes: 20 })
  const rels = files.map((file) => file.rel)
  assert.ok(rels.includes('skills/ok.md'))
  assert.equal(rels.some((rel) => rel.includes('linked') || rel.includes('alias')), false)
  assert.equal(rels.includes('skills/model.safetensors'), false)
  assert.equal(rels.includes('skills/pytorch_model.bin'), false)
  assert.equal(rels.includes('skills/big.txt'), false)
  await rm(root, { recursive: true, force: true })
})

test('junctions are not followed', { skip: process.platform !== 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'uh-junction-'))
  const dsh = join(root, 'dsh')
  const outside = join(root, 'outside')
  await mkdir(join(dsh, 'skills'), { recursive: true })
  await mkdir(outside, { recursive: true })
  await writeFile(join(outside, 'secret.md'), 'nope')
  await symlink(outside, join(dsh, 'skills', 'junction'), 'junction')
  const files = await scanRoot(dsh, 'dsh')
  assert.equal(files.some((file) => file.rel.includes('secret') || file.rel.includes('junction')), false)
  await rm(root, { recursive: true, force: true })
})

test('rescue lists snapshots and restores the profile while dsh is down', async () => {
  const root = await mkdtemp(join(tmpdir(), 'uh-rescue-'))
  const dsh = join(root, 'dsh')
  const data = join(root, 'data')
  const profile = join(dsh, 'profiles', 'web')
  await mkdir(profile, { recursive: true })
  await mkdir(join(dsh, 'sessions', 'proj', 's1'), { recursive: true })
  await writeFile(join(profile, 'package.json'), `${JSON.stringify({ private: true, dependencies: { 'dsh-demo': '1.0.0' } }, null, 2)}\n`)
  await writeFile(join(profile, 'pnpm-lock.yaml'), 'lockfileVersion: \'9.0\'\n')
  await writeFile(join(profile, 'cordis.patch.yml'), '- id: dsh-demo\n  name: dsh-demo\n')
  await writeFile(join(dsh, 'sessions', 'proj', 's1', 'session.v3.jsonl'), 'keep-session\n')
  const { dek } = await establishKeys(data, PASS)
  const created = await createSnapshot({ dataDir: data, dshHome: dsh, dek, kind: 'manual' })
  await writeFile(join(profile, 'package.json'), `${JSON.stringify({ private: true, dependencies: { 'dsh-demo': '9.9.9' } }, null, 2)}\n`)
  await writeFile(join(dsh, 'sessions', 'proj', 's1', 'session.v3.jsonl'), 'mutated-session\n')
  const logs = []
  const original = console.log
  console.log = (line) => logs.push(String(line))
  const env = { ...process.env, UNDOHAVEN_PASSPHRASE: PASS }
  const previous = process.env
  process.env = env
  try {
    const listed = await main(['node', 'undohaven', 'rescue', 'list', '--dsh-home', dsh, '--data-dir', data, '--json'])
    assert.equal(listed, 0)
    const restored = await main(['node', 'undohaven', 'rescue', '--to', created.id, '--dsh-home', dsh, '--data-dir', data, '--json'])
    assert.equal(restored, 0)
  } finally {
    console.log = original
    process.env = previous
  }
  const pkg = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'))
  assert.equal(pkg.dependencies['dsh-demo'], '1.0.0')
  assert.equal(await readFile(join(dsh, 'sessions', 'proj', 's1', 'session.v3.jsonl'), 'utf8'), 'mutated-session\n')
  assert.match(logs.join('\n'), new RegExp(created.id))
  await rm(root, { recursive: true, force: true })
})

test('plugin history can roll one package back without touching the others', async () => {
  const root = await mkdtemp(join(tmpdir(), 'uh-plug-'))
  const dsh = join(root, 'dsh')
  const data = join(root, 'data')
  const profile = join(dsh, 'profiles', 'web')
  await mkdir(profile, { recursive: true })
  const writePkg = (spec) => writeFile(join(profile, 'package.json'), `${JSON.stringify({ private: true, dependencies: { 'dsh-demo': spec, 'dsh-other': '9.0.0' } }, null, 2)}\n`)
  await writePkg('1.0.0')
  const { dek } = await establishKeys(data, PASS)
  const first = await createSnapshot({ dataDir: data, dshHome: dsh, dek, kind: 'manual' })
  await writePkg('2.0.0')
  const second = await createSnapshot({ dataDir: data, dshHome: dsh, dek, kind: 'manual' })
  const history = await listPluginHistory(data, 'dsh-demo')
  assert.ok(history.some((item) => item.snapshotId === first.id))
  assert.ok(history.some((item) => item.snapshotId === second.id))
  const rolled = await rollbackGuard({
    tier: 'pro',
    dataDir: data,
    name: 'dsh-demo',
    to: first.id,
    applyPlugin: async ({ id }) => {
      const { readSnapshotRecord } = await import('../src/store.js')
      const record = await readSnapshotRecord(data, id)
      return { changed: await restoreOnePlugin(dsh, record.plugins, 'dsh-demo') }
    },
  })
  assert.equal(rolled.id, first.id)
  const pkg = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'))
  assert.equal(pkg.dependencies['dsh-demo'], '1.0.0')
  assert.equal(pkg.dependencies['dsh-other'], '9.0.0')
  await rm(root, { recursive: true, force: true })
})

test('install and update show declared network permissions and the diff', async () => {
  const root = await mkdtemp(join(tmpdir(), 'uh-decl-'))
  const pluginDir = join(root, 'plugin')
  await mkdir(pluginDir, { recursive: true })
  await writeFile(join(pluginDir, 'index.js'), 'export {}\n')
  const declared = declaredFromManifest({ dshhub: { permissions: { network: ['api.example'] } } })
  assert.deepEqual(declared.destinations, ['api.example'])
  assert.ok(declared.capabilities.includes('network'))
  const plugin = { name: 'dsh-cost-meter', version: '1.0.0', dir: pluginDir, profile: 'web', spec: '1.0.0', declared }
  const first = await scanGuard({
    tier: 'free',
    dataDir: join(root, 'data'),
    dshHome: join(root, 'dsh'),
    plugins: [plugin],
    blocklist: { entries: [] },
    audit: async () => ({ capabilities: [], destinations: [], buildScripts: [], redLines: [] }),
  })
  assert.equal(first.changes[0].from, null)
  assert.equal(first.changes[0].delta.network, true)
  assert.deepEqual(first.changes[0].declared, ['api.example'])
  const nextDeclared = declaredFromManifest({ dshhub: { permissions: { network: ['api.example', 'cdn.example'] } } })
  const second = await scanGuard({
    tier: 'free',
    dataDir: join(root, 'data'),
    dshHome: join(root, 'dsh'),
    plugins: [{ ...plugin, version: '1.1.0', declared: nextDeclared }],
    previous: first.baseline,
    blocklist: { entries: [] },
    audit: async () => ({ capabilities: [], destinations: [], buildScripts: [], redLines: [] }),
  })
  assert.equal(second.changes[0].from, '1.0.0')
  assert.equal(second.changes[0].to, '1.1.0')
  assert.deepEqual(second.changes[0].delta.domains, ['cdn.example'])
  await rm(root, { recursive: true, force: true })
})
