import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { collectFiles, isConfigPath, list, shouldSnapshotBeforeTool, snapshot, undo } from '../src/engine.js'
import { sandbox } from './helpers.js'

test('isConfigPath covers global config, .opencode and project config files', async () => {
  const s = await sandbox()
  const o = s.opts
  assert.ok(isConfigPath(join(s.configDir, 'agent', 'x.md'), o))
  assert.ok(isConfigPath(join(s.projectDir, '.opencode', 'command', 'ship.md'), o))
  assert.ok(isConfigPath('.opencode/agent/new.md', o))
  assert.ok(isConfigPath(join(s.projectDir, 'opencode.jsonc'), o))
  assert.ok(isConfigPath(join(s.projectDir, 'AGENTS.md'), o))
  assert.ok(!isConfigPath(join(s.projectDir, 'src', 'AGENTS.md'), o))
  assert.ok(!isConfigPath(join(s.projectDir, 'src', 'index.ts'), o))
  assert.ok(!isConfigPath('', o))
})

test('shouldSnapshotBeforeTool only fires for edits that touch config', async () => {
  const s = await sandbox()
  const o = s.opts
  assert.ok(shouldSnapshotBeforeTool('edit', { filePath: join(s.projectDir, 'opencode.json') }, o))
  assert.ok(shouldSnapshotBeforeTool('write', { filePath: '.opencode/agent/a.md' }, o))
  assert.ok(shouldSnapshotBeforeTool('apply_patch', { patchText: '*** Begin Patch\n*** Update File: .opencode/command/ship.md\n' }, o))
  assert.ok(shouldSnapshotBeforeTool('bash', { command: 'rm -rf .opencode/agent' }, o))
  assert.ok(!shouldSnapshotBeforeTool('edit', { filePath: join(s.projectDir, 'src', 'a.ts') }, o))
  assert.ok(!shouldSnapshotBeforeTool('read', { filePath: join(s.projectDir, 'opencode.json') }, o))
  assert.ok(!shouldSnapshotBeforeTool('bash', { command: 'ls src' }, o))
})

test('collectFiles skips secrets and keeps project root config', async () => {
  const s = await sandbox()
  const names = (await collectFiles(s.opts)).map((f) => `${f.root}:${f.rel}`).sort()
  assert.deepEqual(names, [
    'config:agent/reviewer.md',
    'config:opencode.json',
    'project:command/ship.md',
    'root:AGENTS.md',
    'root:opencode.json',
  ])
})

test('snapshot, break config, undo restores it and keeps a pre-undo backup', async () => {
  const s = await sandbox()
  const first = await snapshot({ ...s.opts, kind: 'manual' })
  assert.equal(first.unchanged, false)
  assert.equal(first.files, 5)
  await writeFile(join(s.configDir, 'agent', 'reviewer.md'), 'BROKEN\n')
  await writeFile(join(s.projectDir, 'opencode.json'), '{"model":"broken"}\n')
  await writeFile(join(s.projectDir, '.opencode', 'command', 'ship.md'), 'BROKEN\n')
  const result = await undo(s.opts)
  assert.equal(result.id, first.id)
  assert.equal(await readFile(join(s.configDir, 'agent', 'reviewer.md'), 'utf8'), 'reviewer v1\n')
  assert.equal(await readFile(join(s.projectDir, 'opencode.json'), 'utf8'), '{"model":"a"}\n')
  assert.equal(await readFile(join(s.projectDir, '.opencode', 'command', 'ship.md'), 'utf8'), 'ship v1\n')
  const rows = await list(s.opts)
  assert.deepEqual(rows.map((r) => r.kind), ['manual', 'pre-undo'])
  // Undoing the undo brings the broken state back from the pre-undo backup.
  await undo({ ...s.opts, id: result.backup })
  assert.equal(await readFile(join(s.configDir, 'agent', 'reviewer.md'), 'utf8'), 'BROKEN\n')
})

test('identical state is not snapshotted twice, and undo skips a snapshot equal to disk', async () => {
  const s = await sandbox()
  const a = await snapshot(s.opts)
  await writeFile(join(s.projectDir, 'AGENTS.md'), 'agents v2\n')
  const b = await snapshot(s.opts)
  const again = await snapshot(s.opts)
  assert.equal(again.unchanged, true)
  assert.equal(again.id, b.id)
  // Disk equals b, so plain undo goes back to a.
  const r = await undo(s.opts)
  assert.equal(r.id, a.id)
  assert.equal(await readFile(join(s.projectDir, 'AGENTS.md'), 'utf8'), 'agents v1\n')
})

test('snapshots are per project', async () => {
  const s = await sandbox()
  const t = await sandbox()
  await snapshot(s.opts)
  assert.equal((await list({ ...t.opts, dataDir: s.dataDir })).length, 0)
  await assert.rejects(undo({ ...t.opts, dataDir: s.dataDir }), /No earlier OpenCode snapshot/)
})

test('a wrong passphrase never replaces existing keys', async () => {
  const s = await sandbox()
  await snapshot(s.opts)
  const keys = await readFile(join(s.dataDir, 'keys.json'), 'utf8')
  const parsed = JSON.parse(keys)
  delete parsed.dek
  await writeFile(join(s.dataDir, 'keys.json'), JSON.stringify(parsed))
  await writeFile(join(s.projectDir, 'AGENTS.md'), 'changed\n')
  await assert.rejects(snapshot({ ...s.opts, env: { ...s.env, UNDOHAVEN_PASSPHRASE: 'wrong' } }))
  const after = JSON.parse(await readFile(join(s.dataDir, 'keys.json'), 'utf8'))
  assert.equal(after.wrappedDek, parsed.wrappedDek)
})
