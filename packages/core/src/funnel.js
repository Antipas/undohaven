import { loadConfig } from './keys.js'
import { readPrompts, writePrompts } from './prompts.js'

export const ANONYMOUS_FUNNEL = new Set(['install', 'first_snapshot', 'rollback', 'limit_hit'])

const SCOPES = new Set(['sessions', 'storages', 'config', 'all'])
const LIMITS = new Set(['quota', 'device', 'snapshot'])

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
  return null
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
