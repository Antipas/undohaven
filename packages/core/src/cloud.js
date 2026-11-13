import { HouhuiError } from './errors.js'

export class CloudClient {
  constructor({ apiBase, token }) {
    this.apiBase = String(apiBase || '').replace(/\/$/, '')
    this.token = token || ''
  }

  async request(method, path, { body, headers, raw, purpose } = {}) {
    const reqHeaders = { ...(headers || {}) }
    if (this.token) reqHeaders.authorization = `Bearer ${this.token}`
    if (purpose) reqHeaders['x-undohaven-purpose'] = purpose
    let payload
    if (body !== undefined && !raw) {
      reqHeaders['content-type'] = 'application/json'
      payload = JSON.stringify(body)
    } else if (raw) {
      payload = raw
      reqHeaders['content-type'] = reqHeaders['content-type'] || 'application/octet-stream'
    }
    const response = await fetch(`${this.apiBase}${path}`, { method, headers: reqHeaders, body: payload })
    const type = response.headers.get('content-type') || ''
    const parsed = type.includes('json') ? await response.json() : Buffer.from(await response.arrayBuffer())
    if (!response.ok) {
      const code = parsed && parsed.error ? parsed.error : `http_${response.status}`
      const zh = parsed?.zh || `云端请求失败（${response.status}）`
      const en = parsed?.en || `Cloud request failed (${response.status})`
      throw new HouhuiError(code, zh, en, { exitCode: response.status === 402 ? 4 : 1, details: parsed })
    }
    return { status: response.status, headers: response.headers, body: parsed }
  }

  deviceCode(body) {
    return this.request('POST', '/v1/device/code', { body }).then((res) => res.body)
  }

  deviceToken(deviceCode) {
    return this.request('POST', '/v1/device/token', {
      body: { device_code: deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' },
    }).then((res) => res.body)
  }

  account() {
    return this.request('GET', '/v1/account').then((res) => res.body)
  }

  putKeys(body) {
    return this.request('POST', '/v1/account/keys', { body }).then((res) => res.body)
  }

  missing(ids) {
    return this.request('POST', '/v1/chunks/missing', { body: { ids } }).then((res) => res.body.missing)
  }

  async chunkStatus(id) {
    const response = await fetch(`${this.apiBase}/v1/chunks/${id}`, {
      method: 'HEAD',
      headers: this.token ? { authorization: `Bearer ${this.token}` } : {},
    })
    if (response.status === 404) return { state: 'absent', received: 0 }
    if (!response.ok) {
      throw new HouhuiError('chunk_status', '无法查询分块上传进度', `Chunk status failed (${response.status})`)
    }
    return {
      state: response.headers.get('x-chunk-state') || 'complete',
      received: Number(response.headers.get('content-length') || 0),
    }
  }

  async uploadChunk(id, bytes) {
    const status = await this.chunkStatus(id)
    if (status.state === 'complete' && status.received === bytes.length) return
    let offset = status.state === 'partial' ? status.received : 0
    const part = 1024 * 1024
    while (offset < bytes.length) {
      const end = Math.min(bytes.length, offset + part)
      const slice = bytes.subarray(offset, end)
      await this.request('PUT', `/v1/chunks/${id}`, {
        raw: slice,
        headers: {
          'upload-offset': String(offset),
          'upload-length': String(bytes.length),
          'content-type': 'application/octet-stream',
        },
      })
      offset = end
    }
  }

  async downloadChunk(id, purpose) {
    const res = await this.request('GET', `/v1/chunks/${id}`, { purpose })
    return Buffer.from(res.body)
  }

  createSnapshot(body) {
    return this.request('POST', '/v1/snapshots', { body }).then((res) => res.body)
  }

  listSnapshots() {
    return this.request('GET', '/v1/snapshots').then((res) => res.body.snapshots)
  }

  getSnapshot(id, purpose) {
    const query = purpose ? `?purpose=${encodeURIComponent(purpose)}` : ''
    return this.request('GET', `/v1/snapshots/${id}${query}`, { purpose }).then((res) => res.body)
  }

  pinSnapshot(id, body) {
    return this.request('POST', `/v1/snapshots/${id}`, { body }).then((res) => res.body)
  }

  deleteSnapshot(id) {
    return this.request('DELETE', `/v1/snapshots/${id}`).then((res) => res.body)
  }

  migrationGrant() {
    return this.request('POST', '/v1/migrations', { body: {} }).then((res) => res.body)
  }

  track(name, meta) {
    return this.request('POST', '/v1/events', { body: { name, meta } }).then((res) => res.body)
  }

  startTrial() {
    return this.request('POST', '/v1/trial', { body: {} }).then((res) => res.body)
  }
}
