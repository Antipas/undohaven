import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { decideBlock } from './match.js'

const SESSION_LOG = /^session(?:\.v\d+)?\.jsonl(?:\.zstd)?$/
const READ_LIMIT = 32 * 1024 * 1024

export function resolveDshHome(env = process.env, flag) {
  if (flag) return resolve(flag)
  if (env.DSH_HOME) return resolve(env.DSH_HOME)
  return join(homedir(), '.dsh')
}

/** Pull plugin config blocks out of a cordis patch list. Tolerates comments and nested config. */
export function readPatchPlugins(text) {
  const plugins = []
  let current = null
  let inConfig = false
  let inRules = false
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/\t/g, '  ')
    if (/^\s*#/.test(line) || !line.trim()) continue
    const id = line.match(/^- id:\s*['"]?([A-Za-z0-9_-]+)['"]?\s*$/)
    if (id) {
      current = { id: id[1], config: {}, disabled: false }
      plugins.push(current)
      inConfig = false
      inRules = false
      continue
    }
    if (!current) continue
    if (/^\s+disabled:\s*true\s*$/.test(line)) current.disabled = true
    if (/^\s+config:\s*$/.test(line)) {
      inConfig = true
      inRules = false
      continue
    }
    if (!inConfig) continue
    if (/^\S/.test(line) || /^- /.test(line)) {
      inConfig = false
      inRules = false
      continue
    }
    const enabled = line.match(/^\s+enabled:\s*(true|false)\s*$/)
    if (enabled) current.config.enabled = enabled[1] === 'true'
    const mode = line.match(/^\s+mode:\s*['"]?([A-Za-z0-9_-]+)['"]?\s*$/)
    if (mode && !mode[1].startsWith('!!')) current.config.mode = mode[1]
    if (/^\s+rules:\s*$/.test(line)) {
      current.config.rules = []
      inRules = true
      continue
    }
    const rule = line.match(/^\s+-\s+['"]?(.+?)['"]?\s*$/)
    if (inRules && rule) current.config.rules.push(rule[1])
    else if (!/^\s+- /.test(line)) inRules = false
  }
  return plugins
}

function lastPlugin(plugins, id) {
  return [...plugins].reverse().find((row) => row.id === id) || null
}

async function readMaybe(path) {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

async function dirSize(root, state = { bytes: 0, files: 0, capped: false }) {
  let entries = []
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return state
    throw error
  }
  for (const entry of entries) {
    if (state.files > 20000) {
      state.capped = true
      return state
    }
    const path = join(root, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) await dirSize(path, state)
    else if (entry.isFile()) {
      const info = await stat(path)
      state.bytes += info.size
      state.files += 1
    }
  }
  return state
}

async function walkLogs(sessionsRoot) {
  const found = []
  async function walk(dir) {
    let entries = []
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (error) {
      if (error.code === 'ENOENT') return
      throw error
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile() && SESSION_LOG.test(entry.name)) found.push(path)
    }
  }
  await walk(sessionsRoot)
  return found
}

function parseLog(bytes) {
  let text
  if (bytes.length >= 4 && bytes[0] === 0x28 && bytes[1] === 0xb5 && bytes[2] === 0x2f && bytes[3] === 0xfd) {
    text = zstdDecompressSync(bytes).toString('utf8')
  } else {
    text = bytes.toString('utf8')
  }
  let header = null
  let maxSeq = -1
  let accepted = -1
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    let row
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    if (row.type === 'session' && header === null) header = row
    if (typeof row.seq === 'number') maxSeq = Math.max(maxSeq, row.seq)
    if (row.type === 'session-log-deepseek/delivery-accepted') {
      const through = Number(row.data?.throughSeq)
      if (Number.isFinite(through)) accepted = Math.max(accepted, through)
    }
  }
  return { header, maxSeq, accepted, pending: maxSeq > accepted }
}

export async function inspectSessions(sessionsRoot) {
  const files = await walkLogs(sessionsRoot)
  const sessions = []
  for (const file of files) {
    const info = await stat(file)
    if (info.size > READ_LIMIT) {
      sessions.push({ file, unreadable: true, reason: 'too-large', bytes: info.size })
      continue
    }
    try {
      const parsed = parseLog(await readFile(file))
      sessions.push({
        file,
        id: parsed.header?.id || null,
        cwd: parsed.header?.cwd || null,
        maxSeq: parsed.maxSeq,
        acceptedThrough: parsed.accepted,
        pending: parsed.pending,
        bytes: info.size,
      })
    } catch {
      sessions.push({ file, unreadable: true, reason: 'unreadable', bytes: info.size })
    }
  }
  return sessions
}

function telemetryReport(env, plugins) {
  const row = lastPlugin(plugins, 'session-telemetry-otel')
  const disabledEnv = env.DSH_TELEMETRY_DISABLED
  const envSet = disabledEnv != null && disabledEnv !== ''
  const patchMode = row?.disabled ? 'disabled-row' : (row?.config?.mode || null)
  return {
    separateFromSessionLog: true,
    defaultMode: 'FEEDBACK_ONLY',
    patchMode,
    envMode: env.DSH_TELEMETRY_MODE || null,
    disabledEnv: envSet,
    note: envSet
      ? 'A non-empty DSH_TELEMETRY_DISABLED makes the launcher append a disabled row for session-telemetry-otel. Any value, including 0 or false, counts.'
      : 'Session telemetry is a different switch from official session-log upload. The stock default is FEEDBACK_ONLY: a prefix leaves only after explicit feedback.',
  }
}

function uploadSwitch(plugins) {
  const row = lastPlugin(plugins, 'session-log-deepseek')
  if (row?.disabled) return { enabled: false, source: 'row-disabled' }
  if (typeof row?.config?.enabled === 'boolean') return { enabled: row.config.enabled, source: 'patch' }
  return { enabled: true, source: 'default' }
}

function gateConfig(plugins) {
  const row = lastPlugin(plugins, 'log-gate')
  if (!row || row.disabled) return { installed: false, mode: null, rules: [] }
  return {
    installed: true,
    mode: row.config.mode === 'listed' ? 'listed' : 'all',
    rules: Array.isArray(row.config.rules) ? row.config.rules : [],
  }
}

export async function auditHome(opts = {}) {
  const env = opts.env || process.env
  const dshHome = resolveDshHome(env, opts.dshHome)
  const agentsHome = opts.agentsHome || (env.DSH_AGENTS_HOME ? resolve(env.DSH_AGENTS_HOME) : join(homedir(), '.agents'))
  const profileRoot = join(dshHome, 'profiles')
  let profileNames = []
  try {
    profileNames = (await readdir(profileRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  } catch {
    profileNames = []
  }
  const layers = []
  for (const name of profileNames) {
    const text = await readMaybe(join(profileRoot, name, 'cordis.patch.yml'))
    if (text != null) layers.push({ name: `profiles/${name}`, plugins: readPatchPlugins(text) })
  }
  const homeText = await readMaybe(join(dshHome, 'cordis.patch.yml'))
  if (homeText != null) layers.push({ name: 'home', plugins: readPatchPlugins(homeText) })
  const merged = layers.flatMap((layer) => layer.plugins)
  const upload = uploadSwitch(merged)
  const gate = gateConfig(merged)
  const telemetry = telemetryReport(env, merged)
  const sessionsRoot = join(dshHome, 'sessions')
  const sessions = await inspectSessions(sessionsRoot)
  const classified = sessions.map((session) => {
    if (session.unreadable) return { ...session, blocked: null }
    const decision = decideBlock({ mode: gate.installed ? gate.mode : 'off', rules: gate.rules, cwd: session.cwd })
    const blocked = gate.installed ? decision.blocked : false
    let catchUp = 'none'
    if (session.pending && !upload.enabled) catchUp = 'held-by-official-switch'
    else if (session.pending && blocked) catchUp = 'held-by-gate'
    else if (session.pending) catchUp = 'would-upload'
    return { ...session, blocked, reason: decision.reason, catchUp }
  })
  const [homeSize, sessionSize, agentsSize, anon] = await Promise.all([
    dirSize(dshHome),
    dirSize(sessionsRoot),
    dirSize(agentsHome),
    stat(join(dshHome, '.anonymous-user-id')).then((info) => ({ exists: true, bytes: info.size })).catch(() => ({ exists: false, bytes: 0 })),
  ])
  return {
    dshHome,
    agentsHome,
    layers: layers.map((layer) => layer.name),
    upload,
    telemetry,
    gate,
    sizes: {
      dshHome: homeSize,
      sessions: sessionSize,
      agents: agentsSize,
      anonymousUserId: anon,
    },
    sessions: classified,
  }
}

export function renderReport(report) {
  const lines = []
  lines.push('dsh-log-gate audit / 本机数据去向体检')
  lines.push(`DSH_HOME  ${report.dshHome}`)
  lines.push(`agents    ${report.agentsHome}`)
  lines.push('')
  lines.push(`Official session-log upload: ${report.upload.enabled ? 'on' : 'off'} (${report.upload.source})`)
  lines.push(`官方会话日志上传：${report.upload.enabled ? '开' : '关'}（${report.upload.source}）`)
  lines.push(`Telemetry mode on disk: ${report.telemetry.patchMode || 'not set'}; env DSH_TELEMETRY_MODE=${report.telemetry.envMode || 'unset'}; DSH_TELEMETRY_DISABLED=${report.telemetry.disabledEnv ? 'set' : 'unset'}`)
  lines.push(report.telemetry.note)
  lines.push('')
  if (!report.gate.installed) {
    lines.push('dsh-log-gate is not enabled in the profile or home patch, so it is not omitting uploads.')
    lines.push('配置里没有启用 dsh-log-gate，因此它现在不会拦截上传。')
  } else {
    lines.push(`dsh-log-gate mode: ${report.gate.mode}; rules: ${report.gate.rules.length ? report.gate.rules.join(', ') : '(none)'}`)
  }
  lines.push('')
  lines.push(`Size  home ${report.sizes.dshHome.bytes} B, sessions ${report.sizes.sessions.bytes} B, agents ${report.sizes.agents.bytes} B`)
  lines.push(`Anonymous id file: ${report.sizes.anonymousUserId.exists ? `present, ${report.sizes.anonymousUserId.bytes} B` : 'absent'}`)
  lines.push('')
  const pending = report.sessions.filter((session) => session.catchUp && session.catchUp !== 'none')
  if (pending.length === 0) {
    lines.push('No stored session showed an unsent suffix past the last delivery-accepted mark.')
    lines.push('没有发现越过最近一次 delivery-accepted 的未发送后缀。')
  } else {
    lines.push('Unsent suffixes stay in the local log. A blocked request does not write delivery-accepted, so opening the gate later can upload that suffix on a later official API request.')
    lines.push('未发送的后缀仍在本地日志里。被拦住的请求不会写下 delivery-accepted，所以以后打开闸门时，下一次官方 API 请求可能补传这段。')
    for (const session of pending.slice(0, 20)) {
      lines.push(`- ${session.id || session.file}  cwd=${session.cwd || '?'}  ${session.catchUp}  seq ${session.acceptedThrough} -> ${session.maxSeq}`)
    }
  }
  lines.push('')
  lines.push('UndoHaven can keep an encrypted snapshot of this home on the machine, and only copy it off the machine if you ask. https://undohaven.com')
  lines.push('如果想给这份家目录留一份默认只在本机的加密快照，可以用 UndoHaven。https://undohaven.com')
  return lines.join('\n')
}
