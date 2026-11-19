import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { parseYaml } from 'undohaven-core'

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..')

function inserted(text, id) {
  const doc = parseYaml(text)
  assert.equal(Array.isArray(doc), true)
  const bare = doc.filter((row) => row && row.id === id && !row.insert)
  assert.equal(bare.length, 0, `a bare - id: ${id} patches a missing entry`)
  const rows = doc.flatMap((row) => Array.isArray(row?.insert) ? row.insert : [])
  const found = rows.find((row) => row.id === id)
  assert.ok(found, `insert list is missing ${id}`)
  return found
}

test('bundle patches insert new plugin rows instead of patching missing ids', async () => {
  const undohaven = await readFile(join(root, 'packages/plugin/cordis.patch.yml'), 'utf8')
  const gate = await readFile(join(root, 'packages/log-gate/cordis.patch.yml'), 'utf8')
  assert.equal(inserted(undohaven, 'undohaven').name, 'dsh-undohaven')
  assert.equal(inserted(gate, 'log-gate').name, 'dsh-log-gate')
  assert.match(undohaven, /^-\s+insert:/m)
  assert.match(gate, /^-\s+insert:/m)
  assert.doesNotMatch(undohaven, /^-\s+id:\s+undohaven\s*$/m)
  assert.doesNotMatch(gate, /^-\s+id:\s+log-gate\s*$/m)
})
