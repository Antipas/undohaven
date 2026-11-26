import { homedir } from 'node:os'
import {
  ALIGN_COPY,
  DELETE_LAYER_COPY,
  cloudFromConfig,
  confirmDelete,
  createSnapshot,
  guardDeleteCommand,
  listDeleted,
  listRuntimeMismatch,
  loadDek,
  onPreExecute,
  readAlignmentNotice,
  realignPlugins,
  restoreDeleted,
} from 'undohaven-core'
import { installProfile } from 'undohaven-core'

function log(ctx, level, message) {
  const logger = ctx?.logger
  if (logger && typeof logger[level] === 'function') logger[level](message)
  else if (level === 'error' || level === 'warn') console.error(message)
}

export function safetyOptions(runtime) {
  const paths = runtime.paths()
  const env = paths.env || process.env
  return {
    ...paths,
    home: env.HOME || env.USERPROFILE || homedir(),
    userProfile: env.USERPROFILE || env.HOME || homedir(),
    platform: env.UNDOHAVEN_PLATFORM || process.platform,
    env,
  }
}

async function optionsWithKeys(runtime) {
  const opts = safetyOptions(runtime)
  try {
    opts.dek = (await loadDek(opts.dataDir)).dek
  } catch {
    opts.dek = null
  }
  try {
    opts.cloud = (await cloudFromConfig(opts.dataDir)).cloud
  } catch {
    opts.cloud = null
  }
  return opts
}

export async function noteRuntimeAlignment(runtime, started) {
  if (!started?.runtimeChanged) return null
  const paths = runtime.paths()
  const runtimeVersion = started.versions?.dshVersion && started.versions.dshVersion !== 'unknown'
    ? started.versions.dshVersion
    : started.versions?.dshBaseVersion
  const previousVersion = started.previousDshVersion || started.previousBaseVersion || null
  const report = await listRuntimeMismatch({ dshHome: paths.dshHome, runtimeVersion, previousVersion })
  if (!report.plugins.length) return null
  const notice = await saveAlignmentNotice(paths.dataDir, report)
  runtime.alignment = notice
  log(runtime.ctx, 'warn', `undohaven: ${notice.zh} ${notice.plugins.map((plugin) => plugin.name).join(', ')}`)
  return notice
}

function textOf(raw) {
  if (typeof raw === 'string') return raw.trim()
  if (raw && typeof raw.rawInput === 'string') return raw.rawInput.trim()
  return ''
}

export async function handleUndoHavenCommand(raw, runtime) {
  try {
    return await dispatchUndoHavenCommand(raw, runtime)
  } catch (error) {
    return { kind: 'error', text: `${error.zh || error.message} / ${error.en || error.message}` }
  }
}

async function dispatchUndoHavenCommand(raw, runtime) {
  const text = textOf(raw)
  const [head, ...rest] = text.split(/\s+/).filter(Boolean)
  const paths = runtime.paths()
  if (!head || head === 'help') {
    return {
      kind: 'success',
      text: `/undohaven restore-deleted [id]\n/undohaven confirm-delete <token>\n/undohaven align [apply]\n${DELETE_LAYER_COPY.zh}\n${DELETE_LAYER_COPY.en}\nUnofficial third-party. ${ALIGN_COPY.en}`,
    }
  }
  if (head === 'confirm-delete') {
    const token = rest[0]
    if (!token) return { kind: 'error', text: '用法：/undohaven confirm-delete <确认码> / Usage: /undohaven confirm-delete <token>' }
    await confirmDelete(paths.dataDir, token)
    return {
      kind: 'success',
      text: `已记下确认码 ${token}。下一次同样的递归删除可以继续。${DELETE_LAYER_COPY.zh} / Noted confirmation ${token}. The same recursive delete can continue once. ${DELETE_LAYER_COPY.en}`,
    }
  }
  if (head === 'restore-deleted') {
    if (!rest[0] || rest[0] === 'list') {
      const listed = await listDeleted({ dataDir: paths.dataDir })
      const lines = listed.entries.map((entry) => `${entry.createdAt}  ${entry.id}  ${entry.mode}  ${(entry.paths || []).map((item) => item.abs).join(', ')}`)
      return {
        kind: 'success',
        text: `${lines.join('\n') || '还没有删除留底。 / No delete copies yet.'}\n${DELETE_LAYER_COPY.zh} / ${DELETE_LAYER_COPY.en}`,
      }
    }
    let dek = null
    try {
      dek = (await loadDek(paths.dataDir)).dek
    } catch (error) {
      return { kind: 'error', text: `${error.zh || error.message} / ${error.en || error.message}` }
    }
    const restored = await restoreDeleted({ ...paths, dek, id: rest[0], deferInsideDsh: true })
    if (restored.deferred) return { kind: 'success', text: `${restored.zh} / ${restored.en} ${restored.command}` }
    return {
      kind: 'success',
      text: `已还原 ${restored.files.length} 个文件，来自 ${restored.id}。${DELETE_LAYER_COPY.zh} / Restored ${restored.files.length} files from ${restored.id}. ${DELETE_LAYER_COPY.en}`,
    }
  }
  if (head === 'align') {
    const notice = runtime.alignment || await readAlignmentNotice(paths.dataDir)
    if (rest[0] !== 'apply') {
      const names = (notice?.plugins || []).map((plugin) => `${plugin.name}@${plugin.version}`).join(', ') || 'none'
      return { kind: 'success', text: `${ALIGN_COPY.zh}\n${ALIGN_COPY.en}\n${names}` }
    }
    const opts = await optionsWithKeys(runtime)
    if (!opts.dek) return { kind: 'error', text: '本地密钥未解锁，还不能对齐。 / The local key is locked, so realignment has not started.' }
    const runtimeVersion = notice?.runtimeVersion
    if (!runtimeVersion) return { kind: 'error', text: '没有记录到 runtime 变化。 / No runtime change is recorded.' }
    const result = await realignPlugins({
      dshHome: opts.dshHome,
      dataDir: opts.dataDir,
      runtimeVersion,
      previousVersion: notice.previousVersion,
      createSnapshot: () => createSnapshot({
        ...opts,
        kind: 'pre-upgrade',
        tags: ['guard', 'align'],
        includeCredentials: false,
      }),
      install: (dir) => installProfile(dir, opts.env),
    })
    runtime.alignment = null
    return {
      kind: 'success',
      text: `已先快照 ${result.snapshotId || '（没有需要升级的包）'}，再处理插件。${ALIGN_COPY.zh} / Snapshotted first (${result.snapshotId || 'nothing to upgrade'}), then updated plugins. ${ALIGN_COPY.en}`,
    }
  }
  return { kind: 'error', text: '用法：/undohaven restore-deleted / Usage: /undohaven restore-deleted' }
}

function registerCommand(commands, runtime) {
  if (runtime.commandRegistered || typeof commands?.register !== 'function') return
  runtime.commandRegistered = true
  try {
    const stop = commands.register({
      name: 'undohaven',
      description: 'Extra encrypted copy before a recursive delete. Unofficial third-party. /undohaven restore-deleted',
      input: { hint: 'restore-deleted [id] | align [apply]' },
      handler: (input) => handleUndoHavenCommand(input, runtime),
    })
    if (typeof stop === 'function') runtime.safetyStops.push(stop)
  } catch (error) {
    runtime.commandRegistered = false
    runtime.lastError = error.message
  }
}

/**
 * Listen beside other tools/pre-execute plugins. Hard refusals also register
 * a monotonic guard so a later allow cannot widen a delete to a drive root,
 * a home directory, or .dsh. Backup-then-allow calls next().
 */
export function attachSafety(ctx, runtime) {
  if (runtime.safetyAttached) return () => {}
  runtime.safetyAttached = true
  runtime.safetyStops = runtime.safetyStops || []
  if (typeof ctx?.on === 'function') {
    const stop = ctx.on('tools/pre-execute', async (exec, next) => {
      const opts = await optionsWithKeys(runtime)
      const decision = await onPreExecute(exec, next, opts)
      if (decision?.decision?.mode === 'backup') {
        log(ctx, 'info', `undohaven: 已加密留底 ${decision.decision.id}。${DELETE_LAYER_COPY.zh} / Encrypted copy ${decision.decision.id}. ${DELETE_LAYER_COPY.en}`)
      }
      return decision
    }, { prepend: true })
    if (typeof stop === 'function') runtime.safetyStops.push(stop)
  }
  const guard = (exec) => guardDeleteCommand(exec, safetyOptions(runtime))
  if (typeof ctx?.tools?.guard === 'function') {
    const stop = ctx.tools.guard(guard)
    if (typeof stop === 'function') runtime.safetyStops.push(stop)
  } else if (typeof ctx?.inject === 'function') {
    ctx.inject(['tools'], (scoped) => {
      if (typeof scoped?.tools?.guard === 'function') {
        const stop = scoped.tools.guard(guard)
        if (typeof stop === 'function') runtime.safetyStops.push(stop)
      }
    })
  }
  if (ctx?.commands) registerCommand(ctx.commands, runtime)
  else if (typeof ctx?.inject === 'function') ctx.inject(['commands'], (scoped) => registerCommand(scoped?.commands, runtime))
  return () => {
    for (const stop of runtime.safetyStops) stop()
    runtime.safetyStops = []
    runtime.safetyAttached = false
    runtime.commandRegistered = false
  }
}
