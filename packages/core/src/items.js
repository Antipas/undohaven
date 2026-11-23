import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { atomicWrite } from './store.js'

const SECRET_NAME = /^(?:\.env(?:\..*)?|credentials(?:\.(?:json|ya?ml))?|auth\.json|secrets\.json|id_rsa|id_ed25519|.*\.(?:pem|key))$/i

export function isWatchedStorage(rel) {
  const parts = String(rel || '').split('/')
  if (parts.length !== 2 || parts[0] !== 'storages') return false
  const name = parts[1]
  if (!name.endsWith('.json')) return false
  if (SECRET_NAME.test(name)) return false
  return true
}

export async function mergeScheduleDocument(dshHome, saved) {
  const path = join(dshHome, 'storages', 'schedule.json')
  let live = null
  try {
    live = JSON.parse(await readFile(path, 'utf8'))
  } catch {
    live = null
  }
  const savedTasks = saved?.tables?.tasks && typeof saved.tables.tasks === 'object' ? saved.tables.tasks : {}
  let document
  let restored
  if (!live || typeof live !== 'object' || !live.tables || typeof live.tables.tasks !== 'object') {
    document = saved
    restored = Object.keys(savedTasks)
  } else {
    const tasks = { ...live.tables.tasks }
    restored = []
    for (const [id, task] of Object.entries(savedTasks)) {
      tasks[id] = task
      restored.push(id)
    }
    document = { ...live, tables: { ...live.tables, tasks } }
  }
  await mkdir(join(dshHome, 'storages'), { recursive: true })
  await atomicWrite(path, `${JSON.stringify(document)}\n`)
  return { restored, document }
}

export async function mergeSessionListing(dshHome, saved, sessionId) {
  const path = join(dshHome, 'storages', 'workspace.json')
  let live = null
  try {
    live = JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return []
  }
  const savedSpaces = saved?.tables?.workspaces
  const liveSpaces = live?.tables?.workspaces
  if (!savedSpaces || !liveSpaces) return []
  const listed = []
  for (const [id, space] of Object.entries(savedSpaces)) {
    const current = liveSpaces[id]
    if (!current || !Array.isArray(space?.sessionIds) || !space.sessionIds.includes(sessionId)) continue
    const ids = Array.isArray(current.sessionIds) ? current.sessionIds.slice() : []
    if (!ids.includes(sessionId)) {
      ids.push(sessionId)
      current.sessionIds = ids
      listed.push(id)
    }
    if (Array.isArray(current.archivedSessionIds)) {
      current.archivedSessionIds = current.archivedSessionIds.filter((item) => item !== sessionId)
    }
  }
  if (listed.length) await atomicWrite(path, `${JSON.stringify(live)}\n`)
  return listed
}
