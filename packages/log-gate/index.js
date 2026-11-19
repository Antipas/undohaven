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

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/**
 * Register on connection.fetch. dsh 0.2.2-rc.4 admits that route inside the
 * shared /api handler (Host/Origin, then the Peer) before fetch runs.
 * A webServer.register route on the same prefix can be dispatched first and
 * skip that admission. Missing fetch.register mounts nothing.
 */
export function mount(connection, ctx, config) {
  if (typeof connection?.fetch?.register !== 'function') return () => {}
  const stop = connection.fetch.register({
    path: '/api/log-gate/status',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => {
      const live = typeof ctx.sessions?.list === 'function' ? ctx.sessions.list() : []
      const rows = classifyLive(live, config)
      return jsonResponse(200, { ...currentRules(config), sessions: rows, message: statusMessage(rows, config) })
    },
  })
  return () => {
    const result = stop?.()
    if (result && typeof result.then === 'function') result.catch(() => {})
  }
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
    if (typeof host?.connection?.fetch?.register === 'function') unmount = mount(host.connection, host, config) || (() => {})
  }
  if (typeof ctx.connection?.fetch?.register === 'function') attach(ctx)
  else if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['connection'], (child) => { attach(child) })
    } catch {
      /* the status route is optional */
    }
  }
  return () => {
    unmount()
    return stop?.()
  }
}
