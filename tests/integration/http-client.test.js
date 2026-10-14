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

const redirectCases = [
  ...[302, 303, 307, 308].map(status => ({
    name: `POST write rejects ${status} redirects without replaying or converting the request`,
    status,
    credentials: { accessToken: 'token-secret' },
    path: '/system/reboot',
    options: { method: 'POST', body: { reboot: true } },
    original: { method: 'POST', path: '/api/v1/system/reboot' }
  })),
  {
    name: 'GET read rejects redirects',
    status: 302,
    credentials: { accessToken: 'token-secret' },
    path: '/status',
    original: { method: 'GET', path: '/api/v1/status' }
  },
  {
    name: 'password login rejects redirects without sending a subsequent read',
    status: 307,
    credentials: { password: 'password-secret' },
    path: '/status',
    original: { method: 'POST', path: '/api/v1/auth/login' }
  },
  {
    name: 'token refresh rejects redirects without falling back to password login',
    status: 308,
    credentials: { password: 'password-secret', refreshToken: 'refresh-secret' },
    path: '/status',
    original: { method: 'POST', path: '/api/v1/auth/refresh' }
  }
]

for (const scenario of redirectCases) {
  test(scenario.name, async (t) => {
    const originalRequests = []
    const redirectedRequests = []
    const server = http.createServer((req, res) => {
      if (req.url === '/redirected') {
        redirectedRequests.push({ method: req.method, path: req.url })
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: true, access_token: 'redirected-token' }))
        return
      }

      originalRequests.push({ method: req.method, path: req.url })
      res.writeHead(scenario.status, { location: '/redirected' })
      res.end()
    })

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    t.teardown(() => server.close())

    const client = new ProtoHttpClient({
      address: '127.0.0.1',
      port: server.address().port,
      ...scenario.credentials,
      fetchImpl: globalThis.fetch
    })

    await t.exception(client.request(scenario.path, scenario.options), { message: 'ERR_DEVICE_CONNECTION' })
    t.alike(originalRequests, [scenario.original], 'only the original request is sent once')
    t.alike(redirectedRequests, [], 'the redirect destination receives no request')
  })
}
