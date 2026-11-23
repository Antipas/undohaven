import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { REMOVED_WORKING_DIRECTORY_TOOL, stripWorkingDirectoryToolPackage, stripWorkingDirectoryToolYaml } from './compat.js'
import { parseYaml } from './yaml.js'

const STATE_NAME = 'plugins.json'

function statePath(dataDir) {
  return join(dataDir, STATE_NAME)
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

async function readText(file) {
  try {
    return await readFile(file, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return ''
    throw error
  }
}

function disabledFlag(value) {
  if (value === true) return true
  if (value === false) return false
  return null
}

function rowsOf(parsed) {
  const list = Array.isArray(parsed) ? parsed : []
  return list.filter((row) => row && typeof row === 'object' && typeof row.id === 'string').map((row) => ({
    id: row.id,
    name: typeof row.name === 'string' ? row.name : null,
    disabled: disabledFlag(row.disabled),
  }))
}

/** Read installed package specs and boolean enabled flags. Non-boolean disabled lines are left as null. */
export async function collectPluginState(dshHome) {
  const { readdir } = await import('node:fs/promises')
  const root = join(dshHome, 'profiles')
  let entries = []
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const profiles = {}
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = join(root, entry.name)
    const pkg = await readJson(join(dir, 'package.json'))
    const patch = await readText(join(dir, 'cordis.patch.yml'))
    let parsed = []
    if (patch.trim()) {
      try {
        parsed = parseYaml(patch)
      } catch {
        parsed = []
      }
    }
    const dependencies = {}
    for (const [name, spec] of Object.entries(pkg?.dependencies || {})) {
      if (typeof spec === 'string') dependencies[name] = spec
    }
    const bundles = Array.isArray(pkg?.dsh?.profile?.bundles)
      ? pkg.dsh.profile.bundles.filter((name) => typeof name === 'string')
      : []
    profiles[entry.name] = { dependencies, bundles, rows: rowsOf(parsed) }
  }
  return { version: 1, capturedAt: new Date().toISOString(), profiles }
}

export async function savePluginState(dataDir, state) {
  await mkdir(dataDir, { recursive: true })
  await writeFile(statePath(dataDir), JSON.stringify(state, null, 2), { mode: 0o600 })
}

export async function loadPluginState(dataDir) {
  return readJson(statePath(dataDir))
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function applyDisabledFlags(text, rows) {
  let next = text || ''
  const appended = []
  for (const row of rows) {
    if (typeof row.disabled !== 'boolean') continue
    const idRe = new RegExp(`^(\\s*)-\\s+id:\\s*${escapeRegExp(row.id)}\\s*$`)
    const lines = next.split('\n')
    let found = false
    for (let i = 0; i < lines.length; i += 1) {
      const match = idRe.exec(lines[i])
      if (!match) continue
      found = true
      const base = match[1].length
      let disabledAt = -1
      for (let j = i + 1; j < lines.length; j += 1) {
        if (lines[j].trim() === '') continue
        const indent = lines[j].match(/^\s*/)[0].length
        if (indent <= base && lines[j].trim().startsWith('-')) break
        if (/^\s*disabled:/.test(lines[j]) && !lines[j].includes('!!')) {
          disabledAt = j
          break
        }
      }
      if (disabledAt >= 0) lines[disabledAt] = lines[disabledAt].replace(/disabled:\s*.*/, `disabled: ${row.disabled}`)
      else if (row.disabled) lines.splice(i + 1, 0, `${' '.repeat(base + 2)}disabled: true`)
      break
    }
    next = lines.join('\n')
    if (!found) appended.push(row)
  }
  if (appended.length) {
    const blocks = appended.map((row) => {
      const lines = [`- id: ${row.id}`]
      if (row.name) lines.push(`  name: ${row.name}`)
      lines.push(`  disabled: ${row.disabled}`)
      return lines.join('\n')
    })
    next = `${next.replace(/\s*$/, '')}\n${blocks.join('\n')}\n`
  }
  return next
}

export async function restoreOnePlugin(dshHome, state, pluginName) {
  const changed = []
  for (const [profile, body] of Object.entries(state?.profiles || {})) {
    if (!body?.dependencies || !(pluginName in body.dependencies)) continue
    const dir = join(dshHome, 'profiles', profile)
    await mkdir(dir, { recursive: true })
    const pkgPath = join(dir, 'package.json')
    const pkg = await readJson(pkgPath) || { private: true }
    pkg.dependencies = { ...(pkg.dependencies || {}), [pluginName]: body.dependencies[pluginName] }
    stripWorkingDirectoryToolPackage(pkg)
    await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)
    const row = (body.rows || []).find((item) => item.id === pluginName || item.name === pluginName)
    if (row) {
      const patchPath = join(dir, 'cordis.patch.yml')
      const patch = stripWorkingDirectoryToolYaml(applyDisabledFlags(await readText(patchPath), [row])).text
      await writeFile(patchPath, patch.endsWith('\n') ? patch : `${patch}\n`)
    }
    changed.push({ profile, spec: body.dependencies[pluginName] })
  }
  return changed
}

export async function restorePluginState(dshHome, state) {
  const changed = []
  for (const [name, profile] of Object.entries(state?.profiles || {})) {
    const dir = join(dshHome, 'profiles', name)
    await mkdir(dir, { recursive: true })
    const pkgPath = join(dir, 'package.json')
    const pkg = await readJson(pkgPath) || { private: true }
    const dependencies = { ...(profile.dependencies || {}) }
    delete dependencies[REMOVED_WORKING_DIRECTORY_TOOL.packageName]
    pkg.dependencies = { ...(pkg.dependencies || {}), ...dependencies }
    stripWorkingDirectoryToolPackage(pkg)
    if (Array.isArray(profile.bundles) && profile.bundles.length) {
      pkg.dsh = pkg.dsh || {}
      pkg.dsh.profile = pkg.dsh.profile || {}
      const bundles = new Set([...(pkg.dsh.profile.bundles || []), ...profile.bundles])
      pkg.dsh.profile.bundles = [...bundles]
    }
    await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)
    const patchPath = join(dir, 'cordis.patch.yml')
    const rows = (profile.rows || []).filter((row) => row.id !== REMOVED_WORKING_DIRECTORY_TOOL.id && row.name !== REMOVED_WORKING_DIRECTORY_TOOL.packageName)
    const patch = stripWorkingDirectoryToolYaml(applyDisabledFlags(await readText(patchPath), rows)).text
    await writeFile(patchPath, patch.endsWith('\n') ? patch : `${patch}\n`)
    changed.push(name)
  }
  return changed
}

export function diffPluginState(saved, current) {
  const names = new Set([...Object.keys(saved?.profiles || {}), ...Object.keys(current?.profiles || {})])
  const profiles = {}
  for (const name of names) {
    const before = saved?.profiles?.[name] || { dependencies: {}, bundles: [], rows: [] }
    const after = current?.profiles?.[name] || { dependencies: {}, bundles: [], rows: [] }
    const missing = Object.keys(before.dependencies).filter((dep) => !(dep in after.dependencies))
    const extra = Object.keys(after.dependencies).filter((dep) => !(dep in before.dependencies))
    const beforeRows = new Map((before.rows || []).map((row) => [row.id, row]))
    const afterRows = new Map((after.rows || []).map((row) => [row.id, row]))
    const disabledChanged = []
    for (const [id, row] of beforeRows) {
      if (typeof row.disabled !== 'boolean') continue
      const now = afterRows.get(id)
      const currentDisabled = now ? now.disabled : false
      if (currentDisabled !== row.disabled) disabledChanged.push({ id, saved: row.disabled, current: currentDisabled === true })
    }
    profiles[name] = { missing, extra, disabledChanged }
  }
  return { profiles }
}

export function installProfile(profileDir, env = process.env) {
  return new Promise((resolve) => {
    const child = spawn('pnpm', ['install'], { cwd: profileDir, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let err = ''
    child.stderr.on('data', (chunk) => { err += chunk })
    child.on('error', (error) => resolve({ installed: false, reason: error.code === 'ENOENT' ? 'pnpm-missing' : error.message }))
    child.on('close', (code) => resolve({ installed: code === 0, reason: code === 0 ? null : err.slice(0, 400) || `exit ${code}` }))
  })
}
