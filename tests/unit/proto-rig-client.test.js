'use strict'

const test = require('brittle')
const { ProtoRigClient } = require('../../lib/proto-rig-client')

function apiFixture (overrides = {}) {
  return {
    getMiningStatus: async () => ({ status: 'Mining', reboot_uptime_s: 521 }),
    getTelemetry: async () => ({
      miner: {
        hashrate: { value: 95.5, unit: 'TH/s' },
        temperature: { value: 65.5, unit: '°C' },
        power: { value: 3250, unit: 'W' },
        efficiency: { value: 34.03, unit: 'J/TH' }
      },
      hashboards: [
        { index: 0, temperature: { unit: '°C', inlet: 45, outlet: 68, average: 56 } },
        { index: 1, temperature: { unit: '°C', inlet: 46, outlet: 70, average: 58 } }
      ]
    }),
    getPools: async () => [{ url: 'stratum+tcp://pool:3333', user: 'worker', password: 'secret', accepted: 10, rejected: 1, status: 'Active' }],
    getErrors: async () => [],
    getMiningTarget: async () => ({ power_target_watts: 3300, power_target_min_watts: 400, power_target_max_watts: 6000, performance_mode: 'MaximumHashrate' }),
    // Key set observed on R2 firmware, so snapshot tests run against a realistic
    // payload rather than one trimmed to what the worker happens to publish.
    getSystemInfo: async () => ({
      'system-info': {
        model: 'R2',
        cb_sn: 'R2-001',
        os: { version: '1.8.2' },
        manufacturer: 'Proto',
        uptime_seconds: 526,
        mining_driver_sw: { name: 'mining-driver', version: '1.8.2' },
        board: { revision: 'rev-c' },
        soc: { model: 'soc-model' },
        sw_update_status: { status: 'Idle' }
      }
    }),
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

test('reboot enforces a five-minute cooldown per device', async (t) => {
  const originalNow = Date.now
  let now = 0
  Date.now = () => now
  t.teardown(() => { Date.now = originalNow })

  let writes = 0
  const api = apiFixture({ reboot: async () => { writes++; return { rebooting: true } } })
  const first = new ProtoRigClient({ id: 'R2-001', api })
  const second = new ProtoRigClient({ id: 'R2-002', api })

  t.alike(await first.reboot(), { rebooting: true, success: true })
  await t.exception(first.reboot(), /ERR_COMMAND_COOLDOWN/)
  await second.reboot()
  t.is(writes, 2, 'another device has its own cooldown')
  now = 299999
  await t.exception(first.reboot(), /ERR_COMMAND_COOLDOWN/)
  t.is(writes, 2, 'rejected attempts never reach firmware')
  now = 300000
  await first.reboot()
  t.is(writes, 3, 'the next reboot is allowed at five minutes')
})

test('an in-flight or failed reboot cannot trigger another write', async (t) => {
  const originalNow = Date.now
  let now = 0
  Date.now = () => now
  t.teardown(() => { Date.now = originalNow })

  let rejectWrite
  let writes = 0
  const client = new ProtoRigClient({
    id: 'R2-001',
    api: apiFixture({
      reboot: () => {
        writes++
        return new Promise((resolve, reject) => { rejectWrite = reject })
      }
    })
  })
  const pending = client.reboot()
  const failure = t.exception(pending, /ERR_REQUEST_TIMEOUT/)
  await t.exception(client.reboot(), /ERR_COMMAND_IN_PROGRESS/)
  t.is(writes, 1, 'an in-flight reboot stays exclusive')
  rejectWrite(new Error('ERR_REQUEST_TIMEOUT'))
  await failure

  now = 299999
  await t.exception(client.reboot(), /ERR_COMMAND_COOLDOWN/)
  t.is(writes, 1, 'an ambiguous failure still consumes the cooldown')
  now = 300000
  const next = client.reboot()
  const nextFailure = t.exception(next, /ERR_DEVICE_CONNECTION/)
  t.is(writes, 2, 'the in-flight guard is released after failure')
  rejectWrite(new Error('ERR_DEVICE_CONNECTION'))
  await nextFailure
})

test('scalar getters reject malformed successful values with stable errors', async (t) => {
  const cases = [
    ['getHashrateAvg', { getTelemetry: async () => ({ miner: { hashrate: { value: '95.5', unit: 'TH/s' } } }) }, /ERR_TELEMETRY_RESPONSE_INVALID/],
    ['getPower', { getTelemetry: async () => ({ miner: { power: { value: Infinity, unit: 'W' } } }) }, /ERR_TELEMETRY_RESPONSE_INVALID/],
    ['getTemperature', { getTelemetry: async () => ({ miner: { temperature: null } }) }, /ERR_TELEMETRY_RESPONSE_INVALID/],
    ['getEfficiency', { getTelemetry: async () => ({ miner: {} }) }, /ERR_TELEMETRY_RESPONSE_INVALID/],
    ['getStatus', { getMiningStatus: async () => ({ status: 1 }) }, /ERR_MINING_RESPONSE_INVALID/],
    ['getUptime', { getMiningStatus: async () => ({ status: 'Mining' }) }, /ERR_MINING_RESPONSE_INVALID/],
    ['getUptime', { getMiningStatus: async () => ({ status: 'Mining', reboot_uptime_s: Number.MAX_VALUE }) }, /ERR_MINING_RESPONSE_INVALID/],
    ['getAcceptedShares', { getPools: async () => [{ accepted: '10' }] }, /ERR_POOLS_RESPONSE_INVALID/],
    ['getAcceptedShares', { getPools: async () => [{ accepted: Number.MAX_VALUE }, { accepted: Number.MAX_VALUE }] }, /ERR_POOLS_RESPONSE_INVALID/],
    ['getRejectedShares', { getPools: async () => [{ rejected: Infinity }] }, /ERR_POOLS_RESPONSE_INVALID/],
    ['getPowerTarget', { getMiningTarget: async () => ({ power_target_watts: '3300' }) }, /ERR_POWER_TARGET_RESPONSE_INVALID/],
    ['getFanSpeed', { getCooling: async () => ({ 'cooling-status': { fans: [{ rpm: '5000' }] } }) }, /ERR_COOLING_RESPONSE_INVALID/],
    ['getFanSpeed', { getCooling: async () => ({ 'cooling-status': { fans: [{ rpm: Number.MAX_VALUE }, { rpm: Number.MAX_VALUE }] } }) }, /ERR_COOLING_RESPONSE_INVALID/]
  ]

  for (const [method, overrides, error] of cases) {
    const client = new ProtoRigClient({ id: 'R2-001', api: apiFixture(overrides), cacheMs: 0 })
    await t.exception(client[method](), error, `${method} rejects malformed success`)
  }
})

test('scalar telemetry rejects missing or mismatched released units', async (t) => {
  const cases = [
    ['getHashrateAvg', 'hashrate', undefined],
    ['getHashrateAvg', 'hashrate', 'W'],
    ['getPower', 'power', 'TH/s'],
    ['getTemperature', 'temperature', 'J/TH'],
    ['getEfficiency', 'efficiency', '°C']
  ]

  for (const [method, metric, unit] of cases) {
    const client = new ProtoRigClient({
      id: 'R2-001',
      cacheMs: 0,
      api: apiFixture({
        getTelemetry: async () => ({ miner: { [metric]: { value: 1, unit } } })
      })
    })
    await t.exception(client[method](), /ERR_TELEMETRY_RESPONSE_INVALID/)
  }
})

test('snapshot rejects malformed nested successful inputs with stable errors', async (t) => {
  const cases = [
    [{
      getTelemetry: async () => ({
        miner: {
          hashrate: { value: 95.5, unit: 'TH/s' },
          temperature: { value: 65.5, unit: '°C' },
          power: { value: 3250, unit: 'W' },
          efficiency: { value: 34.03, unit: 'J/TH' }
        },
        hashboards: {}
      })
    }, /ERR_TELEMETRY_RESPONSE_INVALID/],
    [{
      getTelemetry: async () => ({
        miner: {
          hashrate: { value: Number.MAX_VALUE, unit: 'TH/s' },
          temperature: { value: 65.5, unit: '°C' },
          power: { value: 3250, unit: 'W' },
          efficiency: { value: 34.03, unit: 'J/TH' }
        },
        hashboards: []
      })
    }, /ERR_TELEMETRY_RESPONSE_INVALID/],
    [{
      getTelemetry: async () => ({
        miner: {
          hashrate: { value: 95.5, unit: 'TH/s' },
          temperature: { value: 65.5, unit: '°C' },
          power: { value: 3250, unit: 'W' },
          efficiency: { value: 34.03, unit: 'J/TH' }
        },
        hashboards: [{ index: 0, temperature: { unit: '°C', inlet: 45, outlet: Infinity, average: 56 } }]
      })
    }, /ERR_TELEMETRY_RESPONSE_INVALID/],
    [{ getPools: async () => [null] }, /ERR_POOLS_RESPONSE_INVALID/],
    [{ getErrors: async () => [null] }, /ERR_ERRORS_RESPONSE_INVALID/],
    [{ getMiningTarget: async () => ({ power_target_watts: Infinity }) }, /ERR_POWER_TARGET_RESPONSE_INVALID/],
    [{ getSystemInfo: async () => ({ 'system-info': null }) }, /ERR_SYSTEM_RESPONSE_INVALID/],
    [{ getNetworkInformation: async () => ({ 'network-info': { dhcp: 'yes' } }) }, /ERR_NETWORK_RESPONSE_INVALID/],
    [{ getCooling: async () => ({ 'cooling-status': { fans: {} } }) }, /ERR_COOLING_RESPONSE_INVALID/]
  ]

  for (const [overrides, error] of cases) {
    const client = new ProtoRigClient({ id: 'R2-001', api: apiFixture(overrides), cacheMs: 0 })
    await t.exception(client.getSnap(), error)
  }
})

test('snapshot treats released-optional stale shares as zero and omits secrets', async (t) => {
  const client = new ProtoRigClient({ id: 'R2-001', api: apiFixture(), cacheMs: 0 })
  const snap = await client.getSnap()
  t.is(snap.stats.status, 'mining')
  t.is(snap.stats.hashrate_mhs.avg, 95500000)
  t.is(snap.stats.power_w, 3250)
  t.is(snap.stats.temperature_c.max, 70)
  t.is(snap.stats.all_pools_shares.stale, 0)
  t.is(snap.stats.pool_status[0].stale, 0)
  t.is(snap.config.power_mode, 'normal')
  t.is(snap.config.network_config.ip_address, '192.0.2.10')
  t.is(snap.config.model, 'R2')
  t.is(JSON.stringify(snap).includes('password'), false)
  t.is(JSON.stringify(snap).includes('token'), false)
  t.is(JSON.stringify(snap).includes('secret'), false)
})

test('share telemetry rejects fractional, unsafe, and overflowing counts', async (t) => {
  const cases = [
    ['getAcceptedShares', [{ accepted: 1.5 }]],
    ['getRejectedShares', [{ rejected: Number.MAX_SAFE_INTEGER + 1 }]],
    ['getAcceptedShares', [{ accepted: Number.MAX_SAFE_INTEGER }, { accepted: 1 }]]
  ]

  for (const [method, pools] of cases) {
    const client = new ProtoRigClient({
      id: 'R2-001',
      cacheMs: 0,
      api: apiFixture({ getPools: async () => pools })
    })
    await t.exception(client[method](), /ERR_POOLS_RESPONSE_INVALID/)
  }
})

test('snapshot rejects malformed or overflowing present stale shares', async (t) => {
  const pool = { url: 'stratum+tcp://pool:3333', accepted: 10, rejected: 1 }
  const cases = [
    [{ ...pool, stale: '2' }],
    [{ ...pool, stale: -1 }],
    [{ ...pool, stale: 0.5 }],
    [{ ...pool, stale: Infinity }],
    [{ ...pool, stale: Number.MAX_SAFE_INTEGER + 1 }],
    [{ ...pool, stale: Number.MAX_SAFE_INTEGER }, { ...pool, stale: 1 }]
  ]

  for (const pools of cases) {
    const client = new ProtoRigClient({
      id: 'R2-001',
      api: apiFixture({ getPools: async () => pools }),
      cacheMs: 0
    })
    await t.exception(client.getSnap(), /ERR_POOLS_RESPONSE_INVALID/)
  }
})

test('unknown mining states fail closed', async (t) => {
  const client = new ProtoRigClient({
    id: 'R2-001',
    api: apiFixture({ getMiningStatus: async () => ({ status: 'FutureFirmwareState' }) }),
    cacheMs: 0
  })

  await t.exception(client.getStatus(), /ERR_MINING_RESPONSE_INVALID/)
  await t.exception(client.getPowerMode(), /ERR_MINING_RESPONSE_INVALID/)
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
      return { miner: { hashrate: { value: 95.5, unit: 'TH/s' }, power: { value: 3250, unit: 'W' } } }
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
      return { miner: { power: { value: 3100, unit: 'W' } } }
    }
  })
  const client = new ProtoRigClient({ id: 'R2-001', api, cacheMs: 1000 })
  await t.exception(client.getPower(), /telemetry down/)
  t.is(await client.getPower(), 3100)
  t.is(calls, 2)
})

test('cacheMs must be a finite duration from zero through 5000 milliseconds', (t) => {
  for (const cacheMs of [-1, Infinity, NaN, 5000.1, '100']) {
    t.exception(() => new ProtoRigClient({ id: 'R2-001', api: apiFixture(), cacheMs }), /ERR_CACHE_DURATION_INVALID/)
  }
  t.is(new ProtoRigClient({ id: 'R2-001', api: apiFixture(), cacheMs: 0 }).cacheMs, 0)
  t.is(new ProtoRigClient({ id: 'R2-001', api: apiFixture(), cacheMs: 5000 }).cacheMs, 5000)
})

test('read caches are instance-local', async (t) => {
  let firstCalls = 0
  let secondCalls = 0
  const first = new ProtoRigClient({
    id: 'R2-001',
    api: apiFixture({ getTelemetry: async () => { firstCalls++; return { miner: { power: { value: 3000, unit: 'W' } } } } }),
    cacheMs: 1000
  })
  const second = new ProtoRigClient({
    id: 'R2-002',
    api: apiFixture({ getTelemetry: async () => { secondCalls++; return { miner: { power: { value: 4000, unit: 'W' } } } } }),
    cacheMs: 1000
  })
  t.is(await first.getPower(), 3000)
  t.is(await second.getPower(), 4000)
  t.is(await first.getPower(), 3000)
  t.is(firstCalls, 1)
  t.is(secondCalls, 1)
})

test('reboot delegates once and invalidates every read cache entry', async (t) => {
  let calls = 0
  const api = apiFixture({ reboot: async () => { calls++; return { rebooting: true } } })
  const client = new ProtoRigClient({ id: 'R2-001', api })
  for (const key of ['mining', 'telemetry', 'pools', 'errors', 'target', 'cooling', 'system', 'network']) {
    client.reads.set(key, { promise: Promise.resolve({}), expires: Date.now() + 1000 })
  }
  t.alike(await client.reboot(), { success: true, rebooting: true })
  t.is(calls, 1)
  t.is(client.reads.size, 0)
})

test('setPowerTarget normalizes the exact transmitted integer before checking bounds', async (t) => {
  const writes = []
  const api = apiFixture({ setPowerTarget: async watts => { writes.push(watts); return { power_target_watts: watts } } })
  const client = new ProtoRigClient({ id: 'R2-001', api, cacheMs: 0 })
  t.alike(await client.setPowerTarget(399.6), { success: true, target: { power_target_watts: 400 } })
  await t.exception(client.setPowerTarget(399.4), /ERR_POWER_TARGET_OUT_OF_RANGE: 400-6000/)
  t.alike(writes, [400])
})

test('setPowerTarget accepts exact hardware bounds and rejects one watt above', async (t) => {
  const writes = []
  const api = apiFixture({
    getMiningTarget: async () => ({
      power_target_watts: 3300,
      power_target_min_watts: 400,
      power_target_max_watts: 12000
    }),
    setPowerTarget: async watts => { writes.push(watts); return { power_target_watts: watts } }
  })
  const client = new ProtoRigClient({ id: 'R2-001', api, cacheMs: 0 })

  t.alike(await client.setPowerTarget(400), { success: true, target: { power_target_watts: 400 } })
  t.alike(await client.setPowerTarget(12000), { success: true, target: { power_target_watts: 12000 } })
  await t.exception(client.setPowerTarget(12001), /ERR_POWER_TARGET_OUT_OF_RANGE: 400-12000/)
  t.alike(writes, [400, 12000])
})

test('setPowerTarget rejects unusable requests before reading device bounds', async (t) => {
  for (const watts of [NaN, Infinity, -Infinity, -100, 0, 0.4, '2800', null, undefined]) {
    let writes = 0
    let bounds = 0
    const api = apiFixture({
      getMiningTarget: async () => {
        bounds++
        return { power_target_watts: 3300, power_target_min_watts: 400, power_target_max_watts: 6000 }
      },
      setPowerTarget: async () => { writes++ }
    })
    const client = new ProtoRigClient({ id: 'R2-001', api, cacheMs: 0 })
    await t.exception(client.setPowerTarget(watts), /ERR_POWER_TARGET_INVALID/)
    t.is(writes, 0)
    t.is(bounds, 0)
  }
})

test('device write responses cannot shadow the worker success flag', async (t) => {
  const api = apiFixture({
    reboot: async () => ({ success: false, rebooting: true }),
    setLED: async () => ({ success: 'no' }),
    startMining: async () => ({ success: null })
  })
  const client = new ProtoRigClient({ id: 'R2-001', api })
  t.alike(await client.reboot(), { rebooting: true, success: true })
  t.alike(await client.setLED(true), { success: true })
  t.alike(await client.setPowerMode('normal'), { success: true })
})

test('setPowerTarget rejects unsafe device bounds before writing', async (t) => {
  const invalidBounds = [
    {},
    { power_target_min_watts: '400', power_target_max_watts: 6000 },
    { power_target_min_watts: 400, power_target_max_watts: Infinity },
    { power_target_min_watts: 6000, power_target_max_watts: 400 },
    { power_target_min_watts: 0, power_target_max_watts: 6000 },
    { power_target_min_watts: 400, power_target_max_watts: 12001 },
    { power_target_min_watts: 400, power_target_max_watts: Number.MAX_SAFE_INTEGER + 1 }
  ]

  for (const target of invalidBounds) {
    let writes = 0
    const api = apiFixture({
      getMiningTarget: async () => target,
      setPowerTarget: async () => { writes++ }
    })
    const client = new ProtoRigClient({ id: 'R2-001', api, cacheMs: 0 })
    await t.exception(client.setPowerTarget(2800), /ERR_POWER_TARGET_RESPONSE_INVALID/)
    t.is(writes, 0)
  }
})

test('setPowerTarget invalidates target and mining telemetry around a successful write', async (t) => {
  const api = apiFixture({ setPowerTarget: async watts => ({ power_target_watts: watts }) })
  const client = new ProtoRigClient({ id: 'R2-001', api, cacheMs: 1000 })
  for (const key of ['target', 'mining', 'telemetry', 'pools']) {
    client.reads.set(key, { promise: Promise.resolve({}), expires: Date.now() + 1000 })
  }
  t.alike(await client.setPowerTarget(2800), { success: true, target: { power_target_watts: 2800 } })
  t.is(client.reads.has('target'), false)
  t.is(client.reads.has('mining'), false)
  t.is(client.reads.has('telemetry'), false)
  t.is(client.reads.has('pools'), true)
})

test('reads after rejected writes bypass stale command-affected cache entries', async (t) => {
  let rebootPower = 3000
  let rebootReads = 0
  const rebootClient = new ProtoRigClient({
    id: 'R2-001',
    cacheMs: 5000,
    api: apiFixture({
      getTelemetry: async () => {
        rebootReads++
        return { miner: { power: { value: rebootPower, unit: 'W' } } }
      },
      reboot: async () => {
        rebootPower = 3100
        throw new Error('ERR_DEVICE_CONNECTION')
      }
    })
  })
  t.is(await rebootClient.getPower(), 3000)
  await t.exception(rebootClient.reboot(), /ERR_DEVICE_CONNECTION/)
  t.is(await rebootClient.getPower(), 3100)
  t.is(rebootReads, 2)

  let miningStatus = 'Mining'
  let miningReads = 0
  let errorReads = 0
  const modeClient = new ProtoRigClient({
    id: 'R2-001',
    cacheMs: 5000,
    api: apiFixture({
      getMiningStatus: async () => { miningReads++; return { status: miningStatus, reboot_uptime_s: 521 } },
      getErrors: async () => { errorReads++; return [] },
      stopMining: async () => {
        miningStatus = 'Stopped'
        throw new Error('ERR_DEVICE_CONNECTION')
      }
    })
  })
  t.is(await modeClient.getStatus(), 'mining')
  await t.exception(modeClient.setPowerMode('sleep'), /ERR_DEVICE_CONNECTION/)
  t.is(await modeClient.getStatus(), 'sleeping')
  t.is(miningReads, 2)
  t.is(errorReads, 2)

  let target = 3300
  let targetReads = 0
  const targetClient = new ProtoRigClient({
    id: 'R2-001',
    cacheMs: 5000,
    api: apiFixture({
      getMiningTarget: async () => {
        targetReads++
        return { power_target_watts: target, power_target_min_watts: 400, power_target_max_watts: 6000 }
      },
      setPowerTarget: async watts => {
        target = watts
        throw new Error('ERR_DEVICE_CONNECTION')
      }
    })
  })
  t.is(await targetClient.getPowerTarget(), 3300)
  await t.exception(targetClient.setPowerTarget(2800), /ERR_DEVICE_CONNECTION/)
  t.is(await targetClient.getPowerTarget(), 2800)
  t.is(targetReads, 3)

  let accepted = 10
  let poolReads = 0
  const poolsClient = new ProtoRigClient({
    id: 'R2-001',
    cacheMs: 5000,
    api: apiFixture({
      getPools: async () => {
        poolReads++
        return [{ url: 'stratum+tcp://pool:3333', accepted, rejected: 1, stale: 2 }]
      },
      setPools: async () => {
        accepted = 20
        throw new Error('ERR_DEVICE_CONNECTION')
      }
    })
  })
  t.is(await poolsClient.getAcceptedShares(), 10)
  await t.exception(poolsClient.setupPools([{ url: 'stratum+tcp://pool:3333', worker_name: 'worker' }]), /ERR_DEVICE_CONNECTION/)
  t.is(await poolsClient.getAcceptedShares(), 20)
  t.is(poolReads, 2)
})

test('finally invalidation evicts a read repopulated during an ambiguous write', async (t) => {
  let status = 'Mining'
  let reads = 0
  let rejectWrite
  const api = apiFixture({
    getMiningStatus: async () => { reads++; return { status, reboot_uptime_s: 521 } },
    startMining: async () => new Promise((_resolve, reject) => { rejectWrite = reject })
  })
  const client = new ProtoRigClient({ id: 'R2-001', api, cacheMs: 5000 })
  const command = client.setPowerMode('normal')
  await Promise.resolve()
  status = 'Stopped'
  t.is(await client.getPowerMode(), 'sleep')
  rejectWrite(new Error('ERR_DEVICE_CONNECTION'))
  await t.exception(command, /ERR_DEVICE_CONNECTION/)
  status = 'Mining'
  t.is(await client.getPowerMode(), 'normal')
  t.is(reads, 2)
})

test('power mode and LED reject unsupported values before writing', async (t) => {
  const calls = []
  const api = apiFixture({
    startMining: async () => { calls.push('start') },
    stopMining: async () => { calls.push('stop') },
    setLED: async value => { calls.push(['led', value]) }
  })
  const client = new ProtoRigClient({ id: 'R2-001', api })
  await client.setPowerMode('normal')
  await client.setPowerMode('sleep')
  await client.setLED(true)
  await t.exception(client.setPowerMode('high'), /ERR_SET_POWER_MODE_INVALID/)
  await t.exception(client.setLED('true'), /ERR_SET_LED_ENABLED_INVALID/)
  t.alike(calls, ['start', 'stop', ['led', true]])
})

test('setupPools validates and translates without exposing passwords', async (t) => {
  let body
  const api = apiFixture({ setPools: async value => { body = value } })
  const client = new ProtoRigClient({ id: 'R2-001', api })
  t.alike(await client.setupPools([{
    url: '  stratum+tcp://pool:3333  ',
    worker_name: '  account  ',
    worker_password: 'secret',
    pool: 'Primary'
  }]), { success: true })
  t.alike(body, [{
    url: 'stratum+tcp://pool:3333',
    username: 'account.R2-001',
    password: 'secret',
    name: 'Primary',
    priority: 0
  }])
  await t.exception(client.setupPools([]), /ERR_POOLS_INVALID/)
  await t.exception(client.setupPools([{}, {}, {}, {}]), /ERR_POOLS_INVALID/)
})

test('setupPools with appendId false transmits the bare worker name', async (t) => {
  let body
  const api = apiFixture({ setPools: async value => { body = value } })
  const client = new ProtoRigClient({ id: 'R2-001', api })
  t.alike(await client.setupPools([{
    url: 'stratum+tcp://pool:3333',
    worker_name: '  account  '
  }], false), { success: true })
  t.alike(body, [{
    url: 'stratum+tcp://pool:3333',
    username: 'account',
    password: '',
    name: '',
    priority: 0
  }])
  t.is(JSON.stringify(body).includes('R2-001'), false)
})

test('setupPools rejects every malformed entry and appendId before writing', async (t) => {
  const invalid = [
    [[null], true],
    [[{ url: '', worker_name: 'worker' }], true],
    [[{ url: '   ', worker_name: 'worker' }], true],
    [[{ url: 'pool.example:3333', worker_name: 'worker' }], true],
    [[{ url: 'stratum+tcp://pool:3333', worker_name: '' }], true],
    [[{ url: 'stratum+tcp://pool:3333', worker_name: '   ' }], true],
    [[{ url: 'stratum+tcp://user:pool-secret@pool:3333', worker_name: 'worker' }], true],
    [[{ url: 'stratum+tcp://pool:3333', worker_name: 'worker', worker_password: 1 }], true],
    [[{ url: 'stratum+tcp://pool:3333', worker_name: 'worker', pool: false }], true],
    [[{ url: 'stratum+tcp://pool:3333', worker_name: 'worker' }], 'false']
  ]
  let writes = 0
  const client = new ProtoRigClient({
    id: 'R2-001',
    api: apiFixture({ setPools: async () => { writes++ } })
  })

  for (const [pools, appendId] of invalid) {
    await t.exception(client.setupPools(pools, appendId), /ERR_(POOL_ENTRY|APPEND_ID)_INVALID/)
  }
  t.is(writes, 0)
})

test('snapshot publishes no undeclared system-info field', async (t) => {
  const client = new ProtoRigClient({ id: 'R2-001', api: apiFixture(), cacheMs: 0 })
  const snap = await client.getSnap()
  const serialized = JSON.stringify(snap)

  // The worker declares firmware_ver, product_name, model, and serial_number.
  // Everything else the device volunteers must stay out of the snapshot.
  for (const undeclared of ['mining_driver_sw', 'board', 'soc', 'sw_update_status', 'manufacturer', 'uptime_seconds']) {
    t.is(serialized.includes(undeclared), false)
  }
  t.is(serialized.includes('rev-c'), false)
  t.is(serialized.includes('soc-model'), false)
  t.is(snap.config.firmware_ver, '1.8.2')
  t.is(snap.config.serial_number, 'R2-001')
  // The OS clock must not reach uptime_ms even while it is on offer.
  t.is(snap.stats.uptime_ms, 521000)
})

test('snapshot uptime accepts only the miner clock', async (t) => {
  // system-info.uptime_seconds is a different clock. It must not stand in for a
  // missing reboot_uptime_s, and getSnap must fail exactly where getUptime does.
  const api = apiFixture({
    getMiningStatus: async () => ({ status: 'Mining' }),
    getSystemInfo: async () => ({
      'system-info': { model: 'R2', cb_sn: 'R2-001', uptime_seconds: 99999, os: { version: '1.8.2' } }
    })
  })
  const client = new ProtoRigClient({ id: 'R2-001', api, cacheMs: 0 })
  await t.exception(client.getSnap(), /ERR_MINING_RESPONSE_INVALID/)
  await t.exception(client.getUptime(), /ERR_MINING_RESPONSE_INVALID/)
})

test('snapshot reports no hashrate window it cannot measure', async (t) => {
  const client = new ProtoRigClient({ id: 'R2-001', api: apiFixture(), cacheMs: 0 })
  const snap = await client.getSnap()
  t.alike(snap.stats.hashrate_mhs, { avg: 95500000 })
  for (const window of ['t_5s', 't_5m', 't_30m']) {
    t.is(snap.stats.hashrate_mhs[window], undefined)
  }
})

test('snapshot rejects malformed hashboard indexes', async (t) => {
  for (const index of [undefined, -1, 1.5, '0', null]) {
    const client = new ProtoRigClient({
      id: 'R2-001',
      cacheMs: 0,
      api: apiFixture({
        getTelemetry: async () => ({
          miner: {
            hashrate: { value: 95.5, unit: 'TH/s' },
            temperature: { value: 65.5, unit: '°C' },
            power: { value: 3250, unit: 'W' },
            efficiency: { value: 34.03, unit: 'J/TH' }
          },
          hashboards: [{ index, temperature: { unit: '°C', inlet: 45, outlet: 68, average: 56 } }]
        })
      })
    })
    await t.exception(client.getSnap(), /ERR_TELEMETRY_RESPONSE_INVALID/)
  }
})

test('snapshot rejects mismatched hashboard temperature units', async (t) => {
  const telemetry = await apiFixture().getTelemetry()
  telemetry.hashboards[0].temperature.unit = 'W'
  const client = new ProtoRigClient({
    id: 'R2-001',
    cacheMs: 0,
    api: apiFixture({ getTelemetry: async () => telemetry })
  })
  await t.exception(client.getSnap(), /ERR_TELEMETRY_RESPONSE_INVALID/)
})

test('snapshot rejects cooling values outside the released schema', async (t) => {
  for (const coolingStatus of [
    { fan_mode: 'Turbo', speed_percentage: 55, fans: [] },
    { fan_mode: 'Auto', speed_percentage: 50.5, fans: [] },
    { fan_mode: 'Manual', speed_percentage: 101, fans: [] }
  ]) {
    const client = new ProtoRigClient({
      id: 'R2-001',
      cacheMs: 0,
      api: apiFixture({ getCooling: async () => ({ 'cooling-status': coolingStatus }) })
    })
    await t.exception(client.getSnap(), /ERR_COOLING_RESPONSE_INVALID/)
  }
})

test('snapshot publishes only declared fan fields', async (t) => {
  const client = new ProtoRigClient({
    id: 'R2-001',
    cacheMs: 0,
    api: apiFixture({
      getCooling: async () => ({
        'cooling-status': {
          fan_mode: 'Auto',
          speed_percentage: 55,
          fans: [{ rpm: 5000, serial: 'FAN-SECRET', firmware: '9.9.9' }]
        }
      })
    })
  })
  const snap = await client.getSnap()
  t.alike(snap.stats.cooling.fans, [{ rpm: 5000 }])
  t.is(JSON.stringify(snap).includes('FAN-SECRET'), false)
})

test('snapshot omits free-form firmware error strings', async (t) => {
  const client = new ProtoRigClient({
    id: 'R2-001',
    cacheMs: 0,
    api: apiFixture({
      getErrors: async () => [{
        error_code: 'token-secret',
        message: 'password-secret',
        source: 'psu',
        slot: 3,
        timestamp: 1764160757
      }]
    })
  })
  const snap = await client.getSnap()
  t.alike(snap.stats.errors, [{
    name: 'firmware_error',
    source: 'psu',
    slot: 3,
    timestamp: 1764160757
  }])
  t.is(JSON.stringify(snap).includes('token-secret'), false)
  t.is(JSON.stringify(snap).includes('password-secret'), false)
})

test('snapshot rejects firmware error metadata outside the released schema', async (t) => {
  for (const error of [
    { source: 'token-secret' },
    { source: 'fan', slot: '3' },
    { source: 'rig', timestamp: Infinity }
  ]) {
    const client = new ProtoRigClient({
      id: 'R2-001',
      cacheMs: 0,
      api: apiFixture({ getErrors: async () => [error] })
    })
    await t.exception(client.getSnap(), /ERR_ERRORS_RESPONSE_INVALID/)
  }
})

test('snapshot refuses externally configured pool URL userinfo without exposing it', async (t) => {
  const client = new ProtoRigClient({
    id: 'R2-001',
    api: apiFixture({
      getPools: async () => [{
        url: 'stratum+tcp://worker:returned-pool-secret@pool:3333',
        user: 'worker',
        accepted: 10,
        rejected: 1,
        stale: 2,
        status: 'Active'
      }]
    }),
    cacheMs: 0
  })
  let failure
  await t.exception(client.getSnap().catch(err => {
    failure = err
    throw err
  }), /ERR_POOLS_RESPONSE_INVALID/)
  t.is(failure.message.includes('returned-pool-secret'), false)
})

test('setupPools invalidates pool, mining, and error caches only', async (t) => {
  const api = apiFixture({ setPools: async () => {} })
  const client = new ProtoRigClient({ id: 'R2-001', api, cacheMs: 1000 })
  for (const key of ['pools', 'mining', 'errors', 'target']) {
    client.reads.set(key, { promise: Promise.resolve({}), expires: Date.now() + 1000 })
  }
  t.alike(await client.setupPools([{ url: 'stratum+tcp://pool:3333', worker_name: 'account' }], false), { success: true })
  t.is(client.reads.has('pools'), false)
  t.is(client.reads.has('mining'), false)
  t.is(client.reads.has('errors'), false)
  t.is(client.reads.has('target'), true)
})

test('all commands bypass _read while power target fetches bounds directly', async (t) => {
  const calls = []
  const api = apiFixture({
    reboot: async () => { calls.push('reboot') },
    startMining: async () => { calls.push('start') },
    getMiningTarget: async () => {
      calls.push('bounds')
      return { power_target_watts: 3300, power_target_min_watts: 400, power_target_max_watts: 6000 }
    },
    setPowerTarget: async () => { calls.push('target') },
    setLED: async () => { calls.push('led') },
    setPools: async () => { calls.push('pools') }
  })
  const client = new ProtoRigClient({ id: 'R2-001', api })
  client._read = async () => { throw new Error('command used read cache') }
  await client.reboot()
  await client.setPowerMode('normal')
  await client.setPowerTarget(2800)
  await client.setLED(true)
  await client.setupPools([{ url: 'stratum+tcp://pool:3333', worker_name: 'worker' }])
  t.alike(calls, ['reboot', 'start', 'bounds', 'target', 'led', 'pools'])
})

test('commands do not retry connection rejections', async (t) => {
  let calls = 0
  const api = apiFixture({
    setLED: async () => {
      calls++
      throw new Error('ECONNRESET')
    }
  })
  const client = new ProtoRigClient({ id: 'R2-001', api })
  await t.exception(client.setLED(true), /ECONNRESET/)
  t.is(calls, 1)
})

test('errors channel projects identifiers and metadata without free-form firmware text', async (t) => {
  const client = new ProtoRigClient({
    id: 'R2-001',
    api: apiFixture({
      getErrors: async () => [
        { error_code: 'FanSlow_3', source: 'fan', slot: 3, timestamp: 1764160757, message: 'password-secret', arbitrary: 'secret' },
        { error_code: 'A'.repeat(64) },
        ...['', 'token-secret', 'contains spaces', '3FanSlow', 'érror', 'A'.repeat(65), 'FanSlow\n', 'FanSlow\r'].map(errorCode => ({ error_code: errorCode })),
        {}
      ]
    })
  })
  t.alike(await client.getErrors(), [
    { name: 'firmware_error', code: 'FanSlow_3', source: 'fan', slot: 3, timestamp: 1764160757 },
    { name: 'firmware_error', code: 'A'.repeat(64) },
    ...Array.from({ length: 9 }, () => ({ name: 'firmware_error' }))
  ])
  const snap = await client.getSnap()
  t.alike(snap.stats.errors[0], { name: 'firmware_error', source: 'fan', slot: 3, timestamp: 1764160757 })
})

test('errors channel rejects malformed code and metadata while snapshot keeps ignoring code', async (t) => {
  for (const error of [
    { error_code: null }, { error_code: 1 }, { error_code: {} },
    { source: 'unknown' }, { slot: 1.5 }, { timestamp: Number.MAX_SAFE_INTEGER + 1 }
  ]) {
    const client = new ProtoRigClient({ id: 'R2-001', api: apiFixture({ getErrors: async () => [error] }) })
    await t.exception(client.getErrors(), /ERR_ERRORS_RESPONSE_INVALID/)
    if (Object.hasOwn(error, 'error_code')) t.is((await client.getSnap()).stats.errors[0].name, 'firmware_error')
  }
})

test('pools channel projects released pool fields and drops credentials and siblings', async (t) => {
  const client = new ProtoRigClient({
    id: 'R2-001',
    api: apiFixture({
      getPools: async () => [{
        url: '  stratum2+tcp://pool:3336  ',
        user: 'account.worker',
        accepted: 10,
        rejected: 2,
        stale: 3,
        status: 'Active',
        id: 0,
        priority: 1,
        name: '',
        protocol: 'Stratum V2',
        password: 'secret',
        v2_authority_pubkey: 'authority-secret',
        invalid: 5,
        arbitrary: 'secret'
      }]
    })
  })
  t.alike(await client.getPools(), [{
    url: 'stratum2+tcp://pool:3336',
    username: 'account.worker',
    accepted: 10,
    rejected: 2,
    stale: 3,
    status: 'Active',
    id: 0,
    priority: 1,
    name: '',
    protocol: 'Stratum V2'
  }])
  const snap = await client.getSnap()
  t.alike(snap.stats.pool_status, [{ pool: 'stratum2+tcp://pool:3336', accepted: 10, rejected: 2, stale: 3, status: 'Active' }])
  t.alike(snap.config.pool_config, [{ url: 'stratum2+tcp://pool:3336', username: 'account.worker' }])
})

test('pools channel rejects unsafe URLs, counts, and optional field types', async (t) => {
  const pool = { url: 'stratum+tcp://pool:3333', accepted: 10, rejected: 1 }
  for (const change of [
    { url: 'stratum+tcp://worker:secret@pool:3333' }, { url: '' }, { url: 'pool:3333' },
    { accepted: -1 }, { rejected: 0.5 }, { stale: '2' }, { stale: Infinity },
    { id: -1 }, { id: Number.MAX_SAFE_INTEGER + 1 }, { priority: 0.5 },
    { user: 3 }, { status: false }, { name: {} }, { protocol: null }
  ]) {
    const client = new ProtoRigClient({ id: 'R2-001', api: apiFixture({ getPools: async () => [{ ...pool, ...change }] }) })
    await t.exception(client.getPools(), /ERR_POOLS_RESPONSE_INVALID/)
    if (['id', 'priority', 'name', 'protocol'].some(key => Object.hasOwn(change, key))) {
      t.is((await client.getSnap()).stats.pool_status[0].accepted, 10)
    }
  }
})

test('hashboards channel exposes measured board metrics only', async (t) => {
  const client = new ProtoRigClient({
    id: 'R2-001',
    api: apiFixture({
      getTelemetry: async () => ({
        hashboards: [{
          index: 0,
          serial_number: 'HB001',
          temperature: { unit: '°C', inlet: -5, outlet: 68, average: 56 },
          hashrate: { unit: 'TH/s', value: 47.5 },
          power: { unit: 'W', value: 1600 },
          efficiency: { unit: 'J/TH', value: 33.68 },
          voltage: { unit: 'V', value: 12 },
          current: { unit: 'A', value: 133 },
          asics: { temperature: [90] },
          frequency: 500,
          arbitrary: 'secret'
        }]
      })
    })
  })
  t.alike(await client.getHashboards(), [{
    index: 0,
    serial_number: 'HB001',
    temperature_c: { inlet: -5, outlet: 68, avg: 56 },
    hashrate_ths: 47.5,
    power_w: 1600,
    efficiency_w_ths: 33.68,
    voltage_v: 12,
    current_a: 133
  }])
})

test('hashboards channel rejects malformed measured fields and optional metrics', async (t) => {
  const board = { index: 0, temperature: { unit: '°C', inlet: 45, outlet: 68, average: 56 } }
  for (const change of [
    { index: '0' }, { index: -1 }, { temperature: { unit: 'W', inlet: 45, outlet: 68, average: 56 } },
    { temperature: { unit: '°C', inlet: 45, outlet: Infinity, average: 56 } }, { serial_number: 1 }
  ]) {
    const client = new ProtoRigClient({ id: 'R2-001', api: apiFixture({ getTelemetry: async () => ({ hashboards: [{ ...board, ...change }] }) }) })
    await t.exception(client.getHashboards(), /ERR_TELEMETRY_RESPONSE_INVALID/)
  }
  for (const [field, unit] of [['hashrate', 'TH/s'], ['power', 'W'], ['efficiency', 'J/TH'], ['voltage', 'V'], ['current', 'A']]) {
    for (const metric of [null, [], { value: 1 }, { unit: 'wrong', value: 1 }, { unit, value: -1 }, { unit, value: Infinity }, { unit, value: '1' }]) {
      const telemetry = await apiFixture().getTelemetry()
      telemetry.hashboards[0][field] = metric
      const client = new ProtoRigClient({ id: 'R2-001', api: apiFixture({ getTelemetry: async () => telemetry }) })
      await t.exception(client.getHashboards(), /ERR_TELEMETRY_RESPONSE_INVALID/)
      t.is((await client.getSnap()).stats.temperature_c.max, 70, 'snapshot ignores newly exposed optional metrics')
    }
  }
})

test('device info projects identity and network without hardware or firmware siblings', async (t) => {
  const client = new ProtoRigClient({
    id: 'worker-device-id',
    api: apiFixture({
      getSystemInfo: async () => ({
        'system-info': {
          product_name: 'Proto Rig',
          manufacturer: 'Proto',
          model: 'R2',
          cb_sn: 'CONTROL001',
          os: { version: '1.8.2', status: { secret: true } },
          board: { secret: true },
          sw_update_status: { message: 'secret' }
        }
      }),
      getNetworkInformation: async () => ({
        'network-info': {
          dhcp: false,
          ip: '192.0.2.10',
          gateway: '192.0.2.1',
          netmask: '255.255.255.0',
          mac: '82:11:D2:94:0D:6D',
          hostname: 'proto-rig',
          password: 'secret'
        }
      })
    })
  })
  t.alike(await client.getDeviceInfo(), {
    device_id: 'worker-device-id',
    product_name: 'Proto Rig',
    manufacturer: 'Proto',
    model: 'R2',
    serial_number: 'CONTROL001',
    network: { mode: 'static', ip_address: '192.0.2.10', ip_gw: '192.0.2.1', ip_netmask: '255.255.255.0', mac: '82:11:D2:94:0D:6D', hostname: 'proto-rig' }
  })
})

test('device info validates present network and identity types without tightening snapshot', async (t) => {
  for (const [source, change, error] of [
    ['system', { product_name: 1 }, /ERR_SYSTEM_RESPONSE_INVALID/],
    ['system', { model: null }, /ERR_SYSTEM_RESPONSE_INVALID/],
    ['system', { cb_sn: {} }, /ERR_SYSTEM_RESPONSE_INVALID/],
    ['system', { manufacturer: false }, /ERR_SYSTEM_RESPONSE_INVALID/],
    ['network', { dhcp: 'true' }, /ERR_NETWORK_RESPONSE_INVALID/],
    ['network', { dhcp: null }, /ERR_NETWORK_RESPONSE_INVALID/],
    ['network', { ip: false }, /ERR_NETWORK_RESPONSE_INVALID/],
    ['network', { gateway: null }, /ERR_NETWORK_RESPONSE_INVALID/],
    ['network', { netmask: 1 }, /ERR_NETWORK_RESPONSE_INVALID/],
    ['network', { mac: [] }, /ERR_NETWORK_RESPONSE_INVALID/],
    ['network', { hostname: 1 }, /ERR_NETWORK_RESPONSE_INVALID/]
  ]) {
    const system = await apiFixture().getSystemInfo()
    const network = await apiFixture().getNetworkInformation()
    Object.assign(source === 'system' ? system['system-info'] : network['network-info'], change)
    const client = new ProtoRigClient({ id: 'R2-001', api: apiFixture({ getSystemInfo: async () => system, getNetworkInformation: async () => network }) })
    await t.exception(client.getDeviceInfo(), error)
    if (['manufacturer', 'mac', 'hostname'].some(key => Object.hasOwn(change, key))) t.is((await client.getSnap()).config.model, 'R2')
  }
})

test('device info preserves identity when optional network fields are missing or blank', async (t) => {
  for (const info of [{}, { ip: '', gateway: ' \t ', netmask: '', mac: '\n', hostname: ' ' }]) {
    const client = new ProtoRigClient({
      id: 'R2-001',
      api: apiFixture({ getNetworkInformation: async () => ({ 'network-info': info }) })
    })
    t.alike(await client.getDeviceInfo(), {
      device_id: 'R2-001', manufacturer: 'Proto', model: 'R2', serial_number: 'R2-001', network: {}
    })
    await t.exception(client.getSnap(), /ERR_NETWORK_RESPONSE_INVALID/, 'snapshot still requires its network fields')
  }

  for (const [field, output] of [['dhcp', 'mode'], ['ip', 'ip_address'], ['gateway', 'ip_gw'], ['netmask', 'ip_netmask'], ['mac', 'mac'], ['hostname', 'hostname']]) {
    for (const value of field === 'dhcp' ? [undefined] : [undefined, '', ' \t\n ']) {
      const network = await apiFixture().getNetworkInformation()
      network['network-info'][field] = value
      const client = new ProtoRigClient({ id: 'R2-001', api: apiFixture({ getNetworkInformation: async () => network }) })
      const result = await client.getDeviceInfo()
      t.is(Object.hasOwn(result.network, output), false, `${field} is omitted when missing or blank`)
      t.is(result.serial_number, 'R2-001', 'network omissions preserve identity')
      if (['dhcp', 'ip', 'gateway', 'netmask'].includes(field)) {
        await t.exception(client.getSnap(), /ERR_NETWORK_RESPONSE_INVALID/, `snapshot still requires ${field}`)
      }
    }
  }
})

test('firmware info projects only declared component strings', async (t) => {
  const client = new ProtoRigClient({
    id: 'R2-001',
    api: apiFixture({
      getSystemInfo: async () => ({
        'system-info': {
          os: { name: 'Proto Linux', version: '1.8.2', git_hash: 'abcdef', variant: 'release', build_datetime_utc: '20261013T120000Z', machine: 'c3', status: { secret: true } },
          mining_driver_sw: { name: 'driver', version: '1.8.2', arbitrary: 'secret' },
          pool_interface_sw: { name: 'pool', version: '2' },
          web_server: { name: 'server', version: '3' },
          web_dashboard: { name: 'dashboard', version: '4' },
          hashboard_firmware: { name: 'board', version: '5' },
          sw_update_status: { message: 'secret' },
          api_version: 'fabricated',
          cb_sn: 'secret'
        }
      })
    })
  })
  t.alike(await client.getFirmwareInfo(), {
    os: { name: 'Proto Linux', version: '1.8.2', git_hash: 'abcdef', variant: 'release', build_datetime_utc: '20261013T120000Z', machine: 'c3' },
    mining_driver_sw: { name: 'driver', version: '1.8.2' },
    pool_interface_sw: { name: 'pool', version: '2' },
    web_server: { name: 'server', version: '3' },
    web_dashboard: { name: 'dashboard', version: '4' },
    hashboard_firmware: { name: 'board', version: '5' }
  })
  t.is((await client.getSnap()).config.firmware_ver, '1.8.2')
})

test('firmware info rejects malformed present components and leaves without tightening snapshot', async (t) => {
  const components = ['os', 'mining_driver_sw', 'pool_interface_sw', 'web_server', 'web_dashboard', 'hashboard_firmware']
  for (const component of components) {
    const fields = component === 'os' ? ['name', 'version', 'git_hash', 'variant', 'build_datetime_utc', 'machine'] : ['name', 'version']
    for (const value of [null, [], 'invalid', ...fields.map(field => ({ [field]: 1 }))]) {
      const client = new ProtoRigClient({ id: 'R2-001', api: apiFixture({ getSystemInfo: async () => ({ 'system-info': { [component]: value } }) }) })
      await t.exception(client.getFirmwareInfo(), /ERR_SYSTEM_RESPONSE_INVALID/)
      if (component !== 'os' || (value && !Array.isArray(value) && typeof value === 'object' && value.version === undefined)) {
        t.is((await client.getSnap()).config.firmware_ver, undefined, 'snapshot ignores newly exposed firmware fields')
      }
    }
  }
})

test('detail channels preserve empty collections and absent optional readings', async (t) => {
  const client = new ProtoRigClient({
    id: 'R2-001',
    api: apiFixture({
      getErrors: async () => [],
      getPools: async () => [],
      getTelemetry: async () => ({ hashboards: [] }),
      getSystemInfo: async () => ({ 'system-info': {} })
    })
  })
  t.alike(await client.getErrors(), [])
  t.alike(await client.getPools(), [])
  t.alike(await client.getHashboards(), [])
  t.alike(await client.getFirmwareInfo(), {})
  t.alike(await client.getDeviceInfo(), { device_id: 'R2-001', network: { mode: 'dhcp', ip_address: '192.0.2.10', ip_gw: '192.0.2.1', ip_netmask: '255.255.255.0' } })

  const minimal = new ProtoRigClient({ id: 'R2-001', api: apiFixture() })
  t.alike(await minimal.getPools(), [{ url: 'stratum+tcp://pool:3333', username: 'worker', accepted: 10, rejected: 1, status: 'Active' }])
  t.alike(await minimal.getHashboards(), [
    { index: 0, temperature_c: { inlet: 45, outlet: 68, avg: 56 } },
    { index: 1, temperature_c: { inlet: 46, outlet: 70, avg: 58 } }
  ])
  const partial = new ProtoRigClient({ id: 'R2-001', api: apiFixture({ getSystemInfo: async () => ({ 'system-info': { os: {}, web_server: { name: '' } } }) }) })
  t.alike(await partial.getFirmwareInfo(), { os: {}, web_server: { name: '' } })
  const missingPoolOptions = new ProtoRigClient({ id: 'R2-001', api: apiFixture({ getPools: async () => [{ url: 'stratum+tcp://pool:3333', accepted: 0, rejected: 0 }] }) })
  t.alike(await missingPoolOptions.getPools(), [{ url: 'stratum+tcp://pool:3333', accepted: 0, rejected: 0 }])
  const zeroStale = new ProtoRigClient({ id: 'R2-001', api: apiFixture({ getPools: async () => [{ url: 'stratum+tcp://pool:3333', accepted: 0, rejected: 0, stale: 0 }] }) })
  t.alike(await zeroStale.getPools(), [{ url: 'stratum+tcp://pool:3333', accepted: 0, rejected: 0, stale: 0 }])
})

test('detail getters reject malformed source collections and required envelopes', async (t) => {
  for (const [method, apiMethod, values, error] of [
    ['getErrors', 'getErrors', [null, {}, [null], [[]]], /ERR_ERRORS_RESPONSE_INVALID/],
    ['getPools', 'getPools', [null, {}, [null], [[]]], /ERR_POOLS_RESPONSE_INVALID/],
    ['getHashboards', 'getTelemetry', [null, {}, { hashboards: {} }, { hashboards: [null] }], /ERR_TELEMETRY_RESPONSE_INVALID/],
    ['getDeviceInfo', 'getSystemInfo', [null, {}, { 'system-info': [] }], /ERR_SYSTEM_RESPONSE_INVALID/],
    ['getDeviceInfo', 'getNetworkInformation', [null, {}, { 'network-info': [] }], /ERR_NETWORK_RESPONSE_INVALID/],
    ['getFirmwareInfo', 'getSystemInfo', [null, {}, { 'system-info': [] }], /ERR_SYSTEM_RESPONSE_INVALID/]
  ]) {
    for (const value of values) {
      const client = new ProtoRigClient({ id: 'R2-001', api: apiFixture({ [apiMethod]: async () => value }) })
      await t.exception(client[method](), error)
    }
  }
})

test('detail getters query only their own available sources', async (t) => {
  const cases = [
    ['getErrors', ['getErrors']], ['getPools', ['getPools']], ['getHashboards', ['getTelemetry']],
    ['getDeviceInfo', ['getSystemInfo', 'getNetworkInformation']], ['getFirmwareInfo', ['getSystemInfo']]
  ]
  for (const [method, allowed] of cases) {
    const fixture = apiFixture()
    const calls = []
    const api = Object.fromEntries(Object.entries(fixture).map(([key, load]) => [key, async (...args) => {
      calls.push(key)
      if (!allowed.includes(key)) throw new Error('unrelated source down')
      return load(...args)
    }]))
    const client = new ProtoRigClient({ id: 'R2-001', api })
    await client[method]()
    t.alike(calls.sort(), allowed.slice().sort(), method)
  }
})

test('detail getters share caches with scalar and snapshot reads and honor writes', async (t) => {
  const fixture = apiFixture({ setPools: async () => {}, stopMining: async () => {}, reboot: async () => {} })
  const calls = {}
  const api = Object.fromEntries(Object.entries(fixture).map(([key, load]) => [key, async (...args) => {
    calls[key] = (calls[key] || 0) + 1
    return load(...args)
  }]))
  const client = new ProtoRigClient({ id: 'R2-001', api, cacheMs: 5000 })
  await Promise.all([
    client.getErrors(), client.getPools(), client.getHashboards(), client.getDeviceInfo(), client.getFirmwareInfo(),
    client.getPower(), client.getStatus(), client.getAcceptedShares(), client.getSnap()
  ])
  for (const key of ['getErrors', 'getPools', 'getTelemetry', 'getSystemInfo', 'getNetworkInformation']) t.is(calls[key], 1, key)
  await client.getFirmwareInfo()
  t.is(calls.getSystemInfo, 1, 'sequential reads reuse the same cache')
  await client.setupPools([{ url: 'stratum+tcp://pool:3333', worker_name: 'worker' }])
  await Promise.all([client.getPools(), client.getErrors(), client.getHashboards()])
  t.is(calls.getPools, 2)
  t.is(calls.getErrors, 2)
  t.is(calls.getTelemetry, 1)
  await client.setPowerMode('sleep')
  await Promise.all([client.getHashboards(), client.getErrors(), client.getDeviceInfo()])
  t.is(calls.getTelemetry, 2)
  t.is(calls.getErrors, 3)
  t.is(calls.getSystemInfo, 1)
  await client.reboot()
  await Promise.all([client.getDeviceInfo(), client.getFirmwareInfo()])
  t.is(calls.getSystemInfo, 2)
  t.is(calls.getNetworkInformation, 2)
})

test('detail caches stay local to each device and public projections do not mutate cached payloads', async (t) => {
  let firstCalls = 0
  let secondCalls = 0
  const firstPayload = [{ url: 'stratum+tcp://pool:3333', user: 'first', accepted: 1, rejected: 0 }]
  const first = new ProtoRigClient({ id: 'first', api: apiFixture({ getPools: async () => { firstCalls++; return firstPayload } }), cacheMs: 5000 })
  const second = new ProtoRigClient({ id: 'second', api: apiFixture({ getPools: async () => { secondCalls++; return [{ ...firstPayload[0], user: 'second', accepted: 2 }] } }), cacheMs: 5000 })
  const pools = await first.getPools()
  pools[0].accepted = 999
  t.is((await first.getPools())[0].accepted, 1)
  t.is((await second.getPools())[0].accepted, 2)
  t.is(firstPayload[0].user, 'first')
  t.is(firstCalls, 1)
  t.is(secondCalls, 1)
})
