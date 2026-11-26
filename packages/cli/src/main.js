import { join, resolve } from 'node:path'
import { newDeviceLabel } from 'undohaven-core'
import {
  CloudClient,
  HouhuiError,
  bi,
  cloudFromConfig,
  createSnapshot,
  doctor,
  establishKeys,
  exportArchive,
  UPGRADE,
  readPrompts,
  decryptManifest,
  readSnapshotRecord,
  reportAnonymousEvent,
  showLimitNudge,
  writePrompts,
  importArchive,
  listSnapshots,
  loadConfig,
  loadDek,
  loadKeyFile,
  loadStorageConfig,
  migrateMachine,
  redactStorage,
  saveStorageConfig,
  onRuntimeStart,
  publicKeyFields,
  resolveAgentsHome,
  resolveDataDir,
  resolveDshHome,
  restoreSnapshot,
  pinSnapshot,
  scanGuard,
  rollbackGuard,
  listPluginHistory,
  listDeleted,
  restoreDeleted,
  confirmDelete,
  setDeleteRetention,
  DELETE_LAYER_COPY,
  listRuntimeMismatch,
  realignPlugins,
  readAlignmentNotice,
  ALIGN_COPY,
  detectDshVersions,
  matchBlock,
  loadBlocklist,
  ROLLBACK_LIMIT,
  rotatePassphrase,
  saveConfig,
  collectPluginState,
  diffPluginState,
  installProfile,
  loadPluginState,
  loadState,
  restoreOnePlugin,
  restorePluginState,
  savePluginState,
  saveKeyFile,
  unlockPassphrase,
  upgradeRuntime,
} from 'undohaven-core'

function parseArgs(argv) {
  const args = argv.slice(2)
  const flags = {}
  const positionals = []
  let command = null
  const take = (key, value) => {
    if (flags[key] === undefined) flags[key] = value
    else if (Array.isArray(flags[key])) flags[key].push(value)
    else flags[key] = [flags[key], value]
  }
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (!command && !arg.startsWith('-')) {
      command = arg
      continue
    }
    if (arg === '--') {
      positionals.push(...args.slice(i + 1))
      break
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=')
      const key = eq === -1 ? arg.slice(2) : arg.slice(2, eq)
      if (eq !== -1) take(key, arg.slice(eq + 1))
      else if (args[i + 1] === undefined || args[i + 1].startsWith('-')) take(key, true)
      else {
        take(key, args[i + 1])
        i += 1
      }
      continue
    }
    positionals.push(arg)
  }
  return { command, flags, positionals }
}

function context(flags) {
  const env = process.env
  return {
    dshHome: resolveDshHome(flags['dsh-home'], env),
    agentsHome: resolveAgentsHome(flags['agents-home'], env),
    dataDir: resolveDataDir(flags['data-dir'] || flags.home, env, resolveDshHome(flags['dsh-home'], env)),
    apiBase: flags.api || env.UNDOHAVEN_API || null,
    json: flags.json === true || flags.json === 'true',
    env,
  }
}

async function passphraseOf(flags) {
  if (process.env.UNDOHAVEN_PASSPHRASE) return process.env.UNDOHAVEN_PASSPHRASE
  if (typeof flags.passphrase === 'string') return flags.passphrase
  if (!process.stdin.isTTY) {
    throw new HouhuiError('need_passphrase', '请设置 UNDOHAVEN_PASSPHRASE 或在终端里输入口令', 'Set UNDOHAVEN_PASSPHRASE or run in a terminal to type the passphrase')
  }
  return promptHidden(`${bi('口令', 'Passphrase')}: `)
}

function promptHidden(label) {
  return new Promise((resolve, reject) => {
    process.stdout.write(label)
    const stdin = process.stdin
    stdin.setRawMode(true)
    stdin.resume()
    let value = ''
    const onData = (buf) => {
      const text = buf.toString('utf8')
      if (text === '\u0003') {
        stdin.setRawMode(false)
        stdin.pause()
        stdin.off('data', onData)
        reject(new HouhuiError('cancelled', '已取消', 'Cancelled'))
        return
      }
      if (text === '\r' || text === '\n' || text === '\u0004') {
        stdin.setRawMode(false)
        stdin.pause()
        stdin.off('data', onData)
        process.stdout.write('\n')
        resolve(value)
        return
      }
      if (text === '\u007f' || text === '\b') {
        value = value.slice(0, -1)
        return
      }
      value += text
    }
    stdin.on('data', onData)
  })
}

function printRecovery(words, json) {
  const warning = {
    zh: '把这 24 个单词抄到机器外面。口令和恢复码都丢了，云端备份就永远解不开。服务器只保存被包裹的密钥，没有你的口令。',
    en: 'Write these 24 words down off this machine. If you lose both the passphrase and the recovery code, the cloud backup can never be decrypted. The server stores only wrapped keys, never your passphrase.',
  }
  if (json) {
    console.log(JSON.stringify({ event: 'recovery_code', words, warning }))
    return
  }
  console.log(`\n${warning.zh}\n${warning.en}\n`)
  words.forEach((word, index) => {
    console.log(`${String(index + 1).padStart(2, ' ')}. ${word}`)
  })
  console.log('')
}

async function cloudFor(ctx) {
  const loaded = await cloudFromConfig(ctx.dataDir, { apiBase: ctx.apiBase })
  if (ctx.apiBase && loaded.config.apiBase !== ctx.apiBase) {
    loaded.config.apiBase = ctx.apiBase
    await saveConfig(ctx.dataDir, loaded.config)
  }
  if (!loaded.cloud && ctx.apiBase && loaded.config.accessToken) {
    return { config: loaded.config, cloud: new CloudClient({ apiBase: ctx.apiBase, token: loaded.config.accessToken }) }
  }
  return loaded
}

function emit(ctx, payload) {
  if (ctx.json) console.log(JSON.stringify(payload))
  else console.log(payload.text)
}

async function cmdDoctor(ctx) {
  const report = await doctor(ctx.dshHome)
  if (ctx.json) {
    console.log(JSON.stringify(report))
  } else {
    console.log(bi(`检查 ${ctx.dshHome}`, `Checked ${ctx.dshHome}`))
    if (report.findings.length === 0) console.log(bi('没有发现问题', 'No findings'))
    for (const item of report.findings) {
      console.log(`[${item.level}] ${item.code} ${item.path}\n  ${item.zh}\n  ${item.en}`)
    }
    console.log(bi(`${report.errors} 个错误，${report.warnings} 个警告`, `${report.errors} errors, ${report.warnings} warnings`))
  }
  return report.ok ? 0 : 1
}

async function ensureDek(ctx) {
  try {
    return (await loadDek(ctx.dataDir)).dek
  } catch (error) {
    if (error.code !== 'locked') throw error
  }
  const pass = await passphraseOf({})
  const existing = await loadKeyFile(ctx.dataDir)
  if (existing?.wrappedDek) return (await unlockPassphrase(ctx.dataDir, pass)).dek
  const created = await establishKeys(ctx.dataDir, pass)
  printRecovery(created.words, ctx.json)
  if (!ctx.json) {
    console.log(bi(
      '快照只在这台机器上，不需要账户，也不会上传。',
      'The snapshot stays on this machine. No account, and nothing is uploaded.',
    ))
  }
  return created.dek
}

async function maybePrompt(ctx, kind) {
  const text = UPGRADE[kind]
  if (!text) return
  const prompts = await readPrompts(ctx.dataDir)
  prompts.upgrade = text
  await writePrompts(ctx.dataDir, prompts)
  if (ctx.json) console.error(JSON.stringify({ upgrade: kind, ...text }))
  else console.error(`\n${text.zh}\n${text.en}\n`)
}

async function cmdSnapshot(ctx, flags) {
  const { cloud } = await cloudFor(ctx)
  const dek = await ensureDek(ctx)
  const includeCredentials = flags['include-credentials'] === true || flags['include-credentials'] === 'true'
  const tags = flags.tag ? (Array.isArray(flags.tag) ? flags.tag : String(flags.tag).split(',')) : []
  const snap = await createSnapshot({
    dataDir: ctx.dataDir,
    dshHome: ctx.dshHome,
    agentsHome: ctx.agentsHome,
    includeCredentials,
    kind: flags.kind || 'manual',
    tags,
    dek,
    cloud,
    env: ctx.env,
  })
  await reportAnonymousEvent(ctx.dataDir, 'first_snapshot', null, ctx.env).catch(() => {})
  if (snap.plan === 'free' && Number(snap.pruned) > 0) {
    const nudge = await showLimitNudge(ctx.dataDir, 'history', ctx.env)
    if (nudge.shown) console.error(nudge.line)
  }
  if (snap.cloudError) {
    const message = snap.cloudError instanceof Error ? snap.cloudError.message : String(snap.cloudError)
    if (/quota|容量/.test(message)) await reportAnonymousEvent(ctx.dataDir, 'limit_hit', { reason: 'snapshot' }, ctx.env).catch(() => {})
    if (ctx.json) console.log(JSON.stringify({ ok: false, id: snap.id, cloud: false, error: message, bytes: snap.bytes }))
    else console.error(bi(`本地快照已保存 ${snap.id}，云端同步失败`, `Local snapshot ${snap.id} was saved; cloud sync failed`))
    console.error(message)
    return 1
  }
  emit(ctx, {
    text: bi(`快照 ${snap.id}，${snap.fileCount} 个文件，${snap.bytes} 字节${snap.cloud ? '，已上传' : '，仅本地'}`, `Snapshot ${snap.id}, ${snap.fileCount} files, ${snap.bytes} bytes${snap.cloud ? ', uploaded' : ', local only'}`),
    ...snap,
    manifest: undefined,
    cloudError: undefined,
  })
  if (cloud && snap.cloud) {
    try {
      const account = await cloud.account()
      const cap = account.features?.storageBytes || 1
      if (account.plan === 'free' && account.usageBytes / cap >= 0.8) {
        await maybePrompt(ctx, 'quota')
        await reportAnonymousEvent(ctx.dataDir, 'limit_hit', { reason: 'quota' }, ctx.env).catch(() => {})
      }
    } catch {
      /* quota hint is optional */
    }
  }
  return 0
}

async function cmdList(ctx) {
  const { cloud } = await cloudFor(ctx)
  const rows = await listSnapshots({ dataDir: ctx.dataDir, cloud, allowCloudFailure: !ctx.json })
  if (ctx.json) console.log(JSON.stringify({ snapshots: rows }))
  else if (rows.length === 0) console.log(bi('还没有快照', 'No snapshots yet'))
  else {
    for (const row of rows) {
      console.log(`${row.createdAt}  ${row.id}  ${row.kind}  ${row.bytes} B  ${row.files ?? '?'} files  dsh ${row.dshVersion ?? '?'}  ${row.cloud ? 'cloud' : 'local'}${row.pinned ? '  pinned' : ''}`)
    }
  }
  return 0
}

async function cmdRestore(ctx, flags) {
  const localFile = flags.local
  let id = flags.to
  if (localFile) {
    const imported = await importArchive(localFile, { dataDir: ctx.dataDir })
    id = id || imported.record.id
    if (flags.to && flags.to !== imported.record.id) {
      throw new HouhuiError('snapshot_mismatch', '导出文件里的快照编号和 --to 不一致', 'Export file snapshot id does not match --to')
    }
  }
  if (!id) throw new HouhuiError('need_target', '请提供 --to <快照> 或 --local <文件>', 'Pass --to <snapshot> or --local <file>')
  const dek = await ensureDek(ctx)
  const { cloud } = localFile ? { cloud: null } : await cloudFor(ctx)
  const scope = flags.scope || 'all'
  if (!['sessions', 'storages', 'config', 'profile', 'all', 'tasks', 'session'].includes(scope)) {
    throw new HouhuiError('bad_scope', '范围只能是 sessions、storages、config、profile、tasks、session 或 all', 'Scope must be sessions, storages, config, profile, tasks, session, or all')
  }
  const result = await restoreSnapshot({
    dek,
    dataDir: ctx.dataDir,
    dshHome: ctx.dshHome,
    agentsHome: ctx.agentsHome,
    id,
    scope,
    session: flags.session,
    cloud,
    env: ctx.env,
  })
  emit(ctx, {
    text: bi(`已恢复 ${result.files} 个文件，来自 ${result.id}${result.safetyId ? `。恢复前安全快照 ${result.safetyId}` : ''}`, `Restored ${result.files} files from ${result.id}${result.safetyId ? `. Safety snapshot ${result.safetyId}` : ''}`),
    ok: true,
    ...result,
    safetyCloudError: result.safetyCloudError ? String(result.safetyCloudError.message || result.safetyCloudError) : null,
  })
  const prompts = await readPrompts(ctx.dataDir)
  if (!prompts.rollbackShown) {
    prompts.rollbackShown = true
    await writePrompts(ctx.dataDir, prompts)
    await maybePrompt(ctx, 'rollback')
  }
  await reportAnonymousEvent(ctx.dataDir, 'rollback', { scope: flags.scope || 'all' }, ctx.env).catch(() => {})
  if (cloud) {
    try { await cloud.track('rollback_success', { id: result.id }) } catch { /* offline is fine */ }
  }
  return 0
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function cmdLogin(ctx, flags) {
  const apiBase = ctx.apiBase || (await loadConfig(ctx.dataDir)).apiBase
  if (!apiBase) {
    throw new HouhuiError('need_api', '请用 --api 指定服务地址', 'Pass --api with the service URL')
  }
  const anon = new CloudClient({ apiBase })
  const code = await anon.deviceCode({
    name: typeof flags['device-name'] === 'string' ? flags['device-name'] : newDeviceLabel(),
    purpose: 'login',
  })
  if (ctx.json) console.log(JSON.stringify({ event: 'device_code', ...code }))
  else {
    console.log(bi(`打开 ${code.verification_uri}`, `Open ${code.verification_uri}`))
    console.log(bi(`用户码 ${code.user_code}`, `User code ${code.user_code}`))
  }
  let token = null
  const deadline = Date.now() + (code.expires_in || 900) * 1000
  let interval = (code.interval || 5) * 1000
  while (Date.now() < deadline) {
    await sleep(interval)
    try {
      token = await anon.deviceToken(code.device_code)
      break
    } catch (error) {
      if (error.code === 'authorization_pending') continue
      if (error.code === 'device_limit') {
        const nudge = await showLimitNudge(ctx.dataDir, 'device', ctx.env)
        if (nudge.shown) console.error(nudge.line)
        throw error
      }
      if (error.code === 'slow_down') {
        interval += 5000
        continue
      }
      throw error
    }
  }
  if (!token?.access_token) throw new HouhuiError('login_timeout', '设备授权超时', 'Device authorization timed out')
  const authed = new CloudClient({ apiBase, token: token.access_token })
  const account = await authed.account()
  let keys = await loadKeyFile(ctx.dataDir)
  let created = null
  if (!account.keys) {
    const pass = await passphraseOf(flags)
    created = await establishKeys(ctx.dataDir, pass)
    keys = created
    await authed.putKeys({ ...publicKeyFields(created), rotate: false })
    printRecovery(created.words, ctx.json)
  } else if (flags.recovery) {
    const words = process.env.UNDOHAVEN_RECOVERY || flags.recovery_words
    if (!words) throw new HouhuiError('need_recovery', '请用 UNDOHAVEN_RECOVERY 提供 24 个单词', 'Set UNDOHAVEN_RECOVERY to the 24 words')
    const remoteKeys = {
      salt: account.keys.salt,
      kdf: account.keys.kdf,
      wrappedDek: account.keys.wrappedDek,
      wrappedDekRecovery: account.keys.wrappedDekRecovery,
    }
    await saveKeyFile(ctx.dataDir, {
      salt: Buffer.from(remoteKeys.salt, 'base64'),
      kdf: remoteKeys.kdf,
      wrappedDek: Buffer.from(remoteKeys.wrappedDek, 'base64'),
      wrappedDekRecovery: Buffer.from(remoteKeys.wrappedDekRecovery, 'base64'),
      dek: null,
    })
    const pass = await passphraseOf(flags)
    keys = await rotatePassphrase(ctx.dataDir, words, pass)
    await authed.putKeys({ ...publicKeyFields(keys), rotate: true })
  } else {
    const pass = await passphraseOf(flags)
    keys = await unlockPassphrase(ctx.dataDir, pass, {
      salt: account.keys.salt,
      kdf: account.keys.kdf,
      wrappedDek: account.keys.wrappedDek,
      wrappedDekRecovery: account.keys.wrappedDekRecovery,
    })
  }
  await saveConfig(ctx.dataDir, {
    apiBase,
    accessToken: token.access_token,
    userId: token.user_id,
    deviceId: token.device_id,
    includeCredentials: false,
  })
  const prompts = await readPrompts(ctx.dataDir)
  if (!prompts.installTracked) {
    try {
      await authed.track('install_first_run', { deviceId: token.device_id })
      prompts.installTracked = true
      await writePrompts(ctx.dataDir, prompts)
    } catch {
      /* login already succeeded */
    }
  }
  if (ctx.json) {
    console.log(JSON.stringify({ event: 'logged_in', userId: token.user_id, deviceId: token.device_id, plan: account.plan, created: !!created }))
  } else {
    console.log(bi(`已登录 ${token.user_id}，套餐 ${account.plan}`, `Logged in as ${token.user_id}, plan ${account.plan}`))
    if (created) console.log(bi('上面的恢复码只显示这一次', 'The recovery code above is shown only once'))
  }
  return 0
}

async function cmdLogout(ctx) {
  const { config, cloud } = await cloudFor(ctx)
  if (cloud) {
    try {
      await cloud.request('POST', '/v1/devices/revoke-self', { body: {} })
    } catch {
      /* local logout still proceeds */
    }
  }
  config.accessToken = null
  config.deviceId = null
  await saveConfig(ctx.dataDir, config)
  const keys = await loadKeyFile(ctx.dataDir)
  if (keys) {
    keys.dek = null
    await saveKeyFile(ctx.dataDir, keys)
  }
  emit(ctx, { text: bi('已退出并锁上本地数据密钥', 'Logged out and locked the local data key'), ok: true })
  return 0
}

async function cmdMigrate(ctx, flags) {
  const { cloud } = await cloudFor(ctx)
  if (!cloud) throw new HouhuiError('login_required', '请先登录', 'Log in first')
  if (!flags.to) throw new HouhuiError('need_target', '请用 --to 选择快照', 'Pass --to with the snapshot id')
  const result = await migrateMachine({
    dataDir: ctx.dataDir,
    dshHome: ctx.dshHome,
    agentsHome: ctx.agentsHome,
    id: flags.to,
    cloud,
    env: ctx.env,
    scope: flags.scope || 'all',
  })
  emit(ctx, {
    text: bi(
      `已迁移 ${result.restored.files} 个文件，并重装 ${result.reinstalled.length} 个 profile`,
      `Migrated ${result.restored.files} files and reinstalled ${result.reinstalled.length} profiles`,
    ),
    ok: true,
    ...result,
    restored: { ...result.restored, safetyCloudError: result.restored.safetyCloudError ? String(result.restored.safetyCloudError.message || result.restored.safetyCloudError) : null },
  })
  return 0
}

async function cmdUpgrade(ctx, flags, positionals) {
  const version = positionals[0] || flags.version
  if (!version || version === true) throw new HouhuiError('need_version', '用法：undohaven upgrade <version>', 'Usage: undohaven upgrade <version>')
  const { cloud } = await cloudFor(ctx)
  const snap = await upgradeRuntime(String(version), {
    dataDir: ctx.dataDir,
    dshHome: ctx.dshHome,
    agentsHome: ctx.agentsHome,
    cloud,
    env: ctx.env,
    stdio: ctx.json ? 'pipe' : 'inherit',
  })
  emit(ctx, { text: bi(`升级前快照 ${snap.id}，开始安装 ${version}`, `Pre-upgrade snapshot ${snap.id}; installing ${version}`), ok: true, id: snap.id, version })
  return 0
}

async function cmdExport(ctx, flags) {
  const file = flags.local
  if (!file || file === true) throw new HouhuiError('need_file', '用法：undohaven export --local <文件>', 'Usage: undohaven export --local <file>')
  const keys = await loadKeyFile(ctx.dataDir)
  if (!keys?.dek) await loadDek(ctx.dataDir)
  const result = await exportArchive(file, {
    dataDir: ctx.dataDir,
    dshHome: ctx.dshHome,
    agentsHome: ctx.agentsHome,
    includeCredentials: flags['include-credentials'] === true,
    keys,
    env: ctx.env,
  })
  if (!ctx.json) {
    console.log(bi('这个文件只用口令加密，不经过云端。口令和恢复码都丢了就打不开。', 'This file is encrypted with your passphrase only. It is unreadable if you lose both the passphrase and the recovery code.'))
  }
  emit(ctx, { text: bi(`已导出 ${result.id} 到 ${result.file}`, `Exported ${result.id} to ${result.file}`), ok: true, ...result })
  return 0
}

async function requireByo(ctx) {
  const { cloud } = await cloudFor(ctx)
  if (!cloud) {
    throw new HouhuiError('byo_not_allowed', '自有存储是专业版。请先登录并开通试用或订阅。https://undohaven.com/zh/pricing?utm_source=cli', 'Bring-your-own storage is Pro. Log in and start a trial or subscribe. https://undohaven.com/pricing?utm_source=cli', { exitCode: 4 })
  }
  const account = await cloud.account()
  if (!account.features?.byoStorage) {
    throw new HouhuiError('byo_not_allowed', '当前套餐不能使用自有存储。https://undohaven.com/zh/pricing?utm_source=cli', 'This plan cannot use bring-your-own storage. https://undohaven.com/pricing?utm_source=cli', { exitCode: 4 })
  }
}

async function cmdStorage(ctx, flags, positionals) {
  const action = positionals[0]
  if (action === 'show' || !action) {
    const config = redactStorage(await loadStorageConfig(ctx.dataDir))
    emit(ctx, { text: JSON.stringify(config), ...config })
    return 0
  }
  if (action === 'reset') {
    await saveStorageConfig(ctx.dataDir, { mode: 'local' })
    emit(ctx, { text: bi('已改回本机存储', 'Storage is local again'), mode: 'local' })
    return 0
  }
  if (action === 'set' && positionals[1] === 'dir') {
    if (!positionals[2]) throw new HouhuiError('need_path', '用法：undohaven storage set dir <路径>', 'Usage: undohaven storage set dir <path>')
    await requireByo(ctx)
    await saveStorageConfig(ctx.dataDir, { mode: 'dir', dir: resolve(positionals[2]) })
    emit(ctx, { text: bi(`分块改存到 ${positionals[2]}`, `Chunks now go to ${positionals[2]}`), mode: 'dir' })
    return 0
  }
  if (action === 'set' && positionals[1] === 's3') {
    const secret = flags['secret-access-key'] || process.env.UNDOHAVEN_S3_SECRET_ACCESS_KEY
    if (!flags.endpoint || !flags.bucket || !flags['access-key-id'] || !secret) {
      throw new HouhuiError('need_s3', '需要 --endpoint --bucket --access-key-id 和密钥', 'Need --endpoint, --bucket, --access-key-id, and a secret')
    }
    await requireByo(ctx)
    await saveStorageConfig(ctx.dataDir, {
      mode: 's3',
      s3: {
        endpoint: flags.endpoint,
        bucket: flags.bucket,
        region: flags.region || 'auto',
        prefix: flags.prefix || 'undohaven',
        accessKeyId: flags['access-key-id'],
        secretAccessKey: secret,
        forcePathStyle: true,
      },
    })
    emit(ctx, { text: bi(`分块改存到桶 ${flags.bucket}。密钥只在本机。`, `Chunks now go to bucket ${flags.bucket}. The secret stays on this machine.`), mode: 's3' })
    return 0
  }
  throw new HouhuiError('bad_storage', '用法：storage show | reset | set dir | set s3', 'Usage: storage show, reset, set dir, or set s3')
}

async function cmdInit(ctx) {
  const dek = await ensureDek(ctx)
  const { cloud } = await cloudFor(ctx)
  const snap = await createSnapshot({
    dataDir: ctx.dataDir,
    dshHome: ctx.dshHome,
    agentsHome: ctx.agentsHome,
    kind: 'manual',
    tags: ['init'],
    dek,
    cloud,
    env: ctx.env,
  })
  await reportAnonymousEvent(ctx.dataDir, 'first_snapshot', null, ctx.env).catch(() => {})
  emit(ctx, {
    text: bi(
      `已安装。第一份快照 ${snap.id}。回滚：undohaven restore --to ${snap.id}`,
      `Installed. First snapshot ${snap.id}. Roll back: undohaven restore --to ${snap.id}`,
    ),
    id: snap.id,
    cloud: !!snap.cloud,
  })
  return snap.cloudError ? 1 : 0
}

async function cmdFunnel(ctx, positionals) {
  const config = await loadConfig(ctx.dataDir)
  const action = positionals[0] || 'status'
  if (action === 'on') config.funnelOptIn = true
  else if (action === 'off') config.funnelOptIn = false
  else if (action !== 'status') {
    throw new HouhuiError('bad_funnel', '用法：undohaven funnel on|off|status', 'Usage: undohaven funnel on, off, or status')
  }
  if (action === 'on' || action === 'off') await saveConfig(ctx.dataDir, config)
  if (config.funnelOptIn) await reportAnonymousEvent(ctx.dataDir, 'install', null, ctx.env).catch(() => {})
  emit(ctx, {
    text: config.funnelOptIn
      ? bi('已打开匿名使用统计。没有账户信息。', 'Anonymous usage pings are on. No account is attached.')
      : bi('匿名使用统计是关的。', 'Anonymous usage pings are off.'),
    funnelOptIn: !!config.funnelOptIn,
  })
  return 0
}

async function pluginsFromRecord(ctx, record) {
  if (record?.plugins) return record.plugins
  if (!record?.encryptedManifest) return null
  const { dek } = await loadDek(ctx.dataDir)
  return decryptManifest(record, dek).plugins || null
}

async function cmdPlugins(ctx, flags, positionals) {
  const action = positionals[0] || 'snapshot'
  if (action === 'snapshot') {
    const state = await collectPluginState(ctx.dshHome)
    await savePluginState(ctx.dataDir, state)
    const count = Object.values(state.profiles).reduce((sum, profile) => sum + Object.keys(profile.dependencies).length, 0)
    emit(ctx, {
      text: bi(`已记下 ${count} 个插件包。`, `Recorded ${count} plugin package${count === 1 ? '' : 's'}.`),
      profiles: Object.keys(state.profiles),
      packages: count,
    })
    return 0
  }
  if (action === 'diff' || action === 'restore') {
    const saved = flags.from
      ? await pluginsFromRecord(ctx, await readSnapshotRecord(ctx.dataDir, flags.from))
      : await loadPluginState(ctx.dataDir)
    if (!saved) throw new HouhuiError('no_plugin_state', '还没有插件快照。', 'No plugin snapshot yet.')
    const current = await collectPluginState(ctx.dshHome)
    const diff = diffPluginState(saved, current)
    if (action === 'diff') {
      emit(ctx, { text: JSON.stringify(diff.profiles, null, 2), ...diff })
      return 0
    }
    const changed = await restorePluginState(ctx.dshHome, saved)
    const installs = []
    if (flags.install) {
      for (const name of changed) installs.push({ profile: name, ...(await installProfile(join(ctx.dshHome, 'profiles', name), ctx.env)) })
    }
    emit(ctx, {
      text: bi(`已写回 ${changed.join(', ') || '没有 profile'}。`, `Wrote ${changed.join(', ') || 'no profiles'}.`),
      profiles: changed,
      installs,
    })
    return 0
  }
  throw new HouhuiError('bad_plugins', '用法：undohaven plugins snapshot|restore|diff', 'Usage: undohaven plugins snapshot, restore, or diff')
}

async function cmdS3Keys(ctx, flags, positionals) {
  const { cloud } = await cloudFor(ctx)
  if (!cloud) throw new HouhuiError('login_required', '请先登录', 'Log in first')
  const action = positionals[0] === 'keys' ? positionals[1] : positionals[0]
  if (action === 'list') {
    const keys = await cloud.listS3Keys()
    emit(ctx, { text: keys.map((key) => `${key.accessKeyId} ${key.bucket} ${key.status}`).join('\n') || bi('还没有密钥', 'No keys yet'), keys })
    return 0
  }
  if (action === 'revoke') {
    const id = positionals[positionals[0] === 'keys' ? 2 : 1]
    if (!id) throw new HouhuiError('need_key', '用法：undohaven s3 keys revoke <id>', 'Usage: undohaven s3 keys revoke <id>')
    await cloud.revokeS3Key(id)
    emit(ctx, { text: bi(`已撤销 ${id}`, `Revoked ${id}`), ok: true, accessKeyId: id })
    return 0
  }
  if (action === 'create') {
    const created = await cloud.createS3Key({ label: flags.label || '', bucket: flags.bucket || 'undohaven' })
    emit(ctx, {
      text: bi(
        `密钥只显示这一次。\nendpoint https://s3.undohaven.com\nbucket ${created.bucket}\naccess ${created.accessKeyId}\nsecret ${created.secretAccessKey}`,
        `The secret is shown once.\nendpoint https://s3.undohaven.com\nbucket ${created.bucket}\naccess ${created.accessKeyId}\nsecret ${created.secretAccessKey}`,
      ),
      ...created,
    })
    return 0
  }
  throw new HouhuiError('bad_s3', '用法：undohaven s3 keys create|list|revoke', 'Usage: undohaven s3 keys create, list, or revoke')
}

async function guardTier(ctx) {
  const { cloud, config } = await cloudFor(ctx)
  const apiBase = config.apiBase || ctx.apiBase || 'https://undohaven.com'
  if (!cloud) return { tier: 'free', apiBase }
  try {
    const account = await cloud.account()
    const pro = account.plan === 'pro' || account.features?.guardRealtime
    return { tier: pro ? 'pro' : 'free', apiBase }
  } catch {
    return { tier: 'free', apiBase }
  }
}

async function cmdRescue(ctx, flags, positionals) {
  const action = positionals[0] && positionals[0] !== 'restore' ? positionals[0] : (flags.to ? 'restore' : 'list')
  if (action === 'list' || action === 'ls') {
    const rows = await listSnapshots({ dataDir: ctx.dataDir, allowCloudFailure: true })
    const lines = rows.map((row) => `${row.createdAt}  ${row.id}  ${row.kind}  ${row.files ?? '?'} files`)
    emit(ctx, { text: lines.join('\n') || bi('还没有快照。dsh 没启动也可以先拍一份。', 'No snapshots yet. You can take one even when dsh is not running.'), snapshots: rows })
    return 0
  }
  const id = flags.to || positionals[1]
  if (!id) throw new HouhuiError('need_target', '用法：undohaven rescue --to <快照>', 'Usage: undohaven rescue --to <snapshot>')
  const dek = await ensureDek(ctx)
  const result = await restoreSnapshot({
    dek,
    dataDir: ctx.dataDir,
    dshHome: ctx.dshHome,
    agentsHome: ctx.agentsHome,
    id,
    scope: 'profile',
    env: ctx.env,
  })
  emit(ctx, {
    text: bi(`已把 profile 的 package.json、pnpm-lock 和 cordis.patch.yml 写回到 ${result.id}。dsh 不需要在运行。`, `Wrote profile package.json, pnpm-lock, and cordis.patch.yml from ${result.id}. dsh does not need to be running.`),
    ...result,
  })
  return 0
}

async function cmdGuard(ctx, flags, positionals) {
  const action = positionals[0] || 'scan'
  const { tier, apiBase } = await guardTier(ctx)
  if (action === 'block') {
    const spec = positionals[1] || ''
    const blocklist = await loadBlocklist({ apiBase, tier, dataDir: ctx.dataDir })
    if (!spec) {
      const lines = (blocklist.entries || []).map((entry) => `${entry.name}@${(entry.versions || []).join(',')} ${entry.url}`)
      emit(ctx, { text: lines.join('\n') || 'empty', entries: blocklist.entries })
      return 0
    }
    const at = spec.lastIndexOf('@')
    const name = at > 0 ? spec.slice(0, at) : spec
    const version = at > 0 ? spec.slice(at + 1) : ''
    const hit = matchBlock(blocklist.entries, name, version)
    if (!hit) {
      emit(ctx, { text: bi(`${spec} 不在拦截名单里。`, `${spec} is not on the blocklist.`), blocked: false })
      return 0
    }
    emit(ctx, { text: bi(`拒绝安装或启用 ${spec}。${hit.url}`, `Refusing to install or enable ${spec}. ${hit.url}`), blocked: true, advisory: hit })
    return 1
  }
  if (action === 'history') {
    const name = positionals[1]
    if (!name) throw new HouhuiError('need_plugin', '用法：undohaven guard history <plugin>', 'Usage: undohaven guard history <plugin>')
    const history = await listPluginHistory(ctx.dataDir, name)
    const lines = history.map((item) => `${item.at}  ${item.snapshotId}  ${item.spec}`)
    emit(ctx, { text: lines.join('\n') || bi('还没有这个插件的回滚点。', 'No rollback points for this plugin yet.'), history })
    return 0
  }
  if (action === 'rollback') {
    const name = positionals[1]
    if (!name) throw new HouhuiError('need_plugin', '用法：undohaven guard rollback <plugin> [--to <snapshot|version>]', 'Usage: undohaven guard rollback <plugin> [--to <snapshot|version>]')
    const result = await rollbackGuard({
      tier,
      dataDir: ctx.dataDir,
      name,
      to: flags.to,
      applyPlugin: async ({ id }) => {
        const record = await readSnapshotRecord(ctx.dataDir, id)
        const plugins = await pluginsFromRecord(ctx, record)
        if (!plugins) throw new HouhuiError('no_plugin_state', '这份快照没有插件清单。', 'This snapshot has no plugin list.')
        const changed = await restoreOnePlugin(ctx.dshHome, plugins, name)
        return { id, scope: 'plugin', changed }
      },
    })
    emit(ctx, {
      text: bi(`已从 ${result.id} 恢复插件声明和 dsh 配置目录。${result.limitation}`, `Restored the plugin spec and dsh config directory from ${result.id}. ${result.limitation}`),
      ...result,
    })
    return 0
  }
  if (action === 'diff' && tier !== 'pro') {
    throw new HouhuiError('pro_required', '能力差异是专业版功能。免费版仍有基线扫描和每周名单。https://undohaven.com/zh/pricing?utm_source=cli', 'Capability diff is a Pro feature. Free still has the baseline scan and the weekly blocklist. https://undohaven.com/pricing?utm_source=cli', { exitCode: 4 })
  }
  let dek = null
  if (tier === 'pro') {
    const keys = await loadDek(ctx.dataDir)
    dek = keys.dek
  }
  const result = await scanGuard({
    tier,
    apiBase,
    dataDir: ctx.dataDir,
    dshHome: ctx.dshHome,
    createSnapshot: dek ? async (plugin) => createSnapshot({
      dataDir: ctx.dataDir,
      dshHome: ctx.dshHome,
      agentsHome: ctx.agentsHome,
      dek,
      env: ctx.env,
      kind: 'pre-change',
      tags: ['guard', plugin.name],
    }) : null,
    pinSnapshot: dek ? async (id) => pinSnapshot({ dataDir: ctx.dataDir, dshHome: ctx.dshHome, dek, env: ctx.env }, id) : null,
  })
  if (action === 'diff') {
    const lines = result.changes.map((change) => formatGuardChange(change))
    emit(ctx, { text: lines.join('\n') || bi('没有新的能力。', 'No new capabilities.'), changes: result.changes, blocked: result.blocked })
    return result.blocked.length ? 1 : 0
  }
  const lines = [
    `tier ${result.tier}`,
    ...result.blocked.map((item) => `blocked ${item.name}@${item.version} ${item.advisory.url}`),
    ...result.changes.map((item) => formatGuardChange(item)),
    ROLLBACK_LIMIT,
  ]
  emit(ctx, { text: lines.filter(Boolean).join('\n'), tier: result.tier, blocked: result.blocked, changes: result.changes })
  return result.blocked.length ? 1 : 0
}

function formatGuardChange(change) {
  const bits = [
    change.delta?.shell ? 'shell' : '',
    change.delta?.credentials ? 'credentials' : '',
    change.delta?.network ? 'network' : '',
    ...(change.delta?.installScripts || []).map((item) => `install:${item}`),
    ...(change.delta?.domains || []),
    ...(change.declared || []).map((item) => `declared:${item}`),
  ].filter(Boolean)
  const from = change.from || 'new'
  return `${change.name} ${from} -> ${change.to}: ${bits.join(', ') || 'no new shell, credentials, network, install script, or domain'}`
}

async function cmdTrial(ctx) {
  const { cloud } = await cloudFor(ctx)
  if (!cloud) throw new HouhuiError('login_required', '请先登录', 'Log in first')
  const trial = await cloud.startTrial()
  emit(ctx, { text: bi(`已开始 ${trial.days} 天试用，不需要银行卡。`, `Started a ${trial.days}-day trial. No card required.`), ok: true, ...trial })
  return 0
}

async function cmdRestoreDeleted(ctx, flags, positionals) {
  const action = positionals[0] || (flags.to ? 'restore' : 'list')
  if (action === 'retain') {
    const days = flags.days
    const saved = await setDeleteRetention(ctx.dataDir, days)
    emit(ctx, {
      text: bi(`删除留底保留 ${saved.defaultDays} 天。${DELETE_LAYER_COPY.zh}`, `Delete copies are kept for ${saved.defaultDays} days. ${DELETE_LAYER_COPY.en}`),
      ...saved,
      layer: DELETE_LAYER_COPY,
    })
    return 0
  }
  if (action === 'confirm') {
    const token = positionals[1] || flags.token
    if (!token) throw new HouhuiError('need_token', '用法：undohaven restore-deleted confirm <确认码>', 'Usage: undohaven restore-deleted confirm <token>')
    const confirmed = await confirmDelete(ctx.dataDir, String(token))
    emit(ctx, {
      text: bi(`已确认 ${confirmed.token}。这只是多一层留底。`, `Confirmed ${confirmed.token}. This is an extra backup layer.`),
      ...confirmed,
      layer: DELETE_LAYER_COPY,
    })
    return 0
  }
  if (action === 'list' || action === 'ls') {
    const listed = await listDeleted({ dataDir: ctx.dataDir })
    const lines = listed.entries.map((entry) => `${entry.createdAt}  ${entry.id}  ${entry.mode}  ${(entry.paths || []).map((item) => item.abs).join(', ')}`)
    emit(ctx, {
      text: `${lines.join('\n') || bi('还没有删除留底。', 'No delete copies yet.')}\n${DELETE_LAYER_COPY.zh}\n${DELETE_LAYER_COPY.en}`,
      ...listed,
      layer: DELETE_LAYER_COPY,
    })
    return 0
  }
  const id = flags.to || (action !== 'restore' ? action : positionals[1])
  if (!id) throw new HouhuiError('need_target', '用法：undohaven restore-deleted --to <id>', 'Usage: undohaven restore-deleted --to <id>')
  const dek = await ensureDek(ctx)
  const restored = await restoreDeleted({
    dataDir: ctx.dataDir,
    dshHome: ctx.dshHome,
    dek,
    id,
    dest: typeof flags.dest === 'string' ? flags.dest : null,
  })
  emit(ctx, {
    text: bi(`已还原 ${restored.files.length} 个文件，来自 ${restored.id}。${DELETE_LAYER_COPY.zh}`, `Restored ${restored.files.length} files from ${restored.id}. ${DELETE_LAYER_COPY.en}`),
    ...restored,
    layer: DELETE_LAYER_COPY,
  })
  return 0
}

async function cmdAlign(ctx, flags) {
  const versions = await detectDshVersions({ dshHome: ctx.dshHome, env: ctx.env })
  const notice = await readAlignmentNotice(ctx.dataDir)
  const runtimeVersion = (typeof flags.runtime === 'string' && flags.runtime) || notice?.runtimeVersion || (versions.dshVersion !== 'unknown' ? versions.dshVersion : versions.dshBaseVersion)
  const state = await loadState(ctx.dataDir)
  const previousVersion = (typeof flags.from === 'string' && flags.from) || notice?.previousVersion || state.previousDshVersion || null
  if (flags.apply !== true && flags.apply !== 'true') {
    const report = notice?.plugins ? notice : await listRuntimeMismatch({ dshHome: ctx.dshHome, runtimeVersion, previousVersion })
    const lines = (report.plugins || []).map((plugin) => `${plugin.profile}  ${plugin.name}@${plugin.version}  ${plugin.reason}${plugin.canBump ? '  align' : '  manual'}`)
    emit(ctx, {
      text: `${ALIGN_COPY.zh}\n${ALIGN_COPY.en}\n${lines.join('\n') || bi('没有停用的插件。', 'No disabled plugins.')}`,
      ...report,
    })
    return 0
  }
  const dek = await ensureDek(ctx)
  const { cloud } = await cloudFor(ctx)
  const result = await realignPlugins({
    dshHome: ctx.dshHome,
    dataDir: ctx.dataDir,
    runtimeVersion,
    previousVersion,
    env: ctx.env,
    createSnapshot: () => createSnapshot({
      dataDir: ctx.dataDir,
      dshHome: ctx.dshHome,
      agentsHome: ctx.agentsHome,
      dek,
      cloud,
      env: ctx.env,
      kind: 'pre-upgrade',
      tags: ['guard', 'align'],
      includeCredentials: false,
    }),
    install: (dir) => installProfile(dir, ctx.env),
  })
  emit(ctx, {
    text: bi(
      `已先做快照 ${result.snapshotId || '（没有需要升级的包）'}。${ALIGN_COPY.zh}`,
      `Snapshotted first (${result.snapshotId || 'nothing to upgrade'}). ${ALIGN_COPY.en}`,
    ),
    ...result,
  })
  return 0
}

function help() {
  return [
    'UndoHaven / 后悔药',
    'Unofficial third-party tool compatible with dsh. Losing both passphrase and recovery code = unrecoverable.',
    '默认只在本机做加密快照，不需要登录。 / Default is an encrypted local snapshot. No login.',
    '',
    'undohaven init',
    'undohaven doctor',
    'undohaven snapshot [--include-credentials] [--tag name]',
    'undohaven list',
    'undohaven restore --to <id> [--scope sessions|storages|config|tasks|session|all] [--session <id>] [--local <file>]',
    'undohaven login [--api URL] [--device-name name] [--recovery]',
    'undohaven logout',
    'undohaven trial',
    'undohaven funnel on|off|status',
    'undohaven storage show | reset | set dir <path> | set s3 --endpoint --bucket --access-key-id',
    'undohaven s3 keys create|list|revoke',
    'undohaven plugins snapshot|restore|diff',
    'undohaven rescue [list] | undohaven rescue --to <id>',
    'undohaven guard scan|diff|history <plugin>|rollback <plugin> [--to <snapshot|version>]|block [name@version]|align [--apply]',
    'undohaven restore-deleted [list | --to <id> | confirm <token> | retain --days N]',
    'undohaven migrate-machine --to <id>',
    'undohaven upgrade <version>',
    'undohaven export --local <file>',
    '',
    '--dsh-home --agents-home --data-dir --api --json',
  ].join('\n')
}

export async function main(argv = process.argv) {
  const { command, flags, positionals } = parseArgs(argv)
  try {
    if (!command || command === 'help' || flags.help) {
      console.log(help())
      return 0
    }
    const ctx = context(flags)
    if (command === 'funnel') return await cmdFunnel(ctx, positionals)
    await reportAnonymousEvent(ctx.dataDir, 'install', null, ctx.env).catch(() => {})
    if (command === 'init') return await cmdInit(ctx)
    if (command === 'doctor') return await cmdDoctor(ctx)
    if (command === 'snapshot') return await cmdSnapshot(ctx, flags)
    if (command === 'list') return await cmdList(ctx, flags)
    if (command === 'restore') return await cmdRestore(ctx, flags)
    if (command === 'login') return await cmdLogin(ctx, flags)
    if (command === 'logout') return await cmdLogout(ctx)
    if (command === 'migrate-machine') return await cmdMigrate(ctx, flags)
    if (command === 'upgrade') return await cmdUpgrade(ctx, flags, positionals)
    if (command === 'export') return await cmdExport(ctx, flags)
    if (command === 'storage') return await cmdStorage(ctx, flags, positionals)
    if (command === 's3') return await cmdS3Keys(ctx, flags, positionals)
    if (command === 'plugins') return await cmdPlugins(ctx, flags, positionals)
    if (command === 'rescue') return await cmdRescue(ctx, flags, positionals)
    if (command === 'guard') {
      if (positionals[0] === 'align') return await cmdAlign(ctx, flags)
      return await cmdGuard(ctx, flags, positionals)
    }
    if (command === 'restore-deleted') return await cmdRestoreDeleted(ctx, flags, positionals)
    if (command === 'trial') return await cmdTrial(ctx)
    if (command === 'startup') {
      const { cloud } = await cloudFor(ctx)
      const result = await onRuntimeStart({
        dataDir: ctx.dataDir,
        dshHome: ctx.dshHome,
        agentsHome: ctx.agentsHome,
        cloud,
        env: ctx.env,
      })
      emit(ctx, { text: bi(`启动快照 ${result.snapshot.id}`, `Startup snapshot ${result.snapshot.id}`), ok: true, id: result.snapshot.id, pinned: result.pinned?.id ?? null, versions: result.versions })
      return result.snapshot.cloudError ? 1 : 0
    }
    console.error(help())
    return 2
  } catch (error) {
    if (error instanceof HouhuiError) {
      if (flags.json) console.error(JSON.stringify({ ok: false, code: error.code, zh: error.zh, en: error.en }))
      else console.error(error.message)
      return error.exitCode ?? 1
    }
    console.error(error?.stack || String(error))
    return 1
  }
}
