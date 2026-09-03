'use strict'

const {
  DEFAULT_PORT,
  DEFAULT_PROTOCOL,
  DEFAULT_TIMEOUT,
  API_PREFIX
} = require('./constants')

class ProtoHttpClient {
  constructor (opts = {}) {
    if (!opts.address) throw new Error('ERR_DEVICE_ADDRESS_REQUIRED')
    if (!opts.password && !opts.accessToken) throw new Error('ERR_DEVICE_CREDENTIALS_REQUIRED')

    const protocol = opts.protocol || DEFAULT_PROTOCOL
    if (!['http', 'https'].includes(protocol)) throw new Error('ERR_PROTOCOL_UNSUPPORTED')

    const port = opts.port || DEFAULT_PORT
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('ERR_DEVICE_PORT_INVALID')

    const timeout = opts.timeout ?? DEFAULT_TIMEOUT
    if (!Number.isFinite(timeout) || timeout <= 0) throw new Error('ERR_REQUEST_TIMEOUT_INVALID')

    this.baseUrl = `${protocol}://${opts.address}:${port}${API_PREFIX}`
    this.password = opts.password || null
    this.accessToken = opts.accessToken || null
    this.refreshToken = opts.refreshToken || null
    this.timeout = timeout
    this.fetchImpl = opts.fetchImpl || globalThis.fetch
    if (typeof this.fetchImpl !== 'function') throw new Error('ERR_FETCH_REQUIRED')
  }

  async request (path, { method = 'GET', body, authenticated = true } = {}) {
    if (authenticated) await this._authenticate()
    const response = await this._send(path, { method, body, token: authenticated ? this.accessToken : null })
    return this._parse(response)
  }

  async _authenticate () {
    if (!this.accessToken) throw new Error('ERR_AUTHENTICATION_REQUIRED')
  }

  async _send (path, { method, body, token }) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeout)
    const headers = { Accept: 'application/json' }
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    if (token) headers.Authorization = `Bearer ${token}`

    try {
      return await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal
      })
    } catch (err) {
      if (err && err.name === 'AbortError') throw new Error('ERR_REQUEST_TIMEOUT')
      throw new Error('ERR_DEVICE_CONNECTION')
    } finally {
      clearTimeout(timer)
    }
  }

  async _parse (response) {
    const text = await response.text()
    let data = null
    if (text) {
      try {
        data = JSON.parse(text)
      } catch {
        throw new Error('ERR_RESPONSE_INVALID_JSON')
      }
    }
    if (!response.ok) throw new Error(`ERR_HTTP_RESPONSE: ${response.status}`)
    return data
  }
}

module.exports = { ProtoHttpClient }
