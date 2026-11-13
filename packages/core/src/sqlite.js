import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { backup, DatabaseSync } from 'node:sqlite'
import { HouhuiError } from './errors.js'

/**
 * Consistent snapshot of a SQLite database, including WAL contents.
 * Uses node:sqlite `backup(db, path)` and falls back to `VACUUM INTO`.
 */
export async function snapshotSqlite(src) {
  const dir = await mkdtemp(join(tmpdir(), 'hhy-sqlite-'))
  const dest = join(dir, 'backup.db')
  let db
  try {
    try {
      db = new DatabaseSync(src, { readOnly: true })
    } catch {
      db = new DatabaseSync(src)
    }
    try {
      await backup(db, dest)
    } catch (error) {
      const quoted = dest.replaceAll("'", "''")
      try {
        db.exec(`VACUUM INTO '${quoted}'`)
      } catch (inner) {
        throw new HouhuiError(
          'sqlite_backup_failed',
          `无法用 SQLite backup 复制 ${src}`,
          `SQLite backup failed for ${src}: ${inner.message || error.message}`,
        )
      }
    }
  } finally {
    try {
      db?.close()
    } catch {
      /* already closed */
    }
  }
  return {
    path: dest,
    async cleanup() {
      await rm(dir, { recursive: true, force: true })
    },
  }
}
