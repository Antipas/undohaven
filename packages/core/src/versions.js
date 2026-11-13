import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return null
  }
}

async function findBase(dir) {
  const direct = await readJson(join(dir, 'node_modules', '@deepseek-ai', 'dsh-base', 'package.json'))
  if (direct?.version) return direct.version
  const nested = await readJson(join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-base', 'package.json'))
  if (nested?.version) return nested.version
  return null
}

/**
 * Read the installed dsh and @deepseek-ai/dsh-base versions.
 * UNDOHAVEN_DSH_BASE_VERSION / UNDOHAVEN_DSH_VERSION override the detected
 * values so an upgrade can be simulated without installing a second build.
 */
export async function detectDshVersions(opts = {}) {
  const env = opts.env ?? process.env
  const prefixes = []
  if (opts.dshPrefix) prefixes.push(opts.dshPrefix)
  if (env.UNDOHAVEN_DSH_PREFIX) prefixes.push(env.UNDOHAVEN_DSH_PREFIX)
  if (opts.dshHome) {
    try {
      const profiles = await readdir(join(opts.dshHome, 'profiles'))
      for (const name of profiles) prefixes.push(join(opts.dshHome, 'profiles', name))
    } catch {
      /* no profiles */
    }
  }
  prefixes.push(process.cwd())
  let dshVersion = null
  let dshBaseVersion = null
  for (const prefix of prefixes) {
    if (!dshVersion) {
      const pkg = await readJson(join(prefix, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
      if (pkg?.version) dshVersion = pkg.version
    }
    if (!dshBaseVersion) dshBaseVersion = await findBase(prefix)
  }
  if (env.UNDOHAVEN_DSH_VERSION) dshVersion = env.UNDOHAVEN_DSH_VERSION
  if (env.UNDOHAVEN_DSH_BASE_VERSION) dshBaseVersion = env.UNDOHAVEN_DSH_BASE_VERSION
  if (!dshBaseVersion) dshBaseVersion = dshVersion
  return { dshVersion: dshVersion ?? 'unknown', dshBaseVersion: dshBaseVersion ?? 'unknown' }
}
