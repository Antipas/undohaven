import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { establishKeys, listSnapshots } from 'undohaven-core'
import { Config, createRuntime, mount } from '../index.js'

const PASSPHRASE = 'correct horse battery'

function mockRes() {
  return {
    status: 0,
    headers: {},
    body: '',
    writeHead(status) { this.status = status },
    end(payload) { this.body = Buffer.from(payload).toString('utf8') },
    json() { return JSON.parse(this.body) },
  }
}

function mockReq({ method, url, body = '', address = '127.0.0.1' }) {
  const buf = Buffer.from(body)
  return {
    method,
    url,
    socket: { remoteAddress: address },
    async *[Symbol.asyncIterator]() {
      if (buf.length) yield buf
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
  const routes = []
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    webServer: { register(route) { routes.push(route); return () => { routes.pop() } } },
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
  const unmount = mount(ctx.webServer, runtime)
  const statusRes = mockRes()
  await routes[0].handler(mockReq({ method: 'GET', url: '/api/undohaven/status' }), statusRes)
  assert.equal(statusRes.status, 200)
  assert.equal(statusRes.json().unlocked, true)
  const denied = mockRes()
  await routes[0].handler(mockReq({ method: 'GET', url: '/api/undohaven/status', address: '8.8.8.8' }), denied)
  assert.equal(denied.status, 403)
  const plan = mockRes()
  await routes[0].handler(mockReq({
    method: 'POST',
    url: '/api/undohaven/restore-plan',
    body: JSON.stringify({ id: 'snap_abc', scope: 'sessions' }),
  }), plan)
  assert.match(plan.json().command, /undohaven restore --to snap_abc --scope sessions/)
  assert.match(plan.json().zh, /退出/)
  unmount()
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
})
