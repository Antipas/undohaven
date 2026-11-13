/**
 * Normalized FastCDC (Xia et al.).
 * Gear table is a fixed SplitMix64 stream so chunk boundaries are stable
 * across machines. Defaults target ~1 MiB average and stay under the 4 MiB
 * cloud object cap (max chunk 2 MiB plus the AES-GCM wrapper).
 */

export const MIN_SIZE = 256 * 1024
export const AVG_SIZE = 1024 * 1024
export const MAX_SIZE = 2 * 1024 * 1024

const GEAR = buildGear()

function buildGear() {
  const table = new BigUint64Array(256)
  let state = 0x484f554855495941n
  for (let i = 0; i < 256; i += 1) {
    state = (state + 0x9e3779b97f4a7c15n) & 0xffffffffffffffffn
    let z = state
    z = (z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n & 0xffffffffffffffffn
    z = (z ^ (z >> 27n)) * 0x94d049bb133111ebn & 0xffffffffffffffffn
    z = z ^ (z >> 31n)
    table[i] = z
  }
  return table
}

function masks(avg) {
  const bits = Math.max(1, Math.round(Math.log2(avg)))
  return {
    small: (1n << BigInt(bits + 1)) - 1n,
    large: (1n << BigInt(Math.max(1, bits - 1))) - 1n,
  }
}

/**
 * Cut position relative to `start`, using the normalized two-mask rule.
 * Bytes before `min` never affect the boundary.
 */
export function cutEnd(buffer, start, opts = {}) {
  const min = opts.min ?? MIN_SIZE
  const avg = opts.avg ?? AVG_SIZE
  const max = opts.max ?? MAX_SIZE
  const gear = opts.gear ?? GEAR
  const { small, large } = masks(avg)
  const len = buffer.length - start
  if (len <= min) return start + len
  const limit = Math.min(len, max)
  let offset = min
  let hash = 0n
  const center = Math.min(avg, len)
  let mask = small
  while (offset < limit) {
    if (offset === center) mask = large
    hash = ((hash << 1n) + gear[buffer[start + offset]]) & 0xffffffffffffffffn
    offset += 1
    if ((hash & mask) === 0n) return start + offset
  }
  return start + limit
}

export function chunkBuffer(buffer, opts = {}) {
  const src = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)
  if (src.length === 0) return []
  const out = []
  let start = 0
  while (start < src.length) {
    const end = cutEnd(src, start, opts)
    out.push(Buffer.from(src.subarray(start, end)))
    if (end <= start) break
    start = end
  }
  return out
}

/** Streaming chunker. `finish()` yields the same cuts as `chunkBuffer`. */
export class CdcStream {
  constructor(opts = {}) {
    this.opts = opts
    this.max = opts.max ?? MAX_SIZE
    this.buf = Buffer.alloc(0)
  }

  push(data) {
    if (!data || data.length === 0) return []
    const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data)
    this.buf = this.buf.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buf, chunk])
    const out = []
    while (this.buf.length >= this.max) {
      const end = cutEnd(this.buf, 0, this.opts)
      out.push(Buffer.from(this.buf.subarray(0, end)))
      this.buf = Buffer.from(this.buf.subarray(end))
    }
    return out
  }

  finish() {
    if (this.buf.length === 0) return []
    const rest = chunkBuffer(this.buf, this.opts)
    this.buf = Buffer.alloc(0)
    return rest
  }
}
