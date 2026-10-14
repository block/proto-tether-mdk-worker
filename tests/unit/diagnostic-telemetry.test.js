'use strict'

const test = require('brittle')
const { ProtoRigClient } = require('../../lib/proto-rig-client')

function clientFor (api, options = {}) {
  return new ProtoRigClient({ id: 'diagnostic-rig', api, ...options })
}

test('fans expose measured rpm and optional explicit slot and percentage', async (t) => {
  const payload = {
    'cooling-status': {
      fans: [
        { slot: 1, rpm: 4800, percentage: 55, position: 'secret' },
        { rpm: 0 },
        { slot: 3, rpm: 4900.5, percentage: 100 }
      ]
    }
  }
  const client = clientFor({ getCooling: async () => payload })
  const fans = await client.getFans()
  t.alike(fans, [{ rpm: 4800, slot: 1, percentage: 55 }, { rpm: 0 }, { rpm: 4900.5, slot: 3, percentage: 100 }])
  fans[0].rpm = 99
  t.is((await client.getFans())[0].rpm, 4800, 'projection cannot mutate the cached source')
  t.is(await client.getFanSpeed(), 3234, 'scalar uses the same actual readings')
  t.alike(await clientFor({ getCooling: async () => ({ 'cooling-status': { fans: [] } }) }).getFans(), [])
})

test('fans reject malformed present values and required source envelope', async (t) => {
  for (const fan of [null, [], {}, { rpm: '1' }, { rpm: -1 }, { rpm: Infinity },
    { rpm: 1, slot: -1 }, { rpm: 1, slot: null }, { rpm: 1, slot: 0.5 }, { rpm: 1, slot: Number.MAX_SAFE_INTEGER + 1 },
    { rpm: 1, percentage: -1 }, { rpm: 1, percentage: 101 }, { rpm: 1, percentage: 1.5 }, { rpm: 1, percentage: null }]) {
    const client = clientFor({ getCooling: async () => ({ 'cooling-status': { fans: [fan] } }) })
    await t.exception(client.getFans(), /ERR_COOLING_RESPONSE_INVALID/)
  }
  for (const payload of [null, [], {}, { 'cooling-status': [] }, { 'cooling-status': {} }, { 'cooling-status': { fans: {} } }]) {
    await t.exception(clientFor({ getCooling: async () => payload }).getFans(), /ERR_COOLING_RESPONSE_INVALID/)
  }
})

test('pool url prefers Active then first configured and shares validated credential-free urls', async (t) => {
  const pool = (url, status) => ({ url, status, accepted: 0, rejected: 0 })
  const api = { getPools: async () => [pool('stratum+tcp://first:3333', 'Alive'), pool('  stratum2+tcp://active:3336  ', 'Active')] }
  t.is(await clientFor(api).getPoolUrl(), 'stratum2+tcp://active:3336')
  t.is(await clientFor({ getPools: async () => [pool('stratum+tcp://first:3333', 'Dead'), pool('stratum+tcp://second:3333', 'Alive')] }).getPoolUrl(), 'stratum+tcp://first:3333')
  t.is(await clientFor({ getPools: async () => [] }).getPoolUrl(), null)
  for (const url of ['stratum+tcp://user:secret@pool:3333', '', 'pool:3333']) {
    await t.exception(clientFor({ getPools: async () => [pool(url, 'Active')] }).getPoolUrl(), /ERR_POOLS_RESPONSE_INVALID/)
  }
})

test('pools preserve absent optional counters and validate each present safe count', async (t) => {
  const pool = { url: 'stratum+tcp://pool:3333', accepted: 1, rejected: 2 }
  t.alike(await clientFor({ getPools: async () => [{ ...pool, stale: 0, invalid: 3, duplicate: 0, password: 'secret' }] }).getPools(), [{ ...pool, stale: 0, invalid: 3, duplicate: 0 }])
  t.alike(await clientFor({ getPools: async () => [pool] }).getPools(), [pool])
  for (const field of ['stale', 'invalid', 'duplicate']) {
    for (const value of [null, -1, 0.5, '1', Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      await t.exception(clientFor({ getPools: async () => [{ ...pool, [field]: value }] }).getPools(), /ERR_POOLS_RESPONSE_INVALID/)
    }
  }
})

test('PSU detail selects declared identity firmware and converts milli units to SI', async (t) => {
  const payload = {
    'psus-info': [{
      psu_sn: 'PSU-001',
      slot: 2,
      manufacturer: 'Chicony',
      model: '',
      vendor: '',
      hw_revision: 'v1.0',
      firmware: { app_version: '1.18.22', bootloader_version: '1.0', message: 'secret' },
      power: { input_voltage_mv: 240000, output_voltage_mv: 15380, input_current_ma: 20340, output_current_ma: 25150, input_power_mw: 386800, output_power_mw: 400000, arbitrary: 'secret' },
      temperatures: [{ temperature_type: 'hotspot', temperature_c: 40, message: 'secret' }, { temperature_type: 'ambient', temperature_c: -5 }],
      message: 'secret',
      arbitrary: 'secret'
    }],
    'psu-update-status': { message: 'secret' }
  }
  const client = clientFor({ getPowerSupplies: async () => payload })
  const projected = await client.getPsuInfo()
  t.alike(projected, {
    psus: [{
      serial_number: 'PSU-001',
      slot: 2,
      manufacturer: 'Chicony',
      model: '',
      vendor: '',
      hw_revision: 'v1.0',
      firmware: { app_version: '1.18.22', bootloader_version: '1.0' },
      power: { input_voltage_v: 240, output_voltage_v: 15.38, input_current_a: 20.34, output_current_a: 25.15, input_power_w: 386.8, output_power_w: 400 },
      temperatures: [{ type: 'hotspot', temperature_c: 40 }, { type: 'ambient', temperature_c: -5 }]
    }]
  })
  projected.psus[0].power.input_voltage_v = 99
  t.is((await client.getPsuInfo()).psus[0].power.input_voltage_v, 240)
})

test('PSU detail preserves empty arrays and absent optional source fields', async (t) => {
  for (const [source, expected] of [
    [[], []], [[{}], [{}]],
    [[{ firmware: {}, power: {}, temperatures: [{}, { temperature_c: 0 }] }], [{ firmware: {}, power: {}, temperatures: [{}, { temperature_c: 0 }] }]]
  ]) {
    t.alike(await clientFor({ getPowerSupplies: async () => ({ 'psus-info': source }) }).getPsuInfo(), { psus: expected })
  }
})

test('PSU detail rejects malformed declared fields without publishing free-form siblings', async (t) => {
  const changes = [null, [], ...['psu_sn', 'manufacturer', 'model', 'vendor', 'hw_revision'].flatMap(field => [{ [field]: null }, { [field]: 1 }]),
    ...[-1, 0.5, null, Number.MAX_SAFE_INTEGER + 1].map(slot => ({ slot })),
    ...[null, [], 'invalid', { app_version: 1 }, { bootloader_version: null }].map(firmware => ({ firmware })),
    ...[null, [], 'invalid'].map(power => ({ power })),
    ...[null, {}, [null], [[]], [{ temperature_type: 1 }], [{ temperature_c: Infinity }], [{ temperature_c: null }]].map(temperatures => ({ temperatures }))]
  for (const field of ['input_voltage_mv', 'output_voltage_mv', 'input_current_ma', 'output_current_ma', 'input_power_mw', 'output_power_mw']) {
    for (const value of [-1, '1', null, Infinity, NaN]) changes.push({ power: { [field]: value } })
  }
  for (const psu of changes) {
    await t.exception(clientFor({ getPowerSupplies: async () => ({ 'psus-info': [psu] }) }).getPsuInfo(), /ERR_PSUS_RESPONSE_INVALID/)
  }
  for (const payload of [null, [], {}, { 'psus-info': {} }]) {
    await t.exception(clientFor({ getPowerSupplies: async () => payload }).getPsuInfo(), /ERR_PSUS_RESPONSE_INVALID/)
  }
})

test('hashrate history preserves source values null gaps and declared aggregates', async (t) => {
  const client = clientFor({
    getHashrateHistory: async duration => ({
      'hashrate-data': {
        duration,
        data: [{ datetime: 1704067200, value: 95.5, arbitrary: 'secret' }, { datetime: 1704067260, value: null }],
        aggregates: { min: 0, avg: null, max: null, arbitrary: 'secret' },
        unit: 'undocumented',
        hashrate_rt: { fabricated: 1 }
      },
      secret: true
    })
  })
  t.alike(await client.getHashrateHistory(), {
    duration: '1h',
    data: [{ datetime: 1704067200, value: 95.5 }, { datetime: 1704067260, value: null }],
    aggregates: { min: 0, avg: null, max: null }
  })
  const projection = await client.getHashrateHistory()
  projection.data[0].value = 99
  t.is((await client.getHashrateHistory()).data[0].value, 95.5)
  t.alike(await clientFor({ getHashrateHistory: async duration => ({ 'hashrate-data': { duration, data: [] } }) }).getHashrateHistory({ duration: '5d' }), { duration: '5d', data: [] })
  t.alike(await clientFor({ getHashrateHistory: async duration => ({ 'hashrate-data': { duration, data: [], aggregates: {} } }) }).getHashrateHistory(), { duration: '1h', data: [], aggregates: {} })
})

test('hashrate history validates duration before I/O and malformed source values', async (t) => {
  let calls = 0
  const client = clientFor({ getHashrateHistory: async () => { calls++; return {} } })
  for (const params of [null, [], '1h', { duration: null }, { duration: 1 }, { duration: '2h' }, { duration: '1h', other: true }]) {
    await t.exception(client.getHashrateHistory(params), /ERR_HASHRATE_DURATION_INVALID/)
  }
  t.is(calls, 0)
  const changes = [null, [], {}, { duration: '12h', data: [] }, { duration: 'wrong', data: [] },
    { duration: '1h', data: {} }, { duration: '1h', data: [null] }, { duration: '1h', data: [[]] }]
  for (const datetime of [undefined, null, '1', -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) changes.push({ duration: '1h', data: [{ datetime, value: 1 }] })
  for (const value of [undefined, '1', -1, Infinity, NaN]) changes.push({ duration: '1h', data: [{ datetime: 1, value }] })
  for (const aggregates of [null, [], { min: null }, { min: -1 }, { avg: '1' }, { max: Infinity }]) changes.push({ duration: '1h', data: [], aggregates })
  for (const data of changes) {
    await t.exception(clientFor({ getHashrateHistory: async () => ({ 'hashrate-data': data }) }).getHashrateHistory(), /ERR_HASHRATE_RESPONSE_INVALID/)
  }
  for (const payload of [null, [], {}, { duration: '1h', data: [] }]) {
    await t.exception(clientFor({ getHashrateHistory: async () => payload }).getHashrateHistory(), /ERR_HASHRATE_RESPONSE_INVALID/)
  }
})

test('history accepts exactly the declared durations without changing firmware units', async (t) => {
  const durations = []
  const client = clientFor({
    getHashrateHistory: async duration => {
      durations.push(duration)
      return { 'hashrate-data': { duration, data: [{ datetime: 0, value: 95500000000000 }] } }
    }
  })
  for (const duration of ['1h', '12h', '24h', '48h', '5d']) {
    t.alike(await client.getHashrateHistory({ duration }), { duration, data: [{ datetime: 0, value: 95500000000000 }] })
  }
  t.alike(durations, ['1h', '12h', '24h', '48h', '5d'])
})

test('detail-only fan metadata and pool counters leave legacy snapshot unchanged', async (t) => {
  const client = clientFor({
    getMiningStatus: async () => ({ status: 'Mining', reboot_uptime_s: 1 }),
    getTelemetry: async () => ({
      miner: { hashrate: { unit: 'TH/s', value: 1 }, temperature: { unit: '°C', value: 20 }, power: { unit: 'W', value: 100 }, efficiency: { unit: 'J/TH', value: 100 } },
      hashboards: []
    }),
    getErrors: async () => [],
    getMiningTarget: async () => ({ power_target_watts: 100 }),
    getSystemInfo: async () => ({ 'system-info': {} }),
    getNetworkInformation: async () => ({ 'network-info': { dhcp: true, ip: '192.0.2.1', gateway: '192.0.2.2', netmask: '255.255.255.0' } }),
    getCooling: async () => ({ 'cooling-status': { fans: [{ rpm: 4000, slot: 'invalid', percentage: -1 }] } }),
    getPools: async () => [{ url: 'stratum+tcp://pool:3333', accepted: 1, rejected: 0, invalid: 'invalid', duplicate: -1 }]
  })
  const snap = await client.getSnap()
  t.alike(snap.stats.cooling.fans, [{ rpm: 4000 }])
  t.alike(snap.stats.all_pools_shares, { accepted: 1, rejected: 0, stale: 0 })
  t.alike(snap.stats.pool_status, [{ pool: 'stratum+tcp://pool:3333', accepted: 1, rejected: 0, stale: 0, status: undefined }])
  await t.exception(client.getFans(), /ERR_COOLING_RESPONSE_INVALID/)
  await t.exception(client.getPools(), /ERR_POOLS_RESPONSE_INVALID/)
})

test('diagnostic sources cache per device and history duration while failures propagate', async (t) => {
  const calls = { cooling: 0, pools: 0, psus: 0, history: [] }
  const api = {
    getCooling: async () => { calls.cooling++; return { 'cooling-status': { fans: [{ rpm: 4000 }] } } },
    getPools: async () => { calls.pools++; return [{ url: 'stratum+tcp://pool:3333', accepted: 0, rejected: 0 }] },
    getPowerSupplies: async () => { calls.psus++; return { 'psus-info': [] } },
    getHashrateHistory: async duration => { calls.history.push(duration); return { 'hashrate-data': { duration, data: [] } } },
    reboot: async () => {},
    setPools: async () => {}
  }
  const first = clientFor(api, { cacheMs: 5000 })
  const second = clientFor(api, { cacheMs: 5000 })
  await Promise.all([first.getFans(), first.getFanSpeed(), first.getPoolUrl(), first.getPools(), first.getPsuInfo(), first.getPsuInfo(), first.getHashrateHistory(), first.getHashrateHistory({ duration: '1h' }), first.getHashrateHistory({ duration: '12h' })])
  t.alike(calls, { cooling: 1, pools: 1, psus: 1, history: ['1h', '12h'] })
  await second.getPsuInfo()
  await second.getHashrateHistory()
  t.is(calls.psus, 2, 'PSU cache stays local to the device')
  t.alike(calls.history, ['1h', '12h', '1h'], 'history cache stays local to the device')
  await first.setupPools([{ url: 'stratum+tcp://pool:3333', worker_name: 'worker' }])
  await first.getPoolUrl()
  t.is(calls.pools, 2, 'existing pool writes invalidate the shared pool source')
  await first.reboot()
  await Promise.all([first.getFans(), first.getPsuInfo(), first.getHashrateHistory(), first.getHashrateHistory({ duration: '12h' })])
  t.is(calls.cooling, 2)
  t.is(calls.psus, 3)
  t.alike(calls.history, ['1h', '12h', '1h', '1h', '12h'], 'reboot clears all duration entries')
  for (const [getter, source] of [['getFans', 'getCooling'], ['getPoolUrl', 'getPools'], ['getPsuInfo', 'getPowerSupplies'], ['getHashrateHistory', 'getHashrateHistory']]) {
    let attempts = 0
    const broken = clientFor({ [source]: async () => { attempts++; throw new Error('ERR_HTTP_TIMEOUT') } }, { cacheMs: 5000 })
    await t.exception(broken[getter](), /ERR_HTTP_TIMEOUT/)
    await t.exception(broken[getter](), /ERR_HTTP_TIMEOUT/)
    t.is(attempts, 2, 'failed sources do not produce an empty fallback or cached success')
  }
})
