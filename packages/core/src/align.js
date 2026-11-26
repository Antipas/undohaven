import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { HouhuiError } from './errors.js'
import { collectPluginState, installProfile, restorePluginState } from './plugins.js'

export const ALIGN_COPY = {
  zh: '这些插件和当前 runtime 不一致，兼容检查会停用它们。界面上可能只看到 sessionController unavailable。一键对齐会先做快照，再升级这些插件；失败就回滚。',
  en: 'These plugins do not match the current runtime, so the compatibility check disables them. The screen can show only sessionController unavailable. One-click realignment snapshots first, then upgrades those plugins, and rolls back if that fails.',
}

const NOTICE = 'guard-alignment.json'

export function parseVersion(input) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(input || '').trim())
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pre: match[4] ? match[4].split('.') : null,
  }
}

function cmpIdent(a, b) {
  const an = /^\d+$/.test(a)
  const bn = /^\d+$/.test(b)
  if (an && bn) return Number(a) - Number(b)
  if (an) return -1
  if (bn) return 1
  if (a === b) return 0
  return a < b ? -1 : 1
}

function cmpPre(a, b) {
  if (!a && !b) return 0
  if (!a) return 1
  if (!b) return -1
  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i += 1) {
    if (a[i] === undefined) return -1
    if (b[i] === undefined) return 1
    const diff = cmpIdent(a[i], b[i])
    if (diff) return diff < 0 ? -1 : 1
  }
  return 0
}

export function compareVersions(a, b) {
  const pa = typeof a === 'string' ? parseVersion(a) : a
  const pb = typeof b === 'string' ? parseVersion(b) : b
  if (!pa || !pb) return null
  if (pa.major !== pb.major) return pa.major < pb.major ? -1 : 1
  if (pa.minor !== pb.minor) return pa.minor < pb.minor ? -1 : 1
  if (pa.patch !== pb.patch) return pa.patch < pb.patch ? -1 : 1
  return cmpPre(pa.pre, pb.pre)
}

function cmpOp(op, version, want) {
  const diff = compareVersions(version, want)
  if (diff == null) return false
  if (op === '>=') return diff >= 0
  if (op === '<=') return diff <= 0
  if (op === '>') return diff > 0
  if (op === '<') return diff < 0
  return diff === 0
}

function caretUpper(version) {
  if (version.major > 0) return { major: version.major + 1, minor: 0, patch: 0, pre: null }
  if (version.minor > 0) return { major: 0, minor: version.minor + 1, patch: 0, pre: null }
  return { major: 0, minor: 0, patch: version.patch + 1, pre: null }
}

function comparatorSatisfies(token, version) {
  const text = token.trim()
  if (!text || text === '*' || text === 'x') return true
  const op = /^(>=|<=|>|<|=)/.exec(text)
  if (op) return cmpOp(op[1], version, text.slice(op[1].length))
  if (text.startsWith('^')) {
    const bound = parseVersion(text.slice(1))
    if (!bound) return false
    return cmpOp('>=', version, bound) && compareVersions(version, caretUpper(bound)) < 0
  }
  if (text.startsWith('~')) {
    const bound = parseVersion(text.slice(1))
    if (!bound) return false
    const upper = { major: bound.major, minor: bound.minor + 1, patch: 0, pre: null }
    return cmpOp('>=', version, bound) && compareVersions(version, upper) < 0
  }
  return cmpOp('=', version, text)
}

/** engines.dsh and exact runtime pins. Space means AND, || means OR. */
export function rangeSatisfies(range, version) {
  const text = String(range || '').trim()
  if (!text || text === '*' || text === 'x') return true
  const parsed = typeof version === 'string' ? parseVersion(version) : version
  if (!parsed) return false
  return text.split('||').some((part) => {
    const tokens = part.trim().split(/\s+/).filter(Boolean)
    return tokens.length > 0 && tokens.every((token) => comparatorSatisfies(token, parsed))
  })
}

function pinBags(manifest) {
  return [manifest?.peerDependencies, manifest?.dependencies, manifest?.optionalDependencies]
}

export function classifyPlugin(name, spec, manifest, runtimeVersion, previousVersion) {
  const engines = manifest?.engines?.dsh || manifest?.engines?.['@deepseek-ai/dsh'] || null
  const pins = []
  for (const bag of pinBags(manifest)) {
    for (const [dep, range] of Object.entries(bag || {})) {
      if (!String(dep).startsWith('@deepseek-ai/dsh')) continue
      if (typeof range !== 'string') continue
      if (/^(workspace:|file:|link:|portal:)/.test(range)) continue
      if (!rangeSatisfies(range, runtimeVersion)) pins.push({ dep, range })
    }
  }
  const enginesBad = !!(engines && !rangeSatisfies(engines, runtimeVersion))
  const version = String(manifest?.version || spec || '')
  const versionLocked = !!(previousVersion && version === previousVersion && version !== runtimeVersion && (String(name).startsWith('@deepseek-ai/') || engines))
  if (!enginesBad && pins.length === 0 && !versionLocked) return null
  const canBump = String(name).startsWith('@deepseek-ai/') && (
    version === previousVersion
    || String(spec) === previousVersion
    || (!!previousVersion && pins.some((pin) => pin.range === previousVersion))
  )
  let reason = 'version-locked'
  if (enginesBad) reason = 'engines'
  else if (pins.length) reason = 'requirement'
  return { engines: engines || null, pins, canBump, reason, version }
}

function disabledIds(text) {
  const ids = new Set()
  const lines = String(text || '').split('\n')
  let current = null
  let currentName = null
  for (const line of lines) {
    const id = /^\s*-?\s*id:\s*(\S+)\s*$/.exec(line)
    if (id) {
      current = id[1]
      currentName = null
      continue
    }
    const named = /^\s*name:\s*['"]?(.+?)['"]?\s*$/.exec(line)
    if (named) currentName = named[1]
    if (/^\s*disabled:\s*true\s*$/.test(line) && current) {
      ids.add(current)
      if (currentName) ids.add(currentName)
    }
  }
  return ids
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

export async function listRuntimeMismatch(opts) {
  const runtimeVersion = opts.runtimeVersion
  const previousVersion = opts.previousVersion || null
  const plugins = []
  let profiles = []
  try {
    profiles = await readdir(path.join(opts.dshHome, 'profiles'), { withFileTypes: true })
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  for (const entry of profiles) {
    if (!entry.isDirectory()) continue
    const dir = path.join(opts.dshHome, 'profiles', entry.name)
    const pkg = await readJson(path.join(dir, 'package.json'))
    if (!pkg) continue
    let patch = ''
    try {
      patch = await readFile(path.join(dir, 'cordis.patch.yml'), 'utf8')
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    const disabled = disabledIds(patch)
    for (const [name, spec] of Object.entries(pkg.dependencies || {})) {
      if (typeof spec !== 'string') continue
      const manifestPath = path.join(dir, 'node_modules', ...name.split('/'), 'package.json')
      const manifest = (await readJson(manifestPath)) || { name, version: spec }
      const found = classifyPlugin(name, spec, manifest, runtimeVersion, previousVersion)
      if (!found) continue
      plugins.push({
        name,
        spec,
        version: found.version,
        profile: entry.name,
        engines: found.engines,
        pins: found.pins,
        canBump: found.canBump,
        reason: found.reason,
        disabled: disabled.has(name) || disabled.has(manifest.name),
      })
    }
  }
  return {
    runtimeVersion,
    previousVersion,
    plugins,
    zh: ALIGN_COPY.zh,
    en: ALIGN_COPY.en,
  }
}

export async function readAlignmentNotice(dataDir) {
  return readJson(path.join(dataDir, NOTICE))
}

export async function saveAlignmentNotice(dataDir, report) {
  await mkdir(dataDir, { recursive: true })
  const body = {
    at: new Date().toISOString(),
    runtimeVersion: report.runtimeVersion,
    previousVersion: report.previousVersion,
    plugins: report.plugins,
    zh: ALIGN_COPY.zh,
    en: ALIGN_COPY.en,
  }
  await writeFile(path.join(dataDir, NOTICE), `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 })
  return body
}

export async function clearAlignmentNotice(dataDir) {
  await rm(path.join(dataDir, NOTICE), { force: true })
}

async function rewriteDeps(dshHome, bumps, runtimeVersion) {
  const byProfile = new Map()
  for (const plugin of bumps) {
    const list = byProfile.get(plugin.profile) || []
    list.push(plugin)
    byProfile.set(plugin.profile, list)
  }
  const rewritten = []
  for (const [profile, plugins] of byProfile) {
    const pkgPath = path.join(dshHome, 'profiles', profile, 'package.json')
    const pkg = await readJson(pkgPath)
    if (!pkg) continue
    pkg.dependencies = { ...(pkg.dependencies || {}) }
    for (const plugin of plugins) {
      pkg.dependencies[plugin.name] = runtimeVersion
      rewritten.push({ profile, name: plugin.name, spec: runtimeVersion })
    }
    await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)
  }
  return rewritten
}

/**
 * Snapshot first, then point runtime-locked packages at the current runtime.
 * A failed install writes the previous plugin specs back. Packages that are
 * not runtime-locked are listed and left unchanged.
 */
export async function realignPlugins(opts) {
  const report = opts.report || await listRuntimeMismatch(opts)
  const bumped = report.plugins.filter((plugin) => plugin.canBump)
  const manual = report.plugins.filter((plugin) => !plugin.canBump)
  if (!bumped.length) {
    return { ok: true, applied: false, snapshotId: null, plugins: report.plugins, manual, bumped }
  }
  if (typeof opts.createSnapshot !== 'function') {
    throw new HouhuiError('no_snapshot', '对齐前没有快照步骤，没有改插件。', 'There is no snapshot step, so no plugin spec was changed.')
  }
  const before = await collectPluginState(opts.dshHome)
  let snapshot
  try {
    snapshot = await opts.createSnapshot({ plugins: bumped, kind: 'pre-align' })
  } catch (error) {
    throw new HouhuiError(
      'align_snapshot_failed',
      `对齐前的快照没有做成，插件声明没有改。${error.message}`,
      `The pre-alignment snapshot failed, so plugin specs were not changed. ${error.message}`,
    )
  }
  const snapshotId = snapshot?.id
  if (!snapshotId) {
    throw new HouhuiError('align_snapshot_failed', '对齐前的快照没有编号，插件声明没有改。', 'The pre-alignment snapshot has no id, so plugin specs were not changed.')
  }
  const install = opts.install || ((dir) => installProfile(dir, opts.env))
  try {
    await rewriteDeps(opts.dshHome, bumped, opts.runtimeVersion)
    const profiles = [...new Set(bumped.map((plugin) => plugin.profile))]
    for (const profile of profiles) {
      const result = await install(path.join(opts.dshHome, 'profiles', profile), profile)
      if (result && result.installed === false) throw new Error(result.reason || 'install failed')
    }
  } catch (error) {
    await restorePluginState(opts.dshHome, before)
    throw new HouhuiError(
      'align_failed',
      `对齐失败，已把插件声明回滚。快照 ${snapshotId}。${error.message}`,
      `Realignment failed. Plugin specs were rolled back. Snapshot ${snapshotId}. ${error.message}`,
      { details: { snapshotId } },
    )
  }
  if (opts.dataDir) await clearAlignmentNotice(opts.dataDir)
  return { ok: true, applied: true, snapshotId, bumped, manual, plugins: report.plugins }
}
