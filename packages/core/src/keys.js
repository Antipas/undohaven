import { chmod, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ARGON2, b64, createKeySet, fromB64, generateRecovery, recoveryKek, seal, unwrapWithPassphrase, unwrapWithRecovery } from './crypto.js'
import { HouhuiError } from './errors.js'
import { atomicWrite } from './store.js'

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

export async function ensureDataDir(dataDir) {
  await mkdir(dataDir, { recursive: true, mode: 0o700 })
  try {
    await chmod(dataDir, 0o700)
  } catch {
    /* windows */
  }
}

export async function loadConfig(dataDir) {
  return (await readJson(join(dataDir, 'config.json'))) ?? {
    apiBase: null,
    accessToken: null,
    userId: null,
    deviceId: null,
    includeCredentials: false,
  }
}

export async function saveConfig(dataDir, config) {
  await ensureDataDir(dataDir)
  await atomicWrite(join(dataDir, 'config.json'), JSON.stringify(config, null, 2))
}

export async function loadState(dataDir) {
  return (await readJson(join(dataDir, 'state.json'))) ?? { lastBaseVersion: null, pins: {} }
}

export async function saveState(dataDir, state) {
  await ensureDataDir(dataDir)
  await atomicWrite(join(dataDir, 'state.json'), JSON.stringify(state, null, 2))
}

export async function loadKeyFile(dataDir) {
  const raw = await readJson(join(dataDir, 'keys.json'))
  if (!raw) return null
  return {
    ...raw,
    salt: fromB64(raw.salt),
    wrappedDek: fromB64(raw.wrappedDek),
    wrappedDekRecovery: fromB64(raw.wrappedDekRecovery),
    dek: raw.dek ? fromB64(raw.dek) : null,
    kdf: raw.kdf ?? { ...ARGON2 },
  }
}

export async function saveKeyFile(dataDir, keys) {
  await ensureDataDir(dataDir)
  const raw = {
    v: 1,
    salt: b64(keys.salt),
    kdf: keys.kdf ?? { ...ARGON2 },
    wrappedDek: b64(keys.wrappedDek),
    wrappedDekRecovery: b64(keys.wrappedDekRecovery),
    dek: keys.dek ? b64(keys.dek) : null,
  }
  await atomicWrite(join(dataDir, 'keys.json'), JSON.stringify(raw, null, 2))
}

export async function loadDek(dataDir) {
  const keys = await loadKeyFile(dataDir)
  if (!keys?.dek) {
    throw new HouhuiError('locked', '本地数据密钥未解锁。请先 undohaven login。', 'Local data key is locked. Run undohaven login first.', { exitCode: 5 })
  }
  return { keys, dek: keys.dek }
}

export async function establishKeys(dataDir, passphrase) {
  const created = await createKeySet(passphrase)
  await saveKeyFile(dataDir, created)
  return created
}

export async function unlockPassphrase(dataDir, passphrase, remote) {
  const source = remote ?? await loadKeyFile(dataDir)
  if (!source?.wrappedDek || !source.salt) {
    throw new HouhuiError('no_keys', '还没有密钥。登录新账户时会生成。', 'No keys yet. A new account generates them at login.')
  }
  const salt = Buffer.isBuffer(source.salt) ? source.salt : fromB64(source.salt)
  const wrapped = Buffer.isBuffer(source.wrappedDek) ? source.wrappedDek : fromB64(source.wrappedDek)
  const wrappedRecovery = Buffer.isBuffer(source.wrappedDekRecovery) ? source.wrappedDekRecovery : fromB64(source.wrappedDekRecovery)
  const dek = await unwrapWithPassphrase(passphrase, salt, wrapped, source.kdf ?? ARGON2)
  const keys = { salt, kdf: source.kdf ?? { ...ARGON2 }, wrappedDek: wrapped, wrappedDekRecovery: wrappedRecovery, dek }
  await saveKeyFile(dataDir, keys)
  return keys
}

export async function rotatePassphrase(dataDir, words, nextPassphrase) {
  const current = await loadKeyFile(dataDir)
  if (!current?.wrappedDekRecovery) {
    throw new HouhuiError('no_keys', '本地没有恢复码包裹的密钥', 'No recovery-wrapped key is stored locally')
  }
  const dek = unwrapWithRecovery(words, current.wrappedDekRecovery)
  const { deriveKek } = await import('./crypto.js')
  const salt = (await import('node:crypto')).randomBytes(16)
  const kek = await deriveKek(nextPassphrase, salt)
  const keys = {
    salt,
    kdf: { ...ARGON2 },
    wrappedDek: seal(kek, dek),
    wrappedDekRecovery: current.wrappedDekRecovery,
    dek,
  }
  await saveKeyFile(dataDir, keys)
  return keys
}

export function publicKeyFields(keys) {
  return {
    salt: b64(keys.salt),
    kdf: keys.kdf ?? { ...ARGON2 },
    wrappedDek: b64(keys.wrappedDek),
    wrappedDekRecovery: b64(keys.wrappedDekRecovery),
  }
}

export { generateRecovery, recoveryKek }
