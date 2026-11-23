import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { HouhuiError } from './errors.js'
import { applyDisabledFlags } from './plugins.js'
import { escapesTree } from './scan.js'

export const GUARD_SEED = [
  {
    name: 'dsh-plugin-blender-3d',
    versions: ['0.2.1'],
    id: 'GHSA-c7hg-7rf4-q54h',
    mal: 'MAL-2026-18321',
    url: 'https://github.com/advisories/GHSA-c7hg-7rf4-q54h',
    summary: 'Malicious postinstall in dsh-plugin-blender-3d 0.2.1.',
  },
]

const WATCH = new Set(['shell', 'credentials', 'network'])
const WEEK_MS = 7 * 24 * 60 * 60 * 1000

function baselinePath(dataDir) {
  return join(dataDir, 'guard-baseline.json')
}

function cachePath(dataDir) {
  return join(dataDir, 'guard-blocklist.json')
}

export function matchBlock(entries, name, version) {
  return (entries || []).find((entry) => entry.name === name && (entry.versions || []).includes(version)) || null
}

export function declaredFromManifest(manifest) {
  const permissions = manifest?.dshhub?.permissions || {}
  const network = []
  if (Array.isArray(permissions.network)) network.push(...permissions.network.filter((item) => typeof item === 'string'))
  else if (permissions.network && typeof permissions.network === 'object') network.push(...Object.keys(permissions.network))
  const capabilities = []
  if (network.length) capabilities.push('network')
  for (const [key, value] of Object.entries(permissions)) {
    if (key === 'network') continue
    if (value) capabilities.push(String(key))
  }
  return { capabilities, destinations: network }
}

export function diffCapabilities(before, after) {
  const prevCaps = new Set(before?.capabilities || [])
  const nextCaps = after?.capabilities || []
  const added = nextCaps.filter((item) => !prevCaps.has(item))
  const prevScripts = new Set(before?.buildScripts || [])
  const installScripts = (after?.buildScripts || []).filter((item) => !prevScripts.has(item))
  const prevHosts = new Set(before?.destinations || [])
  const domains = (after?.destinations || []).filter((item) => item && !prevHosts.has(item))
  return {
    capabilities: added,
    shell: added.includes('shell'),
    credentials: added.includes('credentials'),
    network: added.includes('network'),
    installScripts,
    domains,
    watched: added.filter((item) => WATCH.has(item)),
  }
}

async function walkFiles(root, dir, out) {
  let entries = []
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue
    if (entry.isSymbolicLink()) continue
    const abs = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (await escapesTree(dir, abs)) continue
      await walkFiles(root, abs, out)
    } else if (entry.isFile()) out.push(abs)
  }
}

export async function hashDirectory(root) {
  const files = []
  await walkFiles(root, root, files)
  files.sort()
  const hash = createHash('sha256')
  for (const file of files) {
    hash.update(relative(root, file).replaceAll('\\', '/'))
    hash.update('\0')
    hash.update(await readFile(file))
    hash.update('\0')
  }
  return hash.digest('hex')
}

export async function listInstalledPlugins(dshHome) {
  const root = join(dshHome, 'profiles')
  let profiles = []
  try {
    profiles = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    return []
  }
  const plugins = []
  for (const entry of profiles) {
    if (!entry.isDirectory()) continue
    const profileDir = join(root, entry.name)
    let pkg = null
    try {
      pkg = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8'))
    } catch {
      continue
    }
    for (const [name, spec] of Object.entries(pkg.dependencies || {})) {
      const dir = join(profileDir, 'node_modules', ...name.split('/'))
      let manifest = null
      try {
        manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
      } catch {
        continue
      }
      const keywords = Array.isArray(manifest.keywords) ? manifest.keywords : []
      const isPlugin = !!manifest.dsh || keywords.includes('dsh-plugin') || name.startsWith('dsh-')
      if (!isPlugin) continue
      plugins.push({
        name,
        version: String(manifest.version || spec),
        dir,
        profile: entry.name,
        spec: typeof spec === 'string' ? spec : name,
        declared: declaredFromManifest(manifest),
      })
    }
  }
  return plugins
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

export async function readBaseline(dataDir) {
  return (await readJson(baselinePath(dataDir))) || { scannedAt: null, plugins: {} }
}

async function writeJson(file, value) {
  await mkdir(join(file, '..'), { recursive: true })
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
}

export async function loadBlocklist({ apiBase, tier, dataDir, fetchImpl = globalThis.fetch, now = Date.now() }) {
  const cached = await readJson(cachePath(dataDir))
  const age = cached?.fetchedAt ? now - Date.parse(cached.fetchedAt) : Infinity
  const limit = tier === 'pro' ? 0 : WEEK_MS
  if (cached && age < limit) return { ...cached, source: 'cache' }
  if (apiBase) {
    try {
      const response = await fetchImpl(`${String(apiBase).replace(/\/$/, '')}/v1/guard/blocklist`)
      if (response.ok) {
        const body = await response.json()
        const next = { fetchedAt: new Date(now).toISOString(), entries: body.entries || GUARD_SEED, source: 'network' }
        await writeJson(cachePath(dataDir), next)
        return next
      }
    } catch {
      /* keep the seed or the stale cache */
    }
  }
  if (cached) return { ...cached, source: 'stale' }
  return { fetchedAt: new Date(now).toISOString(), entries: GUARD_SEED, source: 'seed' }
}

async function defaultAudit(plugin) {
  const { auditPlugin, collectPlugin } = await import('dsh-trust-check')
  const spec = `npm:${plugin.name}@${plugin.version}`
  const report = auditPlugin(collectPlugin(plugin.dir, spec))
  return {
    capabilities: report.capabilities || [],
    destinations: (report.destinations || []).map((item) => item.value).filter(Boolean),
    buildScripts: report.buildScripts || [],
    redLines: report.redLines || [],
  }
}

export async function disableBlocked(dshHome, plugin) {
  const patchPath = join(dshHome, 'profiles', plugin.profile, 'cordis.patch.yml')
  let text = ''
  try {
    text = await readFile(patchPath, 'utf8')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const next = applyDisabledFlags(text, [{ id: plugin.name, name: plugin.name, disabled: true }])
  await mkdir(join(dshHome, 'profiles', plugin.profile), { recursive: true })
  await writeFile(patchPath, next.endsWith('\n') ? next : `${next}\n`)
}

export async function scanGuard(opts) {
  const tier = opts.tier === 'pro' ? 'pro' : 'free'
  const plugins = opts.plugins || await listInstalledPlugins(opts.dshHome)
  const blocklist = opts.blocklist || await loadBlocklist(opts)
  const previous = opts.previous || await readBaseline(opts.dataDir)
  const auditOf = opts.audit || defaultAudit
  const changes = []
  const blocked = []
  const next = { scannedAt: new Date().toISOString(), tier, plugins: {} }
  for (const plugin of plugins) {
    const hash = plugin.dir ? await hashDirectory(plugin.dir) : null
    const audit = plugin.dir ? await auditOf(plugin) : { capabilities: [], destinations: [], buildScripts: [], redLines: [] }
    const declared = plugin.declared || { capabilities: [], destinations: [] }
    audit.capabilities = [...new Set([...(audit.capabilities || []), ...declared.capabilities])]
    audit.destinations = [...new Set([...(audit.destinations || []), ...declared.destinations])]
    const before = previous.plugins?.[plugin.name] || null
    const changed = !!before && (before.version !== plugin.version || before.hash !== hash)
    const delta = before ? diffCapabilities(before, audit) : diffCapabilities({ capabilities: [], destinations: [], buildScripts: [] }, audit)
    let pinnedId = null
    let snapshotId = before?.snapshotId || null
    if (tier === 'pro' && changed && before?.snapshotId && opts.pinSnapshot) {
      const pinned = await opts.pinSnapshot(before.snapshotId, plugin)
      pinnedId = pinned?.id || before.snapshotId
    }
    if (tier === 'pro' && opts.createSnapshot && (!before || changed)) {
      const snap = await opts.createSnapshot(plugin, { changed })
      snapshotId = snap.id
    }
    const hit = matchBlock(blocklist.entries, plugin.name, plugin.version)
    if (hit) {
      blocked.push({ name: plugin.name, version: plugin.version, profile: plugin.profile, advisory: hit })
      if (opts.disable !== false) await disableBlocked(opts.dshHome, plugin)
    }
    const history = Array.isArray(before?.history) ? before.history.slice() : []
    if (snapshotId && !history.some((item) => item.snapshotId === snapshotId)) {
      history.push({
        snapshotId,
        version: plugin.version,
        spec: plugin.spec || plugin.version,
        profile: plugin.profile,
        at: next.scannedAt,
      })
    }
    if (history.length > 40) history.splice(0, history.length - 40)
    if (changed || !before) {
      changes.push({
        name: plugin.name,
        from: before?.version || null,
        to: plugin.version,
        pinnedId,
        delta,
        declared: audit.destinations,
      })
    }
    next.plugins[plugin.name] = {
      version: plugin.version,
      hash,
      profile: plugin.profile,
      spec: plugin.spec || plugin.version,
      capabilities: audit.capabilities,
      destinations: audit.destinations,
      buildScripts: audit.buildScripts,
      redLines: audit.redLines,
      snapshotId,
      pinnedId: pinnedId || before?.pinnedId || null,
      history,
    }
  }
  await writeJson(baselinePath(opts.dataDir), next)
  return { tier, changes, blocked, baseline: next, blocklist }
}

export async function listPluginHistory(dataDir, name) {
  const baseline = await readBaseline(dataDir)
  return baseline.plugins?.[name]?.history || []
}

export async function notePluginPoints(dataDir, snapshotId, pluginState) {
  if (!snapshotId || !pluginState?.profiles) return []
  const baseline = await readBaseline(dataDir)
  baseline.plugins = baseline.plugins || {}
  const noted = []
  const at = new Date().toISOString()
  for (const [profile, body] of Object.entries(pluginState.profiles)) {
    for (const [name, spec] of Object.entries(body.dependencies || {})) {
      const row = baseline.plugins[name] || { version: spec, profile, history: [] }
      row.history = Array.isArray(row.history) ? row.history : []
      row.profile = row.profile || profile
      row.spec = spec
      if (!row.history.some((item) => item.snapshotId === snapshotId && item.spec === spec)) {
        row.history.push({ snapshotId, version: String(spec), spec, profile, at })
        noted.push(name)
      }
      if (row.history.length > 40) row.history.splice(0, row.history.length - 40)
      row.snapshotId = snapshotId
      baseline.plugins[name] = row
    }
  }
  await writeJson(baselinePath(dataDir), baseline)
  return noted
}

function historyPoint(record, to) {
  const history = record?.history || []
  if (!to) return null
  return history.find((item) => item.snapshotId === to || item.version === to || item.spec === to) || null
}

export async function rollbackGuard(opts) {
  if (opts.tier !== 'pro') {
    throw new HouhuiError('pro_required', '一键回滚是专业版功能。https://undohaven.com/zh/pricing?utm_source=cli', 'One-click rollback is a Pro feature. https://undohaven.com/pricing?utm_source=cli', { exitCode: 4 })
  }
  const baseline = await readBaseline(opts.dataDir)
  const record = baseline.plugins?.[opts.name]
  const picked = historyPoint(record, opts.to)
  const id = picked?.snapshotId || (opts.to ? null : (record?.pinnedId || record?.snapshotId))
  if (!id) {
    throw new HouhuiError('no_guard_snapshot', '还没有这个插件的这个回滚点。', 'There is no rollback point for this plugin.', { exitCode: 1 })
  }
  const restored = opts.applyPlugin
    ? await opts.applyPlugin({ id, name: opts.name, point: picked })
    : await opts.restore({ id, scope: 'config' })
  const limitation = 'Rollback restores that plugin package spec from the chosen snapshot. It cannot remove OS-level persistence such as a systemd unit, a cron entry, or a process that already started.'
  return { id, restored, limitation, point: picked }
}

export const ROLLBACK_LIMIT = 'This restores the plugin package spec and the dsh config directory. It cannot remove OS-level persistence.'
