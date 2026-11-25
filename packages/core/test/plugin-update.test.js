import assert from 'node:assert/strict'
import { access, mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { main } from '../../cli/src/main.js'
import { doctor } from '../src/doctor.js'
import { restoreSnapshot } from '../src/engine.js'
import { establishKeys } from '../src/keys.js'
import {
  GUARD_UPDATE_PHRASES,
  createHostControl,
  detectLockedNativeModules,
  findBrokenTree,
  guardPluginChange,
  hostStopPlan,
  isUpdateFailure,
  repairBrokenTree,
} from '../src/plugin-update.js'

const PASS = 'correct horse battery'
const EPERM_LOG = [
  '无法移除 0.46.0',
  '[ERR_PNPM_EPERM] [importPackage C:\\Users\\Weiqi\\.dsh\\profiles\\desktop\\node_modules\\@node-rs\\jieba-win32-x64-msvc]',
  'EPERM: operation not permitted, rename',
  "'C:\\\\Users\\\\Weiqi\\\\.dsh\\\\profiles\\\\desktop\\\\node_modules\\\\@node-rs\\\\jieba-win32-x64-msvc_tmp_6772_14'",
  "-> 'C:\\\\Users\\\\Weiqi\\\\.dsh\\\\profiles\\\\desktop\\\\node_modules\\\\@node-rs\\\\jieba-win32-x64-msvc'",
].join('\n')

async function exists(file) {
  try {
    await access(file)
    return true
  } catch {
    return false
  }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'uh-guard-upd-'))
  const dsh = join(root, 'dsh')
  const data = join(root, 'data')
  const profile = join(dsh, 'profiles', 'desktop')
  const pluginDir = join(profile, 'node_modules', 'dsh-music-panel')
  const nativeDir = join(profile, 'node_modules', '@node-rs', 'jieba-win32-x64-msvc')
  await mkdir(pluginDir, { recursive: true })
  await mkdir(nativeDir, { recursive: true })
  await writeFile(join(profile, 'package.json'), `${JSON.stringify({
    private: true,
    dependencies: { 'dsh-music-panel': '0.46.0' },
  }, null, 2)}\n`)
  await writeFile(join(profile, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n")
  await writeFile(join(profile, 'cordis.patch.yml'), '- id: dsh-music-panel\n  name: dsh-music-panel\n')
  await writeFile(join(pluginDir, 'package.json'), `${JSON.stringify({ name: 'dsh-music-panel', version: '0.46.0' })}\n`)
  await writeFile(join(pluginDir, 'index.js'), 'module.exports = { v: 1 }\n')
  const nodeFile = join(nativeDir, 'jieba.win32-x64-msvc.node')
  await writeFile(nodeFile, 'native-module')
  await writeFile(join(nativeDir, 'package.json'), `${JSON.stringify({ name: '@node-rs/jieba-win32-x64-msvc', version: '2.0.4' })}\n`)
  const { dek } = await establishKeys(data, PASS)
  return { root, dsh, data, profile, pluginDir, nativeDir, nodeFile, dek }
}

function hostOf(running) {
  const calls = []
  return {
    calls,
    async running() { return running },
    async stop() { calls.push('stop') },
    async start() { calls.push('start') },
  }
}

test('failure text from the Windows reports counts as an update failure', () => {
  assert.equal(isUpdateFailure({ ok: true, stderr: EPERM_LOG }), true)
  assert.equal(isUpdateFailure({ ok: true, stderr: "Error: Cannot find module 'D:\\\\Deepseek\\\\resources\\\\runtime\\\\primary-runtime\\\\dependencies\\\\pnpm\\\\bin\\\\pnpm.mjs'\ncode: 'MODULE_NOT_FOUND'" }), true)
  assert.equal(isUpdateFailure({ ok: true, stderr: '{"errorCode":"operation-error"}' }), true)
  assert.equal(isUpdateFailure({ ok: true, stderr: 'added 458' }), false)
  assert.equal(hostStopPlan('linux'), null)
  assert.equal(hostStopPlan('win32')[0].file, 'taskkill')
  assert.deepEqual(hostStopPlan('win32')[0].args, ['/IM', 'dsh.exe', '/T'])
  assert.deepEqual(hostStopPlan('win32')[1].args, ['/F', '/IM', 'dsh.exe', '/T'])
})

test('windows taskkill plan is built without launching a process', async () => {
  const calls = []
  let running = true
  const host = createHostControl({
    platform: 'win32',
    running: async () => running,
    spawnSync(file, args) {
      calls.push([file, ...args])
      running = false
    },
  })
  const stopped = await host.stop()
  assert.equal(stopped.stopped, true)
  assert.deepEqual(calls, [['taskkill', '/IM', 'dsh.exe', '/T']])
})

test('snapshots the profile before a plugin update', async () => {
  const fix = await fixture()
  const host = hostOf(false)
  const result = await guardPluginChange({
    tier: 'pro',
    dek: fix.dek,
    dataDir: fix.data,
    dshHome: fix.dsh,
    profile: 'desktop',
    plugin: 'dsh-music-panel',
    platform: 'linux',
    mappedFiles: [],
    host,
    runInstall: async () => {
      const pkg = JSON.parse(await readFile(join(fix.profile, 'package.json'), 'utf8'))
      pkg.dependencies['dsh-music-panel'] = '0.46.4'
      await writeFile(join(fix.profile, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`)
      await writeFile(join(fix.pluginDir, 'index.js'), 'module.exports = { v: 2 }\n')
      return { ok: true, stdout: 'added 1', stderr: '' }
    },
  })
  assert.equal(result.ok, true)
  assert.equal(result.rolledBack, false)
  assert.equal(host.calls.length, 0)
  const side = join(fix.root, 'side')
  await mkdir(side)
  await restoreSnapshot({
    dataDir: fix.data,
    dshHome: side,
    dek: fix.dek,
    id: result.snapshotId,
    scope: 'overlay',
    prefix: 'profiles/desktop/',
    skipLockCheck: true,
    skipSafety: true,
  })
  const snapped = JSON.parse(await readFile(join(side, 'profiles', 'desktop', 'package.json'), 'utf8'))
  assert.equal(snapped.dependencies['dsh-music-panel'], '0.46.0')
  assert.equal(await readFile(join(side, 'profiles', 'desktop', 'node_modules', 'dsh-music-panel', 'index.js'), 'utf8'), 'module.exports = { v: 1 }\n')
  const live = JSON.parse(await readFile(join(fix.profile, 'package.json'), 'utf8'))
  assert.equal(live.dependencies['dsh-music-panel'], '0.46.4')
  await rm(fix.root, { recursive: true, force: true })
})

test('rolls the profile back when the update fails with ERR_PNPM_EPERM', async () => {
  const fix = await fixture()
  const host = hostOf(false)
  const result = await guardPluginChange({
    tier: 'pro',
    dek: fix.dek,
    dataDir: fix.data,
    dshHome: fix.dsh,
    profile: 'desktop',
    plugin: 'dsh-music-panel',
    platform: 'linux',
    mappedFiles: [],
    host,
    runInstall: async ({ snapshotId }) => {
      assert.ok(snapshotId)
      await rm(fix.pluginDir, { recursive: true, force: true })
      return { ok: false, code: 1, stdout: '', stderr: EPERM_LOG }
    },
  })
  assert.equal(result.ok, false)
  assert.equal(result.rolledBack, true)
  assert.match(result.install.stderr, /ERR_PNPM_EPERM/)
  const pkg = JSON.parse(await readFile(join(fix.profile, 'package.json'), 'utf8'))
  assert.equal(pkg.dependencies['dsh-music-panel'], '0.46.0')
  assert.equal(await readFile(join(fix.pluginDir, 'index.js'), 'utf8'), 'module.exports = { v: 1 }\n')
  await rm(fix.root, { recursive: true, force: true })
})

test('a locked native module on Windows stops the host, stages the directory, and rolls back', async () => {
  const fix = await fixture()
  const host = hostOf(true)
  const calls = []
  const result = await guardPluginChange({
    tier: 'pro',
    dek: fix.dek,
    dataDir: fix.data,
    dshHome: fix.dsh,
    profile: 'desktop',
    plugin: 'dsh-music-panel',
    platform: 'win32',
    mappedFiles: [fix.nodeFile],
    host,
    runInstall: async () => {
      calls.push('install')
      assert.equal(await exists(fix.nativeDir), false)
      const ignored = await readdir(join(fix.profile, 'node_modules', '.ignored'))
      assert.ok(ignored.some((name) => name.includes('jieba-win32-x64-msvc')))
      await rm(fix.pluginDir, { recursive: true, force: true })
      return { ok: false, code: 1, stdout: '', stderr: EPERM_LOG }
    },
  })
  assert.deepEqual(calls, ['install'])
  assert.deepEqual(host.calls, ['stop', 'start'])
  assert.equal(result.ok, false)
  assert.equal(result.rolledBack, true)
  assert.equal(result.restarted, true)
  assert.equal(result.locked.blocked, true)
  assert.equal(result.locked.modules.some((mod) => mod.name === '@node-rs/jieba-win32-x64-msvc' && mod.reason === 'host_mapped'), true)
  assert.equal(await readFile(join(fix.nativeDir, 'jieba.win32-x64-msvc.node'), 'utf8'), 'native-module')
  assert.equal(await readFile(join(fix.pluginDir, 'index.js'), 'utf8'), 'module.exports = { v: 1 }\n')
  const ignoredDir = join(fix.profile, 'node_modules', '.ignored')
  if (await exists(ignoredDir)) {
    const left = await readdir(ignoredDir)
    assert.deepEqual(left, [])
  }
  await rm(fix.root, { recursive: true, force: true })
})

test('linux does not stop the host when the native module is not mapped', async () => {
  const fix = await fixture()
  const host = hostOf(true)
  const detected = await detectLockedNativeModules(fix.profile, {
    platform: 'linux',
    hostRunning: true,
    mappedFiles: [],
  })
  assert.equal(detected.blocked, false)
  assert.equal(detected.stage.length, 0)
  const result = await guardPluginChange({
    tier: 'pro',
    dek: fix.dek,
    dataDir: fix.data,
    dshHome: fix.dsh,
    profile: 'desktop',
    plugin: 'dsh-music-panel',
    platform: 'linux',
    mappedFiles: [],
    host,
    runInstall: async () => {
      assert.equal(await exists(fix.nodeFile), true)
      return { ok: true, stdout: '', stderr: '' }
    },
  })
  assert.equal(result.ok, true)
  assert.deepEqual(host.calls, [])
  await rm(fix.root, { recursive: true, force: true })
})

test('an EPERM rename probe locks the module even when the map is empty', async () => {
  const fix = await fixture()
  const host = hostOf(true)
  const detected = await detectLockedNativeModules(fix.profile, {
    platform: 'linux',
    hostRunning: true,
    mappedFiles: [],
    probeRename: async () => {
      const error = new Error('EPERM: operation not permitted, rename')
      error.code = 'EPERM'
      throw error
    },
  })
  assert.equal(detected.blocked, true)
  assert.equal(detected.stage.length, 1)
  assert.equal(detected.modules[0].error, 'ERR_PNPM_EPERM')
  let staged = false
  const result = await guardPluginChange({
    tier: 'pro',
    dek: fix.dek,
    dataDir: fix.data,
    dshHome: fix.dsh,
    profile: 'desktop',
    plugin: 'dsh-music-panel',
    platform: 'linux',
    mappedFiles: [],
    probeRename: async () => {
      const error = new Error('EPERM: operation not permitted, rename')
      error.code = 'EPERM'
      throw error
    },
    host,
    runInstall: async () => {
      staged = !(await exists(fix.nativeDir))
      return { ok: true, stdout: '', stderr: '' }
    },
  })
  assert.equal(staged, true)
  assert.equal(result.ok, true)
  assert.deepEqual(host.calls, ['stop', 'start'])
  await rm(fix.root, { recursive: true, force: true })
})

test('a broken tree restores from the latest good snapshot', async () => {
  const fix = await fixture()
  const host = hostOf(false)
  const snapped = await guardPluginChange({
    tier: 'pro',
    dek: fix.dek,
    dataDir: fix.data,
    dshHome: fix.dsh,
    profile: 'desktop',
    plugin: 'dsh-music-panel',
    platform: 'linux',
    mappedFiles: [],
    host,
    runInstall: async () => ({ ok: true, stdout: '', stderr: '' }),
  })
  await rm(fix.pluginDir, { recursive: true, force: true })
  const broken = await findBrokenTree(fix.dsh)
  assert.equal(broken.length, 1)
  assert.equal(broken[0].name, 'dsh-music-panel')
  assert.ok(broken[0].phrases.includes('包不可用'))
  assert.ok(broken[0].phrases.includes('cannot resolve profile bundle'))
  const report = await doctor(fix.dsh)
  const finding = report.findings.find((item) => item.code === 'broken_plugin_tree')
  assert.ok(finding)
  assert.match(finding.en, /ERR_PNPM_EPERM/)
  assert.match(finding.en, /cannot resolve profile bundle/)
  assert.match(finding.zh, /包不可用/)
  assert.match(finding.en, /sessionController" is unavailable/)
  const repairHost = hostOf(true)
  const repaired = await repairBrokenTree({
    tier: 'pro',
    dek: fix.dek,
    dataDir: fix.data,
    dshHome: fix.dsh,
    profile: 'desktop',
    plugin: 'dsh-music-panel',
    reconcile: false,
    host: repairHost,
  })
  assert.equal(repaired.ok, true)
  assert.equal(repaired.snapshotId, snapped.snapshotId)
  assert.equal(repaired.restarted, true)
  assert.deepEqual(repairHost.calls, ['stop', 'start'])
  assert.equal(await readFile(join(fix.pluginDir, 'index.js'), 'utf8'), 'module.exports = { v: 1 }\n')
  const pkg = JSON.parse(await readFile(join(fix.profile, 'package.json'), 'utf8'))
  assert.equal(pkg.dependencies['dsh-music-panel'], '0.46.0')
  await rm(fix.root, { recursive: true, force: true })
})

test('doctor reports an empty desktop runtime and guard tree is free', async () => {
  const fix = await fixture()
  await rm(fix.pluginDir, { recursive: true, force: true })
  const runtime = join(fix.root, 'runtime')
  await mkdir(runtime)
  const report = await doctor(fix.dsh, { UNDOHAVEN_DSH_RUNTIME: runtime })
  const missing = report.findings.find((item) => item.code === 'runtime_pnpm_missing')
  assert.ok(missing)
  assert.match(missing.en, /MODULE_NOT_FOUND/)
  assert.match(missing.zh, /resources\\runtime/)
  assert.match(missing.en, /operation-error/)
  assert.match(missing.en, /already-installed/)
  const logs = []
  const original = console.log
  const originalError = console.error
  console.log = (line) => logs.push(String(line))
  console.error = (line) => logs.push(String(line))
  try {
    const listed = await main(['node', 'undohaven', 'guard', 'tree', '--dsh-home', fix.dsh, '--data-dir', fix.data, '--json'])
    assert.equal(listed, 1)
    const denied = await main(['node', 'undohaven', 'guard', 'repair', '--dsh-home', fix.dsh, '--data-dir', fix.data, '--json'])
    assert.equal(denied, 4)
  } finally {
    console.log = original
    console.error = originalError
  }
  const text = logs.join('\n')
  assert.match(text, /ERR_PNPM_EPERM/)
  assert.match(text, /包不可用/)
  assert.match(text, /cannot resolve profile bundle/)
  assert.match(text, /pro_required/)
  await rm(fix.root, { recursive: true, force: true })
})

test('docs and the landing copy quote the reported error strings', async () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
  const files = [
    'README.md',
    'docs/site/update-gate.md',
    'docs/guard.md',
    'docs/answers/err-pnpm-eperm.md',
    'docs/answers/err-pnpm-eperm.zh.md',
    'packages/cli/README.md',
    'packages/plugin/README.md',
  ]
  const text = (await Promise.all(files.map((file) => readFile(join(root, file), 'utf8')))).join('\n')
  for (const phrase of GUARD_UPDATE_PHRASES) {
    assert.ok(text.includes(phrase), phrase)
  }
  assert.match(text, /undohaven guard update/)
  assert.match(text, /undohaven guard repair/)
  assert.match(text, /undohaven guard tree/)
  assert.match(text, /not affiliated with DeepSeek/)
  assert.match(text, /discussions\/14260/)
  assert.match(text, /discussions\/14216/)
  assert.match(text, /discussions\/14264/)
  const statResult = await stat(join(root, 'docs', 'site', 'update-gate.md'))
  assert.ok(statResult.isFile())
})
