import { constants, zstdCompressSync } from 'node:zlib'
import { mkdir, readdir, readFile, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { HouhuiError } from './errors.js'
import { createSnapshot, restoreSnapshot } from './engine.js'
import { isSessionFile } from './scan.js'
import { decompressZstdFrames, isZstd } from './session.js'
import { atomicWrite } from './store.js'

/**
 * Session poison repair for Guard.
 *
 * A repeated 400 at the same messages[N] or column is a bad message. Known
 * shapes are cleaned in place. Anything else is rolled back to the event
 * before that message. The session file is snapshotted, encrypted, first.
 *
 * Reasoning-only interrupted messages are removed, not padded with an empty
 * text block. The harness skips empty text, so the provider would still see
 * a thinking-only message and return 400. The snapshot keeps the event.
 */

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g
const SPECIAL_TOKEN = /<\|(image_pad|video_pad|vision_pad|vision_start|vision_end)\|>/g
const SOFT_BLOCK = new Set(['reasoning', 'thinking'])
const FAULT_FILE = 'session-faults.json'
const UNDO_FILE = 'repair-undo.json'

export const SESSION_FAULTS = [
  {
    id: 'lone-surrogate',
    discussion: 'https://github.com/deepseek-ai/deepseek-harness/discussions/14391',
  },
  {
    id: 'reasoning-only',
    discussion: 'https://github.com/deepseek-ai/deepseek-harness/discussions/14340',
  },
  {
    id: 'image-pad',
    discussion: 'https://github.com/deepseek-ai/deepseek-harness/discussions/14369',
  },
]

function proRequired() {
  return new HouhuiError(
    'pro_required',
    '坏会话急救是专业版里的 Guard 功能。https://undohaven.com/zh/pricing?utm_source=cli',
    'Session repair is a Guard feature in Pro. https://undohaven.com/pricing?utm_source=cli',
    { exitCode: 4 },
  )
}

export function parseProviderError(text) {
  const raw = String(text || '')
  const indexMatch = /messages\[(\d+)\]/.exec(raw)
  const columnMatch = /column\s+(\d+)/i.exec(raw)
  let kind = 'unknown'
  if (/unexpected end of hex escape/i.test(raw)) kind = 'lone-surrogate'
  else if (/content field is a required field/i.test(raw)) kind = 'reasoning-only'
  else if (/image features and image tokens do not match/i.test(raw)) kind = 'image-pad'
  const status = kind !== 'unknown' || /\b400\b/.test(raw) ? 400 : null
  const signature = raw
    .replace(/request_id:\s*\S+/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500)
  return {
    status,
    kind,
    messageIndex: indexMatch ? Number(indexMatch[1]) : null,
    column: columnMatch ? Number(columnMatch[1]) : null,
    signature,
  }
}

export function faultPlace(parsed) {
  if (parsed.messageIndex != null) return `m:${parsed.messageIndex}`
  if (parsed.column != null) return `c:${parsed.column}`
  return `s:${parsed.signature}`
}

/** Consecutive 400s at the same messages[N], column, or error text. */
export function repeatedFault(samples) {
  const parsed = (samples || []).map((sample) => (typeof sample === 'string' ? parseProviderError(sample) : sample)).filter(Boolean)
  if (!parsed.length) return { poisoned: false, count: 0, place: null, sample: null }
  const place = faultPlace(parsed.at(-1))
  let count = 0
  for (let i = parsed.length - 1; i >= 0; i -= 1) {
    if (parsed[i].status !== 400 || faultPlace(parsed[i]) !== place) break
    count += 1
  }
  return { poisoned: count >= 2, count, place, sample: parsed.at(-1) }
}

/**
 * Replay index. System rows stay out of `messages`. Tool results fold into
 * the following user message, matching serialize(). A trailing tool result
 * with no later user message is its own message.
 */
export function indexReplay(events) {
  const messages = []
  let pending = []
  const push = (group) => {
    messages.push({ index: messages.length, events: group })
  }
  for (const event of events) {
    if (event?.type === 'tool/result') {
      pending.push(event)
      continue
    }
    if (event?.type === 'user/message') {
      push([...pending, event])
      pending = []
      continue
    }
    if (event?.type === 'assistant/message') {
      if (pending.length) {
        push(pending)
        pending = []
      }
      push([event])
    }
  }
  if (pending.length) push(pending)
  return messages
}

function mapStrings(value, fn) {
  if (typeof value === 'string') return fn(value)
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, fn))
  if (value && typeof value === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value)) out[key] = mapStrings(item, fn)
    return out
  }
  return value
}

function stringHas(value, pred) {
  let found = false
  mapStrings(value, (text) => {
    if (pred(text)) found = true
    return text
  })
  return found
}

function scrubString(text) {
  if (typeof text !== 'string' || text.isWellFormed()) return text
  return text.replace(LONE_SURROGATE, '\uFFFD')
}

function hasLoneSurrogate(value) {
  return stringHas(value, (text) => typeof text === 'string' && !text.isWellFormed())
}

function escapeTokens(text) {
  if (typeof text !== 'string' || !text.includes('<|')) return text
  return text.replace(SPECIAL_TOKEN, (_, name) => `<\uFF5C${name}\uFF5C>`)
}

const TOKEN_NAMES = ['image_pad', 'video_pad', 'vision_pad', 'vision_start', 'vision_end']

function hasSpecialToken(value) {
  return stringHas(value, (text) => (
    typeof text === 'string' && TOKEN_NAMES.some((name) => text.includes(`<|${name}|>`))
  ))
}

function isReasoningOnlyInterrupted(event) {
  if (event?.type !== 'assistant/message') return false
  const data = event.data || {}
  const message = data.message || {}
  if (data.interrupted !== true && message.interrupted !== true) return false
  const content = Array.isArray(message.content) ? message.content : []
  if (!content.length) return false
  return content.every((block) => block && SOFT_BLOCK.has(block.type))
}

function seqsOf(events) {
  return events.map((event) => event?.seq).filter((seq) => seq != null)
}

function cannotLocate(parsed) {
  const where = parsed.messageIndex == null ? 'no messages[N]' : `messages[${parsed.messageIndex}]`
  return new HouhuiError(
    'cannot_locate',
    `没法把这次 400 对上日志里的事件（${where}）。没有改会话。`,
    `Could not map this 400 onto a session event (${where}). The session was not changed.`,
  )
}

function rollback(events, group) {
  const start = events.indexOf(group.events[0])
  if (start < 0) {
    return { action: 'rollback', events, seqs: [], changed: false }
  }
  return {
    action: 'rollback',
    events: events.slice(0, start),
    seqs: seqsOf(group.events),
    changed: true,
  }
}

export function repairEvents(events, errorText) {
  const parsed = typeof errorText === 'string' ? parseProviderError(errorText) : errorText
  const replay = indexReplay(events)
  const group = parsed.messageIndex == null ? null : replay[parsed.messageIndex] || null
  if (parsed.messageIndex != null && !group) throw cannotLocate(parsed)

  if (parsed.kind === 'lone-surrogate') {
    const pool = group ? group.events : events
    const targets = pool.filter((event) => hasLoneSurrogate(event))
    if (!targets.length) {
      if (group) return { ...rollback(events, group), kind: parsed.kind }
      throw cannotLocate(parsed)
    }
    const drop = new Set(targets)
    return {
      action: 'lone-surrogate',
      kind: parsed.kind,
      events: events.map((event) => (drop.has(event) ? mapStrings(event, scrubString) : event)),
      seqs: seqsOf(targets),
      changed: true,
    }
  }

  if (parsed.kind === 'reasoning-only') {
    const pool = group ? group.events : events
    const targets = pool.filter((event) => isReasoningOnlyInterrupted(event))
    if (!targets.length) {
      if (group) return { ...rollback(events, group), kind: parsed.kind }
      throw cannotLocate(parsed)
    }
    const drop = new Set(targets)
    return {
      action: 'reasoning-only',
      kind: parsed.kind,
      events: events.filter((event) => !drop.has(event)),
      seqs: seqsOf(targets),
      changed: true,
    }
  }

  if (parsed.kind === 'image-pad') {
    const targets = events.filter((event) => hasSpecialToken(event))
    if (!targets.length) {
      if (group) return { ...rollback(events, group), kind: parsed.kind }
      throw cannotLocate(parsed)
    }
    const drop = new Set(targets)
    return {
      action: 'image-pad',
      kind: parsed.kind,
      events: events.map((event) => (drop.has(event) ? mapStrings(event, escapeTokens) : event)),
      seqs: seqsOf(targets),
      changed: true,
    }
  }

  if (!group) throw cannotLocate(parsed)
  return { ...rollback(events, group), kind: 'unknown' }
}

export function decodeSession(buf) {
  const zstd = isZstd(buf)
  const raw = zstd ? decompressZstdFrames(buf) : buf
  const text = raw.toString('utf8')
  const events = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    events.push(JSON.parse(line))
  }
  return { events, zstd }
}

export function encodeSession(events, { zstd }) {
  const text = `${events.map((event) => JSON.stringify(event)).join('\n')}\n`
  const bytes = Buffer.from(text)
  if (!zstd) return bytes
  const params = { [constants.ZSTD_c_checksumFlag]: 1 }
  return zstdCompressSync(bytes, { params })
}

function assertSessionId(sessionId) {
  if (!/^[\w.-]{1,128}$/.test(sessionId || '')) {
    throw new HouhuiError('need_session', '请提供会话编号', 'Pass a session id')
  }
}

async function walkSessions(dir, dshHome, sessionId, found) {
  let entries = []
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue
    const abs = join(dir, entry.name)
    if (entry.isDirectory()) {
      await walkSessions(abs, dshHome, sessionId, found)
      continue
    }
    if (!entry.isFile() || !isSessionFile(entry.name)) continue
    const rel = relative(dshHome, abs).split(sep).join('/')
    if (!rel.split('/').includes(sessionId)) continue
    found.push({ abs, rel })
  }
}

export async function findSessionLogs(dshHome, sessionId) {
  assertSessionId(sessionId)
  const found = []
  await walkSessions(join(dshHome, 'sessions'), dshHome, sessionId, found)
  found.sort((a, b) => a.rel.localeCompare(b.rel))
  return found
}

async function readFaultStore(dataDir) {
  try {
    const parsed = JSON.parse(await readFile(join(dataDir, FAULT_FILE), 'utf8'))
    if (!parsed || typeof parsed !== 'object' || !parsed.sessions) return { sessions: {} }
    return parsed
  } catch {
    return { sessions: {} }
  }
}

export async function noteSessionFault(dataDir, { sessionId, error }) {
  assertSessionId(sessionId)
  const store = await readFaultStore(dataDir)
  const list = Array.isArray(store.sessions[sessionId]) ? store.sessions[sessionId] : []
  list.push({ at: new Date().toISOString(), error: String(error || '').slice(0, 4000) })
  if (list.length > 20) list.splice(0, list.length - 20)
  store.sessions[sessionId] = list
  await atomicWrite(join(dataDir, FAULT_FILE), JSON.stringify(store))
  return repeatedFault(list.map((item) => item.error))
}

async function loadFaultErrors(dataDir, sessionId) {
  const store = await readFaultStore(dataDir)
  const list = store.sessions?.[sessionId]
  return Array.isArray(list) ? list.map((item) => item.error) : []
}

async function clearFaults(dataDir, sessionId) {
  const store = await readFaultStore(dataDir)
  if (!store.sessions[sessionId]) return
  delete store.sessions[sessionId]
  await atomicWrite(join(dataDir, FAULT_FILE), JSON.stringify(store))
}

export async function repairSession(opts) {
  if (opts.tier !== 'pro') throw proRequired()
  assertSessionId(opts.sessionId)
  const samples = Array.isArray(opts.errors) ? opts.errors.map(String) : await loadFaultErrors(opts.dataDir, opts.sessionId)
  const report = repeatedFault(samples)
  if (!report.poisoned && !opts.force) {
    throw new HouhuiError(
      'not_repeated',
      '还没看到同一个位置连续两次 400。会话没有改。',
      'The same 400 location has not come back twice. The session was not changed.',
    )
  }
  const sample = report.sample || (samples.length ? parseProviderError(samples.at(-1)) : null)
  if (!sample) {
    throw new HouhuiError('need_error', '需要 400 的报错原文', 'Pass the 400 error text')
  }
  const files = await findSessionLogs(opts.dshHome, opts.sessionId)
  if (!files.length) {
    throw new HouhuiError('no_session', '没有找到这个会话的日志', `No session log for ${opts.sessionId}`)
  }
  const decoded = []
  for (const file of files) {
    const buf = await readFile(file.abs)
    let body
    try {
      body = decodeSession(buf)
    } catch (error) {
      throw new HouhuiError('broken_session', '会话日志解不开', `Session log could not be read: ${error.message}`)
    }
    const plan = repairEvents(body.events, sample)
    if (!plan.changed) throw cannotLocate(sample)
    decoded.push({ ...file, ...body, plan })
  }
  if (!opts.skipLockCheck) {
    const { assertDshStopped } = await import('./lock.js')
    await assertDshStopped(opts.dshHome, opts.env)
  }
  const snapshot = await createSnapshot({
    dataDir: opts.dataDir,
    dshHome: opts.dshHome,
    agentsHome: opts.agentsHome,
    dek: opts.dek,
    env: opts.env,
    cloud: null,
    includeCredentials: false,
    kind: 'pre-repair',
    tags: ['session-repair', 'pre-repair', opts.sessionId],
    select: (file) => file.root === 'dsh' && file.rel.startsWith('sessions/') && file.rel.split('/').includes(opts.sessionId),
  })
  const written = []
  for (const file of decoded) {
    const bytes = encodeSession(file.plan.events, { zstd: file.zstd })
    let mode = 0o600
    try {
      mode = (await stat(file.abs)).mode & 0o777
    } catch {
      mode = 0o600
    }
    await mkdir(join(file.abs, '..'), { recursive: true })
    await atomicWrite(file.abs, bytes, mode || 0o600)
    written.push({ rel: file.rel, action: file.plan.action, seqs: file.plan.seqs })
  }
  const undo = {
    snapshotId: snapshot.id,
    sessionId: opts.sessionId,
    at: new Date().toISOString(),
    files: written,
  }
  await atomicWrite(join(opts.dataDir, UNDO_FILE), JSON.stringify(undo))
  await clearFaults(opts.dataDir, opts.sessionId)
  const link = SESSION_FAULTS.find((item) => item.id === sample.kind)?.discussion || null
  return {
    snapshotId: snapshot.id,
    sessionId: opts.sessionId,
    kind: sample.kind,
    action: written[0]?.action || null,
    seqs: written.flatMap((file) => file.seqs),
    files: written,
    discussion: link,
    undoCommand: 'undohaven guard undo',
  }
}

export async function undoSessionRepair(opts) {
  let undo
  try {
    undo = JSON.parse(await readFile(join(opts.dataDir, UNDO_FILE), 'utf8'))
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    throw new HouhuiError('no_repair', '还没有可撤销的会话修复', 'There is no session repair to undo')
  }
  if (!undo?.snapshotId || !undo.sessionId) {
    throw new HouhuiError('no_repair', '还没有可撤销的会话修复', 'There is no session repair to undo')
  }
  const restored = await restoreSnapshot({
    dataDir: opts.dataDir,
    dshHome: opts.dshHome,
    agentsHome: opts.agentsHome,
    dek: opts.dek,
    env: opts.env,
    id: undo.snapshotId,
    scope: 'session',
    session: undo.sessionId,
    includeCredentials: false,
    skipLockCheck: opts.skipLockCheck,
    skipSafety: opts.skipSafety,
  })
  return { ...restored, sessionId: undo.sessionId, snapshotId: undo.snapshotId }
}
