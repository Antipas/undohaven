import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { anonymousMeta, funnelOptedIn, reportAnonymousEvent } from '../src/funnel.js'
import { loadConfig, saveConfig } from '../src/keys.js'

test('anonymous funnel is opt-in and strips paths', async () => {
  assert.equal(funnelOptedIn({}, {}), false)
  assert.equal(funnelOptedIn({ funnelOptIn: true }, {}), true)
  assert.equal(funnelOptedIn({ funnelOptIn: true }, { UNDOHAVEN_FUNNEL: '0' }), false)
  assert.deepEqual(anonymousMeta('limit_hit', { reason: 'device', path: '/tmp/secret' }), { reason: 'device' })
  assert.deepEqual(anonymousMeta('install', { path: '/tmp/secret' }), null)
  const dir = await mkdtemp(join(tmpdir(), 'funnel-'))
  const skipped = await reportAnonymousEvent(dir, 'install', null, {})
  assert.equal(skipped.reason, 'opt-out')
  await saveConfig(dir, { ...(await loadConfig(dir)), funnelOptIn: true, apiBase: 'http://127.0.0.1:1' })
  const offline = await reportAnonymousEvent(dir, 'first_snapshot', null, {})
  assert.equal(offline.sent, false)
  await rm(dir, { recursive: true, force: true })
})
