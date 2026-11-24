import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export async function sandbox() {
  const root = await mkdtemp(join(tmpdir(), 'oc-uh-'))
  const configDir = join(root, 'config')
  const projectDir = join(root, 'proj')
  const dataDir = join(root, 'data')
  await mkdir(join(configDir, 'agent'), { recursive: true })
  await mkdir(join(projectDir, '.opencode', 'command'), { recursive: true })
  await writeFile(join(configDir, 'opencode.json'), '{"theme":"system"}\n')
  await writeFile(join(configDir, 'agent', 'reviewer.md'), 'reviewer v1\n')
  await writeFile(join(configDir, 'auth.json'), '{"secret":"never"}\n')
  await writeFile(join(projectDir, '.opencode', 'command', 'ship.md'), 'ship v1\n')
  await writeFile(join(projectDir, 'opencode.json'), '{"model":"a"}\n')
  await writeFile(join(projectDir, 'AGENTS.md'), 'agents v1\n')
  const env = { UNDOHAVEN_CLOUD: '0', UNDOHAVEN_PASSPHRASE: 'test-passphrase-123' }
  return { root, configDir, projectDir, dataDir, env, opts: { configDir, projectDir, dataDir, env } }
}
