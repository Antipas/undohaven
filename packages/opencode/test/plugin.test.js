import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import plugin from '../src/index.js'
import { list } from '../src/engine.js'
import { sandbox } from './helpers.js'

function withEnv(env, fn) {
  const saved = { ...process.env }
  Object.assign(process.env, env)
  return fn().finally(() => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
    Object.assign(process.env, saved)
  })
}

test('default export has the shape both OpenCode generations load', () => {
  assert.equal(plugin.id, 'undohaven')
  assert.equal(typeof plugin.server, 'function') // OpenCode 1.x: { id, server }
  assert.equal(typeof plugin.setup, 'function') // OpenCode 2.x: { id, setup }
  assert.equal('tui' in plugin, false) // 1.x rejects server and tui together
})

test('OpenCode 1.x hooks: tools, session snapshot, before-tool snapshot, undo', async () => {
  const s = await sandbox()
  await withEnv(s.env, async () => {
    const options = { configDir: s.configDir, dataDir: s.dataDir }
    const hooks = await plugin.server({ directory: s.projectDir, worktree: s.projectDir }, options)
    assert.deepEqual(Object.keys(hooks.tool).sort(), ['undohaven_list', 'undohaven_snapshot', 'undohaven_undo'])
    // Zod shape from @opencode-ai/plugin's tool.schema
    assert.equal(hooks.tool.undohaven_undo.args.id.safeParse(undefined).success, true)
    assert.equal(hooks.tool.undohaven_undo.args.id.safeParse(3).success, false)

    await hooks['chat.message']({ sessionID: 'ses_1' }, {})
    await hooks['chat.message']({ sessionID: 'ses_1' }, {}) // once per session
    const o = { configDir: s.configDir, projectDir: s.projectDir, dataDir: s.dataDir, env: s.env }
    assert.deepEqual((await list(o)).map((r) => r.kind), ['session'])

    await hooks['tool.execute.before']({ tool: 'edit', sessionID: 'ses_1', callID: 'c1' }, { args: { filePath: join(s.projectDir, 'src', 'a.ts') } })
    assert.equal((await list(o)).length, 1)

    await writeFile(join(s.projectDir, '.opencode', 'command', 'ship.md'), 'ship v2\n')
    await hooks['tool.execute.before']({ tool: 'edit', sessionID: 'ses_1', callID: 'c2' }, { args: { filePath: join(s.projectDir, '.opencode', 'command', 'ship.md') } })
    assert.deepEqual((await list(o)).map((r) => r.kind), ['session', 'before-tool'])

    await writeFile(join(s.projectDir, '.opencode', 'command', 'ship.md'), 'BROKEN\n')
    const out = await hooks.tool.undohaven_undo.execute({}, {})
    assert.match(out, /^Restored snap_/)
    assert.equal(await readFile(join(s.projectDir, '.opencode', 'command', 'ship.md'), 'utf8'), 'ship v2\n')
    assert.match(await hooks.tool.undohaven_list.execute({}, {}), /pre-undo/)
    assert.match(await hooks.tool.undohaven_snapshot.execute({}, {}), /snapshot snap_/)
  })
})

test('OpenCode 1.x: a failing safety snapshot never blocks the tool call', async () => {
  const s = await sandbox()
  // A data directory under a regular file cannot be created (ENOTDIR).
  const hooks = await plugin.server({ directory: s.projectDir }, { configDir: s.configDir, dataDir: join(s.projectDir, 'AGENTS.md', 'store') })
  await hooks['tool.execute.before']({ tool: 'write' }, { args: { filePath: join(s.projectDir, 'opencode.json') } })
})

test('OpenCode 2.x setup registers the tools and hooks through ctx', async () => {
  const s = await sandbox()
  const tools = []
  const hooks = {}
  const ctx = {
    options: { configDir: s.configDir, dataDir: s.dataDir },
    location: { directory: s.projectDir },
    tool: {
      transform: async (fn) => { fn({ add: (t) => tools.push(t) }); return { dispose: async () => {} } },
      hook: async (name, cb) => { hooks[`tool.${name}`] = cb; return { dispose: async () => {} } },
    },
    session: {
      hook: async (name, cb) => { hooks[`session.${name}`] = cb; return { dispose: async () => {} } },
    },
  }
  await withEnv(s.env, async () => {
    await plugin.setup(ctx)
    assert.deepEqual(tools.map((t) => t.name).sort(), ['undohaven_list', 'undohaven_snapshot', 'undohaven_undo'])
    for (const t of tools) assert.equal(t.input.type, 'object')
    assert.deepEqual(Object.keys(hooks).sort(), ['session.prompt', 'tool.execute.before'])
    await hooks['session.prompt']({ sessionID: 'ses_a' })
    await writeFile(join(s.configDir, 'opencode.json'), '{"theme":"x"}\n')
    await hooks['tool.execute.before']({ tool: 'write', input: { filePath: join(s.configDir, 'opencode.json') } })
    await writeFile(join(s.configDir, 'opencode.json'), 'BROKEN')
    const undo = tools.find((t) => t.name === 'undohaven_undo')
    const result = await undo.execute({}, {})
    assert.match(result.content, /^Restored snap_/)
    assert.equal(await readFile(join(s.configDir, 'opencode.json'), 'utf8'), '{"theme":"x"}\n')
  })
})
