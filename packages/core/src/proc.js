import { spawn } from 'node:child_process'

export function runProcess(command, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: opts.stdio ?? 'inherit',
      shell: false,
    })
    const out = []
    const err = []
    if (opts.stdio === 'pipe') {
      child.stdout.on('data', (chunk) => out.push(chunk))
      child.stderr.on('data', (chunk) => err.push(chunk))
    }
    child.on('error', (error) => {
      reject(Object.assign(error, { command, args }))
    })
    child.on('close', (code) => {
      if (code === 0) {
        resolve({
          stdout: Buffer.concat(out).toString('utf8'),
          stderr: Buffer.concat(err).toString('utf8'),
        })
        return
      }
      const error = new Error(`${command} ${args.join(' ')} exited ${code}`)
      error.code = 'ENOENT' === child.spawnargs ? code : code
      error.exitCode = code
      error.stdout = Buffer.concat(out).toString('utf8')
      error.stderr = Buffer.concat(err).toString('utf8')
      reject(error)
    })
  })
}
