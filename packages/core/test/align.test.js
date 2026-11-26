import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  ALIGN_COPY,
  compareVersions,
  establishKeys,
  listRuntimeMismatch,
  loadDek,
  onRuntimeStart,
  rangeSatisfies,
  readAlignmentNotice,
  realignPlugins,
  saveAlignmentNotice,
} from '../src/index.js'

test('runtime ranges treat rc.1 as older than rc.5 and older than the final release', () => {
  assert.ok(compareVersions('0.2.2-rc.1', '0.2.2-rc.5') < 0)
  assert.ok(compareVersions('0.2.2-rc.5', '0.2.2') < 0)
  assert.equal(rangeSatisfies('>=0.2.1-rc.5 <0.3.0', '0.2.2-rc.5'), true)
  assert.equal(rangeSatisfies('>=0.2.2-rc.5 <0.3.0', '0.2.2-rc.1'), false)
  assert.equal(rangeSatisfies('0.2.2-rc.1', '0.2.2-rc.5'), false)
  assert.match(ALIGN_COPY.zh, /sessionController unavailable/)
  assert.match(ALIGN_COPY.en, /snapshots first/)
  assert.doesNotMatch(`${ALIGN_COPY.zh}\n${ALIGN_COPY.en}`, /支付宝|微信支付|Alipay|WeChat Pay|DeepSeek/)
})

async function profile(root) {
  const dsh = join(root, 'dsh')
  const profileDir = join(dsh, 'profiles', 'desktop')
  const sqlite = join(profileDir, 'node_modules', '@deepseek-ai', 'dsh-session-query-sqlite')
  const custom = join(profileDir, 'node_modules', 'dsh-custom')
  const old = join(profileDir, 'node_modules', 'dsh-old')
  await mkdir(sqlite, { recursive: true })
  await mkdir(custom, { recursive: true })
  await mkdir(old, { recursive: true })
  const pkg = {
    dependencies: {
      '@deepseek-ai/dsh-session-query-sqlite': '0.2.2-rc.1',
      'dsh-custom': '1.0.0',
      'dsh-old': '1.2.3',
    },
  }
  await writeFile(join(profileDir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`)
  await writeFile(join(profileDir, 'cordis.patch.yml'), [
    '- id: session-query-sqlite',
    "  name: '@deepseek-ai/dsh-session-query-sqlite'",
    '  disabled: true',
    '',
  ].join('\n'))
  await writeFile(join(sqlite, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh-session-query-sqlite',
    version: '0.2.2-rc.1',
    peerDependencies: { '@deepseek-ai/dsh-session': '0.2.2-rc.1' },
  }))
  await writeFile(join(custom, 'package.json'), JSON.stringify({
    name: 'dsh-custom',
    version: '1.0.0',
    engines: { dsh: '>=0.2.1-rc.5 <0.3.0' },
  }))
  await writeFile(join(old, 'package.json'), JSON.stringify({
    name: 'dsh-old',
    version: '1.2.3',
    engines: { dsh: '0.2.2-rc.1' },
  }))
  return { dsh, profileDir }
}

test('a runtime change lists disabled plugins, snapshots, then rolls back a failed upgrade', async () => {
  const root = await mkdtemp(join(tmpdir(), 'uh-align-'))
  const { dsh, profileDir } = await profile(root)
  const data = join(root, 'data')
  const report = await listRuntimeMismatch({
    dshHome: dsh,
    runtimeVersion: '0.2.2-rc.5',
    previousVersion: '0.2.2-rc.1',
  })
  assert.deepEqual(report.plugins.map((plugin) => plugin.name).sort(), ['@deepseek-ai/dsh-session-query-sqlite', 'dsh-old'])
  const sqlite = report.plugins.find((plugin) => plugin.name.startsWith('@deepseek-ai/'))
  assert.equal(sqlite.canBump, true)
  assert.equal(sqlite.disabled, true)
  assert.equal(sqlite.reason, 'requirement')
  assert.equal(report.plugins.find((plugin) => plugin.name === 'dsh-old').canBump, false)
  const order = []
  const applied = await realignPlugins({
    dshHome: dsh,
    dataDir: data,
    runtimeVersion: '0.2.2-rc.5',
    previousVersion: '0.2.2-rc.1',
    report,
    createSnapshot: async () => {
      order.push('snap')
      return { id: 'snap_align' }
    },
    install: async () => {
      order.push('install')
      const pkg = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8'))
      assert.equal(pkg.dependencies['@deepseek-ai/dsh-session-query-sqlite'], '0.2.2-rc.5')
      assert.equal(pkg.dependencies['dsh-old'], '1.2.3')
      assert.equal(pkg.dependencies['dsh-custom'], '1.0.0')
      return { installed: true }
    },
  })
  assert.deepEqual(order, ['snap', 'install'])
  assert.equal(applied.snapshotId, 'snap_align')
  assert.equal(applied.manual.length, 1)

  await writeFile(join(profileDir, 'package.json'), `${JSON.stringify({
    dependencies: {
      '@deepseek-ai/dsh-session-query-sqlite': '0.2.2-rc.1',
      'dsh-custom': '1.0.0',
      'dsh-old': '1.2.3',
    },
  }, null, 2)}\n`)
  await assert.rejects(() => realignPlugins({
    dshHome: dsh,
    dataDir: data,
    runtimeVersion: '0.2.2-rc.5',
    previousVersion: '0.2.2-rc.1',
    report,
    createSnapshot: async () => ({ id: 'snap_fail' }),
    install: async () => { throw new Error('ERR_PNPM_EPERM') },
  }), (error) => {
    assert.equal(error.code, 'align_failed')
    assert.match(error.zh, /snap_fail/)
    assert.match(error.en, /rolled back/)
    return true
  })
  const rolled = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8'))
  assert.equal(rolled.dependencies['@deepseek-ai/dsh-session-query-sqlite'], '0.2.2-rc.1')

  await assert.rejects(() => realignPlugins({
    dshHome: dsh,
    dataDir: data,
    runtimeVersion: '0.2.2-rc.5',
    previousVersion: '0.2.2-rc.1',
    report,
    createSnapshot: async () => { throw new Error('disk full') },
    install: async () => { throw new Error('should not install') },
  }), (error) => {
    assert.equal(error.code, 'align_snapshot_failed')
    return true
  })
  const unchanged = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8'))
  assert.equal(unchanged.dependencies['@deepseek-ai/dsh-session-query-sqlite'], '0.2.2-rc.1')
  await rm(root, { recursive: true, force: true })
})

test('startup records a runtime change for the alignment notice', async () => {
  const root = await mkdtemp(join(tmpdir(), 'uh-boot-'))
  const dsh = join(root, 'dsh')
  const data = join(root, 'data')
  await mkdir(join(dsh, 'skills'), { recursive: true })
  await establishKeys(data, 'correct horse battery')
  const { dek } = await loadDek(data)
  const env = { UNDOHAVEN_DSH_VERSION: '0.2.2-rc.1', UNDOHAVEN_DSH_BASE_VERSION: '0.2.2-rc.1' }
  const first = await onRuntimeStart({ dataDir: data, dshHome: dsh, dek, env })
  assert.equal(first.runtimeChanged, false)
  env.UNDOHAVEN_DSH_VERSION = '0.2.2-rc.5'
  env.UNDOHAVEN_DSH_BASE_VERSION = '0.2.2-rc.5'
  const second = await onRuntimeStart({ dataDir: data, dshHome: dsh, dek, env })
  assert.equal(second.runtimeChanged, true)
  assert.equal(second.previousDshVersion, '0.2.2-rc.1')
  const { dsh: profileHome } = await profile(root)
  const report = await listRuntimeMismatch({
    dshHome: profileHome,
    runtimeVersion: second.versions.dshVersion,
    previousVersion: second.previousDshVersion,
  })
  const notice = await saveAlignmentNotice(data, report)
  assert.equal((await readAlignmentNotice(data)).previousVersion, '0.2.2-rc.1')
  assert.ok(notice.plugins.some((plugin) => plugin.name === '@deepseek-ai/dsh-session-query-sqlite'))
  await rm(root, { recursive: true, force: true })
})
