import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  cloudFromConfig,
  createFileSnapshot,
  establishKeys,
  listFileSnapshots,
  loadDek,
  readFileManifest,
  restoreFileSnapshot,
} from 'undohaven-core'
import { collectPiFiles, loadExcludes, piAgentDir, toggleExclude } from './scan.js'

const SAFETY_MS = 10 * 60 * 1000

export function dataDirFor(agentDir, env = process.env) {
  if (env.UNDOHAVEN_HOME) return env.UNDOHAVEN_HOME
  return join(agentDir, 'undohaven')
}

async function dekOf(dataDir, env) {
  try {
    return (await loadDek(dataDir)).dek
  } catch (error) {
    const pass = env.UNDOHAVEN_PASSPHRASE
    if (!pass) throw error
    const created = await establishKeys(dataDir, pass)
    return created.dek
  }
}

async function proCloud(dataDir) {
  const { cloud } = await cloudFromConfig(dataDir)
  if (!cloud) return null
  try {
    const account = await cloud.account()
    if (account.plan === 'pro' || account.features?.guardRealtime || account.features?.machineMigration) return cloud
  } catch {
    return null
  }
  return null
}

export async function snapshotPi(opts) {
  const agentDir = piAgentDir(opts.env, opts.agentDir)
  const dataDir = opts.dataDir || dataDirFor(agentDir, opts.env)
  const patterns = await loadExcludes(dataDir)
  const { files, skipped } = await collectPiFiles(agentDir, opts.projectDir, patterns)
  const dek = await dekOf(dataDir, opts.env || process.env)
  const cloud = opts.cloud === false ? null : (opts.cloudClient === undefined ? await proCloud(dataDir) : opts.cloudClient)
  const record = await createFileSnapshot({
    dataDir,
    dek,
    files,
    kind: opts.kind || 'manual',
    tags: ['pi', ...(opts.tags || [])],
    tool: 'pi-undohaven',
    cloud,
  })
  return { ...record, skipped, cloud: Boolean(record.cloud), local: true }
}

export async function listPi(opts) {
  const agentDir = piAgentDir(opts.env, opts.agentDir)
  const dataDir = opts.dataDir || dataDirFor(agentDir, opts.env)
  return listFileSnapshots(dataDir)
}

export async function restorePi(opts) {
  const agentDir = piAgentDir(opts.env, opts.agentDir)
  const dataDir = opts.dataDir || dataDirFor(agentDir, opts.env)
  const dek = await dekOf(dataDir, opts.env || process.env)
  return restoreFileSnapshot({
    dataDir,
    dek,
    id: opts.id,
    paths: opts.paths,
    dest: { agent: opts.destAgent || agentDir, project: opts.destProject || opts.projectDir || agentDir },
  })
}

export async function migratePi(opts) {
  await snapshotPi({ ...opts, agentDir: opts.destAgent, kind: 'safety', tags: ['pi', 'before-migrate'], cloud: false })
  return restorePi(opts)
}

export async function safetySnapshot(opts) {
  const agentDir = piAgentDir(opts.env, opts.agentDir)
  const dataDir = opts.dataDir || dataDirFor(agentDir, opts.env)
  const reason = opts.reason || 'risk'
  const statePath = join(dataDir, 'pi-safety.json')
  let state = {}
  try {
    state = JSON.parse(await readFile(statePath, 'utf8'))
  } catch {
    state = {}
  }
  const previous = state[reason]
  if (previous && Date.now() - previous.at < SAFETY_MS) return { id: previous.id, reused: true }
  const record = await snapshotPi({ ...opts, kind: 'safety', tags: ['pi', 'before', reason], cloud: false })
  state[reason] = { id: record.id, at: Date.now() }
  await mkdir(dataDir, { recursive: true })
  await writeFile(statePath, JSON.stringify(state), { mode: 0o600 })
  return { id: record.id, reused: false }
}

export async function diagnosePi(opts) {
  const agentDir = piAgentDir(opts.env, opts.agentDir)
  const dataDir = opts.dataDir || dataDirFor(agentDir, opts.env)
  const patterns = await loadExcludes(dataDir)
  const { files, skipped } = await collectPiFiles(agentDir, opts.projectDir, patterns)
  let unlocked = true
  try {
    await loadDek(dataDir)
  } catch {
    unlocked = false
  }
  const { cloud, config } = await cloudFromConfig(dataDir)
  let plan = 'free'
  if (cloud) {
    try {
      const account = await cloud.account()
      plan = account.plan || 'free'
    } catch {
      plan = 'unknown'
    }
  }
  return {
    agentDir,
    files: files.length,
    sessions: files.filter((file) => file.rel.startsWith('sessions/')).length,
    skippedSecrets: skipped,
    excludes: patterns,
    unlocked,
    loggedIn: Boolean(config.accessToken),
    plan,
    cloudHistory: plan === 'pro',
  }
}

export { toggleExclude, loadExcludes, piAgentDir, dataDirFor as piDataDir }
export { readFileManifest }
