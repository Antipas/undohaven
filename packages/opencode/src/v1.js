import { tool } from '@opencode-ai/plugin'
import { DEFAULT_RISKY_TOOLS, list, shouldSnapshotBeforeTool, snapshot, undo, withTimeout } from './engine.js'
import { DESCRIPTIONS, formatList, formatSnapshot, formatUndo } from './text.js'

// Outside a git repo OpenCode reports the worktree as "/"; use the directory then.
function projectRoot(input) {
  if (input.worktree && input.worktree !== '/') return input.worktree
  return input.directory || ''
}

// OpenCode 1.x server plugin: (input, options) => hooks.
export async function server(input = {}, options = {}) {
  const opts = {
    configDir: options.configDir,
    dataDir: options.dataDir,
    projectDir: options.projectDir || projectRoot(input),
    riskyTools: Array.isArray(options.riskyTools) ? options.riskyTools : DEFAULT_RISKY_TOOLS,
  }
  const onPrompt = options.snapshotOnPrompt !== false
  const onTool = options.snapshotBeforeTool !== false
  const sessions = new Set()

  const log = (level, message, extra) => {
    try {
      return input.client?.app?.log?.({ body: { service: 'undohaven', level, message, extra } })?.catch?.(() => {})
    } catch {
      return undefined
    }
  }
  const guard = async (kind, tags) => {
    try {
      const snap = await withTimeout(snapshot({ ...opts, kind, tags }))
      log('info', `snapshot ${snap.id}`, { kind, files: snap.files })
      return snap
    } catch (error) {
      // A failed safety snapshot must never block the user's work.
      log('warn', `snapshot failed: ${error?.message || error}`, { kind })
      return null
    }
  }

  return {
    tool: {
      undohaven_snapshot: tool({
        description: DESCRIPTIONS.snapshot,
        args: {},
        async execute() {
          return formatSnapshot(await snapshot({ ...opts, kind: 'manual', tags: ['tool'] }))
        },
      }),
      undohaven_list: tool({
        description: DESCRIPTIONS.list,
        args: {},
        async execute() {
          return formatList(await list(opts))
        },
      }),
      undohaven_undo: tool({
        description: DESCRIPTIONS.undo,
        args: { id: tool.schema.string().optional().describe('Snapshot id from undohaven_list. Omit for the latest.') },
        async execute(args) {
          return formatUndo(await undo({ ...opts, id: args?.id || undefined }))
        },
      }),
    },
    'chat.message': async (event) => {
      if (!onPrompt) return
      const key = event?.sessionID || 'session'
      if (sessions.has(key)) return
      sessions.add(key)
      await guard('session', [`session:${key}`])
    },
    'tool.execute.before': async (event, output) => {
      if (!onTool) return
      if (!shouldSnapshotBeforeTool(event?.tool, output?.args, opts)) return
      await guard('before-tool', [`tool:${event.tool}`])
    },
  }
}
