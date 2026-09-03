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

    const port = opts.port ?? DEFAULT_PORT
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
    this.loginPromise = null
  }

  async request (path, { method = 'GET', body, authenticated = true } = {}) {
    if (!authenticated) return this._parse(await this._send(path, { method, body, token: null }))

    await this._authenticate()
    const rejectedToken = this.accessToken
    const response = await this._send(path, { method, body, token: rejectedToken })
    if (response.status !== 401) return this._parse(response)

    if (!this.accessToken || this.accessToken === rejectedToken) {
      if (this.accessToken === rejectedToken) this.accessToken = null
      await this._authenticate(true)
    }
    const retried = await this._send(path, { method, body, token: this.accessToken })
    if (retried.status === 401) throw new Error('ERR_AUTHENTICATION_FAILED')
    return this._parse(retried)
  }

  async _authenticate (force = false) {
    if (!force && this.accessToken) return
    if (this.loginPromise) return this.loginPromise
    if (!this.refreshToken && !this.password) throw new Error('ERR_AUTHENTICATION_FAILED')

    this.loginPromise = this.refreshToken
      ? this._refresh().catch(() => {
        if (!this.password) throw new Error('ERR_AUTHENTICATION_FAILED')
        return this._login()
      })
      : this._login()
    try { await this.loginPromise } finally { this.loginPromise = null }
  }

  async _login () {
    const data = await this.request('/auth/login', {
      method: 'POST',
      body: { password: this.password },
      authenticated: false
    }).catch(() => { throw new Error('ERR_AUTHENTICATION_FAILED') })
    if (!data || typeof data.access_token !== 'string') throw new Error('ERR_AUTHENTICATION_RESPONSE_INVALID')
    this.accessToken = data.access_token
    this.refreshToken = data.refresh_token || null
  }

  async _refresh () {
    const data = await this.request('/auth/refresh', {
      method: 'POST',
      body: { refresh_token: this.refreshToken },
      authenticated: false
    }).catch(() => { throw new Error('ERR_AUTHENTICATION_FAILED') })
    if (!data || typeof data.access_token !== 'string') throw new Error('ERR_AUTHENTICATION_RESPONSE_INVALID')
    this.accessToken = data.access_token
    if (data.refresh_token) this.refreshToken = data.refresh_token
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
