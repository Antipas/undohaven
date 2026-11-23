import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export const TOKEN_HEADER = 'x-undohaven-token'
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1'])

export function ensureRouteToken(file) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  if (existsSync(file)) {
    const text = readFileSync(file, 'utf8').trim()
    if (text) {
      chmodSync(file, 0o600)
      return text
    }
  }
  const token = randomBytes(32).toString('hex')
  writeFileSync(file, `${token}\n`, { mode: 0o600 })
  chmodSync(file, 0o600)
  return token
}

function headerHost(request) {
  const raw = request.headers.get('host') || new URL(request.url).host
  return String(raw).trim().toLowerCase()
}

function hostnameOf(host) {
  try {
    return new URL(`http://${host}`).hostname.replace(/^\[|\]$/g, '')
  } catch {
    return ''
  }
}

/** The dsh web UI is the loopback host. A page on any other origin is rejected. */
export function originAllowed(request) {
  const host = headerHost(request)
  if (!LOOPBACK.has(hostnameOf(host))) return false
  const site = (request.headers.get('sec-fetch-site') || '').toLowerCase()
  if (site === 'cross-site' || site === 'same-site') return false
  const origin = request.headers.get('origin')
  if (!origin) return true
  try {
    return new URL(origin).host.toLowerCase() === host
  } catch {
    return false
  }
}

export function authorize(request, token) {
  if (!originAllowed(request)) return { ok: false, status: 403, code: 'cross_origin' }
  const presented = request.headers.get(TOKEN_HEADER) || ''
  if (!token || presented !== token) return { ok: false, status: 403, code: 'bad_token' }
  return { ok: true }
}

/** Settings-page bootstrap. Same-origin only, so a cross-origin page cannot read the token. */
export function tokenBootstrapAllowed(request) {
  const origin = request.headers.get('origin')
  if (!origin) return false
  return originAllowed(request)
}
