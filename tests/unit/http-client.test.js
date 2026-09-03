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
