import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { b64, chunkEncKey, fromB64, open, seal, sha256 } from './crypto.js'
import { HouhuiError } from './errors.js'
import { createSnapshot, readSnapshotEntry } from './engine.js'
import { safeJoin } from './paths.js'
import { applyDisabledFlags } from './plugins.js'
import { readPrompts, writePrompts } from './prompts.js'
import { atomicWrite } from './store.js'
import { parseYaml } from './yaml.js'

/**
 * Versioned encrypted copies of cordis.patch.yml, and a prompt when the
 * startup recovery button has moved that file aside and left the empty
 * template. Host rows come back as they were. Third-party rows from that
 * backup stay disabled until the user turns each one on.
 */

const BAK_NAME = /^cordis\.patch\.yml\.bak-(\d+)$/
const MIRROR = 'profile-mirror.json'
const tails = new Map()

function proRequired() {
  return new HouhuiError(
    'pro_required',
    '按条目还原设置是专业版里的 Guard 功能。https://undohaven.com/zh/pricing?utm_source=cli',
    'Restoring settings entry by entry is a Guard feature in Pro. https://undohaven.com/pricing?utm_source=cli',
    { exitCode: 4 },
  )
}

export function isEmptyPatchTemplate(text) {
  const stripped = String(text || '').replace(/^\uFEFF/, '').trim()
  if (stripped === '' || stripped === '[]') return true
  try {
    const parsed = parseYaml(stripped)
    return Array.isArray(parsed) && parsed.length === 0
  } catch {
    return false
  }
}

function idOf(line) {
  const stripped = line.replace(/\s+#.*$/, '').trim()
  const match = /^- id:\s*(.+)$/.exec(stripped)
  if (!match) return null
  let id = match[1].trim()
  if ((id.startsWith('"') && id.endsWith('"') && id.length >= 2) || (id.startsWith("'") && id.endsWith("'") && id.length >= 2)) {
    id = id.slice(1, -1)
  }
  if (!id || /\s/.test(id)) return null
  return id
}

export function splitPatch(text) {
  const lines = String(text || '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
  const preamble = []
  const blocks = []
  let current = null
  for (const line of lines) {
    const id = line.startsWith('- id:') ? idOf(line) : null
    if (id) {
      if (current) blocks.push(current)
      current = { id, lines: [line] }
      continue
    }
    if (current) current.lines.push(line)
    else preamble.push(line)
  }
  if (current) blocks.push(current)
  return {
    preamble,
    blocks: blocks.map((block) => ({
      id: block.id,
      party: partyOf(block.lines),
      text: block.lines.join('\n').replace(/\n+$/, ''),
    })),
  }
}

function partyOf(lines) {
  const text = `${lines.join('\n').replace(/\n+$/, '')}\n`
  try {
    const parsed = parseYaml(text)
    const row = Array.isArray(parsed) ? parsed[0] : parsed
    const name = row && typeof row.name === 'string' ? row.name : ''
    if (name && !name.startsWith('@deepseek-ai/')) return 'third-party'
  } catch {
    return 'host'
  }
  return 'host'
}

function disableBlock(block) {
  const text = applyDisabledFlags(block.text.endsWith('\n') ? block.text : `${block.text}\n`, [{ id: block.id, disabled: true }])
  return { ...block, party: 'third-party', text: text.replace(/\s*$/, '') }
}

function renderPatch(preamble, blocks) {
  const parts = []
  const pre = preamble.join('\n').replace(/\n+$/, '')
  if (pre.trim()) parts.push(pre)
  for (const block of blocks) {
    const text = block.text.replace(/\s*$/, '')
    if (text) parts.push(text)
  }
  return `${parts.join('\n')}\n`
}

export function applyConfigRestore(currentText, sourceText, opts = {}) {
  const source = splitPatch(sourceText)
  const items = Array.isArray(opts.items) ? opts.items.filter(Boolean) : []
  const maybe = (block) => (opts.disableThirdParty && block.party === 'third-party' ? disableBlock(block) : block)
  if (!items.length) {
    return {
      text: renderPatch(source.preamble, source.blocks.map(maybe)),
      restored: source.blocks.map((block) => block.id),
      missing: [],
    }
  }
  const current = isEmptyPatchTemplate(currentText) ? { preamble: [], blocks: [] } : splitPatch(currentText)
  const sourceById = new Map(source.blocks.map((block) => [block.id, block]))
  const used = new Set()
  const blocks = []
  for (const block of current.blocks) {
    if (items.includes(block.id) && sourceById.has(block.id)) {
      blocks.push(maybe(sourceById.get(block.id)))
      used.add(block.id)
    } else blocks.push(block)
  }
  for (const id of items) {
    if (used.has(id)) continue
    const block = sourceById.get(id)
    if (!block) continue
    blocks.push(maybe(block))
    used.add(id)
  }
  const preamble = current.preamble.some((line) => line.trim()) ? current.preamble : source.preamble
  return {
    text: renderPatch(preamble, blocks),
    restored: [...used],
    missing: items.filter((id) => !used.has(id)),
  }
}

async function listProfileDirs(dshHome) {
  const dirs = []
  let entries = []
  try {
    entries = await readdir(join(dshHome, 'profiles'), { withFileTypes: true })
  } catch {
    return dirs
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue
    if (!/^[\w.-]+$/.test(entry.name)) continue
    dirs.push(entry.name)
  }
  return dirs
}

async function newestBak(dir) {
  let names = []
  try {
    names = await readdir(dir)
  } catch {
    return null
  }
  let best = null
  for (const name of names) {
    const match = BAK_NAME.exec(name)
    if (!match) continue
    const stamp = Number(match[1])
    if (!best || stamp >= best.stamp) best = { name, stamp, abs: join(dir, name) }
  }
  return best
}

export async function inspectWipedProfiles(dshHome) {
  const profiles = []
  for (const name of await listProfileDirs(dshHome)) {
    const dir = join(dshHome, 'profiles', name)
    const patchAbs = join(dir, 'cordis.patch.yml')
    let text = null
    try {
      text = await readFile(patchAbs, 'utf8')
    } catch {
      continue
    }
    if (!isEmptyPatchTemplate(text)) continue
    const bak = await newestBak(dir)
    if (!bak) continue
    let backup = ''
    try {
      backup = await readFile(bak.abs, 'utf8')
    } catch {
      continue
    }
    if (isEmptyPatchTemplate(backup)) continue
    profiles.push({
      profile: name,
      rel: `profiles/${name}/cordis.patch.yml`,
      bak: bak.name,
      bakAbs: bak.abs,
    })
  }
  const prompt = profiles.length ? wipePrompt(profiles) : null
  return { profiles, prompt }
}

export function wipePrompt(profiles) {
  const names = profiles.map((item) => item.profile).join(', ')
  const bak = profiles.map((item) => `${item.profile}/${item.bak}`).join(', ')
  const command = profiles.length === 1
    ? `undohaven guard config-restore --profile ${profiles[0].profile}`
    : 'undohaven guard config'
  return {
    zh: `你的设置被官方救援移走了。${names} 的 cordis.patch.yml 现在是空模板 []，原来的文件在 ${bak}。可以按条目还原：语言、主题、模型这些宿主设置会回来，第三方插件保持关闭，等你逐个打开。这是非官方的第三方工具，不能保证每次都还原成功。`,
    en: `Your settings were moved by the startup recovery button. cordis.patch.yml in ${names} is the empty template [], and the previous file is ${bak}. You can restore entry by entry: host settings such as language, theme, and model come back, and third-party plugins stay disabled until you turn each one on. This is an unofficial third-party tool and does not repair every case.`,
    command,
    profiles: profiles.map((item) => ({ profile: item.profile, bak: item.bak, rel: item.rel })),
  }
}

export async function rememberProfileWipe(opts) {
  const found = await inspectWipedProfiles(opts.dshHome)
  const prompts = await readPrompts(opts.dataDir)
  if (found.profiles.length) {
    prompts.profileWipe = found.prompt
    await writePrompts(opts.dataDir, prompts)
  } else if (prompts.profileWipe) {
    delete prompts.profileWipe
    await writePrompts(opts.dataDir, prompts)
  }
  return found
}

async function patchFiles(dshHome) {
  const files = []
  for (const name of await listProfileDirs(dshHome)) {
    const rel = `profiles/${name}/cordis.patch.yml`
    const abs = join(dshHome, 'profiles', name, 'cordis.patch.yml')
    try {
      const info = await stat(abs)
      if (!info.isFile()) continue
      files.push({ rel, abs })
    } catch {
      /* missing patch */
    }
  }
  return files
}

async function readLivePatches(dshHome) {
  const out = new Map()
  let unstable = false
  for (const file of await patchFiles(dshHome)) {
    let bytes
    try {
      bytes = await readFile(file.abs)
    } catch {
      continue
    }
    const text = bytes.toString('utf8')
    if (!isEmptyPatchTemplate(text)) {
      try {
        parseYaml(text.replace(/^\uFEFF/, ''))
      } catch {
        unstable = true
        continue
      }
    }
    out.set(file.rel, bytes)
  }
  return { files: out, unstable }
}

async function loadMirror(dataDir, dek) {
  try {
    const raw = JSON.parse(await readFile(join(dataDir, MIRROR), 'utf8'))
    const key = chunkEncKey(dek)
    const out = new Map()
    for (const [rel, sealed] of Object.entries(raw.files || {})) {
      if (!rel.endsWith('/cordis.patch.yml') && rel !== 'cordis.patch.yml') continue
      out.set(rel, Buffer.from(open(key, fromB64(sealed))))
    }
    return out
  } catch {
    return new Map()
  }
}

async function saveMirror(dataDir, dek, files) {
  const key = chunkEncKey(dek)
  const body = { files: {} }
  for (const [rel, bytes] of files) body.files[rel] = b64(seal(key, bytes))
  await atomicWrite(join(dataDir, MIRROR), JSON.stringify(body))
}

async function captureOnce(opts) {
  const dek = opts.dek
  if (!dek) {
    const { loadDek } = await import('./keys.js')
    opts.dek = (await loadDek(opts.dataDir)).dek
  }
  const { files: live, unstable } = await readLivePatches(opts.dshHome)
  if (unstable) return { snapshot: null, changed: [], seeded: false, unstable: true }
  const mirror = await loadMirror(opts.dataDir, opts.dek)
  const previous = []
  if (mirror.size > 0) {
    for (const [rel, before] of mirror) {
      const after = live.get(rel)
      if (after && sha256(after) === sha256(before)) continue
      previous.push({ rel, bytes: before, root: 'dsh' })
    }
  }
  let snapshot = null
  if (previous.length) {
    const profile = previous[0].rel.split('/')[1] || 'home'
    snapshot = await createSnapshot({
      dataDir: opts.dataDir,
      dshHome: opts.dshHome,
      agentsHome: opts.agentsHome,
      dek: opts.dek,
      env: opts.env,
      cloud: null,
      kind: 'config',
      tags: ['config-version', profile],
      includeCredentials: false,
      select: () => false,
      extraFiles: previous,
    })
  }
  await saveMirror(opts.dataDir, opts.dek, live)
  return { snapshot, changed: previous.map((file) => file.rel), seeded: mirror.size === 0 }
}

export function captureProfileChanges(opts) {
  const key = opts.dataDir
  const prev = tails.get(key) || Promise.resolve()
  const job = prev.then(() => captureOnce(opts))
  tails.set(key, job.catch(() => {}))
  return job
}

export function watchProfiles(opts) {
  let closed = false
  let timer = null
  const tick = () => captureProfileChanges(opts).catch(() => {})
  const loop = () => {
    if (closed) return
    tick()
    timer = setTimeout(loop, opts.pollMs ?? 2000)
    timer.unref?.()
  }
  loop()
  return {
    stop() {
      closed = true
      if (timer) clearTimeout(timer)
    },
  }
}

export async function listConfigVersions(dataDir) {
  const { listSnapshotRecords } = await import('./store.js')
  const rows = await listSnapshotRecords(dataDir)
  return rows.filter((row) => row.kind === 'config' || (row.tags || []).includes('config-version') || (row.tags || []).includes('config-restore'))
}

function assertProfile(profile) {
  if (!/^[\w.-]+$/.test(profile || '')) {
    throw new HouhuiError('need_profile', '请提供 profile 名字', 'Pass a profile name')
  }
}

export async function restoreProfileConfig(opts) {
  if (opts.tier !== 'pro') throw proRequired()
  assertProfile(opts.profile)
  const rel = `profiles/${opts.profile}/cordis.patch.yml`
  const abs = safeJoin(opts.dshHome, rel)
  let current = ''
  try {
    current = await readFile(abs, 'utf8')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  let sourceText = ''
  let disableThirdParty = false
  let from = opts.from || null
  if (!from || from === 'bak') {
    const dir = join(opts.dshHome, 'profiles', opts.profile)
    const bak = await newestBak(dir)
    const wiped = !from ? (await inspectWipedProfiles(opts.dshHome)).profiles.find((item) => item.profile === opts.profile) : null
    if (!from && !wiped) {
      throw new HouhuiError(
        'no_wipe',
        '没有看到被移走的设置。cordis.patch.yml 不是空模板，或者旁边没有 .bak 文件。',
        'No moved settings were found. cordis.patch.yml is not an empty template, or there is no .bak file beside it.',
      )
    }
    if (!bak) {
      throw new HouhuiError('no_wipe', '旁边没有 cordis.patch.yml.bak-*', 'There is no cordis.patch.yml.bak-* beside this profile')
    }
    sourceText = await readFile(bak.abs, 'utf8')
    disableThirdParty = true
    from = 'bak'
  } else {
    const bytes = await readSnapshotEntry({ dataDir: opts.dataDir, dek: opts.dek, cloud: opts.cloud }, from, rel)
    sourceText = bytes.toString('utf8')
  }
  const applied = applyConfigRestore(current, sourceText, { items: opts.items, disableThirdParty })
  if (opts.items?.length && applied.restored.length === 0) {
    throw new HouhuiError('no_item', '这份备份里没有这些条目', 'This backup has none of those entries')
  }
  const snapshot = await createSnapshot({
    dataDir: opts.dataDir,
    dshHome: opts.dshHome,
    agentsHome: opts.agentsHome,
    dek: opts.dek,
    env: opts.env,
    cloud: null,
    kind: 'config',
    tags: ['config-restore', opts.profile],
    includeCredentials: false,
    select: () => false,
    extraFiles: [{ rel, bytes: Buffer.from(current), root: 'dsh' }],
  })
  await atomicWrite(abs, applied.text)
  if (from === 'bak') await rememberProfileWipe({ dataDir: opts.dataDir, dshHome: opts.dshHome })
  return {
    snapshotId: snapshot.id,
    profile: opts.profile,
    rel,
    from,
    restored: applied.restored,
    missing: applied.missing,
    disableThirdParty,
  }
}

