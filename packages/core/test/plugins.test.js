import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { applyDisabledFlags, collectPluginState, diffPluginState, restorePluginState, savePluginState, loadPluginState } from '../src/plugins.js'

test('plugin snapshot keeps package specs and boolean enabled flags', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plugins-'))
  const dsh = join(root, 'dsh')
  const profile = join(dsh, 'profiles', 'desktop')
  await mkdir(profile, { recursive: true })
  await writeFile(join(profile, 'package.json'), JSON.stringify({
    dependencies: { 'dsh-ce': '0.1.1' },
    dsh: { profile: { bundles: ['dsh-ce'] } },
  }))
  await writeFile(join(profile, 'cordis.patch.yml'), '- id: ce\n  name: dsh-ce\n  disabled: false\n')
  const state = await collectPluginState(dsh)
  assert.equal(state.profiles.desktop.dependencies['dsh-ce'], '0.1.1')
  assert.deepEqual(state.profiles.desktop.bundles, ['dsh-ce'])
  assert.equal(state.profiles.desktop.rows[0].disabled, false)
  await savePluginState(root, state)
  await writeFile(join(profile, 'package.json'), JSON.stringify({ dependencies: {} }))
  await writeFile(join(profile, 'cordis.patch.yml'), '- id: ce\n  disabled: true\n')
  const diff = diffPluginState(await loadPluginState(root), await collectPluginState(dsh))
  assert.deepEqual(diff.profiles.desktop.missing, ['dsh-ce'])
  assert.deepEqual(diff.profiles.desktop.disabledChanged, [{ id: 'ce', saved: false, current: true }])
  state.profiles.desktop.dependencies['@deepseek-ai/dsh-tool-working-directory'] = '0.2.2-rc.2'
  state.profiles.desktop.rows.push({ id: 'tool-working-directory', name: '@deepseek-ai/dsh-tool-working-directory', disabled: false })
  await restorePluginState(dsh, state)
  const restored = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'))
  assert.equal(restored.dependencies['dsh-ce'], '0.1.1')
  assert.equal(restored.dependencies['@deepseek-ai/dsh-tool-working-directory'], undefined)
  assert.doesNotMatch(await readFile(join(profile, 'cordis.patch.yml'), 'utf8'), /tool-working-directory/)
  assert.match(await readFile(join(profile, 'cordis.patch.yml'), 'utf8'), /disabled: false/)
  const expression = applyDisabledFlags('- id: keep\n  disabled: !!js "ctx.get(\'x\')"\n', [{ id: 'keep', disabled: false }])
  assert.match(expression, /!!js/)
  await rm(root, { recursive: true, force: true })
})
