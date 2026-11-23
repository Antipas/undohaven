import { createHash, createHmac, randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { rename } from 'node:fs/promises'
import { HouhuiError } from './errors.js'

const PAD = 64 * 1024
const MAGIC = Buffer.from('UHVP')

export function padBlob(bytes) {
  const body = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  const header = Buffer.alloc(8)
  MAGIC.copy(header, 0)
  header.writeUInt32BE(body.length, 4)
  const raw = Buffer.concat([header, body])
  const extra = (PAD - (raw.length % PAD)) % PAD
  return extra === 0 ? raw : Buffer.concat([raw, Buffer.alloc(extra)])
}

export function unpadBlob(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  if (buf.length < 8 || !buf.subarray(0, 4).equals(MAGIC)) return buf
  const len = buf.readUInt32BE(4)
  if (len < 0 || 8 + len > buf.length) {
    throw new HouhuiError('bad_pad', '分块填充损坏', 'Chunk padding is corrupt')
  }
  return buf.subarray(8, 8 + len)
}

export function isPadded(bytes) {
  return Buffer.isBuffer(bytes) && bytes.length >= 8 && bytes.subarray(0, 4).equals(MAGIC)
}

function storageFile(dataDir) {
  return join(dataDir, 'storage.json')
}

export async function loadStorageConfig(dataDir) {
  try {
    return JSON.parse(await readFile(storageFile(dataDir), 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return { mode: 'local' }
    throw error
  }
}

export async function saveStorageConfig(dataDir, config) {
  await mkdir(dataDir, { recursive: true, mode: 0o700 })
  const file = storageFile(dataDir)
  const tmp = `${file}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(config, null, 2), { mode: 0o600 })
  await rename(tmp, file)
  try {
    await chmod(file, 0o600)
  } catch {
    /* windows */
  }
}

export function redactStorage(config) {
  if (!config || config.mode === 'local') return { mode: 'local' }
  if (config.mode === 'dir') return { mode: 'dir', dir: config.dir }
  const s3 = config.s3 || {}
  return {
    mode: 's3',
    endpoint: s3.endpoint,
    bucket: s3.bucket,
    region: s3.region || 'auto',
    prefix: s3.prefix || 'undohaven',
    accessKeyId: s3.accessKeyId ? `${s3.accessKeyId.slice(0, 4)}…` : '',
    secretStored: Boolean(s3.secretAccessKey),
  }
}

function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex')
}

function hmac(key, data) {
  return createHmac('sha256', key).update(data).digest()
}

function signingKey(secret, date, region) {
  let key = hmac(`AWS4${secret}`, date)
  key = hmac(key, region)
  key = hmac(key, 's3')
  return hmac(key, 'aws4_request')
}

export async function s3Call(cfg, method, key, body) {
  const endpoint = new URL(cfg.endpoint)
  const region = cfg.region || 'auto'
  const payload = body ? Buffer.from(body) : Buffer.alloc(0)
  const payloadHash = sha256Hex(payload)
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '')
  const date = amzDate.slice(0, 8)
  const segments = [cfg.bucket, ...(cfg.prefix ? [cfg.prefix] : []), ...String(key || '').split('/')].filter(Boolean)
  const canonicalUri = `/${segments.map((part) => encodeURIComponent(part)).join('/')}`
  const host = endpoint.host
  const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date'
  const canonical = [method, canonicalUri, '', canonicalHeaders, signedHeaders, payloadHash].join('\n')
  const scope = `${date}/${region}/s3/aws4_request`
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonical)].join('\n')
  const signature = hmac(signingKey(cfg.secretAccessKey, date, region), stringToSign).toString('hex')
  const authorization = `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
  const response = await fetch(`${endpoint.origin}${canonicalUri}`, {
    method,
    headers: {
      authorization,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      host,
    },
    body: method === 'GET' || method === 'HEAD' ? undefined : payload,
  })
  return response
}

export async function ensureS3Bucket(cfg) {
  const probe = await s3Call(cfg, 'HEAD', '', null)
  if (probe.status === 200 || probe.status === 404 || probe.ok) {
    if (probe.status === 404) {
      const created = await s3Call(cfg, 'PUT', '', Buffer.alloc(0))
      if (!created.ok && created.status !== 409) {
        throw new HouhuiError('s3_bucket', '无法创建存储桶', `Could not create bucket (${created.status})`)
      }
    }
  }
}

function chunkRel(id) {
  return join('chunks', id.slice(0, 2), id)
}

export async function putBlob(dataDir, id, sealed) {
  const stored = isPadded(sealed) ? sealed : padBlob(sealed)
  const cfg = await loadStorageConfig(dataDir)
  if (cfg.mode === 's3') {
    const response = await s3Call(cfg.s3, 'PUT', `c/${id}`, stored)
    if (!response.ok) throw new HouhuiError('s3_put', '写入自有存储失败', `Writing to your bucket failed (${response.status})`)
    return
  }
  const root = cfg.mode === 'dir' ? cfg.dir : dataDir
  const file = join(root, chunkRel(id))
  await mkdir(dirname(file), { recursive: true })
  try {
    await writeFile(file, stored, { flag: 'wx', mode: 0o600 })
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
  }
}

export async function readBlob(dataDir, id, { padded = false } = {}) {
  const cfg = await loadStorageConfig(dataDir)
  let raw
  if (cfg.mode === 's3') {
    const response = await s3Call(cfg.s3, 'GET', `c/${id}`)
    if (response.status === 404) {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    }
    if (!response.ok) throw new HouhuiError('s3_get', '读取自有存储失败', `Reading your bucket failed (${response.status})`)
    raw = Buffer.from(await response.arrayBuffer())
  } else {
    const root = cfg.mode === 'dir' ? cfg.dir : dataDir
    raw = await readFile(join(root, chunkRel(id)))
  }
  return padded ? raw : unpadBlob(raw)
}

export async function hasBlob(dataDir, id) {
  try {
    await readBlob(dataDir, id, { padded: true })
    return true
  } catch {
    return false
  }
}

export function byoIndexRecord(record) {
  return {
    id: record.id,
    createdAt: record.createdAt,
    encryptedManifest: record.encryptedManifest,
    chunkIds: Array.isArray(record.chunkIds) ? record.chunkIds : [],
  }
}

export async function writeByoRecord(dataDir, record) {
  const cfg = await loadStorageConfig(dataDir)
  const json = JSON.stringify(byoIndexRecord(record))
  if (cfg.mode === 's3') {
    const response = await s3Call(cfg.s3, 'PUT', `m/${record.id}.json`, Buffer.from(json))
    if (!response.ok) throw new HouhuiError('s3_put', '写入清单到自有存储失败', `Writing the manifest to your bucket failed (${response.status})`)
    return
  }
  if (cfg.mode === 'dir') {
    const file = join(cfg.dir, 'snapshots', `${record.id}.json`)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, json, { mode: 0o600 })
  }
}

export async function readByoRecord(dataDir, id) {
  const cfg = await loadStorageConfig(dataDir)
  if (cfg.mode === 's3') {
    const response = await s3Call(cfg.s3, 'GET', `m/${id}.json`)
    if (!response.ok) return null
    return JSON.parse(Buffer.from(await response.arrayBuffer()).toString('utf8'))
  }
  if (cfg.mode === 'dir') {
    try {
      return JSON.parse(await readFile(join(cfg.dir, 'snapshots', `${id}.json`), 'utf8'))
    } catch {
      return null
    }
  }
  return null
}

export function newDeviceLabel() {
  return `device-${randomBytes(3).toString('hex')}`
}
