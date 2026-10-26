'use strict'

const test = require('brittle')
const http = require('node:http')
const { createControlPlane } = require('../../tools/control-plane/server')

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
  const server = createControlPlane({ client })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.teardown(async () => {
    await new Promise(resolve => server.close(resolve))
  })
  const base = `http://127.0.0.1:${server.address().port}`
  const page = await fetch(base)
  t.is(page.status, 200)
  t.ok((await page.text()).includes('Proto control plane'))
  await fetch(`${base}/api/telemetry/asic_stats`)
  t.alike(seen.at(-1), { deviceId: 'proto-r2-1', type: 'asic_stats' })
  await fetch(`${base}/api/capabilities`)
  t.is(seen.at(-1), 'capabilities')
  t.is((await (await fetch(`${base}/api/identity`)).json()).workerId, 'proto-worker')
  const body = { command: 'setPerformanceMode', params: { mode: 'Efficiency' } }
  const command = await fetch(`${base}/api/command`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify(body) })
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
  t.is((await fetch(`${base}/api/command`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://another.example' }, body: JSON.stringify(body) })).status, 403)
  t.is((await fetch(`${base}/api/command`, { method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' }, body: JSON.stringify(body) })).status, 403)
  t.is((await fetch(`${base}/api/command`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify(body) })).status, 415)
  t.is((await fetch(`${base}/api/unknown`)).status, 404)
  t.is(seen.length, before, 'invalid routes and cross-origin writes never reach the worker')
})
