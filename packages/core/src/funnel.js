import { loadConfig } from './keys.js'
import { readPrompts, writePrompts } from './prompts.js'

export const ANONYMOUS_FUNNEL = new Set(['install', 'first_snapshot', 'rollback', 'limit_hit', 'copy_install'])

const SCOPES = new Set(['sessions', 'storages', 'config', 'all'])
const LIMITS = new Set(['quota', 'device', 'snapshot', 'history'])
const UTM_SOURCES = new Set(['github', 'x', 'awesome', 'direct'])

export const TRIAL_URL = 'https://undohaven.com/pricing?utm_source=cli&utm_medium=limit'

export function funnelOptedIn(config, env = {}) {
  const flag = env.UNDOHAVEN_FUNNEL
  if (flag === '0' || flag === 'false') return false
  if (flag === '1' || flag === 'true') return true
  return config?.funnelOptIn === true
}

export function anonymousMeta(name, meta) {
  if (name === 'rollback') {
    const scope = SCOPES.has(meta?.scope) ? meta.scope : 'all'
    return { scope }
  }
  if (name === 'limit_hit') {
    const reason = LIMITS.has(meta?.reason) ? meta.reason : 'quota'
    return { reason }
  }
  if (name === 'copy_install') {
    const source = UTM_SOURCES.has(meta?.source) ? meta.source : 'direct'
    return { source }
  }
  return null
}

export function limitNudgeLine(kind) {
  if (kind === 'history') {
    return `Free history is 7 days. A 14-day Pro trial needs no card: ${TRIAL_URL}`
  }
  return `A second device needs Pro. A 14-day trial needs no card: ${TRIAL_URL}`
}

/** Print-once local flag. The funnel ping stays inside reportAnonymousEvent, so it is sent only when opted in. */
export async function showLimitNudge(dataDir, kind, env = process.env) {
  const prompts = await readPrompts(dataDir)
  const nudges = prompts.nudges && typeof prompts.nudges === 'object' ? { ...prompts.nudges } : {}
  if (nudges[kind]) return { shown: false, line: '' }
  nudges[kind] = true
  prompts.nudges = nudges
  await writePrompts(dataDir, prompts)
  const reason = kind === 'history' ? 'history' : 'device'
  await reportAnonymousEvent(dataDir, 'limit_hit', { reason }, env).catch(() => {})
  return { shown: true, line: limitNudgeLine(kind) }
}

/** Opt-in, account-free funnel ping. No token is sent. */
export async function reportAnonymousEvent(dataDir, name, meta, env = process.env) {
  if (!ANONYMOUS_FUNNEL.has(name)) return { sent: false, reason: 'name' }
  const config = await loadConfig(dataDir)
  if (!funnelOptedIn(config, env)) return { sent: false, reason: 'opt-out' }
  const prompts = await readPrompts(dataDir)
  const funnel = prompts.funnel && typeof prompts.funnel === 'object' ? { ...prompts.funnel } : {}
  if ((name === 'install' || name === 'first_snapshot') && funnel[name]) return { sent: false, reason: 'once' }
  const clean = anonymousMeta(name, meta)
  if (name === 'limit_hit') {
    const seen = funnel.limits && typeof funnel.limits === 'object' ? { ...funnel.limits } : {}
    if (seen[clean.reason]) return { sent: false, reason: 'once' }
    funnel.limits = seen
  }
  const apiBase = String(config.apiBase || env.UNDOHAVEN_API || 'https://undohaven.com').replace(/\/$/, '')
  let response
  try {
    response = await fetch(`${apiBase}/v1/events/anonymous`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, meta: clean }),
    })
  } catch {
    return { sent: false, reason: 'offline' }
  }
  if (!response.ok) return { sent: false, reason: 'http' }
  if (name === 'install' || name === 'first_snapshot') funnel[name] = true
  if (name === 'limit_hit') funnel.limits[clean.reason] = true
  prompts.funnel = funnel
  await writePrompts(dataDir, prompts)
  return { sent: true }
}
