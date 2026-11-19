import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import {
  AVG_SIZE,
  CdcStream,
  MAX_SIZE,
  MIN_SIZE,
  chunkBuffer,
  createKeySet,
  createSnapshot,
  doctor,
  establishKeys,
  exportArchive,
  fileLockHeld,
  hmacChunkId,
  chunkIdKey,
  importArchive,
  inspectZstd,
  listSnapshots,
  loadKeyFile,
  onRuntimeStart,
  open,
  parseYaml,
  repairZstd,
  restoreSnapshot,
  safeJoin,
  seal,
  sha256,
  classifyDsh,
  PLANS,
  PRICES,
  assertDshStopped,
  isCrossMajorDowngrade,
  textListsDshProcess,
  windowsSessionSemaphoreName,
} from '../src/index.js'

const PASSPHRASE = 'correct horse battery'

test('plan limits and prices match the offer', () => {
  assert.equal(PLANS.free.storageBytes, 1024 ** 3)
  assert.equal(PLANS.free.historyDays, 7)
  assert.equal(PLANS.free.devices, 1)
  assert.equal(PLANS.free.machineMigration, false)
  assert.equal(PLANS.free.crossMajorDowngrade, false)
  assert.equal(PLANS.pro.storageBytes, 50 * 1024 ** 3)
  assert.equal(PLANS.pro.historyDays, 90)
  assert.equal(PLANS.pro.keepPreUpgrade, true)
  assert.equal(PLANS.pro.devices, 3)
  assert.equal(PLANS.pro.byoStorage, true)
  assert.equal(PRICES.pro_month_usd.amount, 600)
  assert.equal(PRICES.pro_year_usd.amount, 4800)
  assert.equal(PRICES.pro_month_cny.amount, 1500)
  assert.equal(PRICES.pro_year_cny.amount, 12800)
  assert.equal(PRICES.pass_quarter_cny.days, 90)
  assert.equal(PRICES.pass_year_cny.days, 365)
})

test('FastCDC boundaries stay put when bytes before the minimum change', () => {
  assert.equal(MIN_SIZE, 256 * 1024)
  assert.equal(AVG_SIZE, 1024 * 1024)
  assert.equal(MAX_SIZE, 2 * 1024 * 1024)
  const data = Buffer.alloc(3 * 1024 * 1024)
  for (let i = 0; i < data.length; i += 1) data[i] = (i * 17 + 9) & 0xff
  const original = chunkBuffer(data)
  assert.ok(original.length >= 2)
  const mutated = Buffer.from(data)
  mutated[10] ^= 0xff
  const next = chunkBuffer(mutated)
  assert.equal(next.length, original.length)
  assert.notDeepEqual(next[0], original[0])
  for (let i = 1; i < original.length; i += 1) assert.deepEqual(next[i], original[i])
  const stream = new CdcStream({ min: 32, avg: 128, max: 512 })
  const sample = data.subarray(0, 200_000)
  const collected = []
  for (let i = 0; i < sample.length; i += 100) collected.push(...stream.push(sample.subarray(i, i + 100)))
  collected.push(...stream.finish())
  const direct = chunkBuffer(sample, { min: 32, avg: 128, max: 512 })
  assert.deepEqual(collected.map((part) => part.toString('hex')), direct.map((part) => part.toString('hex')))
})

test('crypto roundtrip, unique nonces, recovery words, and argon2 wrapping', async () => {
  const key = Buffer.alloc(32, 7)
  const plain = Buffer.from('后悔药 keeps ciphertext only')
  const a = seal(key, plain)
  const b = seal(key, plain)
  assert.notEqual(a.subarray(2, 14).toString('hex'), b.subarray(2, 14).toString('hex'))
  assert.deepEqual(open(key, a), plain)
  const flipped = Buffer.from(a)
  flipped[20] ^= 0xff
  await assert.rejects(() => Promise.resolve().then(() => open(key, flipped)))
  const idKey = chunkIdKey(key)
  assert.equal(hmacChunkId(idKey, plain), hmacChunkId(idKey, plain))
  assert.notEqual(hmacChunkId(idKey, plain), hmacChunkId(chunkIdKey(Buffer.alloc(32, 8)), plain))
  const keys = await createKeySet(PASSPHRASE)
  assert.equal(keys.words.length, 24)
  const { unwrapWithPassphrase, unwrapWithRecovery, entropyFromWords } = await import('../src/crypto.js')
  const dek = await unwrapWithPassphrase(PASSPHRASE, keys.salt, keys.wrappedDek, keys.kdf)
  assert.deepEqual(dek, keys.dek)
  assert.deepEqual(unwrapWithRecovery(keys.words, keys.wrappedDekRecovery), keys.dek)
  await assert.rejects(() => unwrapWithPassphrase('wrong passphrase', keys.salt, keys.wrappedDek, keys.kdf))
  const words = keys.words.slice()
  words[3] = 'notaword'
  assert.throws(() => entropyFromWords(words))
})

test('cordis patch fixtures parse', async () => {
  const base = parseYaml(await readFile(new URL('./fixtures/base.cordis.patch.yml', import.meta.url), 'utf8'))
  const web = parseYaml(await readFile(new URL('./fixtures/web.cordis.patch.yml', import.meta.url), 'utf8'))
  assert.equal(base[0].insert.find((row) => row.id === 'plan-mode').name, '@deepseek-ai/dsh-plan-mode')
  assert.match(web.find((row) => row.id === 'system-prompt').config.personaPrefix, /coding agent/)
  assert.throws(() => parseYaml('\t- id: bad\n'))
  assert.throws(() => parseYaml('\uFEFFid: x\n'))
})

test('classify backup rules', () => {
  assert.equal(classifyDsh('sessions/p/s/session.v3.jsonl.zstd'), 'include')
  assert.equal(classifyDsh('sessions/p/s/session.lock'), 'exclude')
  assert.equal(classifyDsh('storages/workspace.json'), 'include')
  assert.equal(classifyDsh('storages/session_projcache/x.json'), 'skip-tree')
  assert.equal(classifyDsh('profiles/web/node_modules/a/b.js'), 'skip-tree')
  assert.equal(classifyDsh('profiles/web/cordis.yml'), 'exclude')
  assert.equal(classifyDsh('profiles/web/pnpm-lock.yaml'), 'include')
  assert.equal(classifyDsh('.credentials.yaml'), 'exclude')
  assert.equal(classifyDsh('.credentials.yaml', { includeCredentials: true }), 'include')
  assert.equal(classifyDsh('.env'), 'exclude')
  assert.equal(classifyDsh('cache/a'), 'skip-tree')
  assert.equal(classifyDsh('.anonymous-user-id'), 'exclude')
  assert.equal(classifyDsh('vendor-plugin/note.txt'), 'include')
  assert.equal(classifyDsh('sessions~/orphan/session.v3.jsonl.zstd'), 'exclude')
  assert.throws(() => safeJoin('/tmp/root', '../etc/passwd'))
})

test('doctor reports bom, bad yaml, broken sessions, stray dirs, and a missing registry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hhy-doc-'))
  await mkdir(join(root, 'profiles', 'web'), { recursive: true })
  await mkdir(join(root, 'sessions~', 'orphan'), { recursive: true })
  await mkdir(join(root, 'sessions', 'proj', 's1'), { recursive: true })
  await writeFile(join(root, 'profiles', 'web', 'cordis.patch.yml'), '\uFEFF- id: ok\n')
  await writeFile(join(root, 'cordis.patch.yml'), '\t- id: bad\n')
  await writeFile(join(root, 'sessions~', 'orphan', 'note.txt'), 'stale')
  const header = `${JSON.stringify({ version: 4, id: 'sess-1', cwd: '/work', createdAt: 1 })}\n`
  const broken = Buffer.concat([zstdCompressSync(Buffer.from(header)), Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 1, 2, 3])])
  await writeFile(join(root, 'sessions', 'proj', 's1', 'session.v3.jsonl.zstd'), broken)
  await writeFile(join(root, 'sessions', 'proj', 's1', 'session.v3.jsonl'), `${header}`)
  const report = await doctor(root)
  const codes = new Set(report.findings.map((item) => item.code))
  for (const code of ['bom', 'bad_patch_yml', 'stray_sessions_tilde', 'truncated_session', 'session_compression_mismatch', 'missing_workspace_registry']) {
    assert.ok(codes.has(code), code)
  }
  assert.equal(report.ok, false)
  await rm(root, { recursive: true, force: true })
})

test('snapshot repairs a truncated zstd tail, restores sqlite via backup, and round-trips an export', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hhy-rt-'))
  const dsh = join(root, 'dsh')
  const agents = join(root, 'agents')
  const data = join(root, 'data')
  const project = join(root, 'project')
  await mkdir(join(dsh, 'sessions', 'proj', 's1'), { recursive: true })
  await mkdir(join(dsh, 'storages'), { recursive: true })
  await mkdir(join(dsh, 'skills', 'demo'), { recursive: true })
  await mkdir(join(dsh, 'profiles', 'web', 'node_modules', 'pkg'), { recursive: true })
  await mkdir(join(agents, 'skills', 'shared'), { recursive: true })
  await mkdir(project, { recursive: true })
  const header = `${JSON.stringify({ version: 4, id: 'sess-1', cwd: project, createdAt: 5, isSeeded: false })}\n`
  const event = `${JSON.stringify({ type: 'user', text: 'alpha-memory' })}\n`
  const session = Buffer.concat([
    zstdCompressSync(Buffer.from(header)),
    zstdCompressSync(Buffer.from(event)),
    Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 9, 9]),
  ])
  const sessionPath = join(dsh, 'sessions', 'proj', 's1', 'session.v3.jsonl.zstd')
  await writeFile(sessionPath, session)
  const before = session.length
  await writeFile(join(dsh, 'storages', 'workspace.json'), JSON.stringify({
    unit: { name: 'workspace', version: 2 },
    global: { workspaceIds: ['ws1'] },
    tables: { workspaces: { ws1: { path: project, title: 'Demo', sessionIds: ['sess-1'] } } },
  }))
  const dbPath = join(dsh, 'storages', 'search.db')
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode=WAL')
  db.exec('CREATE TABLE t (v TEXT)')
  db.exec("INSERT INTO t VALUES ('alpha')")
  db.close()
  await writeFile(join(dsh, 'skills', 'demo', 'SKILL.md'), 'skill-alpha')
  await writeFile(join(dsh, 'profiles', 'web', 'package.json'), '{"name":"web"}')
  await writeFile(join(dsh, 'profiles', 'web', 'pnpm-lock.yaml'), 'lockfileVersion: \'9.0\'\n')
  await writeFile(join(dsh, 'profiles', 'web', 'cordis.patch.yml'), '- id: undohaven\n  name: dsh-undohaven\n')
  await writeFile(join(dsh, 'profiles', 'web', 'cordis.yml'), 'regenerated: true\n')
  await writeFile(join(dsh, 'profiles', 'web', 'node_modules', 'pkg', 'index.js'), 'skip')
  await mkdir(join(dsh, 'vendor-plugin'), { recursive: true })
  await mkdir(join(dsh, 'cache'), { recursive: true })
  await writeFile(join(dsh, 'vendor-plugin', 'note.txt'), 'plugin-alpha')
  await writeFile(join(dsh, '.credentials.yaml'), 'secret-token\n')
  await writeFile(join(dsh, '.anonymous-user-id'), 'anon')
  await writeFile(join(dsh, 'cache', 'junk'), 'nope')
  await writeFile(join(agents, 'AGENTS.md'), 'agents-alpha')
  await writeFile(join(agents, 'skills', 'shared', 'SKILL.md'), 'shared-skill')
  const keys = await establishKeys(data, PASSPHRASE)
  const snap = await createSnapshot({ dataDir: data, dshHome: dsh, agentsHome: agents, dek: keys.dek, kind: 'manual', tags: ['test'] })
  assert.equal((await readFile(sessionPath)).length, before)
  const sessionEntry = snap.manifest.entries.find((entry) => entry.rel.endsWith('session.v3.jsonl.zstd'))
  assert.equal(sessionEntry.repaired, true)
  assert.equal(snap.manifest.entries.some((entry) => entry.rel === '.credentials.yaml'), false)
  assert.equal(snap.manifest.entries.some((entry) => entry.rel.includes('node_modules')), false)
  assert.equal(snap.manifest.entries.some((entry) => entry.rel === 'profiles/web/cordis.yml'), false)
  assert.equal(snap.manifest.entries.some((entry) => entry.rel.startsWith('cache/')), false)
  assert.ok(snap.manifest.entries.some((entry) => entry.rel === 'vendor-plugin/note.txt'))
  assert.ok(snap.manifest.entries.some((entry) => entry.root === 'agents' && entry.rel === 'AGENTS.md'))
  const info = inspectZstd(repairZstd(session).bytes)
  assert.equal(info.ok, true)
  await writeFile(sessionPath, zstdCompressSync(Buffer.from(`${header}${JSON.stringify({ type: 'user', text: 'mutated' })}\n`)))
  const db2 = new DatabaseSync(dbPath)
  db2.exec("UPDATE t SET v = 'beta'")
  db2.close()
  await writeFile(join(dsh, 'skills', 'demo', 'SKILL.md'), 'changed')
  const workspace = JSON.parse(await readFile(join(dsh, 'storages', 'workspace.json'), 'utf8'))
  workspace.unit.version = 9
  await writeFile(join(dsh, 'storages', 'workspace.json'), JSON.stringify(workspace))
  await restoreSnapshot({ dataDir: data, dshHome: dsh, agentsHome: agents, id: snap.id, dek: keys.dek, skipLockCheck: true, skipSafety: true })
  const restored = zstdDecompressSync(await readFile(sessionPath)).toString('utf8')
  assert.match(restored, /alpha-memory/)
  assert.equal(JSON.parse(await readFile(join(dsh, 'storages', 'workspace.json'), 'utf8')).unit.version, 2)
  assert.equal(await readFile(join(dsh, 'skills', 'demo', 'SKILL.md'), 'utf8'), 'skill-alpha')
  assert.equal(await readFile(join(dsh, '.credentials.yaml'), 'utf8'), 'secret-token\n')
  const db3 = new DatabaseSync(dbPath, { readOnly: true })
  assert.equal(db3.prepare('SELECT v FROM t').get().v, 'alpha')
  db3.close()
  const archive = join(root, 'backup.hhy')
  const stored = await loadKeyFile(data)
  await exportArchive(archive, { dataDir: data, dshHome: dsh, agentsHome: agents, keys: stored, dek: keys.dek })
  const packed = await readFile(archive)
  assert.equal(packed.subarray(0, 4).toString(), 'UHV1')
  assert.equal(packed.includes(keys.dek), false)
  await writeFile(join(dsh, 'skills', 'demo', 'SKILL.md'), 'gone')
  const imported = await importArchive(archive, { dataDir: data })
  await restoreSnapshot({ dataDir: data, dshHome: dsh, agentsHome: agents, id: imported.record.id, dek: keys.dek, skipLockCheck: true, skipSafety: true })
  assert.equal(await readFile(join(dsh, 'skills', 'demo', 'SKILL.md'), 'utf8'), 'skill-alpha')
  const env = { UNDOHAVEN_DSH_BASE_VERSION: '1.2.3' }
  await onRuntimeStart({ dataDir: data, dshHome: dsh, agentsHome: agents, dek: keys.dek, env })
  env.UNDOHAVEN_DSH_BASE_VERSION = '9.9.9'
  const started = await onRuntimeStart({ dataDir: data, dshHome: dsh, agentsHome: agents, dek: keys.dek, env })
  assert.ok(started.pinned)
  const rows = await listSnapshots({ dataDir: data, dek: keys.dek })
  assert.ok(rows.some((row) => row.dshBaseVersion === '1.2.3' && row.kind === 'pre-upgrade'))
  await rm(root, { recursive: true, force: true })
})

test('restore keeps session workspace events and drops the removed working_directory tool', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hhy-ws-'))
  const dsh = join(root, 'dsh')
  const agents = join(root, 'agents')
  const data = join(root, 'data')
  const profile = join(dsh, 'profiles', 'web')
  await mkdir(join(dsh, 'sessions', 'proj', 's1'), { recursive: true })
  await mkdir(join(dsh, 'storages'), { recursive: true })
  await mkdir(profile, { recursive: true })
  await mkdir(agents, { recursive: true })
  const session = [
    JSON.stringify({ version: 4, id: 'sess-root', cwd: '/work/original', createdAt: 1 }),
    JSON.stringify({ type: 'working-directory/change', cwd: '/work/original/sub' }),
    JSON.stringify({ type: 'workspace-root/change', cwd: '/work/worktree' }),
    '',
  ].join('\n')
  const sessionPath = join(dsh, 'sessions', 'proj', 's1', 'session.v4.jsonl')
  await writeFile(sessionPath, session)
  const patch = [
    '- id: working-directory',
    '  name: \'@deepseek-ai/dsh-working-directory\'',
    '- id: tool-working-directory',
    '  name: \'@deepseek-ai/dsh-tool-working-directory\'',
    '- id: undohaven',
    '  name: dsh-undohaven',
    '',
  ].join('\n')
  await writeFile(join(profile, 'cordis.patch.yml'), patch)
  await writeFile(join(profile, 'package.json'), `${JSON.stringify({
    dependencies: {
      '@deepseek-ai/dsh-working-directory': '0.2.2-rc.2',
      '@deepseek-ai/dsh-tool-working-directory': '0.2.2-rc.2',
      'dsh-undohaven': '0.1.8',
    },
  }, null, 2)}\n`)
  await writeFile(join(dsh, 'storages', 'workspace.json'), JSON.stringify({
    tables: { workspaces: { ws1: { path: '/work/original', sessionIds: ['sess-root'] } } },
  }))
  const before = await doctor(dsh)
  assert.ok(before.findings.some((item) => item.code === 'removed_working_directory_tool'))
  const keys = await establishKeys(data, PASSPHRASE)
  const snap = await createSnapshot({ dataDir: data, dshHome: dsh, agentsHome: agents, dek: keys.dek, kind: 'manual' })
  await writeFile(sessionPath, `${session}mutated\n`)
  await writeFile(join(profile, 'cordis.patch.yml'), '- id: undohaven\n  name: dsh-undohaven\n')
  await writeFile(join(dsh, 'storages', 'workspace.json'), '{"tables":{"workspaces":{}}}\n')
  const restored = await restoreSnapshot({ dataDir: data, dshHome: dsh, agentsHome: agents, id: snap.id, dek: keys.dek, skipLockCheck: true, skipSafety: true })
  assert.ok(restored.compat.length > 0)
  assert.equal(await readFile(sessionPath, 'utf8'), session)
  const nextPatch = await readFile(join(profile, 'cordis.patch.yml'), 'utf8')
  assert.match(nextPatch, /id: working-directory/)
  assert.match(nextPatch, /dsh-undohaven/)
  assert.doesNotMatch(nextPatch, /tool-working-directory/)
  const pkg = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'))
  assert.equal(pkg.dependencies['@deepseek-ai/dsh-working-directory'], '0.2.2-rc.2')
  assert.equal(pkg.dependencies['dsh-undohaven'], '0.1.8')
  assert.equal(pkg.dependencies['@deepseek-ai/dsh-tool-working-directory'], undefined)
  assert.equal(JSON.parse(await readFile(join(dsh, 'storages', 'workspace.json'), 'utf8')).tables.workspaces.ws1.path, '/work/original')
  const after = await doctor(dsh)
  assert.equal(after.findings.some((item) => item.code === 'removed_working_directory_tool'), false)
  await rm(root, { recursive: true, force: true })
})

test('restore refuses a held session lock and an open desktop port', async (t) => {
  if (process.platform === 'win32') {
    t.skip('Windows uses a named semaphore, not flock. The semaphore name is covered by its own test.')
    return
  }
  if (spawnSync('python3', ['-c', 'import fcntl']).status !== 0) {
    t.skip('python3 with fcntl is not available')
    return
  }
  const root = await mkdtemp(join(tmpdir(), 'hhy-lock-'))
  const lock = join(root, 'sessions', 'proj', 's1', 'session.lock')
  await mkdir(join(root, 'sessions', 'proj', 's1'), { recursive: true })
  const child = spawn('python3', ['-c', 'import fcntl,os,time,sys; fd=os.open(sys.argv[1], os.O_RDWR|os.O_CREAT, 0o644); fcntl.flock(fd, fcntl.LOCK_EX); time.sleep(30)', lock], { stdio: 'ignore' })
  try {
    await new Promise((resolve) => setTimeout(resolve, 200))
    const held = fileLockHeld(lock)
    assert.equal(held.held, true)
    await assert.rejects(() => assertDshStopped(root, {}), /dsh is still running|dsh 仍在运行/)
  } finally {
    child.kill('SIGKILL')
  }
  const server = createServer()
  const listening = await new Promise((resolve, reject) => {
    server.once('error', (error) => {
      if (error.code === 'EADDRINUSE') resolve(false)
      else reject(error)
    })
    server.listen(3999, '127.0.0.1', () => resolve(true))
  })
  try {
    if (!listening) {
      t.diagnostic('port 3999 is already in use; skipped the desktop-port check')
    } else {
      await assert.rejects(() => assertDshStopped(root, {}), /dsh is still running|dsh 仍在运行/)
    }
  } finally {
    if (listening) await new Promise((resolve) => server.close(resolve))
    await rm(root, { recursive: true, force: true })
  }
})

test('windows semaphore name and cross-major downgrade', () => {
  assert.match(windowsSessionSemaphoreName('C:\\Users\\a\\.dsh\\sessions\\s\\session.lock'), /^Local\\dsh-session-lock-[0-9a-f]{64}$/)
  assert.equal(textListsDshProcess('"dsh.exe","1234","Console"'), true)
  assert.equal(textListsDshProcess('node @deepseek-ai/dsh'), true)
  assert.equal(textListsDshProcess('notepad.exe'), false)
  assert.equal(isCrossMajorDowngrade('0.2.2-rc.1', '0.3.0'), true)
  assert.equal(isCrossMajorDowngrade('0.2.1-rc.5', '0.2.2-rc.1'), false)
})

test('sha256 helper stays stable', () => {
  assert.equal(sha256(Buffer.from('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
})

void spawnSync
