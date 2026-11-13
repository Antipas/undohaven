import { basename, matchesGlob, resolve, sep } from 'node:path'

/** True when a rule uses glob metacharacters. */
export function hasGlob(rule) {
  return /[*?[\]]/.test(rule)
}

/**
 * Match a session cwd against one rule.
 * A rule with no slash and no glob is a project name (the cwd basename).
 * A path matches that directory and anything inside it.
 * A glob is tested against the cwd and against a `/**` suffix.
 */
export function ruleMatches(cwd, rule) {
  const raw = String(rule || '').trim()
  if (!raw) return false
  if (raw === '*' || raw === '**') return true
  const glob = hasGlob(raw)
  if (!raw.includes('/') && !raw.includes('\\') && !glob) return basename(cwd) === raw
  const abs = resolve(cwd)
  if (!glob) {
    const target = resolve(raw)
    const prefix = target.endsWith(sep) ? target : `${target}${sep}`
    if (abs === target || abs.startsWith(prefix)) return true
  }
  if (matchesGlob(abs, raw)) return true
  if (!raw.endsWith('/**') && matchesGlob(abs, `${raw.replace(/\/$/, '')}/**`)) return true
  return false
}

/**
 * Decide whether one session's log upload should be omitted.
 * `all` blocks every session id, even when cwd is unknown.
 * `listed` blocks only matching rules. An unknown cwd is not blocked:
 * the official exclusion callback does not include a path.
 */
export function decideBlock({ mode, rules, cwd }) {
  if (mode !== 'listed') return { blocked: true, reason: 'all' }
  if (!cwd) return { blocked: false, reason: 'cwd-unknown' }
  for (const rule of rules || []) {
    if (ruleMatches(cwd, rule)) return { blocked: true, reason: String(rule) }
  }
  return { blocked: false, reason: 'no-match' }
}
