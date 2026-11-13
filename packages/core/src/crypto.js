import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { HouhuiError } from './errors.js'

export const ARGON2 = Object.freeze({
  memorySize: 65536,
  iterations: 3,
  parallelism: 1,
  hashLength: 32,
})

const ZSTD_MAGIC = 0xfd2fb528
const WORDS = readFileSync(new URL('./bip39-english.txt', import.meta.url), 'utf8')
  .trim()
  .split(/\r?\n/)
const WORD_INDEX = new Map(WORDS.map((word, index) => [word, index]))

if (WORDS.length !== 2048) {
  throw new Error(`BIP39 wordlist has ${WORDS.length} entries, expected 2048 (${dirname(fileURLToPath(import.meta.url))})`)
}

export function randomId(prefix) {
  return `${prefix}${randomBytes(16).toString('hex')}`
}

export function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

function hkdf(ikm, info) {
  return Buffer.from(hkdfSync('sha256', ikm, Buffer.alloc(32), Buffer.from(info), 32))
}

export function chunkIdKey(dek) {
  return hkdf(dek, 'undohaven/chunk-id/v1')
}

export function chunkEncKey(dek) {
  return hkdf(dek, 'undohaven/chunk-enc/v1')
}

export function manifestKey(dek) {
  return hkdf(dek, 'undohaven/manifest/v1')
}

export function recoveryKek(entropy) {
  return hkdf(entropy, 'undohaven/recovery-kek/v1')
}

export function hmacChunkId(key, plaintext) {
  return createHmac('sha256', key).update(plaintext).digest('hex')
}

function maybeCompress(plaintext) {
  if (plaintext.length >= 4 && plaintext.readUInt32LE(0) === ZSTD_MAGIC) {
    return { body: plaintext, compressed: false }
  }
  if (plaintext.length < 32) return { body: plaintext, compressed: false }
  const compressed = zstdCompressSync(plaintext)
  if (compressed.length >= plaintext.length) return { body: plaintext, compressed: false }
  return { body: compressed, compressed: true }
}

/**
 * Sealed blob: version (1) | flags | 12-byte nonce | ciphertext | 16-byte tag.
 * Flag bit 0 means the plaintext was zstd-compressed before encryption.
 */
export function seal(key, plaintext) {
  const packed = maybeCompress(Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(plaintext))
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  const body = Buffer.concat([cipher.update(packed.body), cipher.final(), cipher.getAuthTag()])
  const out = Buffer.alloc(14 + body.length)
  out[0] = 1
  out[1] = packed.compressed ? 1 : 0
  nonce.copy(out, 2)
  body.copy(out, 14)
  return out
}

export function open(key, blob) {
  const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob)
  if (buf.length < 14 + 16 || buf[0] !== 1) {
    throw new HouhuiError('bad_seal', '密文格式无法识别', 'Ciphertext format is not recognized')
  }
  const nonce = buf.subarray(2, 14)
  const tag = buf.subarray(buf.length - 16)
  const ct = buf.subarray(14, buf.length - 16)
  const decipher = createDecipheriv('aes-256-gcm', key, nonce)
  decipher.setAuthTag(tag)
  let body
  try {
    body = Buffer.concat([decipher.update(ct), decipher.final()])
  } catch {
    throw new HouhuiError('decrypt_failed', '解密失败，口令或恢复码不正确', 'Decryption failed; the passphrase or recovery code is wrong')
  }
  if (buf[1] & 1) return Buffer.from(zstdDecompressSync(body))
  return body
}

export async function deriveKek(passphrase, salt, params = ARGON2) {
  if (typeof passphrase !== 'string' || passphrase.length < 8 || passphrase.length > 1024) {
    throw new HouhuiError('weak_passphrase', '口令至少 8 个字符', 'Passphrase must be at least 8 characters')
  }
  const { argon2id } = await import('hash-wasm')
  const out = await argon2id({
    password: passphrase,
    salt,
    parallelism: params.parallelism,
    iterations: params.iterations,
    memorySize: params.memorySize,
    hashLength: params.hashLength,
    outputType: 'binary',
  })
  return Buffer.from(out)
}

export function generateDek() {
  return randomBytes(32)
}

function bytesToBits(buf) {
  let bits = ''
  for (const byte of buf) bits += byte.toString(2).padStart(8, '0')
  return bits
}

function bitsToBytes(bits) {
  const out = Buffer.alloc(bits.length / 8)
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(bits.slice(i * 8, i * 8 + 8), 2)
  return out
}

export function wordsFromEntropy(entropy) {
  if (entropy.length !== 32) throw new Error('recovery entropy must be 32 bytes')
  const checksum = createHash('sha256').update(entropy).digest()
  const bits = bytesToBits(entropy) + bytesToBits(checksum).slice(0, 8)
  const words = []
  for (let i = 0; i < 24; i += 1) {
    words.push(WORDS[Number.parseInt(bits.slice(i * 11, i * 11 + 11), 2)])
  }
  return words
}

export function entropyFromWords(words) {
  const list = Array.isArray(words) ? words : String(words).trim().toLowerCase().split(/\s+/)
  if (list.length !== 24) {
    throw new HouhuiError('bad_recovery', '恢复码必须是 24 个单词', 'Recovery code must be 24 words')
  }
  let bits = ''
  for (const word of list) {
    const index = WORD_INDEX.get(word)
    if (index === undefined) {
      throw new HouhuiError('bad_recovery', `恢复码里有不认识的单词：${word}`, `Unknown recovery word: ${word}`)
    }
    bits += index.toString(2).padStart(11, '0')
  }
  const entropy = bitsToBytes(bits.slice(0, 256))
  const expect = bytesToBits(createHash('sha256').update(entropy).digest()).slice(0, 8)
  if (bits.slice(256) !== expect) {
    throw new HouhuiError('bad_recovery', '恢复码校验失败，请核对 24 个单词', 'Recovery code checksum failed; check all 24 words')
  }
  return entropy
}

export function generateRecovery() {
  const entropy = randomBytes(32)
  return { entropy, words: wordsFromEntropy(entropy) }
}

export async function createKeySet(passphrase) {
  const salt = randomBytes(16)
  const kek = await deriveKek(passphrase, salt)
  const dek = generateDek()
  const recovery = generateRecovery()
  return {
    salt,
    kdf: { ...ARGON2 },
    wrappedDek: seal(kek, dek),
    wrappedDekRecovery: seal(recoveryKek(recovery.entropy), dek),
    dek,
    words: recovery.words,
  }
}

export async function unwrapWithPassphrase(passphrase, salt, wrappedDek, kdf = ARGON2) {
  const kek = await deriveKek(passphrase, salt, kdf)
  const dek = open(kek, wrappedDek)
  if (dek.length !== 32) {
    throw new HouhuiError('bad_dek', '解开的数据密钥长度不正确', 'Unwrapped data key has the wrong length')
  }
  return dek
}

export function unwrapWithRecovery(words, wrappedDekRecovery) {
  const dek = open(recoveryKek(entropyFromWords(words)), wrappedDekRecovery)
  if (dek.length !== 32) {
    throw new HouhuiError('bad_dek', '解开的数据密钥长度不正确', 'Unwrapped data key has the wrong length')
  }
  return dek
}

export function b64(buf) {
  return Buffer.from(buf).toString('base64')
}

export function fromB64(text) {
  return Buffer.from(text, 'base64')
}
