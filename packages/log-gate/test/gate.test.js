import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { zstdCompressSync } from 'node:zlib'
import { auditHome, readPatchPlugins, renderReport } from '../src/audit.js'
import { decideBlock, ruleMatches } from '../src/match.js'
import { Config, apply, classifyLive, currentRules } from '../index.js'

const DSH = process.env.UNDOHAVEN_DSH_PREFIX || '/tmp/hhy-dsh'

test('rules match project names, directories, and globs', () => {
  assert.equal(ruleMatches('/home/me/secret-proj', 'secret-proj'), true)
  assert.equal(ruleMatches('/home/me/secret-proj', 'other'), false)
  assert.equal(ruleMatches('/home/me/work/private/app', '/home/me/work/private'), true)
  assert.equal(ruleMatches('/home/me/clients/acme', '/home/me/clients/**'), true)
  assert.equal(decideBlock({ mode: 'all', rules: [], cwd: null }).blocked, true)
  assert.equal(decideBlock({ mode: 'listed', rules: ['secret-proj'], cwd: null }).blocked, false)
  assert.equal(decideBlock({ mode: 'listed', rules: ['secret-proj'], cwd: '/x/secret-proj' }).reason, 'secret-proj')
})

test('settings schema defaults to blocking every session', () => {
  const value = Config['~standard'].validate({}).value
  assert.equal(currentRules(value).mode, 'all')
  assert.deepEqual(currentRules(value).rules, [])
})

test('patch reader sees the official switches and this gate', () => {
  const plugins = readPatchPlugins(`
- id: session-log-deepseek
  config:
    enabled: false
- id: session-telemetry-otel
  config:
    mode: DISABLED
- id: log-gate
  config:
    mode: listed
    rules:
      - secret-proj
`)
  assert.equal(plugins.find((row) => row.id === 'session-log-deepseek').config.enabled, false)
  assert.equal(plugins.find((row) => row.id === 'session-telemetry-otel').config.mode, 'DISABLED')
  assert.deepEqual(plugins.find((row) => row.id === 'log-gate').config.rules, ['secret-proj'])
})

test('audit report names switches, catch-up, and UndoHaven', async () => {
  const root = await mkdtemp(join(tmpdir(), 'log-gate-'))
  const dsh = join(root, 'dsh')
  const sessionDir = join(dsh, 'sessions', 'proj', 's1')
  await mkdir(sessionDir, { recursive: true })
  await mkdir(join(dsh, 'profiles', 'default'), { recursive: true })
  await writeFile(join(dsh, 'profiles', 'default', 'cordis.patch.yml'), `
- id: session-log-deepseek
  config:
    enabled: true
- id: log-gate
  config:
    mode: listed
    rules:
      - secret-proj
`)
  const lines = [
    JSON.stringify({ type: 'session', version: 4, id: 's1', cwd: '/work/secret-proj', createdAt: 1, isSeeded: false, delegationDepth: 0 }),
    JSON.stringify({ type: 'user/message', seq: 0, time: 1, data: {} }),
    JSON.stringify({ type: 'session-log-deepseek/delivery-accepted', seq: 1, time: 2, data: { sessionId: 's1', throughSeq: 0 } }),
    JSON.stringify({ type: 'user/message', seq: 2, time: 3, data: {} }),
  ].join('\n')
  await writeFile(join(sessionDir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(lines)))
  const report = await auditHome({ dshHome: dsh, agentsHome: join(root, 'agents'), env: {} })
  assert.equal(report.upload.enabled, true)
  assert.equal(report.gate.mode, 'listed')
  assert.equal(report.sessions[0].catchUp, 'held-by-gate')
  const text = renderReport(report)
  assert.match(text, /https:\/\/undohaven\.com/)
  assert.match(text, /delivery-accepted/)
  assert.match(text, /FEEDBACK_ONLY|Telemetry/)
  await rm(root, { recursive: true, force: true })
})

test('real session-log service omits a blocked session before reading events', async () => {
  const moduleUrl = pathToFileURL(join(DSH, 'node_modules/@deepseek-ai/dsh-session-log-deepseek/lib/index.js'))
  let SessionLogDeepSeekService
  try {
    ;({ SessionLogDeepSeekService } = await import(moduleUrl))
  } catch (error) {
    assert.fail(`real dsh session-log package is required at ${moduleUrl.pathname}: ${error.message}`)
  }
  const sessions = new Map()
  let prepare
  const ctx = {
    reflect: { provide(name, self) { ctx[name] = self; return self } },
    deepseekLlmApiExtensions: { register(_field, handler) { prepare = handler.prepare; return () => {} } },
    sessions: {
      get(id) { return sessions.get(id) },
      list() { return [...sessions.values()] },
    },
    effect(fn) { return fn() },
    logger: { warn() {}, info() {} },
  }
  new SessionLogDeepSeekService(ctx, { enabled: { get() { return true } }, maxBytes: 8 * 1024 * 1024 })
  const reads = []
  const session = (id, cwd) => ({
    id,
    header: { cwd, version: 4 },
    snapshotEvents() { reads.push(id); return [] },
  })
  sessions.set('secret', session('secret', '/work/secret-proj'))
  sessions.set('open', session('open', '/work/public'))
  apply(ctx, { mode: 'listed', rules: ['secret-proj'] })
  assert.equal(prepare({ sessionId: 'secret' }), undefined)
  assert.equal(prepare({ sessionId: 'open' }), undefined)
  assert.deepEqual(reads, ['open'])
  const rows = classifyLive(ctx.sessions.list(), { mode: 'listed', rules: ['secret-proj'] })
  assert.equal(rows.find((row) => row.id === 'secret').blocked, true)
  assert.equal(rows.find((row) => row.id === 'open').blocked, false)
})
