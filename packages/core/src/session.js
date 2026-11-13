import { zstdDecompressSync } from 'node:zlib'

const ZSTD_MAGIC = 0xfd2fb528

export function isZstd(buf) {
  return buf.length >= 4 && buf.readUInt32LE(0) === ZSTD_MAGIC
}

/**
 * Walk independent zstd frames. A truncated final frame is reported and, when
 * repairing, dropped. A broken frame that is not the tail is left intact.
 */
export function inspectZstd(buf) {
  const frames = []
  let offset = 0
  if (!isZstd(buf)) {
    return { ok: false, truncated: false, validEnd: 0, frames, error: 'not zstd' }
  }
  while (offset + 4 <= buf.length) {
    if (buf.readUInt32LE(offset) !== ZSTD_MAGIC) break
    let next = offset + 4
    let found = -1
    while (next + 4 <= buf.length) {
      if (buf.readUInt32LE(next) === ZSTD_MAGIC) {
        try {
          zstdDecompressSync(buf.subarray(offset, next))
          found = next
          break
        } catch {
          next += 1
        }
      } else {
        next += 1
      }
    }
    if (found === -1) {
      try {
        zstdDecompressSync(buf.subarray(offset))
        frames.push({ start: offset, end: buf.length })
        return { ok: true, truncated: false, validEnd: buf.length, frames }
      } catch {
        return {
          ok: frames.length > 0,
          truncated: true,
          validEnd: offset,
          frames,
          error: 'truncated tail',
        }
      }
    }
    frames.push({ start: offset, end: found })
    offset = found
  }
  const truncated = offset < buf.length
  return { ok: frames.length > 0 && !truncated, truncated, validEnd: offset, frames }
}

export function repairZstd(buf) {
  const info = inspectZstd(buf)
  if (!info.truncated || info.validEnd <= 0) return { bytes: buf, repaired: false, info }
  return { bytes: Buffer.from(buf.subarray(0, info.validEnd)), repaired: true, info }
}

export function repairJsonl(buf) {
  const text = buf.toString('utf8')
  if (!text.length) return { bytes: buf, repaired: false, broken: true }
  const endsNl = text.endsWith('\n')
  const lines = text.split('\n')
  if (endsNl) lines.pop()
  const bad = []
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i] === '' && i === lines.length - 1) continue
    try {
      JSON.parse(lines[i])
    } catch {
      bad.push(i)
    }
  }
  if (!endsNl && bad.length === 1 && bad[0] === lines.length - 1) {
    const kept = `${lines.slice(0, -1).join('\n')}\n`
    return { bytes: Buffer.from(kept), repaired: true, broken: false }
  }
  return { bytes: buf, repaired: false, broken: bad.length > 0 }
}

export function readSessionHeader(buf, zstd) {
  try {
    const raw = zstd ? zstdDecompressSync(firstFrame(buf)) : buf
    const line = raw.toString('utf8').split('\n').find((entry) => entry.trim().length > 0)
    if (!line) return null
    const json = JSON.parse(line)
    if (!json || typeof json !== 'object') return null
    return json
  } catch {
    return null
  }
}

function firstFrame(buf) {
  const info = inspectZstd(buf)
  if (info.frames.length === 0) throw new Error('no frame')
  const frame = info.frames[0]
  return buf.subarray(frame.start, frame.end)
}
