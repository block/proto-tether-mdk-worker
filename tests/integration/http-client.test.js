'use strict'

const http = require('http')
const test = require('brittle')
const { ProtoHttpClient } = require('../../lib/http-client')

test('request sends bearer auth over a real http server', async (t) => {
  const server = http.createServer((req, res) => {
    t.is(req.method, 'GET')
    t.is(req.url, '/api/v1/status')
    t.is(req.headers.authorization, 'Bearer token-secret')
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ ok: true }))
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.teardown(() => server.close())

  const { port } = server.address()
  const client = new ProtoHttpClient({
    address: '127.0.0.1',
    accessToken: 'token-secret',
    port,
    fetchImpl: globalThis.fetch
  })

  t.alike(await client.request('/status'), { ok: true })
})
