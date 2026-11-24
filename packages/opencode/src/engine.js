import { createHash, randomBytes } from 'node:crypto'
import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import {
  cloudFromConfig,
  createFileSnapshot,
  establishKeys,
  listFileSnapshots,
  loadDek,
  restoreFileSnapshot,
  unlockPassphrase,
} from 'undohaven-core'

export const TOOL = 'opencode-undohaven'
export const MAX_FILE_BYTES = 64 * 1024 * 1024
export const DEFAULT_RISKY_TOOLS = ['write', 'edit', 'patch', 'apply_patch', 'multiedit', 'bash']
export const PROJECT_ROOT_FILES = ['opencode.json', 'opencode.jsonc', 'AGENTS.md']

const SECRET = /^(?:\.env(?:\..*)?|auth\.json|secrets?\.json|id_rsa|id_ed25519|id_ecdsa|id_dsa|.*\.(?:pem|key|p12|pfx))$/i
const MODEL = /\.(?:safetensors|gguf|ggml|pt|pth|onnx|ckpt|tflite|mlmodel)$/i
const SKIP_DIRS = new Set(['node_modules', '.git', 'undohaven'])

export function configDir(env = process.env) {
  if (env.OPENCODE_CONFIG_DIR) return env.OPENCODE_CONFIG_DIR
  const base = env.XDG_CONFIG_HOME || join(homedir(), '.config')
  return join(base, 'opencode')
}

// Snapshots live outside the OpenCode config directory so writing one never
// triggers a config reload, and so a restore never overwrites the store itself.
export function dataDirFor(env = process.env) {
  if (env.UNDOHAVEN_OPENCODE_HOME) return env.UNDOHAVEN_OPENCODE_HOME
  const base = env.XDG_DATA_HOME || join(homedir(), '.local', 'share')
  return join(base, 'opencode-undohaven')
}

export function resolveOptions(opts = {}) {
  const env = opts.env || process.env
  return {
    env,
    configDir: opts.configDir || configDir(env),
    projectDir: opts.projectDir || '',
    dataDir: opts.dataDir || dataDirFor(env),
  }
}

function norm(value) {
  return String(value || '').replaceAll('\\', '/')
}

// True when a path points at OpenCode configuration: the global config dir,
// a project's .opencode dir, or opencode.json(c) / AGENTS.md at the project root.
export function isConfigPath(value, opts = {}) {
  const text = norm(value)
  if (!text) return false
  const { configDir: config, projectDir } = resolveOptions(opts)
  const abs = norm(projectDir && !text.startsWith('/') && !/^[a-z]:\//i.test(text) ? resolve(projectDir, text) : text)
  const configRoot = norm(config).replace(/\/$/, '')
  if (abs === configRoot || abs.startsWith(`${configRoot}/`)) return true
  if (abs.includes('/.opencode/') || abs.endsWith('/.opencode')) return true
  if (text.startsWith('.opencode/') || text === '.opencode') return true
  const name = abs.split('/').pop()
  if (name === 'opencode.json' || name === 'opencode.jsonc') return true
  if (name === 'AGENTS.md' && projectDir) return abs === norm(join(projectDir, 'AGENTS.md'))
  return false
}

function pathsInArgs(args) {
  if (!args || typeof args !== 'object') return []
  const out = []
  for (const key of ['filePath', 'file_path', 'path', 'file', 'target']) {
    if (typeof args[key] === 'string') out.push(args[key])
  }
  if (typeof args.patchText === 'string') {
    for (const match of args.patchText.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) out.push(match[1].trim())
  }
  if (Array.isArray(args.edits)) {
    for (const edit of args.edits) if (edit && typeof edit.filePath === 'string') out.push(edit.filePath)
  }
  return out
}

// Decide whether a tool call is about to change OpenCode configuration.
export function shouldSnapshotBeforeTool(tool, args, opts = {}) {
  const risky = (opts.riskyTools || DEFAULT_RISKY_TOOLS).map((item) => String(item).toLowerCase())
  const name = String(tool || '').toLowerCase()
  if (!risky.includes(name)) return false
  if (name === 'bash') {
    const command = norm(args?.command)
    return /(^|[\s'"=/])\.opencode(\/|\b)|opencode\.jsonc?\b|\.config\/opencode\b/.test(command) || command.includes(norm(resolveOptions(opts).configDir))
  }
  return pathsInArgs(args).some((item) => isConfigPath(item, opts))
}

async function walk(root, label, out) {
  async function rec(dir) {
    let entries = []
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await rec(join(dir, entry.name))
        continue
      }
      if (!entry.isFile() || SECRET.test(entry.name) || MODEL.test(entry.name)) continue
      await pushFile(root, label, join(dir, entry.name), out)
    }
  }
  await rec(root)
}

async function pushFile(root, label, abs, out) {
  let info
  try {
    info = await lstat(abs)
  } catch {
    return
  }
  if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_FILE_BYTES) return
  out.push({ root: label, rel: relative(root, abs).split(sep).join('/'), abs, mtimeMs: info.mtimeMs, mode: info.mode, size: info.size })
}

export async function collectFiles(opts = {}) {
  const { configDir: config, projectDir } = resolveOptions(opts)
  const files = []
  await walk(config, 'config', files)
  if (projectDir) {
    await walk(join(projectDir, '.opencode'), 'project', files)
    for (const name of PROJECT_ROOT_FILES) await pushFile(projectDir, 'root', join(projectDir, name), files)
  }
  return files
}

async function localPassphrase(dataDir) {
  const file = join(dataDir, 'local-passphrase')
  try {
    const text = (await readFile(file, 'utf8')).trim()
    if (text) return text
  } catch {
    // first run
  }
  const created = randomBytes(24).toString('base64url')
  await mkdir(dataDir, { recursive: true, mode: 0o700 })
  await writeFile(file, `${created}\n`, { mode: 0o600 })
  return created
}

async function dekOf(dataDir, env) {
  try {
    const loaded = await loadDek(dataDir)
    if (loaded?.dek) return loaded.dek
  } catch {
    // locked or no keys yet: unlock with the passphrase below
  }
  const pass = env.UNDOHAVEN_PASSPHRASE || await localPassphrase(dataDir)
  try {
    return (await unlockPassphrase(dataDir, pass)).dek
  } catch (error) {
    // Only create keys when none exist. A wrong passphrase must never replace them.
    if (error?.code !== 'no_keys') throw error
    return (await establishKeys(dataDir, pass)).dek
  }
}

// Local-first: snapshots stay on this machine. They upload only when this data
// directory already holds an UndoHaven Pro login and UNDOHAVEN_CLOUD is not "0".
async function optionalCloud(dataDir, env) {
  if (env.UNDOHAVEN_CLOUD === '0') return null
  try {
    const { cloud } = await cloudFromConfig(dataDir)
    if (!cloud) return null
    const account = await cloud.account()
    if (account?.plan === 'pro' || account?.features?.guardRealtime || account?.features?.machineMigration) return cloud
  } catch {
    return null
  }
  return null
}

// Content fingerprint of the files a snapshot would hold. Used to skip a
// snapshot identical to the previous one, and to find the last state that
// differs from what is on disk now when undoing.
export async function fingerprint(files) {
  const hash = createHash('sha256')
  const sorted = [...files].sort((a, b) => `${a.root}:${a.rel}`.localeCompare(`${b.root}:${b.rel}`))
  for (const file of sorted) {
    let bytes
    try {
      bytes = await readFile(file.abs)
    } catch {
      continue
    }
    hash.update(`${file.root}:${file.rel}\0`)
    hash.update(createHash('sha256').update(bytes).digest('hex'))
    hash.update('\n')
  }
  return hash.digest('hex').slice(0, 32)
}

// Snapshots are kept per project, so an undo never writes one project's
// .opencode files into another. The key is a hash, not the path itself.
export function projectKey(projectDir) {
  if (!projectDir) return 'none'
  return createHash('sha256').update(resolve(projectDir)).digest('hex').slice(0, 16)
}

function fpOf(row) {
  const tag = (row.tags || []).find((item) => item.startsWith('fp:'))
  return tag ? tag.slice(3) : null
}

export async function snapshot(opts = {}) {
  const o = resolveOptions(opts)
  const files = await collectFiles(o)
  const fp = await fingerprint(files)
  if (!opts.force) {
    const last = (await list(o)).at(-1)
    if (last && fpOf(last) === fp) {
      return { id: last.id, createdAt: last.createdAt, files: files.length, cloud: false, unchanged: true }
    }
  }
  await mkdir(o.dataDir, { recursive: true, mode: 0o700 })
  const dek = await dekOf(o.dataDir, o.env)
  const cloud = await optionalCloud(o.dataDir, o.env)
  const record = await createFileSnapshot({
    dataDir: o.dataDir,
    dek,
    files,
    kind: opts.kind || 'manual',
    tags: ['opencode', `fp:${fp}`, `project:${projectKey(o.projectDir)}`, ...(opts.tags || [])],
    tool: TOOL,
    cloud,
  })
  return { id: record.id, createdAt: record.createdAt, files: files.length, cloud: Boolean(record.cloud), unchanged: false }
}

export async function list(opts = {}) {
  const o = resolveOptions(opts)
  let rows = []
  try {
    rows = await listFileSnapshots(o.dataDir)
  } catch {
    return []
  }
  return rows
    .filter((row) => row.tool === TOOL && (row.tags || []).includes(`project:${projectKey(o.projectDir)}`))
    .map((row) => ({ id: row.id, createdAt: row.createdAt, kind: row.kind, tags: row.tags || [] }))
}

export async function undo(opts = {}) {
  const o = resolveOptions(opts)
  const rows = await list(o)
  let pick
  if (opts.id) {
    pick = rows.find((row) => row.id === opts.id)
  } else {
    // The latest snapshot whose content differs from the files on disk now.
    const current = await fingerprint(await collectFiles(o))
    pick = rows.filter((row) => row.kind !== 'pre-undo' && fpOf(row) !== current).at(-1)
  }
  if (!pick) {
    const error = new Error(opts.id ? `No OpenCode snapshot with id ${opts.id}` : 'No earlier OpenCode snapshot differs from the current config')
    error.code = 'no_snapshot'
    throw error
  }
  // Save the current state first so an undo can itself be undone.
  const before = await snapshot({ ...o, kind: 'pre-undo', tags: [`undo:${pick.id}`], force: true })
  const dek = await dekOf(o.dataDir, o.env)
  const dest = { config: o.configDir }
  if (o.projectDir) {
    dest.project = join(o.projectDir, '.opencode')
    dest.root = o.projectDir
  }
  const restored = await restoreFileSnapshot({ dataDir: o.dataDir, dek, id: pick.id, dest })
  return { id: pick.id, files: restored.files, backup: before.id }
}

// Automatic snapshots must never hold up a tool call, even on a stuck filesystem.
export function withTimeout(promise, ms = 20000) {
  let timer
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(`snapshot took longer than ${ms} ms`), { code: 'timeout' })), ms)
    timer.unref?.()
  })
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer))
}
