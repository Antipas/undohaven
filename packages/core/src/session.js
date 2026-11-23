import { zstdDecompressSync } from 'node:zlib'

const ZSTD_MAGIC = 0xfd2fb528

export function isZstd(buf) {
  return buf.length >= 4 && buf.readUInt32LE(0) === ZSTD_MAGIC
}

/**
 * Walk independent zstd frames. A truncated final frame is reported and, when
 * repairing, dropped. A broken frame that is not the tail is left intact.
 *
 * Frame ends come from the frame header and block sizes. Node 22's
 * zstdDecompressSync accepts a torn tail and returns an empty buffer, so a
 * decompress probe cannot tell that tail from a finished frame.
 */
export function inspectZstd(buf) {
  const frames = []
  let offset = 0
  if (!isZstd(buf)) {
    return { ok: false, truncated: false, validEnd: 0, frames, error: 'not zstd' }
  }
  while (offset + 4 <= buf.length) {
    if (buf.readUInt32LE(offset) !== ZSTD_MAGIC) break
    const parsed = frameEnd(buf, offset)
    if (!parsed) break
    if (parsed.truncated) {
      return { ok: frames.length > 0, truncated: true, validEnd: offset, frames, error: 'truncated tail' }
    }
    frames.push({ start: offset, end: parsed.end })
    offset = parsed.end
  }
  const truncated = offset < buf.length
  return {
    ok: frames.length > 0 && !truncated,
    truncated,
    validEnd: offset,
    frames,
    error: truncated ? 'truncated tail' : undefined,
  }
}

function frameEnd(buf, offset) {
  if (offset + 5 > buf.length) return { truncated: true }
  const desc = buf[offset + 4]
  if ((desc & 0x08) !== 0) return null
  const fcsFlag = desc >>> 6
  const single = (desc >>> 5) & 1
  const checksum = (desc >>> 2) & 1
  const dictLen = [0, 1, 2, 4][desc & 3]
  let pos = offset + 5
  if (!single) pos += 1
  pos += dictLen
  pos += fcsFlag === 0 ? (single ? 1 : 0) : [0, 2, 4, 8][fcsFlag]
  if (pos > buf.length) return { truncated: true }
  while (pos < buf.length) {
    if (pos + 3 > buf.length) return { truncated: true }
    const header = buf.readUIntLE(pos, 3)
    const last = header & 1
    const type = (header >>> 1) & 3
    const size = header >>> 3
    pos += 3
    if (type === 3) return null
    pos += type === 1 ? 1 : size
    if (pos > buf.length) return { truncated: true }
    if (last) {
      if (checksum) pos += 4
      if (pos > buf.length) return { truncated: true }
      return { end: pos }
    }
  }
  return { truncated: true }
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

export function decompressZstdFrames(buf) {
  const info = inspectZstd(buf)
  if (!info.frames.length) throw new Error('no frame')
  return Buffer.concat(info.frames.map((frame) => Buffer.from(zstdDecompressSync(buf.subarray(frame.start, frame.end)))))
}

function firstFrame(buf) {
  const info = inspectZstd(buf)
  if (info.frames.length === 0) throw new Error('no frame')
  const frame = info.frames[0]
  return buf.subarray(frame.start, frame.end)
}
