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

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

async function readJson(request) {
  const text = await request.text()
  if (text.length > 1_000_000) {
    const error = new Error('body too large')
    error.status = 413
    throw error
  }
  return text ? JSON.parse(text) : {}
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

/**
 * dsh 0.2.2-rc.4 admits connection.fetch routes inside the shared /api
 * handler before the handler runs. webServer.register does not, so these
 * routes are not mounted there. Missing fetch.register mounts nothing.
 */
export function mount(connection, runtime) {
  if (typeof connection?.fetch?.register !== 'function') return () => {}
  const route = (path, methods, requestBody, fetch) => connection.fetch.register({ path, methods, requestBody, fetch })
  const guarded = (fetch) => async (request) => {
    try {
      return await fetch(request)
    } catch (error) {
      runtime.lastError = error.message
      return jsonResponse(error.status || 500, { error: error.code || 'error', zh: error.zh || error.message, en: error.en || error.message })
    }
  }
  const stops = [
    route('/api/undohaven/status', ['GET'], 'buffered', guarded(async () => {
      const paths = runtime.paths()
      let unlocked = true
      try {
        await loadDek(paths.dataDir)
      } catch {
        unlocked = false
      }
      const config = await loadConfig(paths.dataDir)
      const prompts = await readPrompts(paths.dataDir)
      return jsonResponse(200, {
        unlocked,
        loggedIn: !!config.accessToken,
        apiBase: config.apiBase,
        lastSnapshot: runtime.lastSnapshot,
        lastError: runtime.lastError,
        upgrade: prompts.upgrade || null,
        zh: unlocked ? '已解锁' : '未解锁，先在这里或命令行登录',
        en: unlocked ? 'Unlocked' : 'Locked. Log in here or with the CLI',
      })
    })),
  ]
  const pathsOf = () => runtime.paths()
  stops.push(route('/api/undohaven/snapshots', ['GET'], 'buffered', guarded(async () => {
    const paths = pathsOf()
    const { cloud } = await cloudFromConfig(paths.dataDir)
    const snapshots = await listSnapshots({ dataDir: paths.dataDir, cloud, allowCloudFailure: true })
    return jsonResponse(200, { snapshots })
  })))
  stops.push(route('/api/undohaven/snapshot', ['POST'], 'buffered', guarded(async () => {
    const snap = await runtime.snapshot('manual')
    return jsonResponse(200, { ok: !snap.cloudError, id: snap.id, bytes: snap.bytes, cloud: snap.cloud, error: runtime.lastError })
  })))
  stops.push(route('/api/undohaven/restore-plan', ['POST'], 'buffered', guarded(async (request) => {
    const body = await readJson(request)
    const scope = ['sessions', 'storages', 'config', 'all'].includes(body.scope) ? body.scope : 'all'
    const id = String(body.id || '')
    return jsonResponse(200, {
      blocked: true,
      zh: '恢复必须先退出 dsh。桌面端的紧急恢复可能会卸掉第三方插件，所以这一步交给独立命令。',
      en: 'Restore runs only after dsh has quit. Desktop fatal recovery can remove third-party plugins, so this step belongs to the standalone command.',
      command: `undohaven restore --to ${id} --scope ${scope}`,
    })
  })))
  stops.push(route('/api/undohaven/login/start', ['POST'], 'buffered', guarded(async (request) => {
    const body = await readJson(request)
    const paths = pathsOf()
    const apiBase = body.apiBase || (await loadConfig(paths.dataDir)).apiBase
    if (!apiBase) return jsonResponse(400, { error: 'need_api', zh: '需要 API 地址', en: 'API base URL is required' })
    const code = await new CloudClient({ apiBase }).deviceCode({ name: 'dsh-undohaven', purpose: 'login' })
    runtime.pending = { apiBase, deviceCode: code.device_code, userCode: code.user_code }
    return jsonResponse(200, { user_code: code.user_code, verification_uri: code.verification_uri, interval: code.interval })
  })))
  stops.push(route('/api/undohaven/login/poll', ['GET'], 'buffered', guarded(async () => {
    if (!runtime.pending) return jsonResponse(400, { error: 'no_login', zh: '还没开始登录', en: 'Login has not started' })
    try {
      const token = await new CloudClient({ apiBase: runtime.pending.apiBase }).deviceToken(runtime.pending.deviceCode)
      runtime.pending.token = token
      return jsonResponse(200, { pending: false, userId: token.user_id })
    } catch (error) {
      if (error.code === 'authorization_pending' || error.code === 'slow_down') return jsonResponse(200, { pending: true })
      throw error
    }
  })))
  stops.push(route('/api/undohaven/login/finish', ['POST'], 'buffered', guarded(async (request) => {
    const body = await readJson(request)
    const paths = pathsOf()
    if (!runtime.pending?.token) return jsonResponse(400, { error: 'not_authorized', zh: '设备还没授权', en: 'The device is not authorized yet' })
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
    return jsonResponse(200, {
      ok: true,
      created,
      recoveryWords: words || null,
      zh: created ? '把恢复码抄到机器外面。口令和恢复码都丢了就无法解密。' : '已用口令解开。',
      en: created ? 'Copy the recovery code off this machine. Losing both passphrase and recovery code makes the backup undecryptable.' : 'Unlocked with the passphrase.',
    })
  })))
  return () => {
    for (const stop of stops) {
      const result = stop?.()
      if (result && typeof result.then === 'function') result.catch(() => {})
    }
  }
}

export function apply(ctx, config) {
  const runtime = createRuntime(ctx, config)
  const booting = runtime.boot()
  runtime.startTimer()
  let unmount = () => {}
  const attach = (host) => {
    if (typeof host?.connection?.fetch?.register === 'function') unmount = mount(host.connection, runtime) || (() => {})
  }
  if (typeof ctx.connection?.fetch?.register === 'function') attach(ctx)
  else if (typeof ctx.inject === 'function') ctx.inject(['connection'], (scoped) => attach(scoped))
  return async () => {
    unmount()
    await booting
    await runtime.shutdown()
  }
}

export default { name, inject, Config, apply }
