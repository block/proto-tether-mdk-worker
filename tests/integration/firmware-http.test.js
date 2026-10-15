'use strict'

const http = require('http')
const test = require('brittle')
const { ApiV1 } = require('../../lib/api-v1')
const { ProtoHttpClient } = require('../../lib/http-client')

async function fixture (t, handler, options = {}) {
  const server = http.createServer(handler)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  t.teardown(() => {
    server.closeAllConnections()
    return new Promise(resolve => server.close(resolve))
  })
  const client = new ProtoHttpClient({
    address: '127.0.0.1',
    port: server.address().port,
    accessToken: 'token-secret',
    ...options,
    fetchImpl: globalThis.fetch
  })
  return { api: new ApiV1(client), client }
}

async function readBody (req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return Buffer.concat(chunks)
}

const firmwareBytes = Buffer.from([0, 255, 128, 13, 10, 1, 65, 195, 40])

function update (api, mode) {
  return mode === 'upload' ? api.uploadFirmware(firmwareBytes, 'release.swu') : api.startFirmwareUpdate()
}

test('native fetch uploads exact binary multipart bytes and accepts a plain 200 response', async (t) => {
  let received
  const { api } = await fixture(t, async (req, res) => {
    const body = await readBody(req)
    received = { method: req.method, path: req.url, headers: req.headers, body }
    // The upload override must outlast the client's ordinary short deadline.
    setTimeout(() => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('firmware accepted') }, 30)
  }, { timeout: 15 })
  t.alike(await api.uploadFirmware(firmwareBytes, 'release.swu'), { status: 200, data: null })
  t.is(received.method, 'PUT')
  t.is(received.path, '/api/v1/system/update')
  t.is(received.headers.authorization, 'Bearer token-secret')
  const boundary = /^multipart\/form-data; boundary=(.+)$/.exec(received.headers['content-type'])
  t.ok(boundary, 'native fetch generates the multipart boundary')
  const expected = Buffer.concat([
    Buffer.from(`--${boundary[1]}\r\nContent-Disposition: form-data; name="file"; filename="release.swu"\r\nContent-Type: application/octet-stream\r\n\r\n`),
    firmwareBytes,
    Buffer.from(`\r\n--${boundary[1]}--\r\n`)
  ])
  t.alike(received.body, expected, 'the file field carries the original bytes without JSON or text conversion')
})

test('native fetch sends a bodyless OTA request and accepts an empty 202 response', async (t) => {
  let received
  const { api } = await fixture(t, async (req, res) => {
    received = { method: req.method, path: req.url, body: await readBody(req), contentType: req.headers['content-type'] }
    res.writeHead(202)
    res.end()
  })
  t.alike(await api.startFirmwareUpdate(), { status: 202, data: null })
  t.alike(received, { method: 'POST', path: '/api/v1/system/update', body: Buffer.alloc(0), contentType: undefined })
})

for (const mode of ['ota', 'upload']) {
  test(`native ${mode} update renews first and sends only one firmware request after 401`, async (t) => {
    const paths = []
    let authorization
    const { api } = await fixture(t, async (req, res) => {
      paths.push(req.url)
      await readBody(req)
      if (req.url === '/api/v1/auth/refresh') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ access_token: 'fresh-token' }))
        return
      }
      authorization = req.headers.authorization
      res.writeHead(401, { 'content-type': 'text/plain' })
      res.end('password=password-secret token=token-secret')
    }, { refreshToken: 'refresh-secret', password: 'password-secret' })
    await t.exception(update(api, mode), { message: 'ERR_AUTHENTICATION_FAILED' })
    t.alike(paths, ['/api/v1/auth/refresh', '/api/v1/system/update'])
    t.is(authorization, 'Bearer fresh-token')
  })

  for (const status of [302, 303, 307, 308]) {
    test(`native ${mode} update rejects ${status} redirects without a second request`, async (t) => {
      const requests = []
      const { api } = await fixture(t, async (req, res) => {
        requests.push({ method: req.method, path: req.url })
        await readBody(req)
        if (req.url === '/redirected') { res.end('unexpected redirect'); return }
        res.writeHead(status, { location: '/redirected' })
        res.end()
      })
      await t.exception(update(api, mode), { message: 'ERR_DEVICE_CONNECTION' })
      t.alike(requests, [{ method: mode === 'upload' ? 'PUT' : 'POST', path: '/api/v1/system/update' }])
    })
  }

  test(`native ${mode} update preserves HTTP failure codes and makes one attempt`, async (t) => {
    let attempts = 0
    const { api } = await fixture(t, async (req, res) => {
      attempts++
      await readBody(req)
      res.writeHead(409, { 'content-type': 'text/plain' })
      res.end('private-secret update already running')
    })
    await t.exception(update(api, mode), { message: 'ERR_HTTP_RESPONSE: 409' })
    t.is(attempts, 1)
  })

  test(`native ${mode} update does not replay an ambiguous socket failure`, async (t) => {
    let attempts = 0
    const { api } = await fixture(t, async (req) => {
      attempts++
      await readBody(req)
      req.socket.destroy()
    })
    await t.exception(update(api, mode), { message: 'ERR_DEVICE_CONNECTION' })
    t.is(attempts, 1)
  })
}

test('native response-body timeout uses the override and does not replay the upload', async (t) => {
  let attempts = 0
  const { client } = await fixture(t, async (req, res) => {
    attempts++
    await readBody(req)
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.write('accepted headers, body still pending')
  })
  const body = new FormData()
  body.append('file', new Blob([firmwareBytes], { type: 'application/octet-stream' }), 'release.swu')
  await t.exception(client.request('/system/update', { method: 'PUT', body, responseType: 'none', retryAuth: false, timeout: 100 }), { message: 'ERR_REQUEST_TIMEOUT' })
  t.is(attempts, 1)
})

test('native JSON network write preserves the existing JSON transport behavior', async (t) => {
  let received
  const { api } = await fixture(t, async (req, res) => {
    received = { method: req.method, path: req.url, type: req.headers['content-type'], body: JSON.parse((await readBody(req)).toString()) }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ 'network-info': { dhcp: true, hostname: 'miner' } }))
  })
  t.alike(await api.setNetwork({ dhcp: true, hostname: 'miner' }), { 'network-info': { dhcp: true, hostname: 'miner' } })
  t.alike(received, { method: 'PUT', path: '/api/v1/network', type: 'application/json', body: { 'network-config': { dhcp: true, hostname: 'miner' } } })
})
