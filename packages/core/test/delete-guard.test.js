import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  DELETE_LAYER_COPY,
  confirmDelete,
  evaluateDeleteCommand,
  guardDeleteCommand,
  listDeleted,
  onPreExecute,
  prepareRecursiveDelete,
  restoreDeleted,
  setDeleteRetention,
  establishKeys,
  loadDek,
  readFileManifest,
} from '../src/index.js'

const PASSPHRASE = 'correct horse battery'
const WIN = {
  platform: 'win32',
  home: 'C:\\Users\\me',
  userProfile: 'C:\\Users\\me',
  dshHome: 'C:\\Users\\me\\.dsh',
  cwd: 'C:\\Users\\me',
}

function forbid(text) {
  assert.doesNotMatch(text, /支付宝|微信支付|Alipay|WeChat Pay/)
  assert.doesNotMatch(text, /100%|百分百|完全防止/)
  assert.match(text, /多一层留底/)
}

test('recursive deletes of a drive root, home, and .dsh are refused', () => {
  const drive = evaluateDeleteCommand({ command: 'cmd /c "rd /s /q E:\\"' }, WIN)
  assert.equal(drive.action, 'deny')
  assert.equal(drive.code, 'protected')
  assert.deepEqual(drive.protected, ['drive-root'])
  forbid(drive.reason)
  assert.match(drive.reason, /E:\\/)

  const home = evaluateDeleteCommand({ command: 'Remove-Item -LiteralPath $HOME -Recurse -Force' }, WIN)
  assert.equal(home.action, 'deny')
  assert.ok(home.protected.includes('home'))

  const dsh = evaluateDeleteCommand({ command: 'rd /s /q %USERPROFILE%\\.dsh' }, WIN)
  assert.equal(dsh.action, 'deny')
  assert.ok(dsh.protected.includes('dsh'))

  const tilde = evaluateDeleteCommand({ command: 'rm -rf ~/.dsh' }, {
    platform: 'linux',
    home: '/home/me',
    dshHome: '/home/me/.dsh',
    cwd: '/home/me',
  })
  assert.equal(tilde.action, 'deny')
  assert.ok(tilde.protected.includes('dsh'))

  const root = evaluateDeleteCommand({ command: 'rm -rf /' }, {
    platform: 'linux',
    home: '/home/me',
    dshHome: '/home/me/.dsh',
    cwd: '/home/me',
  })
  assert.equal(root.code, 'protected')
  assert.ok(root.protected.includes('drive-root'))

  assert.equal(evaluateDeleteCommand({ command: 'rm /tmp/one-file' }, {
    platform: 'linux',
    home: '/home/me',
    dshHome: '/home/me/.dsh',
    cwd: '/tmp',
  }).action, 'ignore')
  assert.equal(guardDeleteCommand({ arguments: { command: 'ls' } }, WIN), undefined)
  assert.match(guardDeleteCommand({ arguments: { command: 'rd /s /q C:\\' } }, WIN), /盘符|drive root/)
})

test('assembled paths that no longer match the intended target are refused', () => {
  const truncated = evaluateDeleteCommand({
    command: 'cmd /c "rd /s /q E:\\"',
    intended: ['E:\\项目\\临时克隆'],
  }, WIN)
  assert.equal(truncated.action, 'deny')
  assert.equal(truncated.code, 'path_mismatch')
  assert.ok(truncated.protected.includes('drive-root'))
  forbid(truncated.reason)

  const openQuote = evaluateDeleteCommand({ command: 'rd /s /q "E:\\中文' }, WIN)
  assert.equal(openQuote.action, 'deny')
  assert.equal(openQuote.code, 'path_mismatch')

  const same = evaluateDeleteCommand({
    command: 'cmd /c "rd /s /q E:\\项目\\临时"',
    intended: ['E:/项目/临时'],
  }, WIN)
  assert.equal(same.action, 'backup')
  assert.equal(same.targets[0].abs, 'E:\\项目\\临时')
})

test('a symlink whose real path differs from the command path is refused', async () => {
  const root = await mkdtemp(join(tmpdir(), 'uh-link-'))
  const real = join(root, 'real')
  const link = join(root, 'link')
  await mkdir(real)
  await writeFile(join(real, 'a.txt'), 'a')
  await symlink(real, link)
  const decision = evaluateDeleteCommand({ command: `rm -rf ${link}` }, {
    platform: 'linux',
    home: join(root, 'home'),
    dshHome: join(root, 'home', '.dsh'),
    cwd: root,
  })
  assert.equal(decision.action, 'deny')
  assert.equal(decision.code, 'path_mismatch')
  const next = []
  const result = await onPreExecute(
    { arguments: { command: `rm -rf ${link}` } },
    async () => { next.push('next') },
    { platform: 'linux', home: join(root, 'home'), dshHome: join(root, 'home', '.dsh'), cwd: root },
  )
  assert.equal(result.kind, 'deny')
  assert.equal(next.length, 0)
  assert.equal(await readFile(join(real, 'a.txt'), 'utf8'), 'a')
  await rm(root, { recursive: true, force: true })
})

test('a small recursive delete is encrypted before other listeners run, and restores on another path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'uh-del-'))
  const target = join(root, 'proj')
  const home = join(root, 'home')
  const dsh = join(home, '.dsh')
  const data = join(root, 'data')
  await mkdir(target, { recursive: true })
  await mkdir(dsh, { recursive: true })
  await writeFile(join(target, 'note.txt'), 'keep-me')
  await writeFile(join(target, 'auth.json'), 'secret')
  await establishKeys(data, PASSPHRASE)
  const { dek } = await loadDek(data)
  const uploaded = []
  const cloud = {
    async missing(ids) { return ids },
    async uploadChunk(id) { uploaded.push(id) },
    async createSnapshot() { return { plan: 'pro', pruned: 0 } },
  }
  const order = []
  const command = `rm -rf ${target}`
  const opts = {
    dataDir: data,
    dek,
    cloud,
    platform: 'linux',
    home,
    dshHome: dsh,
    cwd: root,
    createFileSnapshot: async (snap) => {
      order.push('backup')
      const { createFileSnapshot } = await import('../src/filesnap.js')
      return createFileSnapshot(snap)
    },
  }
  const result = await onPreExecute(
    { arguments: { command } },
    async () => {
      order.push('next')
      return { kind: 'deny', reason: 'other-check' }
    },
    opts,
  )
  assert.deepEqual(order, ['backup', 'next'])
  assert.equal(result.kind, 'deny')
  assert.equal(result.reason, 'other-check')
  assert.equal(await readFile(join(target, 'note.txt'), 'utf8'), 'keep-me')
  assert.ok(uploaded.length > 0)
  const listed = await listDeleted({ dataDir: data })
  assert.equal(listed.entries.length, 1)
  assert.equal(listed.entries[0].mode, 'backup')
  assert.equal(listed.entries[0].skippedSecrets, 1)
  const manifest = await readFileManifest(data, dek, listed.entries[0].snapshotId)
  assert.ok(manifest.manifest.entries.some((entry) => entry.rel === 'note.txt'))
  assert.equal(manifest.manifest.entries.some((entry) => entry.rel === 'auth.json'), false)
  await rm(target, { recursive: true, force: true })
  const restored = await restoreDeleted({ dataDir: data, dek, id: listed.entries[0].id, dshHome: dsh })
  assert.equal(await readFile(join(target, 'note.txt'), 'utf8'), 'keep-me')
  assert.ok(restored.files.length >= 1)
  await setDeleteRetention(data, 1)
  const hidden = await listDeleted({ dataDir: data, now: Date.now() + 3 * 24 * 60 * 60 * 1000 })
  assert.equal(hidden.entries.length, 0)
  forbid(DELETE_LAYER_COPY.zh + DELETE_LAYER_COPY.en)
  await rm(root, { recursive: true, force: true })
})

test('a large directory records an inventory and waits for an explicit confirmation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'uh-big-'))
  const target = join(root, 'big')
  const data = join(root, 'data')
  await mkdir(target, { recursive: true })
  await mkdir(data, { recursive: true })
  await writeFile(join(target, 'blob.txt'), 'x'.repeat(40))
  const opts = {
    dataDir: data,
    platform: 'linux',
    home: join(root, 'home'),
    dshHome: join(root, 'home', '.dsh'),
    cwd: root,
    maxBytes: 10,
    createFileSnapshot: async () => { throw new Error('should not copy a large directory') },
  }
  const command = `rm -rf ${target}`
  const asked = await prepareRecursiveDelete({ command }, opts)
  assert.equal(asked.action, 'ask')
  assert.equal(asked.code, 'large')
  forbid(asked.reason)
  const listed = await listDeleted({ dataDir: data })
  assert.equal(listed.entries[0].mode, 'inventory')
  await assert.rejects(() => restoreDeleted({ dataDir: data, dek: Buffer.alloc(32), id: listed.entries[0].id }), /清单|inventory/)
  const next = []
  const blocked = await onPreExecute({ arguments: { command } }, async () => { next.push('next') }, opts)
  assert.equal(blocked.kind, 'ask')
  assert.equal(next.length, 0)
  await confirmDelete(data, asked.token)
  const allowed = await onPreExecute({ arguments: { command } }, async () => { next.push('next'); return { kind: 'allow' } }, opts)
  assert.equal(allowed.kind, 'allow')
  assert.equal(allowed.decision.mode, 'confirmed')
  assert.equal(allowed.decision.backedUp, false)
  assert.equal(await readFile(join(target, 'blob.txt'), 'utf8'), 'x'.repeat(40))
  await rm(root, { recursive: true, force: true })
})

test('a confirmation token cannot authorize a drive-root delete', async () => {
  const root = await mkdtemp(join(tmpdir(), 'uh-tok-'))
  const data = join(root, 'data')
  await confirmDelete(data, 'deadbeefcafe')
  const next = []
  const result = await onPreExecute(
    { arguments: { command: 'rd /s /q E:\\', undohavenConfirm: 'deadbeefcafe' } },
    async () => { next.push('next') },
    { ...WIN, dataDir: data },
  )
  assert.equal(result.kind, 'deny')
  assert.equal(next.length, 0)
  await rm(root, { recursive: true, force: true })
})
