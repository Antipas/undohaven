import Schema from '@deepseek-ai/schemastery'
import {
  cloudFromConfig,
  createSnapshot,
  listSnapshots,
  loadConfig,
  loadDek,
  onRuntimeStart,
  readPrompts,
  reportAnonymousEvent,
  resolveAgentsHome,
  resolveDataDir,
  resolveDshHome,
  saveConfig,
} from 'undohaven-core'
import { publicKeyFields, establishKeys, unlockPassphrase } from 'undohaven-core'
import { CloudClient } from 'undohaven-core'

export const name = 'undohaven'
export const inject = []

export const Config = Schema.object({
  intervalHours: Schema.number().min(1).max(168).default(6).volatile(),
  snapshotOnStart: Schema.boolean().default(true).volatile(),
  snapshotOnDispose: Schema.boolean().default(true).volatile(),
  includeCredentials: Schema.boolean().default(false).volatile(),
})

function read(value, fallback) {
  if (value && typeof value === 'object' && typeof value.get === 'function') {
    const got = value.get()
    return got === undefined || got === null ? fallback : got
  }
  return value === undefined || value === null ? fallback : value
}

function log(ctx, level, message) {
  const logger = ctx?.logger
  if (logger && typeof logger[level] === 'function') logger[level](message)
  else if (level === 'error') console.error(message)
}

async function readBody(req, limit = 1_000_000) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('body too large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

function send(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body))
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': payload.length,
  })
  res.end(payload)
}

function loopback(req) {
  const address = req.socket?.remoteAddress || ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

export function createRuntime(ctx, config = {}, hooks = {}) {
  const runtime = {
    ctx,
    config,
    hooks,
    pending: null,
    lastError: null,
    lastSnapshot: null,
    timer: null,
    paths() {
      const env = hooks.env || process.env
      const dshHome = hooks.dshHome || resolveDshHome(undefined, env)
      return {
        dshHome,
        agentsHome: hooks.agentsHome || resolveAgentsHome(undefined, env),
        dataDir: hooks.dataDir || resolveDataDir(undefined, env, dshHome),
        env,
      }
    },
    async boot() {
      const paths = runtime.paths()
      if (!read(config.snapshotOnStart, true)) return
      try {
        await loadDek(paths.dataDir)
        const { cloud } = await cloudFromConfig(paths.dataDir)
        const result = await onRuntimeStart({ ...paths, cloud })
        runtime.lastSnapshot = { id: result.snapshot.id, at: result.snapshot.createdAt, pinned: result.pinned?.id ?? null }
        await reportAnonymousEvent(paths.dataDir, 'install', null, paths.env).catch(() => {})
        await reportAnonymousEvent(paths.dataDir, 'first_snapshot', null, paths.env).catch(() => {})
        if (result.snapshot.cloudError) runtime.lastError = String(result.snapshot.cloudError.message || result.snapshot.cloudError)
        return result
      } catch (error) {
        runtime.lastError = error.message
        log(ctx, 'warn', `undohaven: startup snapshot skipped: ${error.message}`)
      }
    },
    async snapshot(kind = 'manual') {
      const paths = runtime.paths()
      const { dek } = await loadDek(paths.dataDir)
      const { cloud } = await cloudFromConfig(paths.dataDir)
      const snap = await createSnapshot({
        ...paths,
        dek,
        cloud,
        kind,
        tags: [kind, 'plugin'],
        includeCredentials: !!read(config.includeCredentials, false),
      })
      runtime.lastSnapshot = { id: snap.id, at: snap.createdAt }
      runtime.lastError = snap.cloudError ? String(snap.cloudError.message || snap.cloudError) : null
      await reportAnonymousEvent(paths.dataDir, 'first_snapshot', null, paths.env).catch(() => {})
      if (runtime.lastError && /quota|容量/.test(runtime.lastError)) {
        await reportAnonymousEvent(paths.dataDir, 'limit_hit', { reason: 'snapshot' }, paths.env).catch(() => {})
      }
      return snap
    },
    startTimer() {
      const hours = Number(read(config.intervalHours, 6))
      const interval = hooks.intervalMs ?? Math.max(1, hours) * 60 * 60 * 1000
      runtime.timer = setInterval(() => {
        runtime.snapshot('rolling').catch((error) => {
          runtime.lastError = error.message
          log(ctx, 'error', `undohaven: ${error.message}`)
        })
      }, interval)
      runtime.timer.unref?.()
    },
    async shutdown() {
      if (runtime.timer) clearInterval(runtime.timer)
      if (!read(config.snapshotOnDispose, true)) return
      try {
        await runtime.snapshot('rolling')
      } catch (error) {
        log(ctx, 'warn', `undohaven: dispose snapshot skipped: ${error.message}`)
      }
    },
  }
  return runtime
}

export function mount(webServer, runtime) {
  if (!webServer?.register) return () => {}
  return webServer.register({
    kind: 'prefix',
    path: '/api/undohaven',
    handler: async (req, res) => {
      try {
        if (!loopback(req)) {
          send(res, 403, { error: 'forbidden', zh: '只接受本机请求', en: 'Only loopback clients are accepted' })
          return
        }
        const url = new URL(req.url || '/', 'http://127.0.0.1')
        const path = url.pathname
        const paths = runtime.paths()
        if (req.method === 'GET' && path === '/api/undohaven/status') {
          let unlocked = true
          try {
            await loadDek(paths.dataDir)
          } catch {
            unlocked = false
          }
          const config = await loadConfig(paths.dataDir)
          const prompts = await readPrompts(paths.dataDir)
          send(res, 200, {
            unlocked,
            loggedIn: !!config.accessToken,
            apiBase: config.apiBase,
            lastSnapshot: runtime.lastSnapshot,
            lastError: runtime.lastError,
            upgrade: prompts.upgrade || null,
            zh: unlocked ? '已解锁' : '未解锁，先在这里或命令行登录',
            en: unlocked ? 'Unlocked' : 'Locked. Log in here or with the CLI',
          })
          return
        }
        if (req.method === 'GET' && path === '/api/undohaven/snapshots') {
          const { cloud } = await cloudFromConfig(paths.dataDir)
          const snapshots = await listSnapshots({ dataDir: paths.dataDir, cloud, allowCloudFailure: true })
          send(res, 200, { snapshots })
          return
        }
        if (req.method === 'POST' && path === '/api/undohaven/snapshot') {
          const snap = await runtime.snapshot('manual')
          send(res, 200, { ok: !snap.cloudError, id: snap.id, bytes: snap.bytes, cloud: snap.cloud, error: runtime.lastError })
          return
        }
        if (req.method === 'POST' && path === '/api/undohaven/restore-plan') {
          const body = JSON.parse((await readBody(req)).toString('utf8') || '{}')
          const scope = ['sessions', 'storages', 'config', 'all'].includes(body.scope) ? body.scope : 'all'
          const id = String(body.id || '')
          send(res, 200, {
            blocked: true,
            zh: '恢复必须先退出 dsh。桌面端的紧急恢复可能会卸掉第三方插件，所以这一步交给独立命令。',
            en: 'Restore runs only after dsh has quit. Desktop fatal recovery can remove third-party plugins, so this step belongs to the standalone command.',
            command: `undohaven restore --to ${id} --scope ${scope}`,
          })
          return
        }
        if (req.method === 'POST' && path === '/api/undohaven/login/start') {
          const body = JSON.parse((await readBody(req)).toString('utf8') || '{}')
          const apiBase = body.apiBase || (await loadConfig(paths.dataDir)).apiBase
          if (!apiBase) {
            send(res, 400, { error: 'need_api', zh: '需要 API 地址', en: 'API base URL is required' })
            return
          }
          const code = await new CloudClient({ apiBase }).deviceCode({ name: 'dsh-undohaven', purpose: 'login' })
          runtime.pending = { apiBase, deviceCode: code.device_code, userCode: code.user_code }
          send(res, 200, { user_code: code.user_code, verification_uri: code.verification_uri, interval: code.interval })
          return
        }
        if (req.method === 'GET' && path === '/api/undohaven/login/poll') {
          if (!runtime.pending) {
            send(res, 400, { error: 'no_login', zh: '还没开始登录', en: 'Login has not started' })
            return
          }
          try {
            const token = await new CloudClient({ apiBase: runtime.pending.apiBase }).deviceToken(runtime.pending.deviceCode)
            runtime.pending.token = token
            send(res, 200, { pending: false, userId: token.user_id })
          } catch (error) {
            if (error.code === 'authorization_pending' || error.code === 'slow_down') {
              send(res, 200, { pending: true })
              return
            }
            throw error
          }
          return
        }
        if (req.method === 'POST' && path === '/api/undohaven/login/finish') {
          const body = JSON.parse((await readBody(req)).toString('utf8') || '{}')
          if (!runtime.pending?.token) {
            send(res, 400, { error: 'not_authorized', zh: '设备还没授权', en: 'The device is not authorized yet' })
            return
          }
          const authed = new CloudClient({ apiBase: runtime.pending.apiBase, token: runtime.pending.token.access_token })
          const account = await authed.account()
          let created = false
          if (!account.keys) {
            const keys = await establishKeys(paths.dataDir, String(body.passphrase || ''))
            await authed.putKeys({ ...publicKeyFields(keys), rotate: false })
            runtime.recoveryWords = keys.words
            created = true
          } else {
            await unlockPassphrase(paths.dataDir, String(body.passphrase || ''), {
              salt: account.keys.salt,
              kdf: account.keys.kdf,
              wrappedDek: account.keys.wrappedDek,
              wrappedDekRecovery: account.keys.wrappedDekRecovery,
            })
          }
          await saveConfig(paths.dataDir, {
            apiBase: runtime.pending.apiBase,
            accessToken: runtime.pending.token.access_token,
            userId: runtime.pending.token.user_id,
            deviceId: runtime.pending.token.device_id,
            includeCredentials: false,
          })
          const words = runtime.recoveryWords
          runtime.recoveryWords = null
          runtime.pending = null
          send(res, 200, {
            ok: true,
            created,
            recoveryWords: words || null,
            zh: created ? '把恢复码抄到机器外面。口令和恢复码都丢了就无法解密。' : '已用口令解开。',
            en: created ? 'Copy the recovery code off this machine. Losing both passphrase and recovery code makes the backup undecryptable.' : 'Unlocked with the passphrase.',
          })
          return
        }
        send(res, 404, { error: 'not_found', zh: '没有这个接口', en: 'No such route' })
      } catch (error) {
        runtime.lastError = error.message
        send(res, 500, { error: error.code || 'error', zh: error.zh || error.message, en: error.en || error.message })
      }
    },
  })
}

export function apply(ctx, config) {
  const runtime = createRuntime(ctx, config)
  const booting = runtime.boot()
  runtime.startTimer()
  let unmount = () => {}
  if (ctx.webServer?.register) unmount = mount(ctx.webServer, runtime) || (() => {})
  else if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (scoped) => mount(scoped.webServer, runtime))
  }
  return async () => {
    unmount()
    await booting
    await runtime.shutdown()
  }
}

export default { name, inject, Config, apply }
