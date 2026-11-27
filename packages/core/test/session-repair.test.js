import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { establishKeys } from '../src/keys.js'
import {
  applyConfigRestore,
  captureProfileChanges,
  decodeSession,
  encodeSession,
  inspectWipedProfiles,
  noteSessionFault,
  rememberProfileWipe,
  repairEvents,
  repairSession,
  repeatedFault,
  restoreProfileConfig,
  undoSessionRepair,
} from '../src/index.js'

const PASSPHRASE = 'correct horse battery'
const SURROGATE = '400 INVALID_REQUEST messages[2].content[0].content[0].text: unexpected end of hex escape at line 1 column 120 (request_id: aaa)'
const REASONING = 'HTTP 400 invalid_parameter_error\nThe content field is a required field.'
const IMAGE = 'Image features and image tokens do not match: tokens: 766, features 765   (PI_AI_ERROR)'
const UNKNOWN = '400 provider rejected the body at messages[1] (request_id: zed)'

function user(seq, text) {
  return { type: 'user/message', seq, data: { role: 'user', content: [{ type: 'text', text }] } }
}

function assistant(seq, content, extra = {}) {
  return { type: 'assistant/message', seq, data: { ...extra, message: { role: 'assistant', content } } }
}

async function tree() {
  const root = await mkdtemp(join(tmpdir(), 'hhy-repair-'))
  const dsh = join(root, 'dsh')
  const data = join(root, 'data')
  await mkdir(join(dsh, 'sessions', 'proj', 'sess-repair'), { recursive: true })
  await mkdir(join(dsh, 'profiles', 'desktop'), { recursive: true })
  const keys = await establishKeys(data, PASSPHRASE)
  return { root, dsh, data, dek: keys.dek }
}

async function plaintext(dir) {
  const parts = []
  async function walk(path) {
    let names = []
    try { names = await readdir(path, { withFileTypes: true }) } catch { return }
    for (const name of names) {
      const abs = join(path, name.name)
      if (name.isDirectory()) await walk(abs)
      else parts.push(await readFile(abs))
    }
  }
  await walk(dir)
  return Buffer.concat(parts).toString('utf8')
}

test('the same 400 location twice is a bad message, a different slot is not', () => {
  assert.equal(repeatedFault([SURROGATE]).poisoned, false)
  const again = SURROGATE.replace('request_id: aaa', 'request_id: bbb')
  const same = repeatedFault([SURROGATE, again])
  assert.equal(same.poisoned, true)
  assert.equal(same.place, 'm:2')
  const moved = SURROGATE.replace('messages[2]', 'messages[9]')
  assert.equal(repeatedFault([SURROGATE, moved]).poisoned, false)
  const columnA = '400 unexpected end of hex escape at line 1 column 506363 (request_id: one)'
  const columnB = '400 unexpected end of hex escape at line 1 column 506363 (request_id: two)'
  assert.equal(repeatedFault([columnA, columnB]).poisoned, true)
  assert.equal(repeatedFault([columnA, columnB.replace('506363', '10')]).poisoned, false)
})

test('a lone surrogate in a tool result is replaced and the rest of the log stays', () => {
  const events = [
    user(1, 'hello'),
    assistant(2, [{ type: 'text', text: 'ok' }]),
    {
      type: 'tool/result',
      seq: 3,
      data: { message: { role: 'tool', content: [{ type: 'text', text: `${'x'.repeat(10)}\uD83D` }] } },
    },
    user(4, 'next'),
  ]
  const plan = repairEvents(events, SURROGATE)
  assert.equal(plan.action, 'lone-surrogate')
  assert.deepEqual(plan.seqs, [3])
  const tool = plan.events.find((event) => event.seq === 3)
  assert.equal(tool.data.message.content[0].text, `${'x'.repeat(10)}\uFFFD`)
  assert.equal(tool.data.message.content[0].text.isWellFormed(), true)
  assert.equal(plan.events.find((event) => event.seq === 4).data.content[0].text, 'next')
  assert.equal(plan.events.length, 4)
})

test('an interrupted reasoning-only message is removed and a real answer stays', () => {
  const events = [
    user(1, 'think hard'),
    assistant(2, [{ type: 'reasoning', text: 'still thinking' }], { interrupted: true }),
    user(3, 'go on'),
    assistant(4, [{ type: 'reasoning', text: 'done' }, { type: 'text', text: 'answer' }]),
  ]
  const plan = repairEvents(events, REASONING)
  assert.equal(plan.action, 'reasoning-only')
  assert.deepEqual(plan.seqs, [2])
  assert.deepEqual(plan.events.map((event) => event.seq), [1, 3, 4])
  assert.equal(plan.events.find((event) => event.seq === 4).data.message.content[1].text, 'answer')
})

test('a literal image token is escaped and the image attachment stays', () => {
  const events = [
    {
      type: 'tool/result',
      seq: 809,
      data: {
        message: {
          role: 'tool',
          toolCallId: 'call_bbe02cbd',
          content: [{ type: 'text', text: '68:   "<|image_pad|>", 151655,\n74:   "<|video_pad|>", 151656,\n' }],
        },
      },
    },
    {
      type: 'user/message',
      seq: 1003,
      data: {
        role: 'user',
        content: [
          { type: 'image', attachment: { attachmentId: 'sha256:abc', mediaType: 'image/png' } },
          { type: 'text', text: 'see <|vision_start|>' },
        ],
      },
    },
  ]
  const plan = repairEvents(events, IMAGE)
  assert.equal(plan.action, 'image-pad')
  const dumped = JSON.stringify(plan.events)
  assert.equal(dumped.includes('<|image_pad|>'), false)
  assert.equal(dumped.includes('<|video_pad|>'), false)
  assert.equal(dumped.includes('<|vision_start|>'), false)
  assert.match(dumped, /<\uFF5Cimage_pad\uFF5C>/)
  const image = plan.events.find((event) => event.seq === 1003)
  assert.equal(image.data.content[0].type, 'image')
  assert.equal(image.data.content[0].attachment.mediaType, 'image/png')
})

test('an unrecognized 400 rolls the log back to before that message', () => {
  const events = [
    { type: 'session/start', seq: 0, data: { cwd: '/tmp' } },
    user(1, 'one'),
    assistant(2, [{ type: 'text', text: 'two' }]),
    { type: 'assistant/attempt', seq: 3, data: { turn: 1 } },
    user(4, 'three'),
  ]
  const plan = repairEvents(events, UNKNOWN)
  assert.equal(plan.action, 'rollback')
  assert.equal(plan.kind, 'unknown')
  assert.deepEqual(plan.events.map((event) => event.seq), [0, 1])
  assert.throws(() => repairEvents(events, '400 something went wrong'), /cannot_locate|没法把这次/)
})

test('repair snapshots the session before rewriting it, and undo puts the bytes back', async () => {
  const { root, dsh, data, dek } = await tree()
  const events = [
    user(1, 'hello'),
    assistant(2, [{ type: 'text', text: 'ok' }]),
    {
      type: 'tool/result',
      seq: 3,
      data: { message: { role: 'tool', content: [{ type: 'text', text: `POISON_TOOL_OUTPUT${'\uD83D'}` }] } },
    },
    user(4, 'next'),
  ]
  const original = encodeSession(events, { zstd: true })
  const file = join(dsh, 'sessions', 'proj', 'sess-repair', 'session.v4.jsonl.zstd')
  await writeFile(file, original)
  await assert.rejects(
    () => repairSession({
      tier: 'pro',
      dataDir: data,
      dshHome: dsh,
      dek,
      sessionId: 'sess-repair',
      errors: [SURROGATE],
      skipLockCheck: true,
    }),
    /not_repeated|还没看到/,
  )
  assert.deepEqual(await readFile(file), original)
  const repaired = await repairSession({
    tier: 'pro',
    dataDir: data,
    dshHome: dsh,
    dek,
    sessionId: 'sess-repair',
    errors: [SURROGATE, SURROGATE.replace('aaa', 'bbb')],
    skipLockCheck: true,
  })
  assert.equal(repaired.action, 'lone-surrogate')
  assert.equal(repaired.kind, 'lone-surrogate')
  assert.match(repaired.undoCommand, /guard undo/)
  const cleaned = decodeSession(await readFile(file))
  assert.equal(cleaned.zstd, true)
  assert.equal(cleaned.events.find((event) => event.seq === 3).data.message.content[0].text, 'POISON_TOOL_OUTPUT\uFFFD')
  const stored = await plaintext(data)
  assert.equal(stored.includes('POISON_TOOL_OUTPUT'), false)
  const undone = await undoSessionRepair({
    dataDir: data,
    dshHome: dsh,
    dek,
    skipLockCheck: true,
    skipSafety: true,
  })
  assert.equal(undone.snapshotId, repaired.snapshotId)
  assert.equal(undone.sessionId, 'sess-repair')
  assert.deepEqual(await readFile(file), original)
  await assert.rejects(
    () => repairSession({
      tier: 'free',
      dataDir: data,
      dshHome: dsh,
      dek,
      sessionId: 'sess-repair',
      errors: [SURROGATE, SURROGATE],
      skipLockCheck: true,
    }),
    /pro_required|专业版/,
  )
  await rm(root, { recursive: true, force: true })
})

test('a wiped profile prompts, restores host rows, and leaves third-party plugins disabled', async () => {
  const { root, dsh, data, dek } = await tree()
  const backup = `# kept note
- id: locale
  config:
    preference: zh-CN

- id: ui-theme
  name: '@deepseek-ai/dsh-host-theme'
  config:
    preference: dark

- id: demo
  name: dsh-demo
  disabled: false
  config:
    token: keep-me
`
  const profile = join(dsh, 'profiles', 'desktop')
  await writeFile(join(profile, 'cordis.patch.yml.bak-1730000000000'), backup)
  await writeFile(join(profile, 'cordis.patch.yml'), '[]\n')
  const found = await inspectWipedProfiles(dsh)
  assert.equal(found.profiles.length, 1)
  assert.match(found.prompt.zh, /你的设置被官方救援移走了/)
  assert.match(found.prompt.zh, /空模板/)
  assert.match(found.prompt.zh, /cordis\.patch\.yml\.bak-1730000000000/)
  assert.match(found.prompt.en, /unofficial third-party/i)
  assert.match(found.prompt.command, /guard config-restore --profile desktop/)
  const noted = await rememberProfileWipe({ dataDir: data, dshHome: dsh })
  assert.equal(noted.profiles[0].profile, 'desktop')
  const prompts = JSON.parse(await readFile(join(data, 'prompts.json'), 'utf8'))
  assert.match(prompts.profileWipe.zh, /你的设置被官方救援移走了/)
  const merged = applyConfigRestore('[]\n', backup, { disableThirdParty: true })
  assert.match(merged.text, /preference: zh-CN/)
  assert.match(merged.text, /@deepseek-ai\/dsh-host-theme/)
  assert.match(merged.text, /# kept note/)
  assert.match(merged.text, /id: demo[\s\S]*disabled: true/)
  assert.equal((merged.text.match(/disabled:/g) || []).length, 1)
  const restored = await restoreProfileConfig({
    tier: 'pro',
    dataDir: data,
    dshHome: dsh,
    dek,
    profile: 'desktop',
  })
  assert.equal(restored.from, 'bak')
  assert.deepEqual(restored.restored.sort(), ['demo', 'locale', 'ui-theme'])
  const live = await readFile(join(profile, 'cordis.patch.yml'), 'utf8')
  assert.match(live, /preference: zh-CN/)
  assert.match(live, /disabled: true/)
  assert.match(live, /token: keep-me/)
  const cleared = JSON.parse(await readFile(join(data, 'prompts.json'), 'utf8'))
  assert.equal(cleared.profileWipe, undefined)
  await rm(root, { recursive: true, force: true })
})

test('each config change keeps an encrypted version and one entry can be restored', async () => {
  const { root, dsh, data, dek } = await tree()
  const file = join(dsh, 'profiles', 'desktop', 'cordis.patch.yml')
  const v1 = `- id: locale
  config:
    preference: aurora-zh

- id: ui-theme
  config:
    preference: dark
`
  const v2 = `- id: locale
  config:
    preference: en

- id: ui-theme
  config:
    preference: light
`
  await writeFile(file, v1)
  const seeded = await captureProfileChanges({ dataDir: data, dshHome: dsh, dek })
  assert.equal(seeded.snapshot, null)
  assert.equal(seeded.seeded, true)
  await writeFile(file, v2)
  const changed = await captureProfileChanges({ dataDir: data, dshHome: dsh, dek })
  assert.ok(changed.snapshot)
  assert.ok(changed.snapshot.tags.includes('config-version'))
  const stored = await plaintext(data)
  assert.equal(stored.includes('aurora-zh'), false)
  const one = await restoreProfileConfig({
    tier: 'pro',
    dataDir: data,
    dshHome: dsh,
    dek,
    profile: 'desktop',
    from: changed.snapshot.id,
    items: ['locale'],
  })
  assert.deepEqual(one.restored, ['locale'])
  const live = await readFile(file, 'utf8')
  assert.match(live, /preference: aurora-zh/)
  assert.match(live, /preference: light/)
  assert.equal(live.includes('preference: dark'), false)
  const round = decodeSession(encodeSession([user(1, 'plain')], { zstd: true }))
  assert.equal(round.events[0].data.content[0].text, 'plain')
  await noteSessionFault(data, { sessionId: 'sess-repair', error: IMAGE })
  const second = await noteSessionFault(data, { sessionId: 'sess-repair', error: IMAGE.replace('766', '766') })
  assert.equal(second.poisoned, true)
  await rm(root, { recursive: true, force: true })
})

test('the site copy quotes the four reports and does not promise a full repair', async () => {
  const doc = await readFile(new URL('../../../docs/session-repair.md', import.meta.url), 'utf8')
  assert.match(doc, /later site deploy|not deployed/i)
  assert.match(doc, /unexpected end of hex escape/)
  assert.match(doc, /The content field is a required field/)
  assert.match(doc, /Image features and image tokens do not match: tokens: 766, features 765/)
  assert.match(doc, /Disable third-party plugins, back up profile patch, and restart/)
  assert.match(doc, /discussions\/14391/)
  assert.match(doc, /discussions\/14340/)
  assert.match(doc, /discussions\/14369/)
  assert.match(doc, /discussions\/14400/)
  assert.match(doc, /unofficial third-party/i)
  assert.doesNotMatch(doc, /100%/)
  assert.doesNotMatch(doc, /支付宝|微信支付|Alipay|WeChat Pay/)
})
