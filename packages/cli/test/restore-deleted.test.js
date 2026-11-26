import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { main } from '../src/main.js'

test('restore-deleted and guard align are listed and the empty list stays an extra copy', async () => {
  const logs = []
  const orig = console.log
  console.log = (line) => { logs.push(String(line)) }
  try {
    assert.equal(await main(['node', 'undohaven', 'help']), 0)
  } finally {
    console.log = orig
  }
  const help = logs.join('\n')
  assert.match(help, /undohaven restore-deleted/)
  assert.match(help, /align \[--apply\]/)
  assert.match(help, /Unofficial third-party/)
  assert.doesNotMatch(help, /支付宝|微信支付|Alipay|WeChat Pay/)

  const root = await mkdtemp(join(tmpdir(), 'uh-cli-'))
  const data = join(root, 'data')
  const dsh = join(root, 'dsh')
  await mkdir(dsh, { recursive: true })
  const out = []
  console.log = (line) => { out.push(String(line)) }
  try {
    const code = await main(['node', 'undohaven', 'restore-deleted', '--data-dir', data, '--dsh-home', dsh, '--json'])
    assert.equal(code, 0)
  } finally {
    console.log = orig
  }
  const body = JSON.parse(out.at(-1))
  assert.deepEqual(body.entries, [])
  assert.match(body.layer.zh, /多一层留底/)
  assert.doesNotMatch(JSON.stringify(body), /100%|百分百|完全防止|支付宝|微信支付|Alipay|WeChat Pay/)
  await rm(root, { recursive: true, force: true })
})
