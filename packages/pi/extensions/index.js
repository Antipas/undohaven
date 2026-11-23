import { diagnosePi, piAgentDir, piDataDir, restorePi, safetySnapshot, snapshotPi, toggleExclude } from '../src/index.js'

const RISKS = ['session_before_compact', 'session_before_tree', 'session_before_switch', 'session_before_fork']

export default function undohaven(pi) {
  for (const event of RISKS) {
    pi.on(event, async (_payload, ctx) => {
      const projectDir = ctx.isProjectTrusted?.() ? `${ctx.cwd}/.pi` : undefined
      await safetySnapshot({
        agentDir: ctx.sessionManager?.getSessionDir?.() ? undefined : undefined,
        projectDir,
        reason: event,
        env: process.env,
      }).catch(() => {})
    })
  }
  pi.registerCommand('undohaven', {
    description: 'Snapshot, list, or restore pi state. Unofficial third-party; not affiliated with pi or DeepSeek.',
    handler: async (args, ctx) => {
      const [action, extra] = String(args || '').trim().split(/\s+/)
      const projectDir = ctx.isProjectTrusted?.() ? `${ctx.cwd}/.pi` : undefined
      if (action === 'list') {
        const { listPi } = await import('../src/index.js')
        const rows = await listPi({ projectDir, env: process.env })
        ctx.ui.notify(rows.map((row) => row.id).join('\n') || 'no snapshots', 'info')
        return
      }
      if (action === 'restore') {
        const result = await restorePi({ id: extra, projectDir, env: process.env })
        ctx.ui.notify(`restored ${result.files.length}`, 'info')
        return
      }
      if (action === 'exclude' && extra) {
        const result = await toggleExclude(piDataDir(piAgentDir()), extra)
        ctx.ui.notify(result.enabled ? `excluding ${extra}` : `including ${extra}`, 'info')
        return
      }
      if (action === 'doctor') {
        const report = await diagnosePi({ projectDir, env: process.env })
        ctx.ui.notify(`${report.files} files, plan ${report.plan}`, 'info')
        return
      }
      const record = await snapshotPi({ projectDir, env: process.env })
      ctx.ui.notify(record.id, 'info')
    },
  })
}
