import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { main } from '../../cli/src/main.js'
import { establishKeys } from '../src/index.js'
import { parseYaml } from '../src/yaml.js'
import {
  encodeAsar,
  isEmptyPackageTemplate,
  repairStartup,
  startupCheckup,
  undoStartupRepair,
} from '../src/startup-doctor.js'

const PASS = 'correct horse battery'
const MARKER = 'DOCTOR_PLAINTEXT_MARKER_9f3a'
const RELEASE = '0.2.2-rc.5'
const OLD = '0.2.2-rc.1'
const SEARCH = '@deepseek-ai/dsh-experimental-session-search'
const TERMINAL = '@deepseek-ai/dsh-experimental-terminal-bundle'

function env(extra = {}) {
  const next = {
    ...process.env,
    UNDOHAVEN_ASSUME_DSH_STOPPED: '1',
    ...extra,
  }
  delete next.UNDOHAVEN_DSH_RELEASE
  delete next.UNDOHAVEN_DESKTOP_RUNTIME
  delete next.UNDOHAVEN_APP_ROOT
  delete next.UNDOHAVEN_APP_ASAR
  delete next.UNDOHAVEN_DSH_PORT
  return next
}

async function writeJson(file, value) {
  await mkdir(join(file, '..'), { recursive: true })
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`)
}

async function tree(root) {
  const out = new Map()
  async function walk(dir) {
    let entries = []
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name)
      if (entry.isSymbolicLink()) {
        out.set(abs, 'symlink')
        continue
      }
      if (entry.isDirectory()) await walk(abs)
      else if (entry.isFile()) out.set(abs, await readFile(abs))
    }
  }
  await walk(root)
  return out
}

function sameTree(before, after) {
  assert.equal(after.size, before.size)
  for (const [file, bytes] of before) {
    const next = after.get(file)
    if (Buffer.isBuffer(bytes)) assert.deepEqual(next, bytes)
    else assert.equal(next, bytes)
  }
}

async function fixture() {
  const root = await mkdtempSafe()
  const dsh = join(root, 'dsh')
  const data = join(root, 'data')
  const profile = join(dsh, 'profiles', 'desktop')
  const outside = join(root, 'outside')
  await mkdir(join(profile, 'node_modules', '.ignored'), { recursive: true })
  await mkdir(outside, { recursive: true })
  await writeFile(join(outside, 'keep.txt'), 'keep')
  const body = {
    name: MARKER,
    private: true,
    dependencies: {
      [SEARCH]: OLD,
      [TERMINAL]: OLD,
    },
    dsh: { profile: { bundles: [SEARCH, TERMINAL] } },
  }
  const json = `${JSON.stringify(body, null, 2)}\n`
  await writeFile(join(profile, 'package.json'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(json)]))
  const patch = [
    '- id: locale',
    '  config:',
    '    lang: zh-CN',
    '- id: pet',
    '  name: dsh-pet',
    '- id: search',
    `  name: ${SEARCH}`,
    '',
  ].join('\n')
  await writeFile(join(profile, 'cordis.patch.yml'), '[]\n')
  await writeFile(join(profile, 'cordis.patch.yml.bak-20'), patch)
  await writeFile(join(profile, '.env'), 'SECRET=nope\n')
  for (const name of [SEARCH, TERMINAL]) {
    await writeJson(join(profile, 'node_modules', ...name.split('/'), 'package.json'), {
      name,
      version: OLD,
    })
  }
  const tmp = join(profile, 'node_modules', '.ignored', 'dsh-experimental-terminal-bundle_tmp_2736_5')
  await mkdir(tmp, { recursive: true })
  await writeFile(join(tmp, 'stub.txt'), 'half')
  await symlink(outside, join(profile, 'node_modules', '.ignored', 'outside_tmp_9'), 'dir')
  const runtime = join(root, 'app', 'dsh', 'desktop-runtime.json')
  await writeJson(runtime, { release: { version: RELEASE } })
  return { root, dsh, data, profile, outside, runtime }
}

function mkdtempSafe() {
  return mkdtemp(join(tmpdir(), 'uh-doctor-'))
}

test('a read-only checkup reports the BOM, empty template, bundle mismatch, and half-extracted directory', async () => {
  const fx = await fixture()
  const before = await tree(fx.dsh)
  const report = await startupCheckup(fx.dsh, { env: env(), runtimeFile: fx.runtime })
  sameTree(before, await tree(fx.dsh))
  const codes = report.findings.map((item) => `${item.code}:${item.path}`)
  assert.ok(codes.some((item) => item.startsWith('utf8_bom:profiles/desktop/package.json')))
  assert.ok(codes.some((item) => item.startsWith('empty_template:profiles/desktop/cordis.patch.yml')))
  assert.equal(report.findings.filter((item) => item.code === 'bundle_version_mismatch').length, 2)
  assert.ok(report.findings.some((item) => item.code === 'half_extracted' && item.path.includes('_tmp_')))
  assert.equal(report.findings.some((item) => item.code === 'profile_bak'), false)
  assert.equal(report.ok, false)
  assert.equal(report.mode, 'read-only')
  assert.equal(report.shipped.version, RELEASE)
  const bom = report.findings.find((item) => item.code === 'utf8_bom')
  assert.match(bom.quote, /Unexpected token/)
  assert.match(bom.quote, /\uFEFF/)
  assert.equal(bom.url, 'https://github.com/deepseek-ai/deepseek-harness/discussions/14459')
  const mismatch = report.findings.find((item) => item.code === 'bundle_version_mismatch')
  assert.equal(mismatch.quote, 'active Service "sessionController" is unavailable')
  assert.equal(mismatch.url, 'https://github.com/deepseek-ai/deepseek-harness/discussions/14408')
  assert.equal(report.notes[0].quote, 'SessionFormatError: format v4 message requires a producer-owned source kind')
  assert.equal(report.notes[0].url, 'https://github.com/deepseek-ai/deepseek-harness/discussions/14411')
  await rm(fx.root, { recursive: true, force: true })
})

test('free repair writes nothing', async () => {
  const fx = await fixture()
  const before = await tree(fx.dsh)
  let snapped = false
  await assert.rejects(
    () => repairStartup({
      tier: 'free',
      dshHome: fx.dsh,
      dataDir: fx.data,
      env: env(),
      runtimeFile: fx.runtime,
      snapshot: async () => {
        snapped = true
        return { id: 'nope' }
      },
    }),
    /Pro/,
  )
  assert.equal(snapped, false)
  sameTree(before, await tree(fx.dsh))
  await assert.rejects(() => readFile(join(fx.data, 'doctor-repair.json')), { code: 'ENOENT' })
  await rm(fx.root, { recursive: true, force: true })
})

test('a failed snapshot does not change the profile', async () => {
  const fx = await fixture()
  const { dek } = await establishKeys(fx.data, PASS)
  const before = await tree(fx.dsh)
  await assert.rejects(
    () => repairStartup({
      tier: 'pro',
      dek,
      dshHome: fx.dsh,
      dataDir: fx.data,
      env: env(),
      runtimeFile: fx.runtime,
      install: false,
      snapshot: async () => {
        throw new Error('snapshot failed')
      },
    }),
    /snapshot failed/,
  )
  sameTree(before, await tree(fx.dsh))
  await assert.rejects(() => readFile(join(fx.data, 'doctor-repair.json')), { code: 'ENOENT' })
  await rm(fx.root, { recursive: true, force: true })
})

test('pro repair snapshots first, fixes the profile, and undo restores it', async () => {
  const fx = await fixture()
  const originalPackage = await readFile(join(fx.profile, 'package.json'))
  const originalPatch = await readFile(join(fx.profile, 'cordis.patch.yml'))
  const { dek } = await establishKeys(fx.data, PASS)
  let installed = 0
  const result = await repairStartup({
    tier: 'pro',
    dek,
    dshHome: fx.dsh,
    dataDir: fx.data,
    env: env(),
    runtimeFile: fx.runtime,
    restoreConfig: false,
    install: async (dir) => {
      installed += 1
      for (const name of [SEARCH, TERMINAL]) {
        const file = join(dir, 'node_modules', ...name.split('/'), 'package.json')
        const pkg = JSON.parse(await readFile(file, 'utf8'))
        pkg.version = RELEASE
        await writeFile(file, `${JSON.stringify(pkg)}\n`)
      }
      return { installed: true }
    },
  })
  assert.equal(result.repaired, true)
  assert.equal(result.hooks.configRestore, 'builtin')
  assert.equal(result.hooks.align, 'not-called')
  assert.equal(result.hooks.preflight, 'not-in-tree')
  assert.equal(installed, 1)
  assert.match(result.snapshotId, /^snap_/)
  const stored = await readFile(join(fx.data, 'snapshots', `${result.snapshotId}.json`), 'utf8')
  assert.equal(stored.includes(MARKER), false)
  assert.equal(stored.includes('SECRET=nope'), false)
  const pkg = JSON.parse(await readFile(join(fx.profile, 'package.json'), 'utf8'))
  assert.equal(pkg.dependencies[SEARCH], RELEASE)
  assert.equal(pkg.dependencies[TERMINAL], RELEASE)
  assert.equal(pkg.name, MARKER)
  const patch = await readFile(join(fx.profile, 'cordis.patch.yml'), 'utf8')
  assert.equal(patch.includes('\uFEFF'), false)
  assert.match(patch, /id: pet\n {2}disabled: true/)
  assert.doesNotMatch(patch, /id: locale\n {2}disabled:/)
  assert.doesNotMatch(patch, /id: search\n {2}disabled:/)
  const parsed = parseYaml(patch)
  assert.equal(parsed.find((row) => row.id === 'pet').disabled, true)
  assert.equal(parsed.find((row) => row.id === 'search').name, SEARCH)
  await assert.rejects(() => readFile(join(fx.profile, 'node_modules', '.ignored', 'dsh-experimental-terminal-bundle_tmp_2736_5', 'stub.txt')), { code: 'ENOENT' })
  assert.equal(await readFile(join(fx.outside, 'keep.txt'), 'utf8'), 'keep')
  const link = await readFile(join(fx.profile, '.env'), 'utf8')
  assert.equal(link, 'SECRET=nope\n')
  const after = await startupCheckup(fx.dsh, { env: env(), runtimeFile: fx.runtime })
  assert.equal(after.findings.some((item) => item.code === 'utf8_bom' || item.code === 'empty_template' || item.code === 'bundle_version_mismatch' || item.code === 'half_extracted'), false)

  const undone = await undoStartupRepair({
    tier: 'pro',
    dek,
    dshHome: fx.dsh,
    dataDir: fx.data,
    env: env(),
  })
  assert.equal(undone.snapshotId, result.snapshotId)
  assert.deepEqual(await readFile(join(fx.profile, 'package.json')), originalPackage)
  assert.deepEqual(await readFile(join(fx.profile, 'cordis.patch.yml')), originalPatch)
  await assert.rejects(() => readFile(join(fx.profile, 'node_modules', '.ignored', 'dsh-experimental-terminal-bundle_tmp_2736_5', 'stub.txt')), { code: 'ENOENT' })
  await assert.rejects(
    () => undoStartupRepair({ tier: 'pro', dek, dshHome: fx.dsh, dataDir: fx.data, env: env() }),
    /no doctor repair/i,
  )
  await rm(fx.root, { recursive: true, force: true })
})

test('an empty package.json is restored from the sibling bak, and free repair does not write', async () => {
  const root = await mkdtempSafe()
  const dsh = join(root, 'dsh')
  const data = join(root, 'data')
  const profile = join(dsh, 'profiles', 'web')
  await mkdir(profile, { recursive: true })
  const empty = '{}\n'
  const bak = `${JSON.stringify({ name: 'web', private: true, dependencies: { 'dsh-demo': '1.2.3' } }, null, 2)}\n`
  await writeFile(join(profile, 'package.json'), empty)
  await writeFile(join(profile, 'package.json.bak-3'), bak)
  const report = await startupCheckup(dsh, { env: env() })
  const hit = report.findings.find((item) => item.code === 'empty_template')
  assert.equal(hit.detail.bak, 'package.json.bak-3')
  assert.equal(hit.repairable, true)
  assert.equal(isEmptyPackageTemplate({}), true)
  assert.equal(isEmptyPackageTemplate({ name: 'desktop', dependencies: { a: '1' } }), false)
  const before = await tree(dsh)
  await assert.rejects(() => repairStartup({ tier: 'free', dshHome: dsh, dataDir: data, env: env() }), /Pro/)
  sameTree(before, await tree(dsh))
  const { dek } = await establishKeys(data, PASS)
  const repaired = await repairStartup({
    tier: 'pro',
    dek,
    dshHome: dsh,
    dataDir: data,
    env: env(),
    install: false,
    restoreConfig: false,
  })
  assert.equal(repaired.repaired, true)
  const pkg = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'))
  assert.equal(pkg.dependencies['dsh-demo'], '1.2.3')
  await undoStartupRepair({ tier: 'pro', dek, dshHome: dsh, dataDir: data, env: env() })
  assert.equal(await readFile(join(profile, 'package.json'), 'utf8'), empty)
  await rm(root, { recursive: true, force: true })
})

test('a config-restore hook replaces the built-in patch write', async () => {
  const root = await mkdtempSafe()
  const dsh = join(root, 'dsh')
  const data = join(root, 'data')
  const profile = join(dsh, 'profiles', 'desktop')
  await mkdir(profile, { recursive: true })
  await writeFile(join(profile, 'cordis.patch.yml'), '[]\n')
  await writeFile(join(profile, 'cordis.patch.yml.bak-9'), '- id: pet\n  name: dsh-pet\n')
  await writeFile(join(profile, 'package.json'), `${JSON.stringify({ private: true, dependencies: { 'dsh-demo': '1.0.0' } })}\n`)
  const { dek } = await establishKeys(data, PASS)
  let called = 0
  const result = await repairStartup({
    tier: 'pro',
    dek,
    dshHome: dsh,
    dataDir: data,
    env: env(),
    install: false,
    restoreConfig: async () => {
      called += 1
      await writeFile(join(profile, 'cordis.patch.yml'), 'from-hook\n')
    },
  })
  assert.equal(called, 1)
  assert.equal(result.hooks.configRestore, 'hook')
  assert.equal(await readFile(join(profile, 'cordis.patch.yml'), 'utf8'), 'from-hook\n')
  await rm(root, { recursive: true, force: true })
})

test('release.version is read from a desktop app archive', async () => {
  const root = await mkdtempSafe()
  const body = Buffer.from(JSON.stringify({ release: { version: RELEASE } }))
  const asar = join(root, 'app.asar')
  await writeFile(asar, encodeAsar([{ path: 'dsh/desktop-runtime.json', body }]))
  const shipped = await startupCheckup(join(root, 'missing'), { env: env(), appAsar: asar })
  assert.equal(shipped.shipped.version, RELEASE)
  assert.equal(shipped.findings.some((item) => item.code === 'no_profiles'), true)
  await rm(root, { recursive: true, force: true })
})

test('the doctor command stays read-only without a license', async () => {
  const fx = await fixture()
  const before = await tree(fx.dsh)
  const logs = []
  const errors = []
  const original = console.log
  const originalErr = console.error
  console.log = (line) => logs.push(String(line))
  console.error = (line) => errors.push(String(line))
  const previous = process.env
  process.env = env()
  let code = 0
  let repair = 0
  try {
    code = await main(['node', 'undohaven', 'doctor', '--dsh-home', fx.dsh, '--data-dir', fx.data, '--runtime', fx.runtime, '--json'])
    repair = await main(['node', 'undohaven', 'doctor', 'repair', '--dsh-home', fx.dsh, '--data-dir', fx.data, '--json'])
  } finally {
    console.log = original
    console.error = originalErr
    process.env = previous
  }
  assert.equal(code, 1)
  assert.equal(repair, 4)
  const report = JSON.parse(logs[0])
  assert.equal(report.mode, 'read-only')
  assert.ok(report.findings.some((item) => item.code === 'utf8_bom'))
  assert.match(errors.join('\n'), /pro_required/)
  sameTree(before, await tree(fx.dsh))
  await rm(fx.root, { recursive: true, force: true })
})

test('the bin entry runs the checkup', async () => {
  const fx = await fixture()
  const script = fileURLToPath(new URL('../../cli/bin/undohaven.js', import.meta.url))
  const { stdout, status } = await new Promise((resolve, reject) => {
    execFile(process.execPath, [script, 'doctor', '--dsh-home', fx.dsh, '--data-dir', fx.data, '--runtime', fx.runtime, '--json'], {
      env: env(),
    }, (error, stdout, stderr) => {
      if (error && error.code !== 1) {
        reject(error)
        return
      }
      resolve({ stdout, stderr, status: error ? error.code : 0 })
    })
  })
  assert.equal(status, 1)
  const report = JSON.parse(stdout)
  assert.equal(report.mode, 'read-only')
  assert.ok(report.findings.some((item) => item.quote && item.quote.includes('sessionController')))
  await rm(fx.root, { recursive: true, force: true })
})
