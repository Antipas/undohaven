import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const retired = /kind\s*:\s*['"]plugin['"]/

async function scan(dir, hits) {
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue
    const abs = join(dir, entry.name)
    if (entry.isDirectory()) {
      await scan(abs, hits)
      continue
    }
    if (!/\.(?:js|mjs|cjs|yml|yaml)$/.test(entry.name)) continue
    const text = await readFile(abs, 'utf8')
    if (retired.test(text)) hits.push(abs.slice(root.length + 1))
  }
}

test('UndoHaven and dsh-log-gate do not emit the retired plugin source kind', async () => {
  const hits = []
  await scan(join(root, 'packages'), hits)
  const rootPatch = join(root, 'cordis.patch.yml')
  try {
    const text = await readFile(rootPatch, 'utf8')
    if (retired.test(text)) hits.push('cordis.patch.yml')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  assert.deepEqual(hits, [])
})
