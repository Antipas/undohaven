#!/usr/bin/env node
import { diagnosePi, listPi, migratePi, piAgentDir, restorePi, safetySnapshot, snapshotPi, toggleExclude, piDataDir } from '../src/index.js'

function flag(name) {
  const index = process.argv.indexOf(name)
  if (index === -1) return undefined
  return process.argv[index + 1]
}

const [command, ...rest] = process.argv.slice(2).filter((arg) => !arg.startsWith('--'))
const env = process.env
const agentDir = flag('--pi-home') || piAgentDir(env)
const projectDir = flag('--project')
const dataDir = piDataDir(agentDir, env)
const json = process.argv.includes('--json')

function emit(payload) {
  if (json) console.log(JSON.stringify(payload))
  else console.log(payload.text || JSON.stringify(payload, null, 2))
}

try {
  if (!command || command === 'help') {
    console.log(`pi-undohaven snapshot|list|restore|migrate|exclude|doctor|before
Unofficial third-party snapshots for pi. Not affiliated with pi's authors or DeepSeek.
Keys stay on this machine. .env and credential files are never snapshotted.`)
    process.exit(0)
  }
  if (command === 'snapshot') {
    const record = await snapshotPi({ env, agentDir, projectDir, dataDir })
    emit({ text: record.id, ...record })
  } else if (command === 'list') {
    const rows = await listPi({ env, agentDir, dataDir })
    emit({ text: rows.map((row) => `${row.id} ${row.kind} ${row.fileCount}`).join('\n'), rows })
  } else if (command === 'restore' || command === 'migrate') {
    const id = flag('--to') || rest[0]
    const file = flag('--file')
    if (!id) throw new Error('pass --to <snapshot>')
    const fn = command === 'migrate' ? migratePi : restorePi
    const result = await fn({ env, agentDir, projectDir, dataDir, id, paths: file ? [file] : undefined, destAgent: flag('--dest') || agentDir, destProject: projectDir })
    emit({ text: `${result.files.length} files from ${result.id}`, ...result })
  } else if (command === 'exclude') {
    const pattern = rest[0]
    if (!pattern) {
      const { loadExcludes } = await import('../src/scan.js')
      emit({ text: (await loadExcludes(dataDir)).join('\n'), patterns: await loadExcludes(dataDir) })
    } else {
      const result = await toggleExclude(dataDir, pattern)
      emit({ text: result.enabled ? `excluding ${pattern}` : `including ${pattern}`, ...result })
    }
  } else if (command === 'doctor') {
    const report = await diagnosePi({ env, agentDir, projectDir, dataDir })
    emit({ text: `${report.files} files, plan ${report.plan}, secrets skipped ${report.skippedSecrets.length}`, ...report })
  } else if (command === 'before') {
    const result = await safetySnapshot({ env, agentDir, projectDir, dataDir, reason: rest[0] || 'manual' })
    emit({ text: result.reused ? `reused ${result.id}` : result.id, ...result })
  } else {
    throw new Error(`unknown command ${command}`)
  }
} catch (error) {
  console.error(error.message || error)
  process.exit(1)
}
