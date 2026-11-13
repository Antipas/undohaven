import Schema from '@deepseek-ai/schemastery'
import { decideBlock } from './src/match.js'

export const name = 'log-gate'
export const inject = ['sessionLogDeepSeek', 'sessions']

export const Config = Schema.object({
  mode: Schema.union(['all', 'listed']).default('all').volatile(),
  rules: Schema.array(Schema.string()).default([]).volatile(),
})

function read(value, fallback) {
  if (value && typeof value === 'object' && typeof value.get === 'function') {
    const got = value.get()
    return got === undefined || got === null ? fallback : got
  }
  return value === undefined || value === null ? fallback : value
}

export function currentRules(config = {}) {
  return {
    mode: read(config.mode, 'all') === 'listed' ? 'listed' : 'all',
    rules: [...read(config.rules, [])],
  }
}

export function classifyLive(sessions, config) {
  const rules = currentRules(config)
  return [...sessions].map((session) => {
    const cwd = session?.header?.cwd || null
    const decision = decideBlock({ ...rules, cwd })
    return {
      id: session?.id || null,
      cwd,
      blocked: decision.blocked,
      reason: decision.reason,
    }
  })
}

export function statusMessage(rows, config) {
  const rules = currentRules(config)
  const blocked = rows.filter((row) => row.blocked).length
  const open = rows.length - blocked
  if (rules.mode === 'all') {
    return `dsh-log-gate: session-log upload is blocked for every live session (${blocked} blocked, ${open} still eligible). Telemetry is a separate switch. / 日志闸门：当前实时会话的官方会话日志上传都已拦住（拦住 ${blocked}，仍会上传 ${open}）。遥测是另一个开关。`
  }
  return `dsh-log-gate: listed rules, ${blocked} live session(s) blocked, ${open} still eligible. Unknown cwd is not blocked. / 日志闸门：按列出的规则，拦住 ${blocked} 个实时会话，${open} 个仍会上传。读不到 cwd 时不拦。`
}

function log(ctx, message) {
  if (typeof ctx?.logger?.info === 'function') ctx.logger.info(message)
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

export function mount(webServer, ctx, config) {
  return webServer.register({
    kind: 'prefix',
    path: '/api/log-gate',
    async handler(req, res) {
      const address = req.socket?.remoteAddress || ''
      if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') {
        send(res, 403, { error: 'loopback' })
        return
      }
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      if (req.method === 'GET' && (url.pathname === '/api/log-gate/status' || url.pathname === '/status')) {
        const live = typeof ctx.sessions?.list === 'function' ? ctx.sessions.list() : []
        const rows = classifyLive(live, config)
        send(res, 200, { ...currentRules(config), sessions: rows, message: statusMessage(rows, config) })
        return
      }
      send(res, 404, { error: 'not_found' })
    },
  })
}

export function apply(ctx, config = {}) {
  const exclude = (request) => {
    const session = ctx.sessions?.get?.(request.sessionId)
    return decideBlock({ ...currentRules(config), cwd: session?.header?.cwd }).blocked
  }
  const stop = ctx.sessionLogDeepSeek.registerExclusion(exclude)
  const rows = classifyLive(typeof ctx.sessions?.list === 'function' ? ctx.sessions.list() : [], config)
  log(ctx, statusMessage(rows, config))
  let unmount = () => {}
  const attach = (host) => {
    if (host?.webServer?.register) unmount = mount(host.webServer, host, config) || (() => {})
  }
  if (ctx.webServer?.register) attach(ctx)
  else if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['webServer'], (child) => { attach(child) })
    } catch {
      /* settings UI is optional */
    }
  }
  return () => {
    unmount()
    return stop?.()
  }
}
