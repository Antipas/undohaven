export { HouhuiError, bi } from './errors.js'
export { parseYaml, YamlError } from './yaml.js'
export { chunkBuffer, CdcStream, MIN_SIZE, AVG_SIZE, MAX_SIZE, cutEnd } from './cdc.js'
export {
  ARGON2,
  seal,
  open,
  deriveKek,
  generateDek,
  createKeySet,
  wordsFromEntropy,
  entropyFromWords,
  generateRecovery,
  unwrapWithPassphrase,
  unwrapWithRecovery,
  hmacChunkId,
  chunkIdKey,
  chunkEncKey,
  manifestKey,
  sha256,
  b64,
  fromB64,
  randomId,
} from './crypto.js'
export { resolveDshHome, resolveAgentsHome, resolveDataDir, safeJoin } from './paths.js'
export { classifyDsh, classifyAgents, scanRoot, isSessionFile, isStraySessionsDir, isModelWeight, escapesTree, DEFAULT_MAX_FILE_BYTES } from './scan.js'
export { inspectZstd, repairZstd, repairJsonl, readSessionHeader, decompressZstdFrames } from './session.js'
export { snapshotSqlite } from './sqlite.js'
export { doctor } from './doctor.js'
export { fileLockHeld, assertDshStopped, portOpen, windowsSessionSemaphoreName, textListsDshProcess } from './lock.js'
export { detectDshVersions } from './versions.js'
export { CloudClient } from './cloud.js'
export {
  loadConfig,
  saveConfig,
  loadState,
  saveState,
  loadKeyFile,
  saveKeyFile,
  loadDek,
  establishKeys,
  unlockPassphrase,
  rotatePassphrase,
  publicKeyFields,
} from './keys.js'
export {
  createSnapshot,
  listSnapshots,
  restoreSnapshot,
  pinSnapshot,
  onRuntimeStart,
  exportArchive,
  readArchive,
  importArchive,
  upgradeRuntime,
  reinstallProfiles,
  migrateMachine,
  cloudFromConfig,
  decryptManifest,
  publishSnapshot,
  uploadPendingLocal,
} from './engine.js'
export { isWatchedStorage } from './items.js'
export { captureStorageChanges, watchStorages } from './watch.js'
export { PLANS, PRICES, PRICE_ENV, effectivePlan, versionLine, isCrossMajorDowngrade } from './plans.js'
export { padBlob, unpadBlob, loadStorageConfig, saveStorageConfig, redactStorage, s3Call, newDeviceLabel } from './byo.js'
export { UPGRADE, readPrompts, writePrompts } from './prompts.js'
export { ANONYMOUS_FUNNEL, anonymousMeta, funnelOptedIn, limitNudgeLine, reportAnonymousEvent, showLimitNudge, TRIAL_URL } from './funnel.js'
export { readPaddedChunk, readSnapshotRecord } from './store.js'
export { createFileSnapshot, listFileSnapshots, readFileManifest, restoreFileSnapshot } from './filesnap.js'
export {
  GUARD_SEED,
  ROLLBACK_LIMIT,
  diffCapabilities,
  disableBlocked,
  hashDirectory,
  listInstalledPlugins,
  loadBlocklist,
  matchBlock,
  readBaseline,
  declaredFromManifest,
  listPluginHistory,
  latestGoodSnapshotId,
  markSnapshotTree,
  notePluginPoints,
  rollbackGuard,
  scanGuard,
} from './guard.js'
export {
  GUARD_UPDATE_PHRASES,
  createHostControl,
  detectLockedNativeModules,
  findBrokenTree,
  guardPluginChange,
  hostStopPlan,
  isUpdateFailure,
  listNativeModules,
  pluginChangeArgs,
  repairBrokenTree,
  runtimePnpmStatus,
} from './plugin-update.js'
export {
  applyDisabledFlags,
  collectPluginState,
  diffPluginState,
  installProfile,
  loadPluginState,
  restoreOnePlugin,
  restorePluginState,
  savePluginState,
} from './plugins.js'
