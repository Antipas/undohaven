import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { createConnection } from 'node:net'
import { join, resolve } from 'node:path'
import { HouhuiError } from './errors.js'

const PYTHON = `
import errno, fcntl, os, sys
fd = os.open(sys.argv[1], os.O_RDONLY)
try:
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError as exc:
        if exc.errno in (errno.EAGAIN, errno.EWOULDBLOCK):
            sys.exit(2)
        raise
    else:
        fcntl.flock(fd, fcntl.LOCK_UN)
        sys.exit(0)
finally:
    os.close(fd)
`

function devParts(dev) {
  const major = (dev >> 8) & 0xfff
  const minor = (dev & 0xff) | ((dev >> 12) & 0xfff00)
  return { major, minor }
}

function procLocksHeld(file) {
  if (process.platform !== 'linux' || !existsSync('/proc/locks')) return { supported: false }
  let st
  try {
    st = statSync(file)
  } catch {
    return { supported: true, held: false }
  }
  const { major, minor } = devParts(st.dev)
  const text = readFileSync('/proc/locks', 'utf8')
  for (const line of text.split('\n')) {
    const match = /(\d+):([0-9a-f]+):(\d+)/i.exec(line)
    if (!match) continue
    if (Number.parseInt(match[1], 10) === major && Number.parseInt(match[2], 16) === minor && Number(match[3]) === st.ino) {
      return { supported: true, held: true }
    }
  }
  return { supported: true, held: false }
}

/** Same name dsh uses on Windows: Local\\dsh-session-lock-<sha256 of the lowercased path>. */
export function windowsSessionSemaphoreName(lockPath) {
  const hash = createHash('sha256').update(resolve(lockPath).toLowerCase()).digest('hex')
  return `Local\\dsh-session-lock-${hash}`
}

export function textListsDshProcess(text) {
  return /\bdsh\.exe\b/i.test(text) || /@deepseek-ai\/dsh\b/.test(text)
}

function windowsSemaphoreHeld(lockPath) {
  const name = windowsSessionSemaphoreName(lockPath).replaceAll("'", "''")
  const script = `
try {
  $sem = [System.Threading.Semaphore]::OpenExisting('${name}')
  if ($sem.WaitOne(0)) { $sem.Release() | Out-Null; 'FREE' } else { 'HELD' }
} catch { 'ABSENT' }
`
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8' })
  return (result.stdout || '').includes('HELD')
}

/** True when another process holds an exclusive advisory lock on the file. */
export function fileLockHeld(file) {
  if (!existsSync(file)) return { supported: true, held: false, exists: false }
  if (process.platform === 'win32') return { supported: false, held: false, exists: true }
  const py = spawnSync('python3', ['-c', PYTHON, file], { encoding: 'utf8' })
  if (!py.error && py.status === 0) return { supported: true, held: false, exists: true }
  if (!py.error && py.status === 2) return { supported: true, held: true, exists: true }
  const viaProc = procLocksHeld(file)
  if (viaProc.supported) return { ...viaProc, exists: true }
  return { supported: false, held: false, exists: true }
}

export function portOpen(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host })
    const finish = (open) => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(open)
    }
    socket.setTimeout(400, () => finish(false))
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}

async function collectLockFiles(root) {
  const { readdir, stat } = await import('node:fs/promises')
  const found = []
  async function walk(dir, depth) {
    if (depth > 8) return
    let entries = []
    try {
      entries = await readdir(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry === 'node_modules' || entry === 'cache') continue
      const abs = join(dir, entry)
      let st
      try {
        st = await stat(abs)
      } catch {
        continue
      }
      if (st.isDirectory()) await walk(abs, depth + 1)
      else if (entry === 'session.lock' || abs.endsWith(`${join('profiles', 'desktop', 'lock')}`)) found.push(abs)
    }
  }
  const desktop = join(root, 'profiles', 'desktop', 'lock')
  await walk(join(root, 'sessions'), 0)
  try {
    const st = await stat(desktop)
    if (st.isFile()) found.push(desktop)
  } catch {
    /* no desktop lock */
  }
  return found
}

/**
 * Restore is allowed only when dsh is not holding a session or desktop lock
 * and nothing is listening on the desktop port (3999).
 */
export async function assertDshStopped(dshHome, env = process.env) {
  if (env.UNDOHAVEN_ASSUME_DSH_STOPPED === '1') {
    return { running: false, assumed: true, reasons: [] }
  }
  const reasons = []
  const locks = await collectLockFiles(dshHome)
  let unsupported = false
  if (process.platform === 'win32') {
    const listing = spawnSync('tasklist', ['/FO', 'CSV'], { encoding: 'utf8' })
    if (textListsDshProcess(`${listing.stdout || ''}\n${listing.stderr || ''}`)) {
      reasons.push({ code: 'process_running', path: 'dsh.exe' })
    }
    for (const file of locks) {
      if (windowsSemaphoreHeld(file)) reasons.push({ code: 'lock_held', path: file })
    }
  } else {
    for (const file of locks) {
      const held = fileLockHeld(file)
      if (!held.supported) {
        unsupported = true
        reasons.push({ code: 'lock_check_unsupported', path: file })
      } else if (held.held) {
        reasons.push({ code: 'lock_held', path: file })
      }
    }
  }
  const ports = [3999]
  if (env.UNDOHAVEN_DSH_PORT) ports.push(Number(env.UNDOHAVEN_DSH_PORT))
  for (const port of ports) {
    if (!Number.isFinite(port)) continue
    if (await portOpen(port) || await portOpen(port, '::1')) {
      reasons.push({ code: 'port_open', path: String(port) })
    }
  }
  if (reasons.some((reason) => reason.code === 'lock_held' || reason.code === 'port_open' || reason.code === 'lock_check_unsupported')) {
    const zh = unsupported
      ? '无法确认 dsh 已停止（当前系统不能检查锁）。Windows 的会话锁是命名信号量。设置 UNDOHAVEN_ASSUME_DSH_STOPPED=1 前请先退出 dsh。'
      : 'dsh 仍在运行。请先退出再恢复，避免和正在写入的会话互相覆盖。'
    const en = unsupported
      ? 'Cannot prove dsh is stopped on this OS. Windows session locks are named semaphores. Exit dsh before setting UNDOHAVEN_ASSUME_DSH_STOPPED=1.'
      : 'dsh is still running. Quit it before restore so a live writer cannot race the rollback.'
    throw new HouhuiError('dsh_running', zh, en, { exitCode: 3, details: reasons })
  }
  return { running: false, reasons }
}
