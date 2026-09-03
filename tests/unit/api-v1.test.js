'use strict'

const test = require('brittle')
const { ApiV1 } = require('../../lib/api-v1')

function fixture () {
  const calls = []
  const http = {
    request: async (path, opts = {}) => {
      calls.push([path, opts])
      if (path === '/mining') return { 'mining-status': { status: 'Mining' } }
      if (path === '/pools') return { pools: [{ url: 'stratum+tcp://pool:3333' }] }
      if (path === '/errors') return []
      return { ok: true }
    }
  }
  return { api: new ApiV1(http), calls }
}

test('read methods map public API v1 paths and unwrap documented envelopes', async (t) => {
  const { api, calls } = fixture()
  t.alike(await api.getMiningStatus(), { status: 'Mining' })
  t.alike(await api.getPools(), [{ url: 'stratum+tcp://pool:3333' }])
  t.alike(await api.getErrors(), [])
  await api.getTelemetry(['miner', 'hashboard'])
  t.is(calls[3][0], '/telemetry?level=miner%2Chashboard')
})

test('read methods map direct public API v1 paths', async (t) => {
  const { api, calls } = fixture()
  t.alike(await api.getSystemInfo(), { ok: true })
  t.alike(await api.getNetworkInformation(), { ok: true })
  t.alike(await api.getMiningTarget(), { ok: true })
  t.alike(await api.getCooling(), { ok: true })
  t.alike(await api.reboot(), { ok: true })
  t.alike(calls, [
    ['/system', {}],
    ['/network', {}],
    ['/mining/target', {}],
    ['/cooling', {}],
    ['/system/reboot', { method: 'POST' }]
  ])
})

test('write methods use exact methods and bodies', async (t) => {
  const { api, calls } = fixture()
  await api.setPowerTarget(2800)
  await api.setLED(true)
  await api.startMining()
  await api.stopMining()
  await api.setPools([{ url: 'stratum+tcp://pool:3333', username: 'worker', password: 'x', priority: 0 }])
  t.alike(calls, [
    ['/mining/target', { method: 'PUT', body: { power_target_watts: 2800 } }],
    ['/system/locate?enable=true&led_on_time=0', { method: 'POST' }],
    ['/mining/start', { method: 'POST' }],
    ['/mining/stop', { method: 'POST' }],
    ['/pools', { method: 'POST', body: [{ url: 'stratum+tcp://pool:3333', username: 'worker', password: 'x', priority: 0 }] }]
  ])
})
