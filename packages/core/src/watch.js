import { watch } from 'node:fs'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { b64, chunkEncKey, fromB64, open, seal, sha256 } from './crypto.js'
import { createSnapshot } from './engine.js'
import { isWatchedStorage } from './items.js'
import { loadDek } from './keys.js'

const tails = new Map()

export function captureStorageChanges(opts) {
  const key = opts.dataDir
  const prev = tails.get(key) || Promise.resolve()
  const job = prev.then(() => captureOnce(opts))
  tails.set(key, job.catch(() => {}))
  return job
}

async function readLive(dshHome) {
  const dir = join(dshHome, 'storages')
  const out = new Map()
  let names = []
  try {
    names = await readdir(dir)
  } catch {
    return { files: out, unstable: false }
  }
  let unstable = false
  for (const name of names) {
    const rel = `storages/${name}`
    if (!isWatchedStorage(rel)) continue
    const abs = join(dir, name)
    let info
    try {
      info = await stat(abs)
    } catch {
      continue
    }
    if (!info.isFile()) continue
    let bytes
    try {
      bytes = await readFile(abs)
    } catch {
      continue
    }
    try {
      JSON.parse(bytes.toString('utf8'))
    } catch {
      unstable = true
      continue
    }
    out.set(rel, bytes)
  }
  return { files: out, unstable }
}

async function loadMirror(dataDir, dek) {
  try {
    const raw = JSON.parse(await readFile(join(dataDir, 'storage-mirror.json'), 'utf8'))
    const key = chunkEncKey(dek)
    const out = new Map()
    for (const [rel, sealed] of Object.entries(raw.files || {})) {
      if (!isWatchedStorage(rel)) continue
      out.set(rel, Buffer.from(open(key, fromB64(sealed))))
    }
    return out
  } catch {
    return new Map()
  }
}

async function saveMirror(dataDir, dek, files) {
  const key = chunkEncKey(dek)
  const body = { files: {} }
  for (const [rel, bytes] of files) {
    if (!isWatchedStorage(rel)) continue
    body.files[rel] = b64(seal(key, bytes))
  }
  await mkdir(dataDir, { recursive: true, mode: 0o700 })
  await writeFile(join(dataDir, 'storage-mirror.json'), JSON.stringify(body), { mode: 0o600 })
}

async function captureOnce(opts) {
  const dek = opts.dek || (await loadDek(opts.dataDir)).dek
  const { files: live, unstable } = await readLive(opts.dshHome)
  if (unstable) return { snapshot: null, changed: [], seeded: false, unstable: true }
  const mirror = await loadMirror(opts.dataDir, dek)
  const previous = []
  if (mirror.size > 0) {
    for (const [rel, before] of mirror) {
      const after = live.get(rel)
      if (after && sha256(after) === sha256(before)) continue
      previous.push({ rel, bytes: before, root: 'dsh' })
    }
  }
  let snapshot = null
  if (previous.length) {
    snapshot = await createSnapshot({
      dataDir: opts.dataDir,
      dshHome: opts.dshHome,
      agentsHome: opts.agentsHome,
      dek,
      env: opts.env,
      cloud: null,
      kind: 'safety',
      tags: ['pre-change', 'storages'],
      includeCredentials: false,
      select: () => false,
      extraFiles: previous,
    })
  }
  await saveMirror(opts.dataDir, dek, live)
  return { snapshot, changed: previous.map((file) => file.rel), seeded: mirror.size === 0 }
}

export function watchStorages(opts) {
  let closed = false
  let timer = null
  let watcher = null
  const tick = () => captureStorageChanges(opts).catch(() => {})
  const loop = () => {
    if (closed) return
    tick()
    timer = setTimeout(loop, opts.pollMs ?? 2000)
    timer.unref?.()
  }
  loop()
  try {
    watcher = watch(join(opts.dshHome, 'storages'), { persistent: false }, () => tick())
  } catch {
    watcher = null
  }
  return {
    stop() {
      closed = true
      if (timer) clearTimeout(timer)
      watcher?.close()
    },
  }
}
