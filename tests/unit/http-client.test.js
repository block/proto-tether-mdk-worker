'use strict'

const test = require('brittle')
const { ProtoHttpClient } = require('../../lib/http-client')

const response = (status, body) => ({
  status,
  ok: status >= 200 && status < 300,
  text: async () => body === undefined ? '' : JSON.stringify(body)
})

test('constructor validates and applies public API defaults', (t) => {
  const client = new ProtoHttpClient({
    address: '192.0.2.10',
    password: 'secret',
    fetchImpl: async () => response(200, {})
  })
  t.is(client.baseUrl, 'http://192.0.2.10:80/api/v1')
  t.exception(() => new ProtoHttpClient({ address: '192.0.2.10', password: 'secret', protocol: 'file' }), /ERR_PROTOCOL_UNSUPPORTED/)
  t.exception(() => new ProtoHttpClient({ password: 'secret' }), /ERR_DEVICE_ADDRESS_REQUIRED/)
  t.exception(() => new ProtoHttpClient({ address: '192.0.2.10' }), /ERR_DEVICE_CREDENTIALS_REQUIRED/)
  t.exception(() => new ProtoHttpClient({ address: '192.0.2.10', password: 'secret', timeout: -1 }), /ERR_REQUEST_TIMEOUT_INVALID/)
  t.exception(() => new ProtoHttpClient({ address: '192.0.2.10', password: 'secret', timeout: 0.5 }), /ERR_REQUEST_TIMEOUT_INVALID/)
  t.exception(() => new ProtoHttpClient({ address: '192.0.2.10', password: 'secret', timeout: 2147483648 }), /ERR_REQUEST_TIMEOUT_INVALID/)
  t.exception(() => new ProtoHttpClient({ address: '192.0.2.10', password: 'secret', port: 0 }), /ERR_DEVICE_PORT_INVALID/)
})

test('constructor rejects non-string credentials and non-host-only addresses', (t) => {
  for (const address of [42, '', '   ', 'user:secret@example.com', 'example.com/path', 'example.com?x=1', 'example.com#part', 'http://example.com', 'example.com:8080']) {
    t.exception(() => new ProtoHttpClient({ address, password: 'secret' }), /ERR_DEVICE_ADDRESS_INVALID/)
  }

  for (const credentials of [
    { password: 1 },
    { password: '' },
    { accessToken: {} },
    { accessToken: 'token', refreshToken: 1 },
    { password: 'secret', accessToken: '' }
  ]) {
    t.exception(() => new ProtoHttpClient({ address: 'example.com', ...credentials }), /ERR_DEVICE_CREDENTIALS_INVALID/)
  }
})

test('request sends JSON and parses JSON without leaking credentials', async (t) => {
  let seen
  const client = new ProtoHttpClient({
    address: '192.0.2.10',
    accessToken: 'token-secret',
    fetchImpl: async (url, opts) => {
      seen = { url, opts }
      return response(200, { value: 42 })
    }
  })
  t.alike(await client.request('/telemetry'), { value: 42 })
  t.is(seen.url, 'http://192.0.2.10:80/api/v1/telemetry')
  t.is(seen.opts.headers.Authorization, 'Bearer token-secret')
  t.is(JSON.stringify(await client.request('/telemetry')).includes('token-secret'), false)
})

test('concurrent requests share one login', async (t) => {
  let logins = 0
  const fetchImpl = async (url) => {
    if (url.endsWith('/auth/login')) {
      logins++
      return response(200, { access_token: 'access-1', refresh_token: 'refresh-1' })
    }
    return response(200, { ok: true })
  }
  const client = new ProtoHttpClient({ address: '192.0.2.10', password: 'secret', fetchImpl })
  await Promise.all([client.request('/system'), client.request('/network')])
  t.is(logins, 1)
})

test('explicit 401 refreshes and retries exactly once', async (t) => {
  const calls = []
  const fetchImpl = async (url, opts) => {
    calls.push([url, opts.headers.Authorization])
    if (url.endsWith('/auth/refresh')) return response(200, { access_token: 'access-2' })
    if (opts.headers.Authorization === 'Bearer access-1') return response(401, { error: 'expired' })
    return response(200, { ok: true })
  }
  const client = new ProtoHttpClient({
    address: '192.0.2.10',
    password: 'secret',
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
    fetchImpl
  })
  t.alike(await client.request('/system'), { ok: true })
  t.is(calls.filter(([url]) => url.endsWith('/system')).length, 2)
})

test('a 401 on a write replays the identical body exactly once', async (t) => {
  const sends = []
  const fetchImpl = async (url, opts) => {
    if (url.endsWith('/auth/refresh')) return response(200, { access_token: 'access-2' })
    sends.push({ authorization: opts.headers.Authorization, body: opts.body })
    if (opts.headers.Authorization === 'Bearer access-1') return response(401, { error: 'expired' })
    return response(200, { accepted: true })
  }
  const client = new ProtoHttpClient({
    address: '192.0.2.10',
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
    fetchImpl
  })
  const body = { power_target_watts: 2800 }
  t.alike(await client.request('/mining/target', { method: 'POST', body }), { accepted: true })
  t.is(sends.length, 2)
  t.is(sends[0].body, sends[1].body)
  t.alike(JSON.parse(sends[1].body), body)
  t.is(sends[0].authorization, 'Bearer access-1')
  t.is(sends[1].authorization, 'Bearer access-2')
})

test('a 401 with no renewal path preserves the configured access token', async (t) => {
  let calls = 0
  const client = new ProtoHttpClient({
    address: '192.0.2.10',
    accessToken: 'access-only',
    fetchImpl: async () => {
      calls++
      return response(401, { error: 'expired' })
    }
  })
  await t.exception(client.request('/system'), /ERR_AUTHENTICATION_FAILED/)
  t.is(client.accessToken, 'access-only')
  t.is(calls, 1)
})

test('unreachable devices keep their transport error through authentication', async (t) => {
  const timedOut = new ProtoHttpClient({
    address: '192.0.2.10',
    password: 'password-secret',
    timeout: 5,
    fetchImpl: async (_url, opts) => new Promise((_resolve, reject) => {
      opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
    })
  })
  await t.exception(timedOut.request('/system'), /ERR_REQUEST_TIMEOUT/)

  const unreachable = new ProtoHttpClient({
    address: '192.0.2.10',
    password: 'password-secret',
    fetchImpl: async () => { throw new Error('ECONNREFUSED 192.0.2.10:80') }
  })
  await t.exception(unreachable.request('/system'), /ERR_DEVICE_CONNECTION/)

  let attempts = 0
  const refreshUnreachable = new ProtoHttpClient({
    address: '192.0.2.10',
    password: 'password-secret',
    refreshToken: 'refresh-1',
    fetchImpl: async () => {
      attempts++
      throw new Error('ECONNREFUSED 192.0.2.10:80')
    }
  })
  await t.exception(refreshUnreachable.request('/system'), /ERR_DEVICE_CONNECTION/)
  t.is(attempts, 1)
})

test('simultaneous 401 responses share one refresh', async (t) => {
  let refreshes = 0
  const fetchImpl = async (url, opts) => {
    if (url.endsWith('/auth/refresh')) {
      refreshes++
      return response(200, { access_token: 'access-2' })
    }
    if (opts.headers.Authorization === 'Bearer access-1') return response(401, { error: 'expired' })
    return response(200, { ok: true })
  }
  const client = new ProtoHttpClient({
    address: '192.0.2.10',
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
    fetchImpl
  })
  t.alike(await Promise.all([client.request('/system'), client.request('/network')]), [{ ok: true }, { ok: true }])
  t.is(refreshes, 1)
})

test('non-401 HTTP failures are not retried', async (t) => {
  let calls = 0
  const client = new ProtoHttpClient({
    address: '192.0.2.10',
    accessToken: 'access',
    fetchImpl: async () => {
      calls++
      return response(503, { error: 'upstream detail' })
    }
  })
  await t.exception(client.request('/system'), /ERR_HTTP_RESPONSE: 503/)
  t.is(calls, 1)
})

test('timeout and malformed JSON produce stable errors', async (t) => {
  const timeoutClient = new ProtoHttpClient({
    address: '192.0.2.10',
    accessToken: 'access',
    timeout: 5,
    fetchImpl: async (_url, opts) => new Promise((_resolve, reject) => {
      opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
    })
  })
  await t.exception(timeoutClient.request('/system'), /ERR_REQUEST_TIMEOUT/)

  const malformedClient = new ProtoHttpClient({
    address: '192.0.2.10',
    accessToken: 'access',
    fetchImpl: async () => ({ status: 200, ok: true, text: async () => '{not-json' })
  })
  await t.exception(malformedClient.request('/system'), /ERR_RESPONSE_INVALID_JSON/)
})

test('headers-then-stalled body uses request timeout', async (t) => {
  const client = new ProtoHttpClient({
    address: '192.0.2.10',
    accessToken: 'access',
    timeout: 5,
    fetchImpl: async (_url, opts) => ({
      status: 200,
      ok: true,
      text: async () => new Promise((_resolve, reject) => {
        opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
        setTimeout(() => reject(new Error('body did not abort')), 25)
      })
    })
  })
  await t.exception(client.request('/system'), /ERR_REQUEST_TIMEOUT/)
})

test('body read failures use stable redacted errors', async (t) => {
  const client = new ProtoHttpClient({
    address: '192.0.2.10',
    accessToken: 'token-secret',
    fetchImpl: async () => ({
      status: 200,
      ok: true,
      text: async () => { throw new Error('ERR_STREAM token-secret upstream detail') }
    })
  })
  let bodyError
  await t.exception(client.request('/system').catch((err) => {
    bodyError = err
    throw err
  }), /ERR_DEVICE_CONNECTION/)
  t.is(bodyError.message.includes('token-secret'), false)
  t.is(bodyError.message.includes('upstream detail'), false)
})

test('authentication success payloads require non-empty string tokens', async (t) => {
  const payloads = [
    { access_token: '' },
    { access_token: 'access', refresh_token: 1 }
  ]
  for (const payload of payloads) {
    const client = new ProtoHttpClient({
      address: '192.0.2.10',
      password: 'password-secret',
      fetchImpl: async () => response(200, payload)
    })
    await t.exception(client.request('/system'), /ERR_AUTHENTICATION_RESPONSE_INVALID/)
  }
})

test('authentication and HTTP failures use stable redacted errors', async (t) => {
  const rejected = new ProtoHttpClient({
    address: '192.0.2.10',
    password: 'password-secret',
    fetchImpl: async () => response(401, { error: 'token-secret' })
  })
  let authError
  await t.exception(rejected.request('/system').catch((err) => {
    authError = err
    throw err
  }), /ERR_AUTHENTICATION_FAILED/)
  t.is(authError.message.includes('password-secret'), false)
  t.is(authError.message.includes('token-secret'), false)

  const unavailable = new ProtoHttpClient({
    address: '192.0.2.10',
    accessToken: 'token-secret',
    fetchImpl: async () => response(503, { error: 'upstream detail' })
  })
  let httpError
  await t.exception(unavailable.request('/system').catch((err) => {
    httpError = err
    throw err
  }), /ERR_HTTP_RESPONSE: 503/)
  t.is(httpError.message.includes('token-secret'), false)
  t.is(httpError.message.includes('upstream detail'), false)
})
