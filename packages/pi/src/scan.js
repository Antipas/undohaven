import { readdir, readFile, stat, writeFile, mkdir } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { homedir } from 'node:os'

function asRel(root, abs) {
  return relative(root, abs).split(sep).join('/')
}

const SECRET_NAME = /^(?:\.env(?:\..*)?|credentials(?:\.(?:json|ya?ml))?|auth\.json|secrets\.json|id_rsa|id_ed25519|.*\.(?:pem|key))$/i

export function piAgentDir(env = process.env, configured) {
  if (configured) return configured
  if (env.PI_AGENT_DIR) return env.PI_AGENT_DIR
  return join(homedir(), '.pi', 'agent')
}

export function isSecretPath(rel) {
  const name = rel.split('/').pop()
  return SECRET_NAME.test(name)
}

export function isExcluded(rel, patterns) {
  if (rel.split('/').includes('node_modules') || rel.split('/').includes('.git')) return true
  if (isSecretPath(rel)) return true
  return (patterns || []).some((pattern) => rel === pattern || rel.startsWith(`${pattern.replace(/\/$/, '')}/`))
}

async function walk(root, dir, out, patterns, skipped) {
  let entries = []
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    return
  }
  for (const entry of entries) {
    const abs = join(dir, entry.name)
    const rel = asRel(root, abs)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'undohaven') continue
      await walk(root, abs, out, patterns, skipped)
      continue
    }
    if (!entry.isFile()) continue
    if (isExcluded(rel, patterns)) {
      if (isSecretPath(rel)) skipped.push(rel)
      continue
    }
    const info = await stat(abs)
    out.push({ abs, rel, mode: info.mode, mtimeMs: info.mtimeMs })
  }
}

export async function collectPiFiles(agentDir, projectDir, patterns) {
  const files = []
  const skipped = []
  await walk(agentDir, agentDir, files, patterns, skipped)
  const tagged = files.map((file) => ({ ...file, root: 'agent' }))
  if (projectDir) {
    const projectFiles = []
    await walk(projectDir, projectDir, projectFiles, patterns, skipped)
    tagged.push(...projectFiles.map((file) => ({ ...file, root: 'project' })))
  }
  return { files: tagged, skipped }
}

export async function loadExcludes(dataDir) {
  try {
    const parsed = JSON.parse(await readFile(join(dataDir, 'exclude.json'), 'utf8'))
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return []
  }
}

export async function toggleExclude(dataDir, pattern) {
  const current = await loadExcludes(dataDir)
  const next = current.includes(pattern) ? current.filter((item) => item !== pattern) : [...current, pattern]
  await mkdir(dataDir, { recursive: true, mode: 0o700 })
  await writeFile(join(dataDir, 'exclude.json'), `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
  return { patterns: next, enabled: next.includes(pattern) }
}
