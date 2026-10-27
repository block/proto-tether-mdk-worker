'use strict'

const test = require('brittle')
const http = require('node:http')
const { createControlPlane } = require('../../tools/control-plane/server')
const ACCESS_TOKEN = 'ab'.repeat(32)

test('local control plane serves its UI and forwards worker reads and commands without replay', async t => {
  t.exception(() => createControlPlane(), /Worker client is required/)
  const seen = []
  const client = {
    endpoint: 'worker:test',
    capabilities: async () => { seen.push('capabilities'); return { capabilities: {} } },
    identity: async () => { seen.push('identity'); return { workerId: 'proto-worker' } },
    telemetry: async (deviceId, type) => { seen.push({ deviceId, type }); return { value: 123 } },
    command: async (deviceId, command, params) => { seen.push({ deviceId, command, params }); return { status: 'FAILED', error: 'ERR_COMMAND_IN_PROGRESS' } }
  }
  const server = createControlPlane({ client, accessToken: ACCESS_TOKEN })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.teardown(async () => {
    await new Promise(resolve => server.close(resolve))
  })
  const base = `http://127.0.0.1:${server.address().port}`
  const api = (route, options = {}) => fetch(`${base}${route}`, { ...options, headers: { 'x-control-token': ACCESS_TOKEN, ...options.headers } })
  const page = await fetch(base)
  t.is(page.status, 200)
  t.ok((await page.text()).includes('Proto development console'))
  t.is((await fetch(`${base}/api/capabilities`)).status, 401, 'API reads require the per-launch token')
  t.is((await fetch(`${base}/api/command`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ command: 'reboot', params: {} }) })).status, 401, 'a local process without Origin or a token cannot command the worker')
  t.is((await fetch(`${base}/api/capabilities`, { headers: { 'x-control-token': 'wrong-token' } })).status, 401)
  t.alike(seen, [], 'unauthenticated requests never reach the trusted client')
  await api('/api/telemetry/asic_stats')
  t.alike(seen.at(-1), { deviceId: 'proto-r2-1', type: 'asic_stats' })
  await api('/api/capabilities')
  t.is(seen.at(-1), 'capabilities')
  t.is((await (await api('/api/identity')).json()).workerId, 'proto-worker')
  const body = { command: 'setPerformanceMode', params: { mode: 'Efficiency' } }
  const command = await api('/api/command', { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify(body) })
  t.is((await command.json()).status, 'FAILED', 'MDK failure is preserved even with HTTP 200')
  t.alike(seen.at(-1), { deviceId: 'proto-r2-1', ...body })
  t.is(seen.filter(request => request.command).length, 1, 'writes are sent once')
  const before = seen.length
  const rejectedHost = await new Promise((resolve, reject) => {
    http.get(`${base}/api/capabilities`, { headers: { host: 'another.example' } }, response => {
      response.resume()
      resolve(response.statusCode)
    }).on('error', reject)
  })
  t.is(rejectedHost, 403)
  t.is((await api('/api/command', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://another.example' }, body: JSON.stringify(body) })).status, 403)
  t.is((await api('/api/command', { method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' }, body: JSON.stringify(body) })).status, 403)
  t.is((await api('/api/command', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify(body) })).status, 415)
  t.is((await api('/api/unknown')).status, 404)
  t.is(seen.length, before, 'invalid routes and cross-origin writes never reach the worker')
  const malformed = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: server.address().port, path: '//' }, response => {
      response.resume()
      resolve(response.statusCode)
    }).on('error', reject)
  })
  t.is(malformed, 400, 'malformed request targets do not crash the async handler')
  t.is((await api('/api/capabilities')).status, 200, 'the server remains usable after a malformed URL')
})

test('console transport failures expose stable outcome codes without replay or raw diagnostics', async t => {
  const { commandResult } = await import('../../tools/control-plane/public/model.mjs')
  let writes = 0
  const failure = Object.assign(new Error('Bearer synthetic-log-secret'), { code: 'ECONNRESET' })
  const client = {
    capabilities: async () => { throw failure },
    command: async () => { writes++; throw failure }
  }
  const diagnostics = []
  const originalError = console.error
  console.error = value => diagnostics.push(value)
  t.teardown(() => { console.error = originalError })
  const server = createControlPlane({ client, accessToken: ACCESS_TOKEN })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.teardown(() => new Promise(resolve => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}`
  const headers = { 'x-control-token': ACCESS_TOKEN, 'content-type': 'application/json' }
  const read = await fetch(`${base}/api/capabilities`, { headers })
  const readBody = await read.json()
  t.is(read.status, 502)
  t.is(readBody.error, 'ERR_CONTROL_WORKER_UNAVAILABLE')
  t.ok(readBody.message.startsWith('Worker unavailable.'))
  const response = await fetch(`${base}/api/command`, { method: 'POST', headers, body: JSON.stringify({ command: 'setLED', params: { enabled: true } }) })
  const body = await response.json()
  t.is(response.status, 502)
  t.is(body.error, 'ERR_CONTROL_COMMAND_OUTCOME_UNKNOWN')
  t.is(commandResult(body, response.status).uncertain, true)
  t.is(writes, 1, 'an unknown command outcome is never replayed')
  t.alike(diagnostics, ['ERR_CONTROL_WORKER_UNAVAILABLE: ECONNRESET', 'ERR_CONTROL_COMMAND_OUTCOME_UNKNOWN: ECONNRESET'])
  failure.code = 'CHANNEL_DESTROYED'
  t.is((await fetch(`${base}/api/capabilities`, { headers })).status, 502)
  t.is(diagnostics.at(-1), 'ERR_CONTROL_WORKER_UNAVAILABLE: CHANNEL_DESTROYED')
  t.is(JSON.stringify({ body, readBody, diagnostics }).includes('synthetic-log-secret'), false)
})
