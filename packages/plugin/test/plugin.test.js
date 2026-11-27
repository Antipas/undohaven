import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { establishKeys, listSnapshots } from 'undohaven-core'
import { Config, createRuntime, mount } from '../index.js'
import { TOKEN_HEADER } from '../route-guard.js'

const PASSPHRASE = 'correct horse battery'

function fakeConnection() {
  const routes = []
  return {
    routes,
    fetch: {
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
  }
}

test('settings schema defaults are volatile', () => {
  const result = Config['~standard'].validate({})
  assert.equal(typeof result.value.intervalHours.get, 'function')
  assert.equal(result.value.intervalHours.get(), 6)
  assert.equal(result.value.snapshotOnStart.get(), true)
})

test('plugin pins the previous runtime version and serves loopback routes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hhy-plugin-'))
  const dsh = join(root, 'dsh')
  const agents = join(root, 'agents')
  const data = join(root, 'data')
  await mkdir(join(dsh, 'skills'), { recursive: true })
  await mkdir(agents, { recursive: true })
  await writeFile(join(dsh, 'skills', 'SKILL.md'), 'keep-me')
  await establishKeys(data, PASSPHRASE)
  const env = { UNDOHAVEN_DSH_BASE_VERSION: '1.0.0', UNDOHAVEN_DSH_VERSION: '1.0.0' }
  const webHits = []
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    webServer: { register(route) { webHits.push(route); return () => {} } },
    connection: fakeConnection(),
  }
  const runtime = createRuntime(ctx, { snapshotOnStart: true, snapshotOnDispose: false, intervalHours: 6 }, {
    dataDir: data,
    dshHome: dsh,
    agentsHome: agents,
    env,
    intervalMs: 10 ** 9,
  })
  await runtime.boot()
  env.UNDOHAVEN_DSH_BASE_VERSION = '2.0.0'
  env.UNDOHAVEN_DSH_VERSION = '2.0.0'
  const second = await runtime.boot()
  assert.equal(second.pinned.kind, 'pre-upgrade')
  const rows = await listSnapshots({ dataDir: data })
  assert.ok(rows.some((row) => row.dshBaseVersion === '1.0.0' && row.kind === 'pre-upgrade'))
  const unmount = mount(ctx.connection, runtime)
  assert.equal(webHits.length, 0)
  assert.ok(ctx.connection.routes.some((route) => route.path === '/api/undohaven/status' && route.methods.includes('GET')))
  const tokenFile = join(data, 'route-token')
  const tokenStat = await stat(tokenFile)
  assert.equal(tokenStat.mode & 0o777, 0o600)
  const token = (await readFile(tokenFile, 'utf8')).trim()
  const local = (url, init = {}) => new Request(url, {
    ...init,
    headers: { origin: 'http://127.0.0.1', [TOKEN_HEADER]: token, ...(init.headers || {}) },
  })
  const blocked = await ctx.connection.routes.find((route) => route.path === '/api/undohaven/status').fetch(new Request('http://127.0.0.1/api/undohaven/status', {
    headers: { origin: 'https://evil.example', [TOKEN_HEADER]: token },
  }))
  assert.equal(blocked.status, 403)
  const missing = await ctx.connection.routes.find((route) => route.path === '/api/undohaven/status').fetch(local('http://127.0.0.1/api/undohaven/status', {
    headers: { [TOKEN_HEADER]: '' },
  }))
  assert.equal(missing.status, 403)
  const status = await ctx.connection.routes.find((route) => route.path === '/api/undohaven/status').fetch(local('http://127.0.0.1/api/undohaven/status'))
  assert.equal(status.status, 200)
  assert.equal((await status.json()).unlocked, true)
  const bare = mount(null, runtime)
  assert.equal(typeof bare, 'function')
  bare()
  const skipped = mount({ fetch: {} }, runtime)
  skipped()
  assert.equal(webHits.length, 0)
  const plan = await ctx.connection.routes.find((route) => route.path === '/api/undohaven/restore-plan').fetch(local('http://127.0.0.1/api/undohaven/restore-plan', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'snap_abc', scope: 'sessions' }),
  }))
  const planBody = await plan.json()
  assert.match(planBody.command, /undohaven restore --to snap_abc --scope sessions/)
  assert.match(planBody.zh, /退出/)
  const tasks = await ctx.connection.routes.find((route) => route.path === '/api/undohaven/restore-plan').fetch(local('http://127.0.0.1/api/undohaven/restore-plan', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'snap_abc', scope: 'tasks' }),
  }))
  assert.match((await tasks.json()).command, /--scope tasks$/)
  const one = await ctx.connection.routes.find((route) => route.path === '/api/undohaven/restore-plan').fetch(local('http://127.0.0.1/api/undohaven/restore-plan', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'snap_abc', scope: 'session', session: 'sess-1' }),
  }))
  assert.match((await one.json()).command, /--scope session --session sess-1/)
  unmount()
  await runtime.shutdown()
  await rm(root, { recursive: true, force: true })
})

test('startup prompts when the profile patch was moved aside', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hhy-wipe-'))
  const dsh = join(root, 'dsh')
  const data = join(root, 'data')
  const profile = join(dsh, 'profiles', 'desktop')
  await mkdir(profile, { recursive: true })
  await writeFile(join(profile, 'cordis.patch.yml.bak-1730000000000'), '- id: locale\n  config:\n    preference: zh-CN\n')
  await writeFile(join(profile, 'cordis.patch.yml'), '[]\n')
  await establishKeys(data, PASSPHRASE)
  const ctx = { logger: { info() {}, warn() {}, error() {} }, connection: fakeConnection() }
  const runtime = createRuntime(ctx, { snapshotOnStart: false, snapshotOnDispose: false }, {
    dataDir: data,
    dshHome: dsh,
    env: {},
    pollMs: 10 ** 9,
  })
  await runtime.boot()
  const prompts = JSON.parse(await readFile(join(data, 'prompts.json'), 'utf8'))
  assert.match(prompts.profileWipe.zh, /你的设置被官方救援移走了/)
  assert.match(prompts.profileWipe.command, /guard config-restore --profile desktop/)
  mount(ctx.connection, runtime)
  const statusRoute = ctx.connection.routes.find((route) => route.path === '/api/undohaven/status')
  const token = (await readFile(join(data, 'route-token'), 'utf8')).trim()
  const status = await statusRoute.fetch(new Request('http://127.0.0.1/api/undohaven/status', {
    headers: { origin: 'http://127.0.0.1', 'x-undohaven-token': token },
  }))
  const body = await status.json()
  assert.match(body.profileWipe.en, /unofficial third-party/i)
  await runtime.shutdown()
  await rm(root, { recursive: true, force: true })
})

test('client bundle registers a settings tab', async () => {
  const code = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  const registered = []
  const react = {
    createElement(type, props, ...children) { return { type, props, children } },
    useState(initial) { return [initial, () => {}] },
    useEffect() {},
  }
  const sandbox = {
    console,
    fetch: async () => ({ json: async () => ({ snapshots: [] }) }),
    __ModuleLoader__: { load(reg) { sandbox.registration = reg } },
  }
  sandbox.globalThis = sandbox
  vm.runInNewContext(code, sandbox, { filename: 'client.js' })
  const plugin = sandbox.registration.factory((id) => {
    if (id === 'react') return react
    throw new Error(id)
  })
  assert.equal(plugin.inject.length, 1)
  assert.equal(plugin.inject[0], 'slots')
  const ctx = {
    slots: {
      inject(name, fn) {
        assert.equal(name, 'settings.plugins.tab')
        fn()
      },
      register(meta, component) {
        registered.push(meta)
        assert.equal(typeof component, 'function')
        component()
      },
    },
  }
  plugin.apply(ctx)
  assert.equal(registered[0].id, 'undohaven')
  assert.match(registered[0].label, /后悔药/)
  assert.match(code, /Restore only scheduled tasks/)
  assert.match(code, /Restore this session/)
  assert.match(code, /undohaven guard undo/)
})
