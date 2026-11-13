import { open, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { toRel } from './paths.js'

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
  if (isCredential(rel, name)) return opts.includeCredentials ? 'include' : 'exclude'
  if (base === 'profiles' && name === 'cordis.yml') return 'exclude'
  if (base === 'storages' && parts[1] === 'session_projcache') return 'skip-tree'
  if (isSqliteSidecar(name)) return 'exclude'
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
  if (isCredential(rel, name) && !opts.includeCredentials) return 'exclude'
  if (rel === 'AGENTS.md' || rel.startsWith('skills/')) return 'include'
  return 'exclude'
}

function isCredential(rel, name) {
  return rel === '.credentials.yaml' || name === '.credentials.yaml' || rel === '.env' || name === '.env'
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
    let st
    try {
      st = await stat(abs)
    } catch {
      return
    }
    if (st.isSymbolicLink()) return
    if (st.isDirectory()) {
      if (rel && classify(rel, opts) === 'skip-tree') return
      if (rel && isStraySessionsDir(rel.split('/').pop())) return
      let entries = []
      try {
        entries = await readdir(abs)
      } catch {
        return
      }
      for (const entry of entries) {
        const childRel = rel ? `${rel}/${entry}` : entry
        await walk(join(abs, entry), childRel)
      }
      return
    }
    if (!st.isFile() || !rel) return
    const decision = classify(rel, opts)
    if (decision !== 'include') return
    const sqlite = await looksLikeSqlite(abs)
    files.push({
      root: rootKind,
      rel,
      abs,
      mtimeMs: st.mtimeMs,
      mode: st.mode,
      size: st.size,
      sqlite,
      session: rootKind === 'dsh' && rel.startsWith('sessions/') && isSessionFile(rel.split('/').pop()),
    })
  }
  await walk(root, '')
  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
  return files
}
