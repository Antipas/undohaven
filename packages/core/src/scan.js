import { lstat, open, readdir, realpath } from 'node:fs/promises'
import { basename, join } from 'node:path'

export const DEFAULT_MAX_FILE_BYTES = 64 * 1024 * 1024

const MODEL_WEIGHT = /\.(?:safetensors|gguf|ggml|pt|pth|onnx|ckpt|tflite|mlmodel)$/i

export function isModelWeight(name) {
  return MODEL_WEIGHT.test(name) || /(?:^|[._-])(?:pytorch_)?model.*\.bin$/i.test(name)
}

/** True when `child` is a symlink, junction, or other link that leaves `parent`. */
export async function escapesTree(parentAbs, childAbs) {
  try {
    const parentReal = await realpath(parentAbs)
    const childReal = await realpath(childAbs)
    return childReal !== join(parentReal, basename(childAbs))
  } catch {
    return true
  }
}

const KNOWN_TOP = new Set(['sessions', 'storages', 'profiles', 'skills', 'attachments', 'cache', 'undohaven'])
const SESSION_FILE = /^session(?:\.v\d+)?\.jsonl(?:\.zstd)?$/

export function isSessionFile(name) {
  return SESSION_FILE.test(name)
}

export function isStraySessionsDir(name) {
  return name === 'sessions~' || /^sessions~\d*$/.test(name) || name.includes('sessions~')
}

/**
 * Classify a forward-slash path relative to DSH_HOME.
 * `sqlite` means "include, but the reader must check the SQLite header".
 * @returns {'include' | 'exclude' | 'skip-tree'}
 */
export function classifyDsh(rel, opts = {}) {
  const parts = rel.split('/')
  const base = parts[0]
  const name = parts[parts.length - 1]
  if (isStraySessionsDir(base) || parts.some((part) => isStraySessionsDir(part))) return 'exclude'
  if (name === 'session.lock') return 'exclude'
  if (parts.includes('node_modules')) return 'skip-tree'
  if (base === 'cache' || base === 'undohaven') return 'skip-tree'
  if (rel === '.anonymous-user-id' || name === '.anonymous-user-id') return 'exclude'
  if (isAlwaysSecret(name)) return 'exclude'
  if (isCredential(rel, name)) return opts.includeCredentials ? 'include' : 'exclude'
  if (base === 'profiles' && name === 'cordis.yml') return 'exclude'
  if (base === 'storages' && parts[1] === 'session_projcache') return 'skip-tree'
  if (isSqliteSidecar(name)) return 'exclude'
  if (isModelWeight(name)) return 'exclude'
  if (base === 'sessions') return isSessionFile(name) ? 'include' : 'exclude'
  if (base === 'storages') return 'include'
  if (base === 'profiles' && parts.length === 3 && ['package.json', 'pnpm-lock.yaml', 'cordis.patch.yml'].includes(name)) {
    return 'include'
  }
  if (base === 'profiles') return 'exclude'
  if (rel === 'cordis.patch.yml') return 'include'
  if (base === 'skills' || base === 'attachments') return 'include'
  if (base.startsWith('.')) return 'exclude'
  if (!KNOWN_TOP.has(base)) return 'include'
  return 'exclude'
}

export function classifyAgents(rel, opts = {}) {
  const name = rel.split('/').pop()
  if (isModelWeight(name) || isAlwaysSecret(name)) return 'exclude'
  if (isCredential(rel, name) && !opts.includeCredentials) return 'exclude'
  if (rel === 'AGENTS.md' || rel.startsWith('skills/')) return 'include'
  return 'exclude'
}

const ALWAYS_SECRET = /^(?:auth\.json|secrets\.json|id_rsa|id_ed25519|id_ecdsa|id_dsa|.*\.(?:pem|key))$/i

export function isAlwaysSecret(name) {
  return ALWAYS_SECRET.test(name)
}

function isCredential(rel, name) {
  return rel === '.credentials.yaml' || name === '.credentials.yaml' || rel === '.env' || name === '.env' || /^\.env\./.test(name)
}

function isSqliteSidecar(name) {
  return /\.(?:db|sqlite|sqlite3)-(?:wal|shm|journal)$/.test(name)
}

export async function looksLikeSqlite(abs) {
  const fh = await open(abs, 'r')
  try {
    const buf = Buffer.alloc(16)
    const { bytesRead } = await fh.read(buf, 0, 16, 0)
    return bytesRead >= 15 && buf.toString('utf8', 0, 15) === 'SQLite format 3'
  } catch {
    return false
  } finally {
    await fh.close()
  }
}

/**
 * @param {string} root
 * @param {'dsh' | 'agents'} rootKind
 */
export async function scanRoot(root, rootKind, opts = {}) {
  const files = []
  const classify = rootKind === 'agents' ? classifyAgents : classifyDsh
  async function walk(abs, rel) {
    let entries = []
    try {
      entries = await readdir(abs, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const childAbs = join(abs, entry.name)
      const childRel = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (await escapesTree(abs, childAbs)) continue
        if (classify(childRel, opts) === 'skip-tree') continue
        if (isStraySessionsDir(entry.name)) continue
        await walk(childAbs, childRel)
        continue
      }
      if (!entry.isFile()) continue
      const decision = classify(childRel, opts)
      if (decision !== 'include') continue
      let info
      try {
        info = await lstat(childAbs)
      } catch {
        continue
      }
      if (info.isSymbolicLink() || !info.isFile()) continue
      const max = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES
      if (info.size > max) continue
      const sqlite = await looksLikeSqlite(childAbs)
      files.push({
        root: rootKind,
        rel: childRel,
        abs: childAbs,
        mtimeMs: info.mtimeMs,
        mode: info.mode,
        size: info.size,
        sqlite,
        session: rootKind === 'dsh' && childRel.startsWith('sessions/') && isSessionFile(entry.name),
      })
    }
  }
  await walk(root, '')
  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
  return files
}
