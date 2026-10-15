'use strict'

const test = require('brittle')
const { ApiV1 } = require('../../lib/api-v1')
const { ProtoHttpClient } = require('../../lib/http-client')

function response (status, text = '') {
  return { status, ok: status >= 200 && status < 300, text: async () => text }
}

const history = {
  'hashrate-data': {
    duration: '1h',
    data: [{ datetime: 1704067200, value: 95.5 }, { datetime: 1704067260, value: null }],
    aggregates: { min: null, avg: 95.5, max: 95.5 }
  }
}

const logs = { logs: { source: 'miner_sw', lines: 2, content: ['started', 'mining'] } }
const psus = { 'psus-info': [{ psu_sn: 'PSU-1', slot: 2, power: { input_power_mw: 386800 } }] }

test('diagnostic reads return validated raw envelopes and documented query defaults', async (t) => {
  const calls = []
  const api = new ApiV1({
    request: async (path) => {
      calls.push(path)
      if (path === '/hardware/psus') return psus
      if (path.startsWith('/hashrate?')) return history
      return logs
    }
  })
  t.alike(await api.getPowerSupplies(), psus)
  t.alike(await api.getHashrateHistory(), history)
  t.alike(await api.getLogs(), logs)
  await api.getHashrateHistory('5d')
  await api.getLogs('miner_web_server', 10000)
  t.alike(calls, [
    '/hardware/psus', '/hashrate?duration=1h', '/system/logs?source=miner_sw&lines=100',
    '/hashrate?duration=5d', '/system/logs?source=miner_web_server&lines=10000'
  ])
  const optional = { 'hashrate-data': { duration: '1h', data: [] } }
  t.alike(await new ApiV1({ request: async () => optional }).getHashrateHistory(), optional, 'history aggregates may be absent')
})

test('diagnostic reads reject malformed successful responses', async (t) => {
  const cases = [
    ['getPowerSupplies', [null, {}, { 'psus-info': {} }, { 'psus-info': [null] }], 'ERR_PSUS_RESPONSE_INVALID'],
    ['getHashrateHistory', [null, {}, { 'hashrate-data': [] }, { 'hashrate-data': { duration: '1h', data: [null], aggregates: {} } }, { 'hashrate-data': { duration: '1h', data: [], aggregates: null } }, { 'hashrate-data': { duration: '1h', data: [], aggregates: [] } }], 'ERR_HASHRATE_RESPONSE_INVALID'],
    ['getLogs', [null, {}, { logs: [] }, { logs: { ...logs.logs, content: [1] } }, { logs: { ...logs.logs, lines: '2' } }], 'ERR_LOGS_RESPONSE_INVALID']
  ]
  for (const [method, payloads, message] of cases) {
    for (const payload of payloads) {
      const api = new ApiV1({ request: async () => payload })
      await t.exception(api[method](), { message })
    }
  }
})

test('network write wraps configuration and firmware writes declare one-attempt transport options', async (t) => {
  const calls = []
  const api = new ApiV1({ request: async (path, options) => { calls.push([path, options]); return { status: 202, data: null } } })
  const network = { dhcp: false, ip: '192.0.2.4', netmask: '255.255.255.0', hostname: 'miner' }
  await api.setNetwork(network)
  t.alike(calls[0], ['/network', { method: 'PUT', body: { 'network-config': network } }])
  t.alike(await api.startFirmwareUpdate(), { status: 202, data: null })
  t.alike(calls[1], ['/system/update', { method: 'POST', includeStatus: true, retryAuth: false, freshAuth: true, responseType: 'none' }])
  const bytes = Buffer.from([0, 255, 128, 13, 10, 65])
  await api.uploadFirmware(bytes, 'release.swu')
  const [path, options] = calls[2]
  t.is(path, '/system/update')
  t.is(options.method, 'PUT')
  t.is(options.includeStatus, true)
  t.is(options.retryAuth, false)
  t.is(options.freshAuth, true)
  t.is(options.responseType, 'none')
  t.is(options.timeout, 1800000)
  t.ok(options.body instanceof FormData)
  t.is([...options.body.keys()].join(','), 'file')
  const file = options.body.get('file')
  t.is(file.name, 'release.swu')
  t.is(file.type, 'application/octet-stream')
  t.alike(Buffer.from(await file.arrayBuffer()), bytes)
})

test('firmware accepts plain response bodies and avoids authentication replay', async (t) => {
  const statuses = [200, 202, 401, 409, 500]
  for (const status of statuses) {
    const calls = []
    const http = new ProtoHttpClient({ address: '192.0.2.10', accessToken: 'token-only', fetchImpl: async (url, options) => { calls.push([url, options]); return response(status, 'password=private firmware result') } })
    const api = new ApiV1(http)
    if (status < 300) t.alike(await api.startFirmwareUpdate(), { status, data: null })
    else await t.exception(api.startFirmwareUpdate(), { message: status === 401 ? 'ERR_AUTHENTICATION_FAILED' : `ERR_HTTP_RESPONSE: ${status}` })
    t.is(calls.length, 1)
    t.is(http.accessToken, 'token-only')
    t.is(calls[0][1].redirect, 'error')
  }
})

test('fresh authentication renews before firmware and never renews after its rejection', async (t) => {
  const calls = []
  const http = new ProtoHttpClient({
    address: '192.0.2.10',
    accessToken: 'old-access',
    refreshToken: 'refresh-secret',
    password: 'password-secret',
    fetchImpl: async (url, options) => {
      calls.push({ path: new URL(url).pathname, token: options.headers.Authorization, body: options.body })
      if (url.endsWith('/auth/refresh')) return response(200, JSON.stringify({ access_token: 'new-access' }))
      return response(401, 'token=private')
    }
  })
  await t.exception(new ApiV1(http).startFirmwareUpdate(), { message: 'ERR_AUTHENTICATION_FAILED' })
  t.alike(calls.map(call => call.path), ['/api/v1/auth/refresh', '/api/v1/system/update'])
  t.is(calls[1].token, 'Bearer new-access')
})

test('fresh password authentication can fall back only after explicit credential rejection', async (t) => {
  const calls = []
  const http = new ProtoHttpClient({
    address: '192.0.2.10',
    accessToken: 'old-access',
    refreshToken: 'refresh-secret',
    password: 'password-secret',
    fetchImpl: async (url) => {
      calls.push(new URL(url).pathname)
      if (url.endsWith('/auth/refresh')) return response(403, '{}')
      if (url.endsWith('/auth/login')) return response(200, JSON.stringify({ access_token: 'new-access' }))
      return response(202)
    }
  })
  t.alike(await new ApiV1(http).startFirmwareUpdate(), { status: 202, data: null })
  t.alike(calls, ['/api/v1/auth/refresh', '/api/v1/auth/login', '/api/v1/system/update'])
})

test('request timeout override is validated before any authentication or request I/O', async (t) => {
  let calls = 0
  const http = new ProtoHttpClient({ address: '192.0.2.10', password: 'secret', fetchImpl: async () => { calls++; return response(200, '{}') } })
  for (const timeout of [0, -1, 1.5, NaN, Infinity, 2147483648, '10', null]) {
    await t.exception(http.request('/system/update', { timeout }), { message: 'ERR_REQUEST_TIMEOUT_INVALID' })
  }
  t.is(calls, 0)
})

test('firmware timeout and ambiguous transport failures never replay or expose secrets', async (t) => {
  for (const failAt of ['send', 'body', 'timeout']) {
    let calls = 0
    const http = new ProtoHttpClient({
      address: '192.0.2.10',
      accessToken: 'token-secret',
      fetchImpl: async (_url, options) => {
        calls++
        if (failAt === 'send') throw new Error('token-secret ambiguous send')
        if (failAt === 'body') return { status: 200, ok: true, text: async () => { throw new Error('token-secret ambiguous body') } }
        return { status: 200, ok: true, text: async () => new Promise((_resolve, reject) => { options.signal.addEventListener('abort', () => reject(Object.assign(new Error('token-secret timeout'), { name: 'AbortError' }))) }) }
      }
    })
    await t.exception(http.request('/system/update', { method: 'PUT', body: new FormData(), responseType: 'none', retryAuth: false, timeout: 5 }), { message: failAt === 'timeout' ? 'ERR_REQUEST_TIMEOUT' : 'ERR_DEVICE_CONNECTION' })
    t.is(calls, 1)
  }
})

test('multipart transport leaves content type to fetch and preserves the form instance', async (t) => {
  const form = new FormData()
  form.append('file', new Blob([Buffer.from([0, 128, 255])], { type: 'application/octet-stream' }), 'release.swu')
  let sent
  const http = new ProtoHttpClient({ address: '192.0.2.10', accessToken: 'token', fetchImpl: async (_url, options) => { sent = options; return response(200, 'accepted') } })
  t.alike(await http.request('/system/update', { body: form, method: 'PUT', retryAuth: false, responseType: 'none', includeStatus: true }), { status: 200, data: null })
  t.is(sent.body, form)
  t.is(sent.headers['Content-Type'], undefined)
})
