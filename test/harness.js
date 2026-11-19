/** Public client test helper. The private Worker / Stripe harness is not in this export. */
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const CLI = join(ROOT, 'packages', 'cli', 'bin', 'undohaven.js')

export function runCli(args, env) {
  const child = spawn(process.execPath, [CLI, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  let err = ''
  child.stdout.on('data', (chunk) => { out += chunk })
  child.stderr.on('data', (chunk) => { err += chunk })
  const exited = new Promise((resolve) => {
    child.on('close', (code) => resolve({ code, out, err }))
  })
  return {
    child,
    exited,
    text() { return out },
  }
}
