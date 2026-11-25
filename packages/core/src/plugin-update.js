import { spawn, spawnSync } from 'node:child_process'
import { mkdir, readdir, readFile, rm, rename, stat } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { HouhuiError } from './errors.js'
import { createSnapshot, restoreSnapshot } from './engine.js'
import { latestGoodSnapshotId, markSnapshotTree } from './guard.js'
import { runProcess } from './proc.js'

/**
 * Phrases users paste into search, taken from public dsh discussions.
 * #14260 ERR_PNPM_EPERM, #14216 empty resources\\runtime, #14264 sessionController.
 */
export const GUARD_UPDATE_PHRASES = [
  'ERR_PNPM_EPERM',
  'EPERM: operation not permitted, rename',
  '包不可用',
  'cannot resolve profile bundle',
  '无法移除',
  'profile "desktop" is managed exclusively by the Electron application',
  'Cannot find module',
  'MODULE_NOT_FOUND',
  'resources\\runtime',
  'operation-error',
  'already-installed',
  '更新失败',
  'gateway/service-unavailable',
  'sessionController" is unavailable',
]

const PLUGIN_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i
const PROFILE_NAME = /^[a-z0-9][a-z0-9_-]*$/i

function assertPluginName(name) {
  if (typeof name !== 'string' || !PLUGIN_NAME.test(name) || name.includes('..')) {
    throw new HouhuiError('need_plugin', '插件名不合法。', 'The plugin name is not valid.')
  }
}

function assertProfileName(name) {
  if (typeof name !== 'string' || !PROFILE_NAME.test(name)) {
    throw new HouhuiError('need_profile', 'profile 名不合法。', 'The profile name is not valid.')
  }
}

function proRequired() {
  return new HouhuiError(
    'pro_required',
    '更新前快照、失败回滚和破树恢复是专业版里的 Guard。https://undohaven.com/zh/pricing?utm_source=cli',
    'The pre-update snapshot, rollback, and broken-tree restore are Guard on Pro. https://undohaven.com/pricing?utm_source=cli',
    { exitCode: 4 },
  )
}

export function pluginChangeArgs(action, name, spec) {
  if (action === 'uninstall' || action === 'remove') return ['remove', name]
  if (action === 'reinstall') return ['install', '--frozen-lockfile']
  if (action === 'install' || action === 'add') return ['add', spec ? `${name}@${spec}` : name]
  if (spec) return ['add', `${name}@${spec}`]
  return ['update', name]
}

export function isUpdateFailure(result) {
  if (!result || result.ok === false) return true
  const text = `${result.stdout || ''}\n${result.stderr || ''}`
  if (/ERR_PNPM_EPERM/.test(text)) return true
  if (/EPERM: operation not permitted, rename/.test(text)) return true
  if (/operation-error/.test(text)) return true
  if (/Cannot find module/.test(text) && /pnpm\.mjs/.test(text)) return true
  if (/MODULE_NOT_FOUND/.test(text) && /pnpm/.test(text)) return true
  return false
}

function epermRename(error) {
  const code = error?.code || ''
  const message = `${error?.message || ''} ${error?.stderr || ''}`
  return code === 'EPERM' || code === 'EBUSY' || code === 'EACCES' || code === 'ENOTEMPTY'
    || /ERR_PNPM_EPERM/.test(message)
    || /EPERM: operation not permitted, rename/.test(message)
}

function pathsEqual(a, b, platform) {
  if (!a || !b) return false
  const left = resolve(a)
  const right = resolve(b)
  if (left === right) return true
  if (platform === 'win32') return left.toLowerCase() === right.toLowerCase()
  return false
}

async function walkFiles(root, onFile) {
  let entries = []
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    return
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.ignored' || entry.name === '.bin') continue
    const abs = join(root, entry.name)
    if (entry.isDirectory()) await walkFiles(abs, onFile)
    else if (entry.isFile()) await onFile(abs)
  }
}

/** Native addon directories under a profile (a `.node` file pnpm would rename over). */
export async function listNativeModules(profileDir) {
  const root = join(profileDir, 'node_modules')
  const byDir = new Map()
  await walkFiles(root, async (abs) => {
    if (!abs.endsWith('.node')) return
    const rel = relative(root, abs).split(sep).join('/')
    const parts = rel.split('/')
    if (!parts[0] || parts[0] === '.ignored') return
    const name = parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0]
    if (!name || name.startsWith('@') && !name.includes('/')) return
    const dir = join(root, ...name.split('/'))
    const row = byDir.get(dir) || { name, dir, files: [] }
    row.files.push(abs)
    byDir.set(dir, row)
  })
  return [...byDir.values()]
}

/**
 * A dsh host that has a native module mapped blocks pnpm's rename onto that
 * directory. On Windows, MoveFileEx returns EPERM for any non-empty target
 * (`ERR_PNPM_EPERM`). `mappedFiles === null` means the map is unknown.
 */
export async function detectLockedNativeModules(profileDir, opts = {}) {
  const platform = opts.platform || process.platform
  const modules = opts.modules || await listNativeModules(profileDir)
  const hostRunning = typeof opts.hostRunning === 'function' ? await opts.hostRunning() : !!opts.hostRunning
  const mapped = typeof opts.mappedFiles === 'function' ? await opts.mappedFiles() : (opts.mappedFiles === undefined ? null : opts.mappedFiles)
  const detailed = []
  for (const mod of modules) {
    const mappedHit = Array.isArray(mapped) && mod.files.some((file) => mapped.some((item) => pathsEqual(item, file, platform)))
    const assumeMapped = mapped == null && platform === 'win32' && hostRunning && mod.files.length > 0
    let probeBlocked = false
    if (opts.probeRename) {
      try {
        await opts.probeRename(mod)
      } catch (error) {
        if (!epermRename(error)) throw error
        probeBlocked = true
      }
    }
    const renameBlocked = probeBlocked || (platform === 'win32' && mod.files.length > 0)
    const hostLock = !!hostRunning && (mappedHit || assumeMapped || probeBlocked)
    detailed.push({
      name: mod.name,
      dir: mod.dir,
      files: mod.files,
      hostLock,
      renameBlocked,
      reason: hostLock ? 'host_mapped' : (renameBlocked ? 'eperm_nonempty' : null),
      error: hostLock || renameBlocked ? 'ERR_PNPM_EPERM' : null,
    })
  }
  return {
    blocked: detailed.some((mod) => mod.hostLock),
    stage: detailed.filter((mod) => mod.renameBlocked),
    hostRunning: !!hostRunning,
    platform,
    modules: detailed.filter((mod) => mod.hostLock || mod.renameBlocked),
  }
}

/** Move native-module directories aside so pnpm's rename target is not a non-empty directory. */
export async function stageNativeModules(profileDir, modules, opts = {}) {
  const ignored = join(profileDir, 'node_modules', '.ignored')
  await mkdir(ignored, { recursive: true })
  const moves = []
  const stamp = opts.stamp || `${Date.now()}`
  for (const mod of modules) {
    let exists = true
    try {
      await stat(mod.dir)
    } catch {
      exists = false
    }
    if (!exists) continue
    const base = mod.dir.split(/[/\\]/).pop()
    const dest = join(ignored, `${base}-${stamp}`)
    try {
      await rename(mod.dir, dest)
    } catch (error) {
      if (!epermRename(error)) throw error
      throw new HouhuiError(
        'native_module_locked',
        `无法挪开 ${mod.name}。宿主仍占用这个原生模块，pnpm 会报 ERR_PNPM_EPERM（EPERM: operation not permitted, rename）。先退出 dsh。`,
        `Could not move ${mod.name} aside. The host still holds that native module, so pnpm reports ERR_PNPM_EPERM (EPERM: operation not permitted, rename). Quit dsh first.`,
        { exitCode: 3, details: { dir: mod.dir, code: error.code } },
      )
    }
    moves.push({ from: mod.dir, to: dest, name: mod.name })
  }
  return moves
}

export function hostStopPlan(platform, image = 'dsh.exe') {
  if (platform !== 'win32') return null
  const name = image || 'dsh.exe'
  return [
    { file: 'taskkill', args: ['/IM', name, '/T'] },
    { file: 'taskkill', args: ['/F', '/IM', name, '/T'] },
  ]
}

export function createHostControl(opts = {}) {
  const env = opts.env || process.env
  const image = env.UNDOHAVEN_DSH_PROCESS || 'dsh.exe'
  return {
    async running() {
      if (opts.running) return opts.running()
      const { assertDshStopped } = await import('./lock.js')
      try {
        await assertDshStopped(opts.dshHome, env)
        return false
      } catch (error) {
        if (error.code === 'dsh_running') return true
        throw error
      }
    },
    async stop() {
      if (opts.stop) return opts.stop()
      const plan = hostStopPlan(opts.platform || process.platform, image)
      if (!plan) {
        throw new HouhuiError(
          'dsh_running',
          'dsh 仍在运行，而且正占用要被替换的原生模块。请先退出，再运行 undohaven guard update。',
          'dsh is still running and holds a native module the update must replace. Quit it, then run undohaven guard update.',
          { exitCode: 3 },
        )
      }
      const spawnImpl = opts.spawnSync || spawnSync
      spawnImpl(plan[0].file, plan[0].args, { encoding: 'utf8' })
      if (await this.running()) spawnImpl(plan[1].file, plan[1].args, { encoding: 'utf8' })
      if (await this.running()) {
        throw new HouhuiError(
          'dsh_running',
          `taskkill 之后 ${image} 仍在运行。原生模块还被占用，更新会停在 ERR_PNPM_EPERM。`,
          `${image} is still running after taskkill. The native module is still mapped, so the update stops at ERR_PNPM_EPERM.`,
          { exitCode: 3 },
        )
      }
      return { stopped: true, image }
    },
    async start() {
      if (opts.start) return opts.start()
      const file = env.UNDOHAVEN_DSH_RESTART
      if (!file || typeof file !== 'string') return { restarted: false }
      const child = (opts.spawn || spawn)(file, [], {
        detached: true,
        stdio: 'ignore',
        shell: false,
      })
      child.unref?.()
      return { restarted: true, file }
    },
  }
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

export async function findBrokenTree(dshHome, opts = {}) {
  const root = join(dshHome, 'profiles')
  let entries = []
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    return []
  }
  const broken = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (opts.profile && entry.name !== opts.profile) continue
    const profileDir = join(root, entry.name)
    const pkg = await readJson(join(profileDir, 'package.json'))
    if (!pkg) continue
    const deps = pkg.dependencies && typeof pkg.dependencies === 'object' ? pkg.dependencies : {}
    let modulesExist = true
    try {
      const st = await stat(join(profileDir, 'node_modules'))
      modulesExist = st.isDirectory()
    } catch {
      modulesExist = false
    }
    let lockExists = false
    try {
      await stat(join(profileDir, 'pnpm-lock.yaml'))
      lockExists = true
    } catch {
      lockExists = false
    }
    if (!modulesExist && !lockExists) continue
    const seen = new Set()
    const consider = (name, spec, source) => {
      if (typeof name !== 'string' || seen.has(name)) return
      seen.add(name)
      const dir = join(profileDir, 'node_modules', ...name.split('/'))
      const manifest = join(dir, 'package.json')
      return readFile(manifest, 'utf8').then(() => null).catch((error) => {
        if (error.code !== 'ENOENT') throw error
        broken.push({
          profile: entry.name,
          name,
          spec: typeof spec === 'string' ? spec : '',
          dir,
          source,
          missingAll: !modulesExist,
          code: 'broken_plugin_tree',
          phrases: ['包不可用', 'cannot resolve profile bundle', 'ERR_PNPM_EPERM'],
        })
        return null
      })
    }
    const pending = []
    if (modulesExist || Object.keys(deps).length) {
      for (const [name, spec] of Object.entries(deps)) {
        if (typeof spec !== 'string') continue
        pending.push(consider(name, spec, 'dependencies'))
      }
    }
    const bundles = Array.isArray(pkg.dsh?.profile?.bundles) ? pkg.dsh.profile.bundles : []
    for (const name of bundles) {
      if (typeof name === 'string') pending.push(consider(name, deps[name] || '', 'bundle'))
    }
    await Promise.all(pending)
  }
  return broken
}

export async function runtimePnpmStatus(runtimeDir) {
  if (!runtimeDir) return null
  const entry = join(runtimeDir, 'primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.mjs')
  try {
    const st = await stat(entry)
    if (!st.isFile()) return { missing: true, entry }
    return { missing: false, entry }
  } catch {
    return { missing: true, entry }
  }
}

async function filesUnder(dir, profile, profileDir) {
  const files = []
  await walkFiles(dir, async (abs) => {
    const st = await stat(abs)
    if (st.size > 64 * 1024 * 1024) return
    const rel = `profiles/${profile}/${relative(profileDir, abs).split(sep).join('/')}`
    files.push({
      root: 'dsh',
      rel,
      abs,
      mtimeMs: st.mtimeMs,
      mode: st.mode,
      size: st.size,
    })
  })
  return files
}

async function snapshotProfileTree(opts, profile, plugin, detected) {
  const profileDir = join(opts.dshHome, 'profiles', profile)
  const prefix = `profiles/${profile}/`
  const extraFiles = []
  const pluginDir = join(profileDir, 'node_modules', ...plugin.split('/'))
  extraFiles.push(...await filesUnder(pluginDir, profile, profileDir))
  for (const mod of detected?.modules || []) {
    if (mod.dir === pluginDir) continue
    extraFiles.push(...await filesUnder(mod.dir, profile, profileDir))
  }
  const snap = await createSnapshot({
    dataDir: opts.dataDir,
    dshHome: opts.dshHome,
    agentsHome: opts.agentsHome,
    dek: opts.dek,
    env: opts.env,
    cloud: null,
    kind: 'pre-change',
    tags: ['guard', 'guard-pre-update', plugin, opts.action || 'update'],
    includeCredentials: false,
    select: (file) => file.root === 'dsh' && (
      file.rel === `${prefix}package.json`
      || file.rel === `${prefix}pnpm-lock.yaml`
      || file.rel === `${prefix}cordis.patch.yml`
    ),
    extraFiles,
  })
  await markSnapshotTree(opts.dataDir, snap.id, 'good')
  return snap
}

async function rollbackProfile(opts, snapshotId, profile) {
  return restoreSnapshot({
    dataDir: opts.dataDir,
    dshHome: opts.dshHome,
    agentsHome: opts.agentsHome,
    dek: opts.dek,
    env: opts.env,
    id: snapshotId,
    scope: 'overlay',
    prefix: `profiles/${profile}/`,
    skipLockCheck: true,
    skipSafety: true,
    cloud: null,
  })
}

function clip(text) {
  return String(text || '').slice(0, 2000)
}

export async function defaultRunInstall(ctx) {
  const cmd = ctx.env?.UNDOHAVEN_PNPM || 'pnpm'
  const args = pluginChangeArgs(ctx.action, ctx.plugin, ctx.spec)
  try {
    const result = await runProcess(cmd, args, { cwd: ctx.profileDir, env: ctx.env, stdio: 'pipe' })
    return { ok: true, code: 0, stdout: result.stdout, stderr: result.stderr }
  } catch (error) {
    return {
      ok: false,
      code: error.exitCode || 1,
      stdout: error.stdout || '',
      stderr: error.stderr || error.message || '',
    }
  }
}

/**
 * Pro Guard: snapshot the profile, stop the host when it holds a native module,
 * run the plugin change outside the host, and roll back if it fails.
 */
export async function guardPluginChange(opts) {
  if (opts.tier !== 'pro') throw proRequired()
  if (!opts.dek) throw new HouhuiError('no_keys', '还没有本地密钥。先运行 undohaven init。', 'Local keys are missing. Run undohaven init first.')
  const action = opts.action || 'update'
  const profile = opts.profile || 'desktop'
  assertProfileName(profile)
  assertPluginName(opts.plugin)
  const profileDir = join(opts.dshHome, 'profiles', profile)
  const host = opts.host || createHostControl(opts)
  const hostRunning = await host.running()
  const detected = await detectLockedNativeModules(profileDir, {
    platform: opts.platform,
    hostRunning,
    mappedFiles: opts.mappedFiles,
    probeRename: opts.probeRename,
    modules: opts.modules,
  })
  const snapshot = await snapshotProfileTree(opts, profile, opts.plugin, detected)
  const run = opts.runInstall || defaultRunInstall
  let stopped = false
  let staged = []
  let result = null
  try {
    if (detected.blocked) {
      await host.stop()
      stopped = true
    }
    if (detected.stage.length) staged = await stageNativeModules(profileDir, detected.stage)
    let install
    try {
      install = await run({
        profileDir,
        action,
        plugin: opts.plugin,
        spec: opts.spec,
        env: opts.env,
        snapshotId: snapshot.id,
      })
    } catch (error) {
      install = { ok: false, code: error.code || 1, stdout: error.stdout || '', stderr: `${error.stderr || ''}\n${error.message || ''}` }
    }
    const failed = isUpdateFailure(install)
    if (!failed) {
      for (const move of staged) {
        let replaced = false
        try {
          await stat(move.from)
          replaced = true
        } catch {
          replaced = false
        }
        if (replaced) await rm(move.to, { recursive: true, force: true })
        else await rename(move.to, move.from).catch(() => {})
      }
    }
    if (failed) {
      const restored = await rollbackProfile(opts, snapshot.id, profile)
      for (const move of staged) await rm(move.to, { recursive: true, force: true })
      result = {
        ok: false,
        rolledBack: true,
        snapshotId: snapshot.id,
        restored,
        locked: detected,
        staged: staged.map((move) => move.name),
        install: { ok: false, code: install.code, stdout: clip(install.stdout), stderr: clip(install.stderr) },
        restarted: false,
      }
    } else {
      result = {
        ok: true,
        rolledBack: false,
        snapshotId: snapshot.id,
        locked: detected,
        staged: staged.map((move) => move.name),
        install: { ok: true, code: install.code || 0, stdout: clip(install.stdout), stderr: clip(install.stderr) },
        restarted: false,
      }
    }
  } catch (error) {
    try {
      await rollbackProfile(opts, snapshot.id, profile)
    } catch {
      /* the original error is the one to surface */
    }
    for (const move of staged) await rm(move.to, { recursive: true, force: true }).catch(() => {})
    throw error
  } finally {
    if (stopped) {
      try {
        await host.start()
        if (result) result.restarted = true
      } catch (error) {
        if (result) result.restartError = error.message || String(error)
      }
    }
  }
  return result
}

async function snapshotExists(dataDir, id) {
  const { readSnapshotRecord } = await import('./store.js')
  const record = await readSnapshotRecord(dataDir, id)
  return !!record?.encryptedManifest
}

export async function repairBrokenTree(opts) {
  if (opts.tier !== 'pro') throw proRequired()
  if (!opts.dek) throw new HouhuiError('no_keys', '还没有本地密钥。先运行 undohaven init。', 'Local keys are missing. Run undohaven init first.')
  const profile = opts.profile
  if (profile) assertProfileName(profile)
  if (opts.plugin) assertPluginName(opts.plugin)
  const broken = await findBrokenTree(opts.dshHome, { profile })
  const relevant = opts.plugin ? broken.filter((item) => item.name === opts.plugin) : broken
  if (!relevant.length) {
    return { ok: true, restored: false, broken: [], remaining: [], snapshotId: null }
  }
  const profileName = profile || relevant[0].profile
  let snapshotId = opts.to || null
  if (!snapshotId) snapshotId = await latestGoodSnapshotId(opts.dataDir, [...new Set(relevant.map((item) => item.name))])
  if (snapshotId && !(await snapshotExists(opts.dataDir, snapshotId))) snapshotId = null
  if (!snapshotId) {
    throw new HouhuiError(
      'no_guard_snapshot',
      '没有可以恢复的好快照。破树时插件页会显示「包不可用 / cannot resolve profile bundle」。先有一份更新前快照，undohaven guard repair 才能写回去。',
      'There is no good snapshot to restore. A broken tree shows "package unavailable" / "cannot resolve profile bundle" on the plugin page. guard repair needs a snapshot taken before the update.',
      { exitCode: 1, details: { broken: relevant } },
    )
  }
  const host = opts.host || createHostControl({ ...opts, dshHome: opts.dshHome })
  const running = await host.running()
  let stopped = false
  const out = {
    ok: false,
    restored: false,
    snapshotId,
    broken: relevant,
    remaining: relevant,
    files: 0,
    reinstall: null,
    restarted: false,
  }
  try {
    if (running) {
      await host.stop()
      stopped = true
    }
    const restored = await rollbackProfile(opts, snapshotId, profileName)
    let reinstall = null
    let remaining = await findBrokenTree(opts.dshHome, { profile: profileName })
    if (opts.plugin) remaining = remaining.filter((item) => item.name === opts.plugin)
    if (remaining.length && opts.reconcile !== false) {
      const run = opts.runInstall || defaultRunInstall
      reinstall = await run({
        profileDir: join(opts.dshHome, 'profiles', profileName),
        action: 'reinstall',
        plugin: opts.plugin || remaining[0].name,
        env: opts.env,
        snapshotId,
      })
      remaining = await findBrokenTree(opts.dshHome, { profile: profileName })
      if (opts.plugin) remaining = remaining.filter((item) => item.name === opts.plugin)
    }
    out.ok = remaining.length === 0
    out.restored = true
    out.remaining = remaining
    out.files = restored.files
    out.reinstall = reinstall ? { ok: !!reinstall.ok, code: reinstall.code, stderr: clip(reinstall.stderr) } : null
    return out
  } finally {
    if (stopped) {
      try {
        await host.start()
        out.restarted = true
      } catch {
        /* the restore result still stands */
      }
    }
  }
}
