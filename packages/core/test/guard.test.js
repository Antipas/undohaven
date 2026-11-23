import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { diffCapabilities, hashDirectory, matchBlock, rollbackGuard, scanGuard, GUARD_SEED } from '../src/guard.js'
import { entryFromOsv } from '../../server/src/guard-list.js'

test('capability diff names shell, credentials, network, scripts, and domains', () => {
  const delta = diffCapabilities(
    { capabilities: ['fs-read'], destinations: ['undohaven.com'], buildScripts: [] },
    { capabilities: ['fs-read', 'shell', 'network', 'credentials'], destinations: ['undohaven.com', 'evil.example'], buildScripts: ['postinstall'] },
  )
  assert.equal(delta.shell, true)
  assert.equal(delta.credentials, true)
  assert.equal(delta.network, true)
  assert.deepEqual(delta.installScripts, ['postinstall'])
  assert.deepEqual(delta.domains, ['evil.example'])
})

test('the seed blocks dsh-plugin-blender-3d 0.2.1 and OSV malware entries', () => {
  assert.equal(matchBlock(GUARD_SEED, 'dsh-plugin-blender-3d', '0.2.1').id, 'GHSA-c7hg-7rf4-q54h')
  assert.equal(matchBlock(GUARD_SEED, 'dsh-plugin-blender-3d', '0.2.0'), null)
  const entry = entryFromOsv('dsh-plugin-blender-3d', {
    id: 'MAL-2026-18321',
    aliases: ['GHSA-c7hg-7rf4-q54h'],
    summary: 'Malicious code in dsh-plugin-blender-3d (npm)',
    affected: [{ package: { name: 'dsh-plugin-blender-3d' }, versions: ['0.2.1'] }],
  })
  assert.equal(entry.mal, 'MAL-2026-18321')
  assert.deepEqual(entry.versions, ['0.2.1'])
  assert.equal(entryFromOsv('left-pad', { id: 'MAL-1', summary: 'Malicious', affected: [] }), null)
})

test('free scan baselines and disables a blocked plugin without a snapshot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'guard-'))
  const pluginDir = join(root, 'plugin')
  const profile = join(root, 'dsh', 'profiles', 'web')
  await mkdir(pluginDir, { recursive: true })
  await mkdir(profile, { recursive: true })
  await writeFile(join(pluginDir, 'index.js'), 'console.log("one")\n')
  const plugins = [{ name: 'dsh-plugin-blender-3d', version: '0.2.1', dir: pluginDir, profile: 'web' }]
  const snaps = []
  const first = await scanGuard({
    tier: 'free',
    dataDir: join(root, 'data'),
    dshHome: join(root, 'dsh'),
    plugins,
    blocklist: { entries: GUARD_SEED },
    audit: async () => ({ capabilities: ['fs-read'], destinations: [], buildScripts: [], redLines: [] }),
    createSnapshot: async () => { snaps.push('no') ; return { id: 'snap_no' } },
  })
  assert.equal(snaps.length, 0)
  assert.equal(first.blocked[0].advisory.id, 'GHSA-c7hg-7rf4-q54h')
  assert.match(await readFile(join(profile, 'cordis.patch.yml'), 'utf8'), /disabled: true/)
  await writeFile(join(pluginDir, 'index.js'), 'console.log("two")\n')
  const second = await scanGuard({
    tier: 'pro',
    dataDir: join(root, 'data'),
    dshHome: join(root, 'dsh'),
    plugins,
    previous: first.baseline,
    blocklist: { entries: [] },
    disable: false,
    audit: async () => ({ capabilities: ['fs-read', 'shell', 'network'], destinations: ['evil.example'], buildScripts: ['postinstall'], redLines: [] }),
    createSnapshot: async () => ({ id: 'snap_new' }),
    pinSnapshot: async (id) => ({ id }),
  })
  assert.equal(second.changes[0].delta.shell, true)
  assert.deepEqual(second.changes[0].delta.domains, ['evil.example'])
  assert.equal(second.changes[0].delta.installScripts[0], 'postinstall')
  assert.equal(second.baseline.plugins['dsh-plugin-blender-3d'].snapshotId, 'snap_new')
  assert.equal(second.changes[0].pinnedId, null)
  const third = await scanGuard({
    tier: 'pro',
    dataDir: join(root, 'data'),
    dshHome: join(root, 'dsh'),
    plugins: [{ ...plugins[0], version: '0.2.2' }],
    previous: second.baseline,
    blocklist: { entries: [] },
    disable: false,
    audit: async () => ({ capabilities: ['network'], destinations: [], buildScripts: [], redLines: [] }),
    createSnapshot: async () => ({ id: 'snap_after' }),
    pinSnapshot: async (id) => ({ id: `pin_${id}` }),
  })
  assert.equal(third.changes[0].pinnedId, 'pin_snap_new')
  await assert.rejects(() => rollbackGuard({ tier: 'free', dataDir: join(root, 'data'), name: 'dsh-plugin-blender-3d', restore: async () => ({}) }), /Pro/)
  const rolled = await rollbackGuard({
    tier: 'pro',
    dataDir: join(root, 'data'),
    name: 'dsh-plugin-blender-3d',
    restore: async ({ id, scope }) => ({ id, scope }),
  })
  assert.equal(rolled.id, 'pin_snap_new')
  assert.equal(rolled.restored.scope, 'config')
  assert.match(rolled.limitation, /OS-level persistence/)
  const hash = await hashDirectory(pluginDir)
  assert.equal(typeof hash, 'string')
  assert.equal(hash.length, 64)
  await rm(root, { recursive: true, force: true })
})
