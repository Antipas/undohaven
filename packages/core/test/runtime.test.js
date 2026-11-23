import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'

test('the core runs on the Node 22 line pi requires', () => {
  const major = Number(process.versions.node.split('.')[0])
  const minor = Number(process.versions.node.split('.')[1])
  assert.ok(major > 22 || (major === 22 && minor >= 19), process.version)
  const packed = zstdCompressSync(Buffer.from('undohaven'))
  assert.equal(Buffer.from(zstdDecompressSync(packed)).toString(), 'undohaven')
  const db = new DatabaseSync(':memory:')
  db.exec('create table probe (n integer)')
  db.close()
})
