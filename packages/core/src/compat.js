import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Removed in dsh 0.2.2-rc.3. The Host service `working-directory` stays. */
export const REMOVED_WORKING_DIRECTORY_TOOL = {
  id: 'tool-working-directory',
  packageName: '@deepseek-ai/dsh-tool-working-directory',
  since: '0.2.2-rc.3',
}

export function patchMountsRemovedTool(text) {
  const source = String(text || '')
  return source.includes(REMOVED_WORKING_DIRECTORY_TOOL.id) || source.includes(REMOVED_WORKING_DIRECTORY_TOOL.packageName)
}

/**
 * Drop the removed model tool from a cordis patch. Leave the Host service
 * `working-directory` and every other row in place. Session logs are not
 * this function's job.
 */
export function stripWorkingDirectoryToolYaml(text) {
  const lines = String(text || '').split('\n')
  const drop = new Set()
  const marks = (line) => {
    const trimmed = line.trim()
    if (trimmed.includes(REMOVED_WORKING_DIRECTORY_TOOL.packageName)) return true
    return new RegExp(`^-\\s+id:\\s+['"]?${REMOVED_WORKING_DIRECTORY_TOOL.id}['"]?\\s*$`).test(trimmed)
  }
  for (let i = 0; i < lines.length; i += 1) {
    if (!marks(lines[i])) continue
    let start = i
    if (!lines[i].trim().startsWith('-')) {
      const here = lines[i].match(/^\s*/)[0].length
      for (let j = i; j >= 0; j -= 1) {
        const trimmed = lines[j].trim()
        const indent = lines[j].match(/^\s*/)[0].length
        if (trimmed.startsWith('-') && indent <= here) {
          start = j
          break
        }
      }
    }
    const base = lines[start].match(/^\s*/)[0].length
    let end = start + 1
    for (; end < lines.length; end += 1) {
      if (lines[end].trim() === '') continue
      const indent = lines[end].match(/^\s*/)[0].length
      if (indent <= base) break
    }
    for (let k = start; k < end; k += 1) drop.add(k)
  }
  const next = lines.filter((_, index) => !drop.has(index)).join('\n')
  return { text: next, changed: next !== String(text || '') }
}

export function stripWorkingDirectoryToolPackage(pkg) {
  if (!pkg || typeof pkg !== 'object') return false
  let changed = false
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    const block = pkg[field]
    if (block && Object.prototype.hasOwnProperty.call(block, REMOVED_WORKING_DIRECTORY_TOOL.packageName)) {
      delete block[REMOVED_WORKING_DIRECTORY_TOOL.packageName]
      changed = true
    }
  }
  return changed
}

async function writeIfChanged(path, before, after) {
  if (before === after) return false
  await writeFile(path, after)
  return true
}

/**
 * Make a restored home load on dsh 0.2.2-rc.3 and later. Bytes of session
 * logs, header.cwd, and storages/workspace.json are not rewritten.
 */
export async function stripRemovedWorkingDirectoryTool(dshHome) {
  const changed = []
  const patches = [join(dshHome, 'cordis.patch.yml')]
  const packages = []
  let names = []
  try {
    names = await readdir(join(dshHome, 'profiles'))
  } catch {
    names = []
  }
  for (const name of names) {
    patches.push(join(dshHome, 'profiles', name, 'cordis.patch.yml'))
    packages.push(join(dshHome, 'profiles', name, 'package.json'))
  }
  for (const path of patches) {
    let before
    try {
      before = await readFile(path, 'utf8')
    } catch {
      continue
    }
    const stripped = stripWorkingDirectoryToolYaml(before)
    if (await writeIfChanged(path, before, stripped.text)) changed.push(path)
  }
  for (const path of packages) {
    let before
    try {
      before = await readFile(path, 'utf8')
    } catch {
      continue
    }
    let pkg
    try {
      pkg = JSON.parse(before)
    } catch {
      continue
    }
    if (!stripWorkingDirectoryToolPackage(pkg)) continue
    const after = `${JSON.stringify(pkg, null, 2)}\n`
    if (await writeIfChanged(path, before, after)) changed.push(path)
  }
  return changed
}
