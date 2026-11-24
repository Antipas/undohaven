import { DEFAULT_RISKY_TOOLS, list, shouldSnapshotBeforeTool, snapshot, undo, withTimeout } from './engine.js'
import { DESCRIPTIONS, formatList, formatSnapshot, formatUndo } from './text.js'

const EMPTY = { type: 'object', properties: {}, additionalProperties: false }
const UNDO_INPUT = {
  type: 'object',
  properties: { id: { type: 'string', description: 'Snapshot id from undohaven_list. Omit for the latest.' } },
  additionalProperties: false,
}

// OpenCode 2.x setup(ctx), as in @opencode/plugin Plugin.define. Tool input uses
// plain JSON Schema, which the 2.x tool schema accepts, so no runtime import is needed.
export async function setup(ctx) {
  const options = ctx.options || {}
  const opts = {
    configDir: options.configDir,
    dataDir: options.dataDir,
    projectDir: options.projectDir || ctx.location?.directory,
    riskyTools: Array.isArray(options.riskyTools) ? options.riskyTools : DEFAULT_RISKY_TOOLS,
  }
  const sessions = new Set()
  const guard = async (kind, tags) => {
    try {
      return await withTimeout(snapshot({ ...opts, kind, tags }))
    } catch {
      return null
    }
  }

  await ctx.tool.transform((tools) => {
    tools.add({
      name: 'undohaven_snapshot',
      description: DESCRIPTIONS.snapshot,
      input: EMPTY,
      execute: async () => ({ content: formatSnapshot(await snapshot({ ...opts, kind: 'manual', tags: ['tool'] })) }),
    })
    tools.add({
      name: 'undohaven_list',
      description: DESCRIPTIONS.list,
      input: EMPTY,
      execute: async () => ({ content: formatList(await list(opts)) }),
    })
    tools.add({
      name: 'undohaven_undo',
      description: DESCRIPTIONS.undo,
      input: UNDO_INPUT,
      execute: async (input) => ({ content: formatUndo(await undo({ ...opts, id: input?.id || undefined })) }),
    })
  })

  if (options.snapshotOnPrompt !== false && ctx.session?.hook) {
    await ctx.session.hook('prompt', async (event) => {
      const key = event?.sessionID || 'session'
      if (sessions.has(key)) return
      sessions.add(key)
      await guard('session', [`session:${key}`])
    })
  }
  if (options.snapshotBeforeTool !== false && ctx.tool?.hook) {
    await ctx.tool.hook('execute.before', async (event) => {
      if (!shouldSnapshotBeforeTool(event?.tool, event?.input, opts)) return
      await guard('before-tool', [`tool:${event.tool}`])
    })
  }
}
