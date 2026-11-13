#!/usr/bin/env node
import { auditHome, renderReport } from '../src/audit.js'

const args = process.argv.slice(2)
const command = args[0] === 'audit' || !args[0] || args[0] === 'help' ? (args[0] || 'audit') : args[0]
const flags = {}
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i]
  if (arg === '--json') flags.json = true
  else if (arg === '--dsh-home') flags.dshHome = args[++i]
  else if (arg.startsWith('--dsh-home=')) flags.dshHome = arg.slice('--dsh-home='.length)
}

if (command === 'help' || args.includes('--help')) {
  console.log('dsh-log-gate audit [--dsh-home PATH] [--json]\nThird-party local report. Not an official dsh command.')
  process.exit(0)
}

if (command !== 'audit') {
  console.error(`Unknown command ${command}. Try: dsh-log-gate audit`)
  process.exit(1)
}

const report = await auditHome({ dshHome: flags.dshHome })
if (flags.json) console.log(JSON.stringify(report, null, 2))
else console.log(renderReport(report))
