import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'

export function expandHome(path) {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

function resolveRoot(configured, envValue, fallback) {
  const selected = configured ?? (envValue !== undefined && String(envValue).trim() !== '' ? envValue : fallback)
  return resolve(expandHome(String(selected)))
}

/** explicit > DSH_HOME > ~/.dsh. Blank DSH_HOME is unset. */
export function resolveDshHome(configured, env = process.env) {
  return resolveRoot(configured, env.DSH_HOME, join(homedir(), '.dsh'))
}

/** explicit > DSH_AGENTS_HOME > ~/.agents. */
export function resolveAgentsHome(configured, env = process.env) {
  return resolveRoot(configured, env.DSH_AGENTS_HOME, join(homedir(), '.agents'))
}

/**
 * UndoHaven state lives under the dsh home so it travels with that home.
 * explicit path > UNDOHAVEN_HOME > `<DSH_HOME>/undohaven`.
 */
export function resolveDataDir(configured, env = process.env, dshHome) {
  if (configured) return resolve(expandHome(String(configured)))
  const fromEnv = env.UNDOHAVEN_HOME
  if (fromEnv !== undefined && String(fromEnv).trim() !== '') return resolve(expandHome(String(fromEnv)))
  return join(dshHome || resolveDshHome(undefined, env), 'undohaven')
}

export function toRel(path) {
  return path.split(sep).join('/')
}

export function safeJoin(root, rel) {
  if (typeof rel !== 'string' || rel.length === 0 || rel.includes('\0')) {
    throw new Error('refusing an empty or nul path')
  }
  if (rel.startsWith('/') || rel.startsWith('\\') || /^[A-Za-z]:/.test(rel)) {
    throw new Error(`refusing absolute path ${rel}`)
  }
  const parts = rel.split('/')
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw new Error(`refusing unsafe relative path ${rel}`)
  }
  const abs = resolve(root, ...parts)
  const base = resolve(root)
  if (abs !== base && !abs.startsWith(base + sep)) throw new Error(`path escapes root: ${rel}`)
  return abs
}
