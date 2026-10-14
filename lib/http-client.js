'use strict'

const {
  DEFAULT_PORT,
  DEFAULT_PROTOCOL,
  DEFAULT_TIMEOUT,
  MAX_TIMEOUT,
  API_PREFIX
} = require('./constants')

const TRANSPORT_ERRORS = Object.freeze([
  'ERR_REQUEST_TIMEOUT',
  'ERR_DEVICE_CONNECTION',
  'ERR_RESPONSE_INVALID_JSON'
])

class InvalidJsonError extends Error {}

class ProtoHttpClient {
  constructor (opts = {}) {
    if (opts.address === undefined) throw new Error('ERR_DEVICE_ADDRESS_REQUIRED')
    const address = validateAddress(opts.address)

    for (const name of ['password', 'accessToken', 'refreshToken']) {
      if (opts[name] !== undefined && !isNonEmptyString(opts[name])) {
        throw new Error('ERR_DEVICE_CREDENTIALS_INVALID')
      }
    }
    if (opts.password === undefined && opts.accessToken === undefined) {
      throw new Error('ERR_DEVICE_CREDENTIALS_REQUIRED')
    }

    const protocol = opts.protocol === undefined ? DEFAULT_PROTOCOL : opts.protocol
    if (!['http', 'https'].includes(protocol)) throw new Error('ERR_PROTOCOL_UNSUPPORTED')

    const port = opts.port ?? DEFAULT_PORT
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('ERR_DEVICE_PORT_INVALID')

    const timeout = opts.timeout ?? DEFAULT_TIMEOUT
    if (!Number.isInteger(timeout) || timeout <= 0 || timeout > MAX_TIMEOUT) {
      throw new Error('ERR_REQUEST_TIMEOUT_INVALID')
    }

    this.baseUrl = `${protocol}://${address}:${port}${API_PREFIX}`
    this.password = opts.password || null
    this.accessToken = opts.accessToken || null
    this.refreshToken = opts.refreshToken || null
    this.timeout = timeout
    this.fetchImpl = opts.fetchImpl || globalThis.fetch
    if (typeof this.fetchImpl !== 'function') throw new Error('ERR_FETCH_REQUIRED')
    this.loginPromise = null
  }

  async request (path, {
    method = 'GET',
    body,
    authenticated = true,
    includeStatus = false,
    retryAuth = true,
    freshAuth = false,
    responseType = 'json',
    timeout = this.timeout
  } = {}) {
    if (!Number.isInteger(timeout) || timeout <= 0 || timeout > MAX_TIMEOUT) {
      throw new Error('ERR_REQUEST_TIMEOUT_INVALID')
    }
    if (!authenticated) {
      return this._parse(
        await this._roundTrip(path, { method, body, token: null, responseType, timeout }),
        includeStatus
      )
    }

    // Updates need a valid credential before sending their body. A configured
    // access token alone is still usable when no renewal credential exists.
    await this._authenticate(freshAuth && Boolean(this.refreshToken || this.password))
    const rejectedToken = this.accessToken
    const result = await this._roundTrip(path, { method, body, token: rejectedToken, responseType, timeout })
    if (result.response.status !== 401) return this._parse(result, includeStatus)
    if (!retryAuth) throw new Error('ERR_AUTHENTICATION_FAILED')

    if (!this.accessToken || this.accessToken === rejectedToken) {
      // Only discard the rejected token when a renewal path exists. A client
      // configured with an access token alone has nothing to re-authenticate
      // with, so clearing it here would brick every later request on a single
      // transient 401.
      const renewable = Boolean(this.refreshToken || this.password)
      if (renewable && this.accessToken === rejectedToken) this.accessToken = null
      await this._authenticate(true)
    }
    const retried = await this._roundTrip(path, { method, body, token: this.accessToken, responseType, timeout })
    if (retried.response.status === 401) throw new Error('ERR_AUTHENTICATION_FAILED')
    return this._parse(retried, includeStatus)
  }

  async _authenticate (force = false) {
    if (!force && this.accessToken) return
    if (this.loginPromise) return this.loginPromise
    if (!this.refreshToken && !this.password) throw new Error('ERR_AUTHENTICATION_FAILED')

    this.loginPromise = this.refreshToken
      ? this._refresh().catch(err => {
        // Fall back to the password only when the firmware explicitly rejects
        // the refresh credential. Transport, protocol, and server failures are
        // not evidence that a password login would be safe or useful.
        if (!err || err.message !== 'ERR_AUTHENTICATION_FAILED' || !this.password) throw err
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
    }).catch(rethrowAuthenticationFailure)
    validateAuthenticationResponse(data)
    this.accessToken = data.access_token
    this.refreshToken = data.refresh_token || null
  }

  async _refresh () {
    const data = await this.request('/auth/refresh', {
      method: 'POST',
      body: { refresh_token: this.refreshToken },
      authenticated: false
    }).catch(rethrowAuthenticationFailure)
    validateAuthenticationResponse(data)
    this.accessToken = data.access_token
    if (data.refresh_token) this.refreshToken = data.refresh_token
  }

  async _roundTrip (path, { method, body, token, responseType, timeout }) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout)

    try {
      const response = await this._send(path, { method, body, token, signal: controller.signal })
      let data = null
      if (responseType === 'none') await response.text()
      else data = await this._readJson(response)
      return { response, data }
    } catch (err) {
      if (err && err.name === 'AbortError') throw new Error('ERR_REQUEST_TIMEOUT')
      if (err instanceof InvalidJsonError) throw new Error('ERR_RESPONSE_INVALID_JSON')
      throw new Error('ERR_DEVICE_CONNECTION')
    } finally {
      clearTimeout(timer)
    }
  }

  async _send (path, { method, body, token, signal }) {
    const headers = { Accept: 'application/json' }
    const multipart = body instanceof FormData
    if (body !== undefined && !multipart) headers['Content-Type'] = 'application/json'
    if (token) headers.Authorization = `Bearer ${token}`

    return this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined || multipart ? body : JSON.stringify(body),
      redirect: 'error',
      signal
    })
  }

  async _readJson (response) {
    const text = await response.text()
    let data = null
    if (text) {
      try {
        data = JSON.parse(text)
      } catch {
        throw new InvalidJsonError()
      }
    }
    return data
  }

  _parse ({ response, data }, includeStatus = false) {
    if (!response.ok) throw new Error(`ERR_HTTP_RESPONSE: ${response.status}`)
    return includeStatus ? { status: response.status, data } : data
  }
}

function validateAddress (address) {
  if (typeof address !== 'string' || !address || address !== address.trim() || /[/?#@]/.test(address)) {
    throw new Error('ERR_DEVICE_ADDRESS_INVALID')
  }

  let parsed
  try {
    parsed = new URL(`http://${address}`)
  } catch {
    throw new Error('ERR_DEVICE_ADDRESS_INVALID')
  }
  if (!parsed.hostname || parsed.username || parsed.password || parsed.port || parsed.pathname !== '/') {
    throw new Error('ERR_DEVICE_ADDRESS_INVALID')
  }
  return address
}

// Preserve failures that do not prove the credential was rejected. Only
// explicit 401/403 responses are normalized as authentication failures.
function rethrowAuthenticationFailure (err) {
  if (err && TRANSPORT_ERRORS.includes(err.message)) throw err
  const status = err && /^ERR_HTTP_RESPONSE: (\d+)$/.exec(err.message)
  if (status && status[1] !== '401' && status[1] !== '403') throw err
  throw new Error('ERR_AUTHENTICATION_FAILED')
}

function validateAuthenticationResponse (data) {
  if (!data || !isNonEmptyString(data.access_token)) throw new Error('ERR_AUTHENTICATION_RESPONSE_INVALID')
  if (data.refresh_token !== undefined && !isNonEmptyString(data.refresh_token)) {
    throw new Error('ERR_AUTHENTICATION_RESPONSE_INVALID')
  }
}

function isNonEmptyString (value) {
  return typeof value === 'string' && Boolean(value.trim())
}

module.exports = { ProtoHttpClient }
