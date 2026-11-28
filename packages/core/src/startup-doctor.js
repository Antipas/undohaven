import { lstat, readdir, readFile, rm, stat, writeFile, open } from 'node:fs/promises'
import { basename, join, sep } from 'node:path'
import { HouhuiError } from './errors.js'
import { createFileSnapshot, restoreFileSnapshot } from './filesnap.js'
import { assertDshStopped } from './lock.js'
import { applyDisabledFlags } from './plugins.js'
import { isAlwaysSecret } from './scan.js'
import { atomicWrite } from './store.js'
import { parseYaml } from './yaml.js'
import { runProcess } from './proc.js'

/**
 * External startup checkup. dsh often cannot start when these are wrong, so
 * this runs from `undohaven doctor`, not from a plugin inside dsh.
 *
 * Hooks for work that is not on this branch:
 * - `undohaven upgrade` already snapshots before a runtime install. This tree
 *   has no `undohaven guard preflight`. Doctor does not call upgrade.
 * - PR #3 (`cursor/guard-delete-align-4216`) exports `realignPlugins` from
 *   `./align.js`. Doctor does not call it. Pass `opts.align` to run that
 *   realignment after the official-bundle pin rewrite.
 * - PR #4 (`cursor/session-repair-config-keep-eaba`) exports
 *   `restoreProfileConfig` from `./profile-keep.js`. When that module is
 *   present, doctor calls it for an emptied cordis.patch.yml. Until then,
 *   `restoreEmptyPatch` does the same host-back / third-party-disabled write.
 *   Pass `opts.restoreConfig: false` to keep the built-in write, or a function
 *   to replace it.
 */

export const OFFICIAL_BUNDLES = Object.freeze([
  '@deepseek-ai/dsh-experimental-session-search',
  '@deepseek-ai/dsh-experimental-terminal-bundle',
])

export const DOCTOR_LINKS = Object.freeze({
  bundle: 'https://github.com/deepseek-ai/deepseek-harness/discussions/14408',
  bom: 'https://github.com/deepseek-ai/deepseek-harness/discussions/14459',
  sourceKind: 'https://github.com/deepseek-ai/deepseek-harness/discussions/14411',
  bak: 'https://github.com/deepseek-ai/deepseek-harness/discussions/14400',
})

export const DOCTOR_QUOTES = Object.freeze({
  sessionController: 'active Service "sessionController" is unavailable',
  bom: 'Unexpected token \'\uFEFF\', "\uFEFF{\n  "name"... is not valid JSON',
  sourceKind: 'SessionFormatError: format v4 message requires a producer-owned source kind',
})

const JOURNAL = 'doctor-repair.json'
const PROFILE_NAME = /^[\w.-]+$/
const FILE_CAP = 2 * 1024 * 1024
const SNAPSHOT_CAP = 32 * 1024 * 1024

function proRequired() {
  return new HouhuiError(
    'pro_required',
    '一键修复是 UndoHaven Pro / Guard 里的功能。免费版只做只读体检。https://undohaven.com/zh/pricing?utm_source=cli',
    'One-click repair is part of UndoHaven Pro / Guard. The free checkup is read-only. https://undohaven.com/pricing?utm_source=cli',
    { exitCode: 4 },
  )
}

export function bomKind(buf) {
  if (!buf || buf.length < 2) return null
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return 'utf-8'
  if (buf[0] === 0xff && buf[1] === 0xfe) return 'utf-16-le'
  if (buf[0] === 0xfe && buf[1] === 0xff) return 'utf-16-be'
  return null
}

export function stripUtf8Bom(buf) {
  return bomKind(buf) === 'utf-8' ? buf.subarray(3) : buf
}

export function isEmptyPatchTemplate(text) {
  const stripped = String(text || '').replace(/^\uFEFF/, '').trim()
  if (stripped === '' || stripped === '[]' || stripped === '{}') return true
  try {
    const parsed = parseYaml(stripped)
    return parsed == null || (Array.isArray(parsed) && parsed.length === 0)
  } catch {
    return false
  }
}

export function isEmptyPackageTemplate(pkg) {
  if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) return false
  const deps = pkg.dependencies && typeof pkg.dependencies === 'object' ? Object.keys(pkg.dependencies) : []
  const bundles = pkg.dsh?.profile?.bundles
  if (deps.length > 0 || (Array.isArray(bundles) && bundles.length > 0)) return false
  const allowed = new Set(['name', 'private', 'version'])
  return Object.keys(pkg).every((key) => allowed.has(key))
}

export function bundleNames(pkg) {
  const listed = Array.isArray(pkg?.dsh?.profile?.bundles)
    ? pkg.dsh.profile.bundles.filter((name) => typeof name === 'string' && name.startsWith('@deepseek-ai/'))
    : []
  const deps = pkg?.dependencies && typeof pkg.dependencies === 'object' ? Object.keys(pkg.dependencies) : []
  const names = []
  for (const name of [...OFFICIAL_BUNDLES, ...listed]) {
    if (!names.includes(name) && (deps.includes(name) || listed.includes(name))) names.push(name)
  }
  return names
}

export function isHalfExtractedName(name) {
  return typeof name === 'string' && name.includes('_tmp_')
}

export function specMatchesRelease(spec, release) {
  return typeof spec === 'string' && typeof release === 'string' && spec.trim() === release
}

function finding(fields) {
  return {
    level: fields.level,
    code: fields.code,
    path: fields.path,
    profile: fields.profile || null,
    repairable: !!fields.repairable,
    zh: fields.zh,
    en: fields.en,
    quote: fields.quote || null,
    url: fields.url || null,
    detail: fields.detail || {},
  }
}

export function sourceKindNote() {
  return {
    code: 'source_kind_restart',
    quote: DOCTOR_QUOTES.sourceKind,
    url: DOCTOR_LINKS.sourceKind,
    zh: '如果看到这句，重启应用即可。这次失败不落盘，不要改会话日志。仍在使用旧的 source.kind 为 plugin 的第三方插件消息也会触发它。',
    en: 'If you see this, restart the app. The failure is not written to disk, so do not rewrite the session log. Third-party plugin messages that still use the old source.kind of plugin can trigger it too.',
  }
}

function pickleBuffer(payload) {
  const pad = (4 - (payload.length % 4)) % 4
  const padded = pad ? Buffer.concat([payload, Buffer.alloc(pad)]) : payload
  const out = Buffer.alloc(4 + padded.length)
  out.writeUInt32LE(padded.length, 0)
  padded.copy(out, 4)
  return out
}

function asarHeader(files) {
  let cursor = 0
  const root = { files: {} }
  const blobs = []
  for (const file of files) {
    const parts = file.path.split('/')
    let node = root
    for (let i = 0; i < parts.length - 1; i += 1) {
      node.files[parts[i]] = node.files[parts[i]] || { files: {} }
      node = node.files[parts[i]]
    }
    node.files[parts[parts.length - 1]] = { offset: String(cursor), size: file.body.length }
    blobs.push(file.body)
    cursor += file.body.length
  }
  const json = Buffer.from(JSON.stringify(root))
  const stringPayload = Buffer.alloc(4 + json.length)
  stringPayload.writeUInt32LE(json.length, 0)
  json.copy(stringPayload, 4)
  const header = pickleBuffer(stringPayload)
  const sizePayload = Buffer.alloc(4)
  sizePayload.writeUInt32LE(header.length, 0)
  return { prefix: Buffer.concat([pickleBuffer(sizePayload), header]), blobs }
}

/** Build a minimal asar archive. Used by tests and by nothing in the repair path. */
export function encodeAsar(files) {
  const packed = asarHeader(files)
  return Buffer.concat([packed.prefix, ...packed.blobs])
}

function findAsarNode(header, want) {
  let node = header
  for (const part of want.split('/')) {
    node = node?.files?.[part]
    if (!node) return null
  }
  if (!node || node.files || typeof node.size !== 'number') return null
  return node
}

export async function readAsarText(archivePath, want) {
  const fh = await open(archivePath, 'r')
  try {
    const sizeBuf = Buffer.alloc(8)
    if ((await fh.read(sizeBuf, 0, 8, 0)).bytesRead !== 8) return null
    if (sizeBuf.readUInt32LE(0) < 4) return null
    const headerBytes = sizeBuf.readUInt32LE(4)
    if (headerBytes < 8 || headerBytes > 32 * 1024 * 1024) return null
    const headerBuf = Buffer.alloc(headerBytes)
    if ((await fh.read(headerBuf, 0, headerBytes, 8)).bytesRead !== headerBytes) return null
    const payloadSize = headerBuf.readUInt32LE(0)
    if (payloadSize < 4 || 4 + payloadSize > headerBuf.length) return null
    const payload = headerBuf.subarray(4, 4 + payloadSize)
    const strLen = payload.readUInt32LE(0)
    if (strLen < 2 || 4 + strLen > payload.length) return null
    let header
    try {
      header = JSON.parse(payload.subarray(4, 4 + strLen).toString('utf8'))
    } catch {
      return null
    }
    const node = findAsarNode(header, want)
    if (!node || node.size < 0 || node.size > FILE_CAP) return null
    const offset = Number(node.offset)
    if (!Number.isFinite(offset) || offset < 0) return null
    const body = Buffer.alloc(node.size)
    const at = 8 + headerBytes + offset
    if ((await fh.read(body, 0, node.size, at)).bytesRead !== node.size) return null
    return body.toString('utf8')
  } catch {
    return null
  } finally {
    await fh.close()
  }
}

function versionFromRuntimeJson(text) {
  try {
    const json = JSON.parse(String(text || '').replace(/^\uFEFF/, ''))
    const version = json?.release?.version
    return typeof version === 'string' && version.trim() ? version.trim() : null
  } catch {
    return null
  }
}

async function versionFromRuntimeFile(file) {
  try {
    return versionFromRuntimeJson(await readFile(file, 'utf8'))
  } catch {
    return null
  }
}

async function versionFromAsar(file) {
  const text = await readAsarText(file, 'dsh/desktop-runtime.json')
  return text ? versionFromRuntimeJson(text) : null
}

export async function readShippedRelease(opts = {}) {
  const env = opts.env || {}
  if (typeof opts.shippedVersion === 'string' && opts.shippedVersion.trim()) {
    return { version: opts.shippedVersion.trim(), source: 'option' }
  }
  if (typeof env.UNDOHAVEN_DSH_RELEASE === 'string' && env.UNDOHAVEN_DSH_RELEASE.trim()) {
    return { version: env.UNDOHAVEN_DSH_RELEASE.trim(), source: 'env' }
  }
  const runtime = typeof opts.runtimeFile === 'string' ? opts.runtimeFile : env.UNDOHAVEN_DESKTOP_RUNTIME
  if (typeof runtime === 'string' && runtime.trim()) {
    const version = await versionFromRuntimeFile(runtime)
    if (version) return { version, source: runtime }
  }
  const asar = typeof opts.appAsar === 'string' ? opts.appAsar : env.UNDOHAVEN_APP_ASAR
  if (typeof asar === 'string' && asar.trim()) {
    const version = await versionFromAsar(asar)
    if (version) return { version, source: asar }
  }
  const roots = []
  if (typeof opts.appRoot === 'string' && opts.appRoot.trim()) roots.push(opts.appRoot)
  if (typeof env.UNDOHAVEN_APP_ROOT === 'string' && env.UNDOHAVEN_APP_ROOT.trim()) roots.push(env.UNDOHAVEN_APP_ROOT)
  if (env.LOCALAPPDATA) roots.push(join(env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness'))
  if (env.ProgramFiles) roots.push(join(env.ProgramFiles, 'DeepSeek Harness'))
  for (const root of roots) {
    const files = [
      join(root, 'dsh', 'desktop-runtime.json'),
      join(root, 'resources', 'app.asar.unpacked', 'dsh', 'desktop-runtime.json'),
      join(root, 'resources', 'app', 'dsh', 'desktop-runtime.json'),
    ]
    for (const file of files) {
      const version = await versionFromRuntimeFile(file)
      if (version) return { version, source: file }
    }
    const version = await versionFromAsar(join(root, 'resources', 'app.asar'))
    if (version) return { version, source: join(root, 'resources', 'app.asar') }
  }
  return { version: null, source: null }
}

async function listProfileNames(dshHome) {
  let entries = []
  try {
    entries = await readdir(join(dshHome, 'profiles'), { withFileTypes: true })
  } catch {
    return []
  }
  const names = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue
    if (!PROFILE_NAME.test(entry.name)) continue
    names.push(entry.name)
  }
  return names
}

async function readCapped(abs) {
  let st
  try {
    st = await lstat(abs)
  } catch {
    return null
  }
  if (st.isSymbolicLink() || !st.isFile()) return null
  if (st.size > FILE_CAP) return { tooBig: true, size: st.size, buf: null }
  return { tooBig: false, size: st.size, buf: await readFile(abs) }
}

async function siblingBaks(dir, fileName) {
  let names = []
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const prefix = `${fileName}.bak-`
  return names
    .filter((name) => name.startsWith(prefix) && !name.includes('/') && !name.includes('\\'))
    .sort((a, b) => {
      const as = Number(/\d+$/.exec(a)?.[0] || 0)
      const bs = Number(/\d+$/.exec(b)?.[0] || 0)
      return as - bs || (a < b ? -1 : 1)
    })
}

async function readInstalledVersion(profileDir, name) {
  const parts = name.split('/')
  const file = join(profileDir, 'node_modules', ...parts, 'package.json')
  const read = await readCapped(file)
  if (!read?.buf) return null
  try {
    const json = JSON.parse(stripUtf8Bom(read.buf).toString('utf8'))
    return typeof json.version === 'string' ? json.version : null
  } catch {
    return null
  }
}

async function listHalfExtracted(profileDir) {
  const root = join(profileDir, 'node_modules', '.ignored')
  const found = []
  async function walk(dir, depth) {
    if (depth > 4) return
    let entries = []
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const abs = join(dir, entry.name)
      if (entry.isDirectory() && isHalfExtractedName(entry.name)) {
        found.push(abs)
        continue
      }
      if (entry.isDirectory()) await walk(abs, depth + 1)
    }
  }
  await walk(root, 0)
  return found
}

function relFrom(dshHome, abs) {
  const root = dshHome.endsWith(sep) ? dshHome : dshHome + sep
  const text = abs.startsWith(root) ? abs.slice(root.length) : abs
  return text.split(sep).join('/')
}

async function inspectPackage(dshHome, profile, shipped) {
  const dir = join(dshHome, 'profiles', profile)
  const rel = `profiles/${profile}/package.json`
  const read = await readCapped(join(dir, 'package.json'))
  const findings = []
  let pkg = null
  if (!read) return { findings, pkg }
  if (read.tooBig) {
    findings.push(finding({
      level: 'error',
      code: 'profile_unreadable',
      path: rel,
      profile,
      zh: 'package.json 太大，体检没有整份读入。',
      en: 'package.json is too large for this checkup to read.',
    }))
    return { findings, pkg }
  }
  const kind = bomKind(read.buf)
  if (kind === 'utf-8') {
    findings.push(finding({
      level: 'error',
      code: 'utf8_bom',
      path: rel,
      profile,
      repairable: true,
      quote: DOCTOR_QUOTES.bom,
      url: DOCTOR_LINKS.bom,
      detail: { file: 'package.json' },
      zh: 'profile 的 package.json 开头是 UTF-8 BOM（EF BB BF）。readProfileManifest 直接 JSON.parse，启动会崩。',
      en: 'The profile package.json starts with a UTF-8 BOM (EF BB BF). readProfileManifest calls JSON.parse on the raw text, and startup crashes.',
    }))
  } else if (kind) {
    findings.push(finding({
      level: 'error',
      code: 'utf16_bom',
      path: rel,
      profile,
      quote: DOCTOR_QUOTES.bom,
      url: DOCTOR_LINKS.bom,
      detail: { file: 'package.json', bom: kind },
      zh: `package.json 是 ${kind} BOM。体检只去掉 UTF-8 的 EF BB BF。`,
      en: `package.json has a ${kind} BOM. This repair only removes a UTF-8 EF BB BF.`,
    }))
  }
  const baks = await siblingBaks(dir, 'package.json')
  try {
    pkg = JSON.parse(stripUtf8Bom(read.buf).toString('utf8'))
  } catch (error) {
    findings.push(finding({
      level: 'error',
      code: 'profile_unreadable',
      path: rel,
      profile,
      detail: { file: 'package.json' },
      zh: `package.json 去掉 BOM 之后仍不是 JSON：${error.message}`,
      en: `package.json is still not JSON after a BOM is removed: ${error.message}`,
    }))
    return { findings, pkg: null, baks }
  }
  if (isEmptyPackageTemplate(pkg)) {
    findings.push(finding({
      level: 'error',
      code: 'empty_template',
      path: rel,
      profile,
      repairable: baks.length > 0,
      url: DOCTOR_LINKS.bak,
      detail: { file: 'package.json', bak: baks.at(-1) || null },
      zh: baks.length
        ? `package.json 是空模板，原来的文件在 ${baks.at(-1)}。这是官方「停用插件 / 备份 profile / 重启」留下的。`
        : 'package.json 是空模板，旁边没有 package.json.bak-*。',
      en: baks.length
        ? `package.json is an empty template. The previous file is ${baks.at(-1)}, left by the official disable-plugins / backup-profile / restart button.`
        : 'package.json is an empty template, and there is no package.json.bak-* beside it.',
    }))
  }
  if (baks.length && !isEmptyPackageTemplate(pkg)) {
    findings.push(finding({
      level: 'warn',
      code: 'profile_bak',
      path: `profiles/${profile}/${baks.at(-1)}`,
      profile,
      url: DOCTOR_LINKS.bak,
      detail: { file: 'package.json', bak: baks.at(-1) },
      zh: `旁边还有 ${baks.at(-1)}。当前 package.json 能解析，这份备份先留着。`,
      en: `${baks.at(-1)} is still beside a package.json that parses. The backup is left in place.`,
    }))
  }
  if (pkg && !isEmptyPackageTemplate(pkg)) {
    for (const name of bundleNames(pkg)) {
      const pinned = typeof pkg.dependencies?.[name] === 'string' ? pkg.dependencies[name] : null
      const installed = await readInstalledVersion(dir, name)
      const release = shipped.version
      const pinOk = release ? specMatchesRelease(pinned, release) : false
      const installedOk = release ? installed === release : false
      const localDrift = !release && pinned && installed && pinned !== installed
      if (release ? (pinOk && installedOk) : !localDrift) continue
      findings.push(finding({
        level: 'error',
        code: 'bundle_version_mismatch',
        path: rel,
        profile,
        repairable: !!release,
        quote: DOCTOR_QUOTES.sessionController,
        url: DOCTOR_LINKS.bundle,
        detail: { file: 'package.json', name, pinned, installed, shipped: release },
        zh: `${name} 和安装包里的 release.version（${release || '读不到'}）不一致。钉的是 ${pinned || '（没有）'}，已装的是 ${installed || '（没有）'}。之后每次新建会话都会失败，重启也不行。`,
        en: `${name} does not match release.version from the installed app (${release || 'unreadable'}). Pinned ${pinned || '(missing)'}, installed ${installed || '(missing)'}. Every new session fails, and a restart does not help.`,
      }))
    }
  }
  return { findings, pkg, baks }
}

async function inspectPatch(dshHome, profile) {
  const dir = join(dshHome, 'profiles', profile)
  const rel = `profiles/${profile}/cordis.patch.yml`
  const read = await readCapped(join(dir, 'cordis.patch.yml'))
  const findings = []
  if (!read) return findings
  if (read.tooBig) {
    findings.push(finding({
      level: 'error',
      code: 'profile_unreadable',
      path: rel,
      profile,
      zh: 'cordis.patch.yml 太大，体检没有整份读入。',
      en: 'cordis.patch.yml is too large for this checkup to read.',
    }))
    return findings
  }
  const kind = bomKind(read.buf)
  const text = stripUtf8Bom(read.buf).toString('utf8')
  if (kind === 'utf-8') {
    let parses = false
    try {
      parseYaml(text)
      parses = true
    } catch {
      parses = isEmptyPatchTemplate(text)
    }
    findings.push(finding({
      level: 'error',
      code: 'utf8_bom',
      path: rel,
      profile,
      repairable: parses || isEmptyPatchTemplate(text),
      quote: DOCTOR_QUOTES.bom,
      url: DOCTOR_LINKS.bom,
      detail: { file: 'cordis.patch.yml' },
      zh: 'cordis.patch.yml 开头是 UTF-8 BOM。补丁解析会拒绝它。',
      en: 'cordis.patch.yml starts with a UTF-8 BOM. Patch parsing rejects it.',
    }))
  }
  const baks = await siblingBaks(dir, 'cordis.patch.yml')
  const empty = isEmptyPatchTemplate(text)
  if (empty) {
    findings.push(finding({
      level: 'error',
      code: 'empty_template',
      path: rel,
      profile,
      repairable: baks.length > 0,
      url: DOCTOR_LINKS.bak,
      detail: { file: 'cordis.patch.yml', bak: baks.at(-1) || null },
      zh: baks.length
        ? `cordis.patch.yml 现在是空模板 []，原来的设置在 ${baks.at(-1)}。官方「停用插件 / 备份 profile / 重启」会把文件挪成 .bak-*。`
        : 'cordis.patch.yml 是空模板，旁边没有 cordis.patch.yml.bak-*。',
      en: baks.length
        ? `cordis.patch.yml is the empty template []. The previous settings are in ${baks.at(-1)}. The official disable-plugins / backup-profile / restart button renames the file to .bak-*.`
        : 'cordis.patch.yml is an empty template, and there is no cordis.patch.yml.bak-* beside it.',
    }))
  } else {
    try {
      parseYaml(text)
    } catch (error) {
      findings.push(finding({
        level: 'error',
        code: 'profile_unreadable',
        path: rel,
        profile,
        detail: { file: 'cordis.patch.yml' },
        zh: `cordis.patch.yml 无法解析：${error.message}`,
        en: `cordis.patch.yml failed to parse: ${error.message}`,
      }))
    }
    if (baks.length) {
      findings.push(finding({
        level: 'warn',
        code: 'profile_bak',
        path: `profiles/${profile}/${baks.at(-1)}`,
        profile,
        url: DOCTOR_LINKS.bak,
        detail: { file: 'cordis.patch.yml', bak: baks.at(-1) },
        zh: `旁边还有 ${baks.at(-1)}。当前补丁不是空模板，这份备份先留着。`,
        en: `${baks.at(-1)} is still beside a patch that is not an empty template. The backup is left in place.`,
      }))
    }
  }
  return findings
}

async function inspectTmp(dshHome, profile) {
  const dir = join(dshHome, 'profiles', profile)
  const found = await listHalfExtracted(dir)
  return found.map((abs) => finding({
    level: 'error',
    code: 'half_extracted',
    path: relFrom(dshHome, abs),
    profile,
    repairable: true,
    quote: DOCTOR_QUOTES.sessionController,
    url: DOCTOR_LINKS.bundle,
    detail: { file: 'tmp' },
    zh: `半解压目录 ${basename(abs)} 留在 node_modules/.ignored。更新中断后会留下 *_tmp_*，下次安装会把它当成不在依赖树里的残留。`,
    en: `Half-extracted directory ${basename(abs)} is still in node_modules/.ignored. An interrupted update leaves *_tmp_* behind, and the next install warns that it is not in the dependency tree.`,
  }))
}

/**
 * Read-only startup checkup. Never writes.
 */
export async function startupCheckup(dshHome, opts = {}) {
  const shipped = await readShippedRelease({ ...opts, env: opts.env || process.env })
  const profiles = await listProfileNames(dshHome)
  const findings = []
  let sawBundle = false
  for (const profile of profiles) {
    const pkg = await inspectPackage(dshHome, profile, shipped)
    if (pkg.pkg && bundleNames(pkg.pkg).length) sawBundle = true
    findings.push(...pkg.findings)
    findings.push(...await inspectPatch(dshHome, profile))
    findings.push(...await inspectTmp(dshHome, profile))
  }
  if (profiles.length === 0) {
    findings.push(finding({
      level: 'warn',
      code: 'no_profiles',
      path: 'profiles',
      zh: '没有找到 profiles 目录。确认 --dsh-home 指向 dsh 的家目录。',
      en: 'No profiles directory was found. Point --dsh-home at the dsh home.',
    }))
  }
  if (sawBundle && !shipped.version && !findings.some((item) => item.code === 'bundle_version_mismatch')) {
    findings.push(finding({
      level: 'warn',
      code: 'shipped_version_unknown',
      path: 'dsh/desktop-runtime.json',
      url: DOCTOR_LINKS.bundle,
      zh: '读不到安装包里的 release.version（dsh/desktop-runtime.json，通常在 resources/app.asar）。已装版本无法和应带版本比较。可以传 --app-root 或 --runtime。',
      en: 'release.version from the installed app (dsh/desktop-runtime.json, usually inside resources/app.asar) was not readable, so the pinned bundles were not compared with the shipped version. Pass --app-root or --runtime.',
    }))
  }
  const errors = findings.filter((item) => item.level === 'error').length
  const warnings = findings.filter((item) => item.level === 'warn').length
  return {
    dshHome,
    mode: 'read-only',
    shipped,
    profiles,
    findings,
    notes: [sourceKindNote()],
    errors,
    warnings,
    ok: errors === 0,
  }
}

export function disableThirdPartyRows(text) {
  const clean = String(text || '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  let parsed
  try {
    parsed = parseYaml(clean)
  } catch {
    const body = clean.endsWith('\n') ? clean : `${clean}\n`
    return { text: body, disabled: [], parsed: false }
  }
  if (!Array.isArray(parsed)) {
    const body = clean.endsWith('\n') ? clean : `${clean}\n`
    return { text: body, disabled: [], parsed: false }
  }
  const rows = []
  for (const row of parsed) {
    if (!row || typeof row !== 'object' || typeof row.id !== 'string') continue
    const name = typeof row.name === 'string' ? row.name : ''
    if (name && !name.startsWith('@deepseek-ai/')) rows.push({ id: row.id, name, disabled: true })
  }
  let next = applyDisabledFlags(clean.endsWith('\n') ? clean : `${clean}\n`, rows)
  if (!next.endsWith('\n')) next = `${next}\n`
  return { text: next, disabled: rows.map((row) => row.id), parsed: true }
}

function skipSecret(name) {
  return isAlwaysSecret(name) || name === '.env' || name === '.credentials.yaml' || name.startsWith('.env.')
}

async function listProfileSnapshotFiles(dshHome, profile) {
  const root = join(dshHome, 'profiles', profile)
  const files = []
  async function walk(dir, rel) {
    let entries = []
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      if (entry.name === 'node_modules' || entry.name === '.ignored') continue
      const abs = join(dir, entry.name)
      const child = `${rel}/${entry.name}`
      if (entry.isDirectory()) {
        await walk(abs, child)
        continue
      }
      if (!entry.isFile() || skipSecret(entry.name)) continue
      let st
      try {
        st = await stat(abs)
      } catch {
        continue
      }
      if (st.size > SNAPSHOT_CAP) continue
      files.push({ root: 'dsh', rel: child, abs, mtimeMs: st.mtimeMs, mode: st.mode })
    }
  }
  await walk(root, `profiles/${profile}`)
  return files
}

async function readJournal(dataDir) {
  try {
    const parsed = JSON.parse(await readFile(join(dataDir, JOURNAL), 'utf8'))
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.repairs)) return { repairs: [] }
    return parsed
  } catch (error) {
    if (error.code === 'ENOENT') return { repairs: [] }
    throw error
  }
}

async function writeJournal(dataDir, journal) {
  await atomicWrite(join(dataDir, JOURNAL), `${JSON.stringify(journal, null, 2)}\n`)
}

async function resolveRestore(opts) {
  if (opts.restoreConfig === false) return null
  if (typeof opts.restoreConfig === 'function') return opts.restoreConfig
  try {
    const mod = await import('./profile-keep.js')
    return typeof mod.restoreProfileConfig === 'function' ? mod.restoreProfileConfig : null
  } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND') return null
    throw error
  }
}

async function bundledPnpm(dshHome) {
  const base = join(dshHome, 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies')
  const nodeName = process.platform === 'win32' ? 'node.exe' : 'node'
  const node = join(base, 'node', 'bin', nodeName)
  const pnpm = join(base, 'pnpm', 'bin', 'pnpm.cjs')
  try {
    await stat(node)
    await stat(pnpm)
  } catch {
    return null
  }
  return { node, pnpm }
}

async function installBundles(dshHome, profile, env, runner) {
  const dir = join(dshHome, 'profiles', profile)
  if (runner === false) return { profile, installed: false, reason: 'skipped' }
  if (typeof runner === 'function') {
    const result = await runner(dir, profile)
    return { profile, installed: !!result?.installed, reason: result?.reason || null }
  }
  const bundled = await bundledPnpm(dshHome)
  if (!bundled) return { profile, installed: false, reason: 'bundled-pnpm-missing' }
  try {
    await runProcess(bundled.node, [bundled.pnpm, 'install', '--no-frozen-lockfile'], {
      cwd: dir,
      env,
      stdio: 'pipe',
    })
    return { profile, installed: true, reason: null }
  } catch (error) {
    return { profile, installed: false, reason: String(error.message || error).slice(0, 400) }
  }
}

async function removeTmp(dshHome, rel) {
  if (!rel.includes('/node_modules/.ignored/') || !isHalfExtractedName(basename(rel))) return false
  const abs = safeProfilePath(dshHome, rel)
  let st
  try {
    st = await lstat(abs)
  } catch {
    return false
  }
  if (st.isSymbolicLink() || !st.isDirectory()) return false
  await rm(abs, { recursive: true, force: true })
  return true
}

function safeProfilePath(dshHome, rel) {
  if (typeof rel !== 'string' || rel.split('/').some((part) => part === '..' || part === '')) {
    throw new HouhuiError('bad_path', '路径不安全', `Refusing path ${rel}`)
  }
  return join(dshHome, ...rel.split('/'))
}

async function writePackage(pkgPath, buf, pins) {
  const stripped = stripUtf8Bom(buf)
  const hadBom = stripped.length !== buf.length
  let pkg
  try {
    pkg = JSON.parse(stripped.toString('utf8'))
  } catch {
    if (hadBom) {
      await writeFile(pkgPath, stripped)
      return { wrote: 'strip_bom', pinsChanged: false }
    }
    return { wrote: null, pinsChanged: false }
  }
  const names = Object.keys(pins)
  if (!names.length) {
    if (!hadBom) return { wrote: null, pinsChanged: false }
    await writeFile(pkgPath, stripped)
    return { wrote: 'strip_bom', pinsChanged: false }
  }
  pkg.dependencies = { ...(pkg.dependencies || {}) }
  let pinsChanged = false
  for (const name of names) {
    if (pkg.dependencies[name] !== pins[name]) {
      pkg.dependencies[name] = pins[name]
      pinsChanged = true
    }
  }
  if (!pinsChanged && !hadBom) return { wrote: null, pinsChanged: false }
  await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)
  return { wrote: pinsChanged ? 'pin_bundles' : 'strip_bom', pinsChanged }
}

/**
 * Pro repair. Snapshots the whole profile (except node_modules, .ignored, and
 * secret files) before the first write. Free callers get pro_required and
 * this function does not write.
 */
export async function repairStartup(opts) {
  if (opts.tier !== 'pro') throw proRequired()
  if (!opts.dek) {
    throw new HouhuiError('no_keys', '修复前要先有本地密钥，才能加密留底。', 'Repair needs local keys so the profile snapshot can be encrypted.')
  }
  const env = opts.env || process.env
  const report = await startupCheckup(opts.dshHome, opts)
  const repairable = report.findings.filter((item) => item.repairable)
  if (repairable.length === 0) {
    return {
      ok: true,
      repaired: false,
      tier: 'pro',
      snapshotId: null,
      actions: [],
      install: [],
      findings: report.findings,
      hooks: hookStatus(null),
    }
  }
  await assertDshStopped(opts.dshHome, env)
  const profiles = [...new Set(repairable.map((item) => item.profile).filter(Boolean))]
  const files = []
  for (const profile of profiles) files.push(...await listProfileSnapshotFiles(opts.dshHome, profile))
  const record = typeof opts.snapshot === 'function'
    ? await opts.snapshot(files)
    : await createFileSnapshot({
      dataDir: opts.dataDir,
      dek: opts.dek,
      kind: 'pre-doctor',
      tags: ['doctor', 'pre-repair'],
      tool: 'undohaven',
      files,
    })
  if (!record?.id) throw new HouhuiError('snapshot_failed', '修复前的加密快照没有写成。', 'The pre-repair encrypted snapshot was not written.')
  const journal = await readJournal(opts.dataDir)
  journal.repairs.push({
    snapshotId: record.id,
    at: new Date().toISOString(),
    profiles,
    actions: repairable.map((item) => item.code),
    undone: false,
  })
  await writeJournal(opts.dataDir, journal)
  const restoreConfig = await resolveRestore(opts)
  const actions = []
  const installProfiles = new Set()
  for (const profile of profiles) {
    const mine = repairable.filter((item) => item.profile === profile)
    const dir = join(opts.dshHome, 'profiles', profile)
    const pkgPath = join(dir, 'package.json')
    const patchPath = join(dir, 'cordis.patch.yml')
    const packageBak = mine.find((item) => item.code === 'empty_template' && item.detail.file === 'package.json' && item.detail.bak)
    const patchBak = mine.find((item) => item.code === 'empty_template' && item.detail.file === 'cordis.patch.yml' && item.detail.bak)
    if (packageBak) {
      const bakPath = safeProfilePath(opts.dshHome, `profiles/${profile}/${packageBak.detail.bak}`)
      await writeFile(pkgPath, stripUtf8Bom(await readFile(bakPath)))
      actions.push({ profile, action: 'restore_package', bak: packageBak.detail.bak })
    }
    if (patchBak) {
      if (restoreConfig) {
        await restoreConfig({
          tier: 'pro',
          profile,
          dshHome: opts.dshHome,
          dataDir: opts.dataDir,
          dek: opts.dek,
          env,
          from: 'bak',
        })
        actions.push({ profile, action: 'restore_patch', via: 'hook' })
      } else {
        const bakPath = safeProfilePath(opts.dshHome, `profiles/${profile}/${patchBak.detail.bak}`)
        const restored = disableThirdPartyRows(stripUtf8Bom(await readFile(bakPath)).toString('utf8'))
        await writeFile(patchPath, restored.text)
        actions.push({ profile, action: 'restore_patch', via: 'builtin', disabled: restored.disabled })
      }
    } else if (mine.some((item) => item.code === 'utf8_bom' && item.detail.file === 'cordis.patch.yml')) {
      const current = await readFile(patchPath)
      await writeFile(patchPath, stripUtf8Bom(current))
      actions.push({ profile, action: 'strip_patch_bom' })
    }
    const pins = {}
    if (report.shipped.version) {
      for (const item of mine) {
        if (item.code !== 'bundle_version_mismatch' || !item.detail.name) continue
        if (!specMatchesRelease(item.detail.pinned, report.shipped.version)) pins[item.detail.name] = report.shipped.version
      }
      if (packageBak) {
        try {
          const restoredPkg = JSON.parse(stripUtf8Bom(await readFile(pkgPath)).toString('utf8'))
          for (const name of bundleNames(restoredPkg)) {
            if (!specMatchesRelease(restoredPkg.dependencies?.[name], report.shipped.version)) pins[name] = report.shipped.version
          }
        } catch {
          /* the restored package is inspected again below */
        }
      }
    }
    let pkgBuf = null
    try {
      pkgBuf = await readFile(pkgPath)
    } catch {
      pkgBuf = null
    }
    const packageBom = mine.some((item) => item.code === 'utf8_bom' && item.detail.file === 'package.json')
    if (pkgBuf && (packageBom || Object.keys(pins).length)) {
      const written = await writePackage(pkgPath, pkgBuf, pins)
      if (written.wrote) actions.push({ profile, action: written.wrote })
    }
    const needsInstall = mine.some((item) => item.code === 'bundle_version_mismatch' && item.detail.shipped && item.detail.installed !== item.detail.shipped)
      || Object.keys(pins).length > 0
    if (needsInstall) {
      installProfiles.add(profile)
      if (!actions.some((item) => item.profile === profile && item.action === 'pin_bundles')) {
        actions.push({ profile, action: 'reinstall_bundles' })
      }
    }
    for (const item of mine) {
      if (item.code !== 'half_extracted') continue
      if (await removeTmp(opts.dshHome, item.path)) actions.push({ profile, action: 'remove_tmp', path: item.path })
    }
  }
  if (typeof opts.align === 'function') {
    await opts.align({ dshHome: opts.dshHome, dataDir: opts.dataDir, dek: opts.dek, env, shipped: report.shipped })
    actions.push({ action: 'align_hook' })
  }
  const install = []
  for (const profile of installProfiles) {
    install.push(await installBundles(opts.dshHome, profile, env, opts.install))
  }
  const after = await startupCheckup(opts.dshHome, opts)
  return {
    ok: true,
    repaired: true,
    tier: 'pro',
    snapshotId: record.id,
    actions,
    install,
    findings: after.findings,
    errors: after.errors,
    hooks: hookStatus(restoreConfig, opts.align),
  }
}

function hookStatus(restoreConfig, align) {
  return {
    configRestore: typeof restoreConfig === 'function' ? 'hook' : 'builtin',
    align: typeof align === 'function' ? 'called' : 'not-called',
    preflight: 'not-in-tree',
  }
}

export async function undoStartupRepair(opts) {
  if (opts.tier !== 'pro') throw proRequired()
  if (!opts.dek) {
    throw new HouhuiError('no_keys', '撤销要先解开本地密钥。', 'Undo needs the local keys.')
  }
  const journal = await readJournal(opts.dataDir)
  const pending = [...journal.repairs].reverse().find((item) => item && item.undone !== true && item.snapshotId)
  if (!pending) {
    throw new HouhuiError('nothing_to_undo', '没有可撤销的 doctor 修复。', 'There is no doctor repair to undo.')
  }
  await assertDshStopped(opts.dshHome, opts.env || process.env)
  const restored = await restoreFileSnapshot({
    dataDir: opts.dataDir,
    dek: opts.dek,
    id: pending.snapshotId,
    dest: { dsh: opts.dshHome },
  })
  pending.undone = true
  pending.undoneAt = new Date().toISOString()
  await writeJournal(opts.dataDir, journal)
  return {
    ok: true,
    snapshotId: pending.snapshotId,
    files: restored.files,
    zh: '已用修复前的加密快照把 profile 写回去。删掉的 *_tmp_* 半解压目录不会放回来。',
    en: 'Wrote the profile back from the encrypted pre-repair snapshot. Removed *_tmp_* directories are not put back.',
  }
}
