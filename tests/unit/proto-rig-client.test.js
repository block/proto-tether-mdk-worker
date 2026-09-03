'use strict'

const test = require('brittle')
const { ProtoRigClient } = require('../../lib/proto-rig-client')

function apiFixture (overrides = {}) {
  return {
    getMiningStatus: async () => ({ status: 'Mining', reboot_uptime_s: 521 }),
    getTelemetry: async () => ({
      miner: {
        hashrate: { value: 95.5 },
        temperature: { value: 65.5 },
        power: { value: 3250 },
        efficiency: { value: 34.03 }
      },
      hashboards: [
        { index: 0, temperature: { inlet: 45, outlet: 68, average: 56 } },
        { index: 1, temperature: { inlet: 46, outlet: 70, average: 58 } }
      ]
    }),
    getPools: async () => [{ url: 'stratum+tcp://pool:3333', user: 'worker', password: 'secret', accepted: 10, rejected: 1, stale: 2, status: 'Active' }],
    getErrors: async () => [],
    getMiningTarget: async () => ({ power_target_watts: 3300, power_target_min_watts: 400, power_target_max_watts: 6000, performance_mode: 'MaximumHashrate' }),
    getSystemInfo: async () => ({ 'system-info': { model: 'R2', cb_sn: 'R2-001', os: { version: '1.8.2' } } }),
    getCooling: async () => ({ 'cooling-status': { fan_mode: 'Auto', speed_percentage: 55, fans: [{ rpm: 5000 }, { rpm: 5100 }] } }),
    getNetworkInformation: async () => ({ 'network-info': { dhcp: true, ip: '192.0.2.10', netmask: '255.255.255.0', gateway: '192.0.2.1' } }),
    ...overrides
  }
}

test('telemetry methods normalize public API values', async (t) => {
  const client = new ProtoRigClient({ id: 'R2-001', api: apiFixture(), cacheMs: 0 })
  t.is(await client.getHashrateAvg(), 95.5)
  t.is(await client.getPower(), 3250)
  t.is(await client.getTemperature(), 65.5)
  t.is(await client.getEfficiency(), 34.03)
  t.is(await client.getStatus(), 'mining')
  t.is(await client.getUptime(), 521000)
  t.is(await client.getAcceptedShares(), 10)
  t.is(await client.getRejectedShares(), 1)
  t.is(await client.getPowerMode(), 'normal')
  t.is(await client.getPowerTarget(), 3300)
  t.is(await client.getFanSpeed(), 5050)
})

test('snapshot uses the common miner shape and omits secrets', async (t) => {
  const client = new ProtoRigClient({ id: 'R2-001', api: apiFixture(), cacheMs: 0 })
  const snap = await client.getSnap()
  t.is(snap.stats.status, 'mining')
  t.is(snap.stats.hashrate_mhs.avg, 95500000)
  t.is(snap.stats.power_w, 3250)
  t.is(snap.stats.temperature_c.max, 70)
  t.is(snap.config.power_mode, 'normal')
  t.is(snap.config.network_config.ip_address, '192.0.2.10')
  t.is(snap.config.model, 'R2')
  t.is(JSON.stringify(snap).includes('password'), false)
  t.is(JSON.stringify(snap).includes('token'), false)
  t.is(JSON.stringify(snap).includes('secret'), false)
})

test('mining states and active firmware errors map to MDK status', async (t) => {
  const cases = [
    ['Mining', [], 'mining'],
    ['Stopped', [], 'sleeping'],
    ['Curtailed', [], 'sleeping'],
    ['DegradedMining', [], 'error'],
    ['NoPools', [], 'error'],
    ['Error', [], 'error'],
    ['Mining', [{ error_code: 'FanSlow' }], 'error']
  ]
  for (const [status, errors, expected] of cases) {
    const client = new ProtoRigClient({
      id: 'R2-001',
      api: apiFixture({ getMiningStatus: async () => ({ status }), getErrors: async () => errors }),
      cacheMs: 0
    })
    t.is(await client.getStatus(), expected, `${status} with ${errors.length} errors`)
  }
})

test('concurrent telemetry reads share one in-flight request', async (t) => {
  let calls = 0
  let release
  const pending = new Promise(resolve => { release = resolve })
  const api = apiFixture({
    getTelemetry: async () => {
      calls++
      await pending
      return { miner: { hashrate: { value: 95.5 }, power: { value: 3250 } } }
    }
  })
  const client = new ProtoRigClient({ id: 'R2-001', api, cacheMs: 100 })
  const hashrate = client.getHashrateAvg()
  const power = client.getPower()
  release()
  t.alike(await Promise.all([hashrate, power]), [95.5, 3250])
  t.is(calls, 1)
})

test('rejected reads are evicted so later reads can retry', async (t) => {
  let calls = 0
  const api = apiFixture({
    getTelemetry: async () => {
      calls++
      if (calls === 1) throw new Error('telemetry down')
      return { miner: { power: { value: 3100 } } }
    }
  })
  const client = new ProtoRigClient({ id: 'R2-001', api, cacheMs: 1000 })
  await t.exception(client.getPower(), /telemetry down/)
  t.is(await client.getPower(), 3100)
  t.is(calls, 2)
})

test('read caches are instance-local', async (t) => {
  let firstCalls = 0
  let secondCalls = 0
  const first = new ProtoRigClient({
    id: 'R2-001',
    api: apiFixture({ getTelemetry: async () => { firstCalls++; return { miner: { power: { value: 3000 } } } } }),
    cacheMs: 1000
  })
  const second = new ProtoRigClient({
    id: 'R2-002',
    api: apiFixture({ getTelemetry: async () => { secondCalls++; return { miner: { power: { value: 4000 } } } } }),
    cacheMs: 1000
  })
  t.is(await first.getPower(), 3000)
  t.is(await second.getPower(), 4000)
  t.is(await first.getPower(), 3000)
  t.is(firstCalls, 1)
  t.is(secondCalls, 1)
})
