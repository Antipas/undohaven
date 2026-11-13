export class HouhuiError extends Error {
  /**
   * @param {string} code
   * @param {string} zh
   * @param {string} en
   * @param {{ exitCode?: number, details?: unknown }} [opts]
   */
  constructor(code, zh, en, opts = {}) {
    super(`${zh} / ${en}`)
    this.name = 'HouhuiError'
    this.code = code
    this.zh = zh
    this.en = en
    this.exitCode = opts.exitCode ?? 1
    this.details = opts.details
  }
}

export function bi(zh, en) {
  return `${zh} / ${en}`
}
