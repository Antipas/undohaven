import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { HouhuiError } from './errors.js'
import { createFileSnapshot, restoreFileSnapshot } from './filesnap.js'
import { isAlwaysSecret } from './scan.js'

/** Extra encrypted copy. Not a promise that every accidental delete can be restored. */
export const DELETE_LAYER_COPY = {
  zh: '多一层留底。不能保证每次误删都能找回来。',
  en: 'An extra backup layer. This does not guarantee that every accidental delete can be restored.',
}

export const DELETE_BACKUP_MAX_BYTES = 500 * 1024 * 1024
export const DEFAULT_RETAIN_DAYS = 30
const CONFIRM_MS = 10 * 60 * 1000
const LEDGER = 'delete-ledger.json'

const UNIX_RM = new Set(['rm'])
const WIN_DELETE = new Set(['rd', 'rmdir', 'del', 'erase'])
const PS_DELETE = new Set(['remove-item', 'ri'])
const WRAPPERS = new Set(['cmd', 'powershell', 'pwsh', 'bash', 'sh'])

function layer(zh, en) {
  return `${zh} / ${en} ${DELETE_LAYER_COPY.zh} / ${DELETE_LAYER_COPY.en}`
}

function platformPath(platform) {
  return platform === 'win32' ? path.win32 : path.posix
}

export function deleteContext(opts = {}) {
  const platform = opts.platform || process.platform
  const home = opts.home || homedir()
  const userProfile = opts.userProfile || opts.env?.USERPROFILE || home
  const p = platformPath(platform)
  const dshHome = opts.dshHome || p.join(home, '.dsh')
  const cwd = opts.cwd || (platform === process.platform ? process.cwd() : home)
  return { platform, home, userProfile, dshHome, cwd, env: opts.env || {} }
}

function tokenizeShell(input, platform) {
  const s = String(input)
  const tokens = []
  let cur = ''
  let quote = null
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i]
    if (quote) {
      if (ch === quote) quote = null
      else cur += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (platform !== 'win32' && ch === '\\' && i + 1 < s.length) {
      cur += s[i + 1]
      i += 1
      continue
    }
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      if (cur) tokens.push(cur)
      cur = ''
      continue
    }
    cur += ch
  }
  if (quote) return { ok: false, code: 'unbalanced_quotes', tokens }
  if (cur) tokens.push(cur)
  return { ok: true, tokens }
}

function unwrapCommand(command, platform, depth = 0) {
  const parsed = tokenizeShell(command, platform)
  if (!parsed.ok) return parsed
  if (depth > 4 || parsed.tokens.length < 3) return { ok: true, tokens: parsed.tokens, platform }
  const bin = parsed.tokens[0].toLowerCase().replace(/\.exe$/, '')
  const flag = parsed.tokens[1].toLowerCase()
  if (!WRAPPERS.has(bin)) return { ok: true, tokens: parsed.tokens, platform }
  const cmdWrap = bin === 'cmd' && (flag === '/c' || flag === '/k')
  const shellWrap = (bin === 'powershell' || bin === 'pwsh') && (flag === '-command' || flag === '-c' || flag === '/c')
  const bashWrap = (bin === 'bash' || bin === 'sh') && (flag === '-c' || flag === '-lc' || flag === '-command')
  if (!cmdWrap && !shellWrap && !bashWrap) return { ok: true, tokens: parsed.tokens, platform }
  const innerPlatform = cmdWrap || shellWrap ? 'win32' : platform
  return unwrapCommand(parsed.tokens.slice(2).join(' '), innerPlatform, depth + 1)
}

function unixRecursive(flag) {
  if (flag === '--recursive') return true
  if (!flag.startsWith('-') || flag.startsWith('--')) return false
  const letters = flag.slice(1)
  return letters.includes('r') || letters.includes('R')
}

function winRecursive(flag) {
  return flag.toLowerCase() === '/s'
}

function psRecursive(flag) {
  const f = flag.toLowerCase()
  return f === '-recurse' || f === '-recursive' || f === '-r' || f.startsWith('-recurse:')
}

function commandKind(name) {
  if (UNIX_RM.has(name) || WIN_DELETE.has(name) || PS_DELETE.has(name)) return name
  return null
}

function expandUser(raw, ctx) {
  let s = String(raw).trim()
  if (s === '~') return ctx.home
  if (s.startsWith('~/') || s.startsWith('~\\')) return platformPath(ctx.platform).join(ctx.home, s.slice(2))
  if (ctx.platform === 'win32') {
    s = s.replace(/%USERPROFILE%/gi, ctx.userProfile || ctx.home)
    s = s.replace(/%HOME%/gi, ctx.home)
  }
  if (s === '$HOME' || s === '${HOME}' || s === '$env:HOME' || s === '$env:USERPROFILE') return ctx.home
  if (s.startsWith('$HOME/') || s.startsWith('$HOME\\')) return platformPath(ctx.platform).join(ctx.home, s.slice(6))
  return s
}

export function normalizeDeletePath(raw, ctx) {
  const p = platformPath(ctx.platform)
  let s = expandUser(raw, ctx)
  if (ctx.platform === 'win32') {
    if (s.startsWith('\\\\?\\')) s = s.slice(4)
    s = s.replaceAll('/', '\\')
  }
  const abs = p.isAbsolute(s) ? p.normalize(s) : p.normalize(p.resolve(ctx.cwd, s))
  if (ctx.platform === 'win32') {
    if (/^[A-Za-z]:$/.test(abs)) return `${abs}\\`
    if (abs.length > 3 && /[\\/]$/.test(abs)) return abs.replace(/[\\/]+$/, '')
    return abs
  }
  if (abs.length > 1 && abs.endsWith('/')) return abs.replace(/\/+$/, '')
  return abs
}

function samePath(a, b, ctx) {
  if (ctx.platform === 'win32') return a.toLowerCase() === b.toLowerCase()
  return a === b
}

function isPrefixPath(parent, child, ctx) {
  if (samePath(parent, child, ctx)) return false
  const sep = ctx.platform === 'win32' ? '\\' : '/'
  const base = parent.endsWith(sep) ? parent : parent + sep
  if (ctx.platform === 'win32') return child.toLowerCase().startsWith(base.toLowerCase())
  return child.startsWith(base)
}

function isDriveRoot(abs, platform) {
  if (platform === 'win32') return /^[A-Za-z]:\\$/.test(abs) || /^[A-Za-z]:\\\*$/.test(abs)
  return abs === '/' || abs === '/*'
}

function protectionOf(abs, ctx) {
  if (isDriveRoot(abs, ctx.platform)) return 'drive-root'
  if (samePath(abs, normalizeDeletePath(ctx.home, ctx), ctx)) return 'home'
  if (ctx.userProfile && samePath(abs, normalizeDeletePath(ctx.userProfile, ctx), ctx)) return 'home'
  const dsh = normalizeDeletePath(ctx.dshHome, ctx)
  const fallback = normalizeDeletePath(platformPath(ctx.platform).join(ctx.home, '.dsh'), ctx)
  if (samePath(abs, dsh, ctx) || samePath(abs, fallback, ctx)) return 'dsh'
  return null
}

function tryRealpath(abs, ctx) {
  if (ctx.platform !== process.platform) return null
  try {
    return normalizeDeletePath(realpathSync(abs), ctx)
  } catch {
    return null
  }
}

function collectTargets(tokens, ctx) {
  if (!tokens.length) return { recursive: false }
  const name = tokens[0].toLowerCase().replace(/\.exe$/, '')
  if (!commandKind(name)) return { recursive: false }
  const paths = []
  let recursive = false
  let end = false
  for (let i = 1; i < tokens.length; i += 1) {
    const arg = tokens[i]
    if (arg === '--') {
      end = true
      continue
    }
    const lower = arg.toLowerCase()
    if (!end && (lower === '-path' || lower === '-literalpath' || lower === '-include')) {
      const next = tokens[i + 1]
      if (next) paths.push(next)
      i += 1
      continue
    }
    if (!end && arg.startsWith('-') && !arg.startsWith('--') && ctx.platform === 'win32' && PS_DELETE.has(name)) {
      if (psRecursive(arg)) recursive = true
      if (lower.startsWith('-path:') || lower.startsWith('-literalpath:')) paths.push(arg.slice(arg.indexOf(':') + 1))
      continue
    }
    const winSwitch = ctx.platform === 'win32' && /^\/[a-zA-Z](?:[:?].*)?$/.test(arg)
    if (!end && (arg.startsWith('-') || winSwitch)) {
      if (unixRecursive(arg) || winRecursive(arg) || psRecursive(arg)) recursive = true
      continue
    }
    paths.push(arg)
  }
  if (!recursive) return { recursive: false }
  if (!paths.length) return { recursive: true, ok: false, code: 'unbalanced_quotes' }
  return {
    recursive: true,
    ok: true,
    targets: paths.map((raw, index) => ({ raw, abs: normalizeDeletePath(raw, ctx), root: `t${index}` })),
  }
}

/**
 * Parse a shell command after it has been assembled and compare the
 * resolved targets with the paths the caller meant to delete.
 * Refuses a recursive delete of a drive root, a home directory, or .dsh.
 * Other listeners still run when this returns ignore, ask, or backup.
 */
export function evaluateDeleteCommand(input, opts = {}) {
  const ctx = deleteContext(opts)
  const command = String(input?.command || '')
  if (!command.trim()) return { action: 'ignore' }
  const unwrapped = unwrapCommand(command, ctx.platform)
  if (!unwrapped.ok) {
    return {
      action: 'deny',
      code: 'path_mismatch',
      reason: layer(
        '删除命令的引号没有配平，路径可能被截断，已拒绝。',
        'The delete command has unbalanced quotes, so the path may have been truncated. Refused.',
      ),
      targets: [],
    }
  }
  const active = { ...ctx, platform: unwrapped.platform || ctx.platform }
  const parsed = collectTargets(unwrapped.tokens, active)
  if (!parsed.recursive) return { action: 'ignore' }
  if (!parsed.ok) {
    return {
      action: 'deny',
      code: 'path_mismatch',
      reason: layer(
        '递归删除没有解析出明确路径，已拒绝。',
        'The recursive delete did not resolve to a definite path. Refused.',
      ),
      targets: [],
    }
  }
  const targets = parsed.targets.map((target) => {
    const real = tryRealpath(target.abs, active)
    return { ...target, real }
  })
  const widened = targets.find((target) => target.real && !samePath(target.real, target.abs, active))
  const intendedRaw = input?.intended ?? input?.intendedPaths ?? null
  const intended = intendedRaw == null
    ? null
    : (Array.isArray(intendedRaw) ? intendedRaw : [intendedRaw]).map((raw) => normalizeDeletePath(raw, active))
  let mismatch = false
  if (widened) mismatch = true
  if (intended) {
    const got = targets.map((target) => target.abs)
    if (intended.length !== got.length || intended.some((item, index) => !samePath(item, got[index], active))) mismatch = true
    if (intended.some((item) => targets.some((target) => isPrefixPath(target.abs, item, active)))) mismatch = true
  }
  const trip = roundTrip(targets.map((target) => target.abs), active)
  if (!trip.ok || trip.targets.length !== targets.length || trip.targets.some((target, index) => !samePath(target.abs, targets[index].abs, active))) {
    mismatch = true
  }
  const protectedHits = [...new Set(targets.map((target) => protectionOf(target.abs, active)).filter(Boolean))]
  if (mismatch) {
    const shown = targets.map((target) => target.abs).join(', ') || command
    const extraZh = protectedHits.length ? '解析结果落到了盘符根、用户目录或 .dsh。' : ''
    const extraEn = protectedHits.length ? 'The resolved path is a drive root, a home directory, or .dsh.' : ''
    return {
      action: 'deny',
      code: 'path_mismatch',
      reason: layer(
        `拼好之后的路径和原来的目标不一致（${shown}），已拒绝这次删除。${extraZh}`,
        `The path after the command was assembled does not match the original target (${shown}). This delete was refused. ${extraEn}`.trim(),
      ),
      targets,
      protected: protectedHits,
    }
  }
  if (protectedHits.length) {
    const shown = targets.map((target) => target.abs).join(', ')
    return {
      action: 'deny',
      code: 'protected',
      reason: layer(
        `已拒绝递归删除盘符根、用户目录或 .dsh。目标是 ${shown}。`,
        `Refused a recursive delete of a drive root, a home directory, or .dsh. Target: ${shown}.`,
      ),
      targets,
      protected: protectedHits,
    }
  }
  if (targets.some((target) => /[*?]/.test(target.raw))) {
    return {
      action: 'ask',
      code: 'wildcard',
      reason: '',
      targets,
    }
  }
  return { action: 'backup', targets }
}

function roundTrip(paths, ctx) {
  if (paths.some((item) => /["'\n\r]/.test(item))) return { ok: false, targets: [] }
  const command = ctx.platform === 'win32'
    ? `rd /s /q ${paths.map((item) => `"${item}"`).join(' ')}`
    : `rm -rf -- ${paths.map((item) => `'${item}'`).join(' ')}`
  const unwrapped = unwrapCommand(command, ctx.platform)
  if (!unwrapped.ok) return { ok: false, targets: [] }
  const parsed = collectTargets(unwrapped.tokens, ctx)
  if (!parsed.recursive || !parsed.ok) return { ok: false, targets: [] }
  return { ok: true, targets: parsed.targets }
}

export function readToolCommand(exec) {
  const args = exec?.arguments ?? exec?.input ?? exec?.args ?? {}
  if (typeof args === 'string') return { command: args, intended: null, cwd: null, confirm: null }
  const command = ['command', 'cmd', 'script'].map((key) => args?.[key]).find((value) => typeof value === 'string' && value.trim()) || ''
  const intended = args?.intendedPaths ?? args?.intended ?? args?.intendedPath ?? null
  const confirm = args?.undohavenConfirm ?? args?.confirmDelete ?? null
  const cwd = typeof args?.cwd === 'string' ? args.cwd : (typeof args?.workdir === 'string' ? args.workdir : null)
  return { command, intended, confirm: confirm == null ? null : String(confirm), cwd }
}

export function guardDeleteCommand(exec, opts = {}) {
  const read = readToolCommand(exec)
  if (read.cwd && !opts.cwd) opts = { ...opts, cwd: read.cwd }
  const decision = evaluateDeleteCommand(read, opts)
  if (decision.action === 'deny') return decision.reason
  return undefined
}

function tokenFor(command, targets) {
  return createHash('sha256').update(`${command}\n${targets.map((target) => target.abs).join('\n')}`).digest('hex').slice(0, 12)
}

async function readLedger(dataDir) {
  try {
    const parsed = JSON.parse(await readFile(path.join(dataDir, LEDGER), 'utf8'))
    parsed.entries = Array.isArray(parsed.entries) ? parsed.entries : []
    parsed.defaultDays = parsed.defaultDays || DEFAULT_RETAIN_DAYS
    return parsed
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    return { version: 1, defaultDays: DEFAULT_RETAIN_DAYS, entries: [] }
  }
}

async function writeLedger(dataDir, ledger) {
  await mkdir(dataDir, { recursive: true })
  await writeFile(path.join(dataDir, LEDGER), `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 })
}

function freshConfirm(entry, now) {
  if (!entry?.confirmed || !entry.confirmedAt) return false
  return now - Date.parse(entry.confirmedAt) < CONFIRM_MS
}

async function inspectTarget(target) {
  let st
  try {
    st = await lstat(target.abs)
  } catch (error) {
    if (error.code === 'ENOENT') return { missing: true, bytes: 0, files: [], skippedSecrets: 0 }
    throw error
  }
  if (st.isSymbolicLink()) return { link: true, bytes: 0, files: [], skippedSecrets: 0 }
  if (st.isFile()) {
    if (isAlwaysSecret(path.basename(target.abs))) return { bytes: 0, files: [], skippedSecrets: 1 }
    return {
      bytes: st.size,
      skippedSecrets: 0,
      files: [{ abs: target.abs, rel: path.basename(target.abs), size: st.size, mtimeMs: st.mtimeMs, mode: st.mode }],
    }
  }
  if (!st.isDirectory()) return { bytes: 0, files: [], skippedSecrets: 0 }
  const files = []
  let bytes = 0
  let skippedSecrets = 0
  async function walk(dir, rel) {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const child = path.join(dir, entry.name)
      const childRel = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        await walk(child, childRel)
        continue
      }
      if (!entry.isFile()) continue
      if (isAlwaysSecret(entry.name)) {
        skippedSecrets += 1
        continue
      }
      const info = await lstat(child)
      bytes += info.size
      files.push({ abs: child, rel: childRel, size: info.size, mtimeMs: info.mtimeMs, mode: info.mode })
    }
  }
  await walk(target.abs, '')
  return { bytes, files, skippedSecrets, directory: true }
}

async function snapshotFiles(files, opts) {
  const create = opts.createFileSnapshot || createFileSnapshot
  return create({
    dataDir: opts.dataDir,
    dek: opts.dek,
    cloud: opts.cloud || null,
    kind: 'pre-delete',
    tags: ['pre-delete', 'delete-guard'],
    files,
  })
}

function askReason(code, targets, token, bytes) {
  const shown = targets.map((target) => target.abs).join(', ')
  if (code === 'large') {
    const mb = Math.round((bytes / (1024 * 1024)) * 10) / 10
    return layer(
      `目录超过留底上限（约 ${mb} MB），只记了清单，没有保存文件内容。目标是 ${shown}。确认码 ${token}。确认前不会删除。`,
      `The directory is over the backup limit (about ${mb} MB), so only an inventory was recorded and file contents were not saved. Target: ${shown}. Confirmation code ${token}. Nothing is deleted until you confirm.`,
    )
  }
  return layer(
    `递归删除带有通配符，只记了清单。目标是 ${shown}。确认码 ${token}。确认前不会删除。`,
    `This recursive delete uses a wildcard, so only an inventory was recorded. Target: ${shown}. Confirmation code ${token}. Nothing is deleted until you confirm.`,
  )
}

/**
 * Backup a recursive delete, or refuse it. Calls the encrypted file snapshot
 * used by the rest of UndoHaven. A later pre-execute listener can still deny.
 */
export async function prepareRecursiveDelete(input, opts = {}) {
  const decision = evaluateDeleteCommand(input, opts)
  if (decision.action === 'ignore' || decision.action === 'deny') return decision
  const now = opts.now || Date.now()
  const token = tokenFor(input.command, decision.targets)
  const ledger = opts.dataDir ? await readLedger(opts.dataDir) : { entries: [], defaultDays: DEFAULT_RETAIN_DAYS }
  const confirmed = (input.confirm && input.confirm === token) || ledger.entries.some((entry) => entry.token === token && freshConfirm(entry, now))
  if (decision.action === 'ask') {
    if (confirmed) return { action: 'allow', mode: 'confirmed', token, backedUp: false, targets: decision.targets }
    if (opts.dataDir) {
      await remember(opts.dataDir, {
        mode: 'inventory',
        token,
        code: decision.code,
        targets: decision.targets,
        inventory: decision.targets.map((target) => ({ path: target.abs })),
        bytes: 0,
        now,
      })
    }
    return { ...decision, token, reason: askReason(decision.code, decision.targets, token, 0) }
  }
  const inspected = []
  let bytes = 0
  let skippedSecrets = 0
  for (const target of decision.targets) {
    const info = await inspectTarget(target)
    inspected.push({ target, info })
    bytes += info.bytes
    skippedSecrets += info.skippedSecrets || 0
  }
  const maxBytes = opts.maxBytes ?? DELETE_BACKUP_MAX_BYTES
  const allMissing = inspected.every((item) => item.info.missing)
  if (allMissing) return { action: 'allow', mode: 'missing', targets: decision.targets, backedUp: false }
  if (bytes > maxBytes || inspected.some((item) => item.info.link)) {
    if (confirmed) return { action: 'allow', mode: 'confirmed', token, backedUp: false, targets: decision.targets, bytes }
    const inventory = []
    for (const item of inspected) {
      const rows = item.info.files || []
      for (const file of rows) {
        if (inventory.length >= 5000) break
        inventory.push({ path: item.target.abs, rel: file.rel, size: file.size })
      }
      if (!rows.length) inventory.push({ path: item.target.abs, rel: '', size: item.info.bytes || 0 })
    }
    if (opts.dataDir) {
      await remember(opts.dataDir, {
        mode: 'inventory',
        token,
        code: 'large',
        targets: decision.targets,
        inventory,
        bytes,
        now,
      })
    }
    return {
      action: 'ask',
      code: bytes > maxBytes ? 'large' : 'link',
      token,
      bytes,
      targets: decision.targets,
      reason: askReason('large', decision.targets, token, bytes),
    }
  }
  if (!opts.dek) {
    if (confirmed) return { action: 'allow', mode: 'confirmed', token, backedUp: false, targets: decision.targets }
    if (opts.dataDir) {
      await remember(opts.dataDir, {
        mode: 'inventory',
        token,
        code: 'locked',
        targets: decision.targets,
        inventory: decision.targets.map((target) => ({ path: target.abs })),
        bytes,
        now,
      })
    }
    return {
      action: 'ask',
      code: 'locked',
      token,
      bytes,
      targets: decision.targets,
      reason: layer(
        `还没有解开本地密钥，所以没有把 ${decision.targets.map((target) => target.abs).join(', ')} 留底。确认码 ${token}。确认前不会删除。`,
        `The local key is locked, so ${decision.targets.map((target) => target.abs).join(', ')} was not copied. Confirmation code ${token}. Nothing is deleted until you confirm.`,
      ),
    }
  }
  const files = []
  for (const item of inspected) {
    for (const file of item.info.files) {
      files.push({
        root: item.target.root,
        rel: file.rel,
        abs: file.abs,
        mtimeMs: file.mtimeMs,
        mode: file.mode,
      })
    }
  }
  if (!files.length) {
    return { action: 'allow', mode: 'empty', targets: decision.targets, backedUp: false, skippedSecrets }
  }
  let record
  try {
    record = await snapshotFiles(files, opts)
  } catch (error) {
    return {
      action: 'deny',
      code: 'backup_failed',
      reason: layer(
        `留底没有写成，这次删除已停下。${error.message}`,
        `The extra copy was not written, so this delete was stopped. ${error.message}`,
      ),
      targets: decision.targets,
    }
  }
  if (opts.dataDir) {
    await remember(opts.dataDir, {
      mode: 'backup',
      token,
      code: 'backup',
      targets: decision.targets,
      inventory: files.map((file) => ({ path: file.abs, rel: file.rel, size: file.size || 0 })),
      bytes,
      now,
      snapshotId: record.id,
      cloud: !!record.cloud,
      cloudError: record.cloudError || null,
      skippedSecrets,
    })
  }
  return {
    action: 'allow',
    mode: 'backup',
    id: record.id,
    snapshotId: record.id,
    cloud: !!record.cloud,
    cloudError: record.cloudError || null,
    bytes,
    skippedSecrets,
    targets: decision.targets,
    backedUp: true,
  }
}

async function remember(dataDir, item) {
  const ledger = await readLedger(dataDir)
  const days = ledger.defaultDays || DEFAULT_RETAIN_DAYS
  ledger.entries.push({
    id: item.snapshotId || `del_${item.token}_${item.now}`,
    snapshotId: item.snapshotId || null,
    createdAt: new Date(item.now).toISOString(),
    retainUntil: new Date(item.now + days * 24 * 60 * 60 * 1000).toISOString(),
    mode: item.mode,
    token: item.token,
    code: item.code,
    confirmed: false,
    bytes: item.bytes || 0,
    cloud: !!item.cloud,
    cloudError: item.cloudError || null,
    skippedSecrets: item.skippedSecrets || 0,
    paths: item.targets.map((target) => ({ root: target.root, abs: target.abs })),
    inventory: item.inventory || [],
  })
  await writeLedger(dataDir, ledger)
}

export async function confirmDelete(dataDir, token, now = Date.now()) {
  const ledger = await readLedger(dataDir)
  let found = false
  for (const entry of ledger.entries) {
    if (entry.token !== token) continue
    entry.confirmed = true
    entry.confirmedAt = new Date(now).toISOString()
    found = true
  }
  if (!found) {
    ledger.entries.push({
      id: `confirm_${token}`,
      token,
      confirmed: true,
      confirmedAt: new Date(now).toISOString(),
      createdAt: new Date(now).toISOString(),
      mode: 'confirm',
      paths: [],
      inventory: [],
    })
  }
  await writeLedger(dataDir, ledger)
  return { ok: true, token }
}

export async function listDeleted(opts = {}) {
  const now = opts.now || Date.now()
  const ledger = await readLedger(opts.dataDir)
  const entries = ledger.entries.filter((entry) => {
    if (entry.mode === 'confirm') return false
    if (!entry.retainUntil) return true
    return Date.parse(entry.retainUntil) >= now
  })
  return { defaultDays: ledger.defaultDays || DEFAULT_RETAIN_DAYS, entries }
}

export async function setDeleteRetention(dataDir, days, now = Date.now()) {
  const n = Number(days)
  if (!Number.isInteger(n) || n < 1 || n > 3650) {
    throw new HouhuiError('bad_retention', '保留天数要在 1 和 3650 之间。', 'Retention days must be between 1 and 3650.')
  }
  const ledger = await readLedger(dataDir)
  ledger.defaultDays = n
  for (const entry of ledger.entries) {
    if (!entry.createdAt) continue
    entry.retainUntil = new Date(Date.parse(entry.createdAt) + n * 24 * 60 * 60 * 1000).toISOString()
  }
  await writeLedger(dataDir, ledger)
  return { defaultDays: n, entries: ledger.entries.length }
}

export async function restoreDeleted(opts) {
  const ledger = await readLedger(opts.dataDir)
  const entry = ledger.entries.find((item) => item.id === opts.id || item.snapshotId === opts.id)
  if (!entry) throw new HouhuiError('no_delete_copy', '没有这份删除留底。', 'There is no extra copy with that id.')
  if (entry.mode !== 'backup' || !entry.snapshotId) {
    throw new HouhuiError('inventory_only', '这份只记了清单，没有文件内容，不能还原。', 'This entry is an inventory only, so there is no file content to restore.')
  }
  const paths = entry.paths || []
  const inside = opts.dshHome && paths.some((item) => item.abs === opts.dshHome || item.abs.startsWith(opts.dshHome + path.sep) || item.abs.startsWith(opts.dshHome + '/') || item.abs.startsWith(opts.dshHome + '\\'))
  if (inside && opts.deferInsideDsh) {
    return {
      deferred: true,
      command: `undohaven restore-deleted --to ${entry.snapshotId}`,
      zh: '目标在 dsh 目录里。先退出 dsh，再用这条命令还原。',
      en: 'The target is inside the dsh directory. Quit dsh, then run this command.',
    }
  }
  const dest = {}
  for (const item of paths) dest[item.root] = paths.length === 1 && opts.dest ? opts.dest : item.abs
  const restored = await restoreFileSnapshot({ dataDir: opts.dataDir, dek: opts.dek, id: entry.snapshotId, dest })
  for (const item of paths) await mkdir(dest[item.root], { recursive: true })
  return { id: entry.snapshotId, files: restored.files, dest, deferred: false }
}

/**
 * tools/pre-execute body. Ignore and allow call next() so other command
 * checks still run. Drive-root, home, and .dsh refusals do not.
 */
export async function onPreExecute(exec, next, opts = {}) {
  const read = readToolCommand(exec)
  const prepared = await prepareRecursiveDelete(read, { ...opts, cwd: read.cwd || opts.cwd })
  if (prepared.action === 'deny') return { kind: 'deny', reason: prepared.reason, decision: prepared }
  if (prepared.action === 'ask') return { kind: 'ask', reason: prepared.reason, decision: prepared }
  if (typeof next === 'function') {
    const allowed = await next()
    if (allowed && typeof allowed === 'object') return { ...allowed, decision: prepared }
    return { kind: 'allow', decision: prepared }
  }
  return { kind: 'allow', decision: prepared }
}
