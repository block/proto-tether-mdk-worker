'use strict'

const { createHash } = require('node:crypto')
const http = require('node:http')
const test = require('brittle')
const { createServer } = require('../../mock/server')
const { ProtoHttpClient } = require('../../lib/http-client')
const { ApiV1 } = require('../../lib/api-v1')
const { ProtoRigClient } = require('../../lib/proto-rig-client')

async function fixture (t, opts = {}) {
  const mock = createServer(opts)
  const address = await mock.ready
  t.teardown(() => mock.close())
  const base = `http://127.0.0.1:${address.port}/api/v1`
  const request = (path, options = {}) => fetch(`${base}${path}`, {
    ...options,
    headers: { authorization: 'Bearer mock-access-1', ...options.headers }
  })
  return { mock, request }
}

function jsonOptions (method, body) {
  return { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
}

function firmware (bytes, filename = 'fixture.swu') {
  const form = new FormData()
  form.append('file', new Blob([bytes], { type: 'application/octet-stream' }), filename)
  return { method: 'PUT', body: form }
}

test('mock diagnostics expose spec fan fields and optional pool counters without changing legacy defaults', async t => {
  const { mock, request } = await fixture(t)
  const cooling = await (await request('/cooling')).json()
  t.alike(cooling['cooling-status'].fans, [
    { slot: 1, rpm: 5000, percentage: 55 },
    { slot: 2, rpm: 5100, percentage: 55 }
  ])
  const original = await (await request('/pools')).json()
  t.is(Object.hasOwn(original.pools[0], 'invalid'), false)
  t.is(Object.hasOwn(original.pools[0], 'duplicate'), false)
  Object.assign(mock.state.pools[0], { invalid: 2, duplicate: 3 })
  const withCounters = await (await request('/pools')).json()
  t.is(withCounters.pools[0].invalid, 2)
  t.is(withCounters.pools[0].duplicate, 3)
})

test('mock PSU fixture preserves PsuInfo field names and milliunits', async t => {
  const { request } = await fixture(t)
  const response = await request('/hardware/psus')
  t.is(response.status, 200)
  t.alike(await response.json(), {
    'psus-info': [{
      psu_sn: 'MOCK-PSU-001',
      slot: 1,
      manufacturer: 'Simulator',
      hw_revision: 'mock-1',
      model: 'Mock PSU',
      vendor: 'Simulator',
      firmware: { app_version: 'mock-1', bootloader_version: 'mock-1' },
      power: {
        input_voltage_mv: 240000,
        output_voltage_mv: 12100,
        input_current_ma: 14000,
        output_current_ma: 260000,
        input_power_mw: 3250000,
        output_power_mw: 3146000
      },
      temperatures: [{ temperature_type: 'hotspot', temperature_c: 48 }]
    }]
  })
})

test('mock hashrate history wraps the fixture, echoes supported durations and preserves null gaps', async t => {
  const { mock, request } = await fixture(t)
  for (const duration of ['1h', '12h', '24h', '48h', '5d']) {
    const response = await request(`/hashrate?duration=${duration}`)
    t.is(response.status, 200)
    const data = (await response.json())['hashrate-data']
    t.is(data.duration, duration)
    t.alike(data.data, mock.state.hashrateHistory.data)
    t.is(data.data[1].value, null)
    t.alike(data.aggregates, { min: 94, avg: 95, max: 96 })
  }
  t.is((await (await request('/hashrate')).json())['hashrate-data'].duration, '1h')
  t.is((await request('/hashrate?duration=2h')).status, 400)
  mock.state.hashrateHistory = { data: [], aggregates: { min: null, avg: null, max: null } }
  t.alike(await (await request('/hashrate')).json(), {
    'hashrate-data': { duration: '1h', data: [], aggregates: { min: null, avg: null, max: null } }
  })
})

test('default mock history is readable through the real client for every supported duration', async t => {
  const { mock } = await fixture(t)
  const { port } = await mock.ready
  const api = new ApiV1(new ProtoHttpClient({
    address: '127.0.0.1',
    port,
    accessToken: 'mock-access-1'
  }))
  const client = new ProtoRigClient({ id: 'mock-rig', api, cacheMs: 0 })

  for (const duration of ['1h', '12h', '24h', '48h', '5d']) {
    t.alike(await client.getHashrateHistory({ duration }), {
      duration,
      data: [
        { datetime: 1767225600, value: 94 },
        { datetime: 1767225660, value: null },
        { datetime: 1767225720, value: 96 }
      ],
      aggregates: { min: 94, avg: 95, max: 96 }
    })
  }
  mock.state.hashrateHistory = { data: [], aggregates: { min: null, avg: null, max: null } }
  for (const duration of ['1h', '12h', '24h', '48h', '5d']) {
    t.alike(await client.getHashrateHistory({ duration }), {
      duration,
      data: [],
      aggregates: { min: null, avg: null, max: null }
    }, 'startup history remains readable through the real HTTP adapter')
  }
})

test('mock log tails use declared sources and actual returned line counts including empty logs', async t => {
  const { mock, request } = await fixture(t)
  for (const source of ['os', 'pool_sw', 'miner_sw', 'miner_web_server']) {
    mock.state.logs[source] = ['first', 'second', 'third']
    const response = await request(`/system/logs?source=${source}&lines=2`)
    t.is(response.status, 200)
    t.alike(await response.json(), { logs: { source, lines: 2, content: ['second', 'third'] } })
  }
  mock.state.logs.miner_sw = []
  t.alike(await (await request('/system/logs')).json(), { logs: { source: 'miner_sw', lines: 0, content: [] } })
  for (const query of ['source=unknown', 'lines=10001', 'lines=-1', 'lines=1.5', 'lines=nope']) {
    t.is((await request(`/system/logs?${query}`)).status, 400)
  }
})

test('mock network PUT accepts the spec envelope and preserves unrelated state', async t => {
  const { mock, request } = await fixture(t)
  const system = structuredClone(mock.state.system)
  const mining = structuredClone(mock.state.mining)
  const pools = structuredClone(mock.state.pools)
  const network = { dhcp: false, ip: '192.0.2.20', netmask: '255.255.255.0', gateway: '192.0.2.1', hostname: 'static-mock' }
  const response = await request('/network', jsonOptions('PUT', { 'network-config': network }))
  t.is(response.status, 200)
  t.alike(await response.json(), { 'network-info': { mac: '02:00:00:00:00:01', ...network } })
  t.alike(await (await request('/network')).json(), { 'network-info': mock.state.network })
  t.alike(mock.state.system, system)
  t.alike(mock.state.mining, mining)
  t.alike(mock.state.pools, pools)
  t.is(mock.state.writeAttempts['/api/v1/network'], 1)
  t.is((await request('/network', jsonOptions('PUT', { dhcp: true }))).status, 400)
})

test('mock firmware startup is inert and OTA accepts exactly one bodyless POST', async t => {
  const { mock, request } = await fixture(t)
  t.alike(mock.state.updates, [])
  t.is(mock.state.rebooted, false)
  const response = await request('/system/update', { method: 'POST' })
  t.is(response.status, 202)
  t.is(await response.text(), '')
  t.alike(mock.state.updates, [{ mode: 'ota' }])
  t.is(mock.state.writeAttempts['/api/v1/system/update'], 1)
  t.is((await request('/system/update', jsonOptions('POST', {}))).status, 400)
  t.is(mock.state.writeAttempts['/api/v1/system/update'], 2)
})

test('mock multipart firmware preserves binary bytes and records only filename, size and SHA256', async t => {
  const { mock, request } = await fixture(t)
  const bytes = Buffer.from([0, 255, 254, 13, 10, 1, 128, 13, 10, 0])
  const response = await request('/system/update', firmware(bytes))
  const expected = { mode: 'upload', filename: 'fixture.swu', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
  t.is(response.status, 200)
  t.is(await response.text(), '')
  t.alike(mock.state.updates, [expected])
  t.alike(mock.state.requests.at(-1).body, { file: { filename: expected.filename, size: expected.size, sha256: expected.sha256 } })
  t.is(mock.state.requests.at(-1).authorization, null)
  t.is(JSON.stringify(mock.state.updates).includes('mock-access'), false)
  t.is(mock.state.writeAttempts['/api/v1/system/update'], 1)
})

test('mock multipart parser distinguishes embedded CRLF and boundary prefixes from delimiters', async t => {
  const { mock, request } = await fixture(t)
  const boundary = 'mock-upload-boundary'
  const bytes = Buffer.concat([Buffer.from([255, 0]), Buffer.from(`\r\n--${boundary}X\r\ncontent\r\n`), Buffer.from([254, 128])])
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="binary.swu"\r\nContent-Type: application/octet-stream\r\n\r\n`),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ])
  const response = await request('/system/update', {
    method: 'PUT', headers: { 'content-type': `multipart/form-data; boundary="${boundary}"` }, body
  })
  t.is(response.status, 200)
  t.is(mock.state.updates[0].size, bytes.length)
  t.is(mock.state.updates[0].sha256, createHash('sha256').update(bytes).digest('hex'))
})

test('mock update failures count one attempt and never accept an update', async t => {
  const unauthorized = await fixture(t)
  t.is((await unauthorized.request('/system/update', { method: 'POST', headers: { authorization: 'Bearer revoked-secret' } })).status, 401)
  t.is(unauthorized.mock.state.writeAttempts['/api/v1/system/update'], 1)
  t.alike(unauthorized.mock.state.updates, [])
  const failed = await fixture(t, { statusByPath: { '/api/v1/system/update': 409 } })
  t.is((await failed.request('/system/update', { method: 'POST' })).status, 409)
  t.is(failed.mock.state.writeAttempts['/api/v1/system/update'], 1)
  t.alike(failed.mock.state.updates, [])
  const disconnected = await fixture(t, { disconnectPaths: ['/api/v1/system/update'] })
  await t.exception.all(disconnected.request('/system/update', firmware(Buffer.from('upload'))), /fetch failed/)
  t.is(disconnected.mock.state.writeAttempts['/api/v1/system/update'], 1)
  t.alike(disconnected.mock.state.updates, [])
})

test('mock rejects missing, duplicate, non-SWU and malformed multipart files', async t => {
  const { mock, request } = await fixture(t)
  t.is((await request('/system/update', jsonOptions('PUT', { file: 'not binary' }))).status, 400)
  t.is((await request('/system/update', firmware(Buffer.from('upload'), '../unsafe.swu'))).status, 400)
  t.is((await request('/system/update', firmware(Buffer.from('upload'), 'wrong.txt'))).status, 400)
  const empty = new FormData()
  empty.append('other', 'value')
  t.is((await request('/system/update', { method: 'PUT', body: empty })).status, 400)
  const duplicate = new FormData()
  duplicate.append('file', new Blob(['a']), 'one.swu')
  duplicate.append('file', new Blob(['b']), 'two.swu')
  t.is((await request('/system/update', { method: 'PUT', body: duplicate })).status, 400)
  t.is((await request('/system/update', { method: 'PUT', headers: { 'content-type': 'multipart/form-data; boundary=broken' }, body: '--broken' })).status, 400)
  t.alike(mock.state.updates, [])
})

test('mock rejects declared oversized bodies without buffering firmware or accepting an update', async t => {
  const mock = createServer()
  const address = await mock.ready
  t.teardown(() => mock.close())
  const response = await new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: address.port,
      path: '/api/v1/system/update',
      method: 'PUT',
      headers: {
        authorization: 'Bearer mock-access-1',
        'content-type': 'multipart/form-data; boundary=oversized',
        'content-length': 512 * 1024 * 1024 + 1024 * 1024 + 1
      }
    }, res => {
      res.resume()
      res.on('end', () => {
        req.destroy()
        resolve(res)
      })
      res.on('error', reject)
    })
    req.on('error', reject)
    req.end()
  })
  t.is(response.statusCode, 413)
  t.is(mock.state.writeAttempts['/api/v1/system/update'], 1)
  t.alike(mock.state.updates, [])
})
