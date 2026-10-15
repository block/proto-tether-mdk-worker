'use strict'

const test = require('brittle')
const { ApiV1 } = require('../../lib/api-v1')
const { ProtoRigClient } = require('../../lib/proto-rig-client')

function fixture (overrides = {}, options = {}) {
  return new ProtoRigClient({
    id: 'asic-rig',
    cacheMs: 5000,
    api: {
      getHashboardInfo: async () => ({ 'hashboards-info': [{ hb_sn: 'HB-1', slot: 3, board: 'B4_192', mining_asic: 'MC3', mining_asic_count: 192, ec_logs_path: '/private' }] }),
      getHashboardStatus: async () => ({
        'hashboard-stats': {
          hb_sn: 'HB-1',
          status: 'Running',
          asics: [{ index: 7, id: 'A7', row: 0, column: 7, freq_mhz: 650.05, temp_c: 45.5, voltage_mv: 308.44, hashrate_ghs: 300.5, ideal_hashrate_ghs: 320, error_rate: 3.3, message: 'private' }],
          fw_update: { message: 'private' }
        }
      }),
      ...overrides
    },
    ...options
  })
}

test('ASIC reads use documented envelopes and encode board serials as one path segment', async t => {
  const calls = []
  const api = new ApiV1({
    request: async path => {
      calls.push(path)
      return path === '/hashboards' ? { 'hashboards-info': [] } : { 'hashboard-stats': { asics: [] } }
    }
  })
  t.alike(await api.getHashboardInfo(), { 'hashboards-info': [] })
  t.alike(await api.getHashboardStatus('HB /?#'), { 'hashboard-stats': { asics: [] } })
  t.alike(calls, ['/hashboards', '/hashboards/HB%20%2F%3F%23'])
  for (const serial of ['', '.', '..', null]) await t.exception(api.getHashboardStatus(serial), /ERR_ASIC_STATS_RESPONSE_INVALID/)
  for (const payload of [null, [], {}, { 'hashboards-info': {} }, { 'hashboards-info': [null] }]) {
    await t.exception(new ApiV1({ request: async () => payload }).getHashboardInfo(), /ERR_ASIC_STATS_RESPONSE_INVALID/)
  }
  for (const payload of [null, [], {}, { 'hashboard-stats': [] }]) {
    await t.exception(new ApiV1({ request: async () => payload }).getHashboardStatus('HB-1'), /ERR_ASIC_STATS_RESPONSE_INVALID/)
  }
})

test('ASIC diagnostics expose current measurements and explicit identities without inferring health', async t => {
  t.alike(await fixture().getAsicStats(), {
    hashboards: [{
      serial_number: 'HB-1',
      slot: 3,
      board_type: 'B4_192',
      asic_type: 'MC3',
      expected_asic_count: 192,
      status: 'Running',
      reported_asic_count: 1,
      asics: [{ index: 7, id: 'A7', row: 0, column: 7, frequency_mhz: 650.05, temperature_c: 45.5, voltage_v: 0.30844, hashrate_ths: 0.3005, ideal_hashrate_ths: 0.32, error_rate_pct: 3.3 }]
    }]
  })
})

test('ASIC diagnostics preserve absent fields and distinguish empty from unavailable readings', async t => {
  const client = fixture({
    getHashboardInfo: async () => ({ 'hashboards-info': [{ hb_sn: 'HB-1' }] }),
    getHashboardStatus: async () => ({ 'hashboard-stats': { status: 'Stopped', asics: [{ index: 5, temp_c: -2, hashrate_ghs: 0 }] } })
  })
  t.alike(await client.getAsicStats(), { hashboards: [{ serial_number: 'HB-1', status: 'Stopped', reported_asic_count: 1, asics: [{ index: 5, temperature_c: -2, hashrate_ths: 0 }] }] })
  client.api.getHashboardStatus = async () => ({ 'hashboard-stats': { asics: [] } })
  t.alike((await client.getAsicStats()).hashboards[0], { serial_number: 'HB-1', reported_asic_count: 0, asics: [] })
  client.api.getHashboardStatus = async () => ({ 'hashboard-stats': {} })
  t.alike((await client.getAsicStats()).hashboards[0], { serial_number: 'HB-1' })
  client.api.getHashboardInfo = async () => ({ 'hashboards-info': [] })
  t.alike(await client.getAsicStats(), { hashboards: [] })
})

test('ASIC board failures stay isolated and never expose raw device errors', async t => {
  const client = fixture({
    getHashboardInfo: async () => ({ 'hashboards-info': [{ hb_sn: 'down' }, { hb_sn: 'invalid' }, { hb_sn: 'good', mining_asic_count: 2 }] }),
    getHashboardStatus: async serial => {
      if (serial === 'down') throw new Error('password=private')
      return { 'hashboard-stats': { asics: serial === 'invalid' ? [{ index: 0, temp_c: null }] : [{ index: 3 }] } }
    }
  })
  t.alike(await client.getAsicStats(), {
    hashboards: [
      { serial_number: 'down', error: 'ERR_ASIC_STATS_UNAVAILABLE' },
      { serial_number: 'invalid', error: 'ERR_ASIC_STATS_RESPONSE_INVALID' },
      { serial_number: 'good', expected_asic_count: 2, reported_asic_count: 1, asics: [{ index: 3 }] }
    ]
  })
})

test('ASIC diagnostics reject ambiguous inventory before board reads', async t => {
  let reads = 0
  for (const boards of [[{}], [{ hb_sn: '..' }], [{ hb_sn: 'same' }, { hb_sn: 'same' }], [{ hb_sn: 'HB-1', mining_asic_count: -1 }]]) {
    const client = fixture({ getHashboardInfo: async () => ({ 'hashboards-info': boards }), getHashboardStatus: async () => { reads++; return {} } })
    await t.exception(client.getAsicStats(), /ERR_ASIC_STATS_RESPONSE_INVALID/)
  }
  t.is(reads, 0)
})

test('ASIC diagnostics reject malformed readings and conflicting identities per board', async t => {
  const changes = [
    { hb_sn: 'another-board', asics: [] }, { status: 'invented', asics: [] }, { asics: null },
    { asics: [{}] }, { asics: [{ index: 1 }, { index: 1 }] }, { asics: [null] },
    ...['index', 'row', 'column'].flatMap(field => [-1, 0.5, null, Number.MAX_SAFE_INTEGER + 1].map(value => ({ asics: [{ index: 0, [field]: value }] }))),
    ...['freq_mhz', 'voltage_mv', 'hashrate_ghs', 'ideal_hashrate_ghs', 'error_rate'].flatMap(field => [-1, null, Infinity, '1'].map(value => ({ asics: [{ index: 0, [field]: value }] }))),
    { asics: [{ index: 0, temp_c: NaN }] }, { asics: [{ index: 0, id: 1 }] }
  ]
  for (const stats of changes) {
    const client = fixture({ getHashboardStatus: async () => ({ 'hashboard-stats': stats }) })
    t.is((await client.getAsicStats()).hashboards[0].error, 'ERR_ASIC_STATS_RESPONSE_INVALID')
  }
})

test('ASIC collection bounds board concurrency, preserves order and shares only overlapping reads', async t => {
  let inventories = 0
  let active = 0
  let peak = 0
  let reads = 0
  const releases = []
  const api = {
    getHashboardInfo: async () => { inventories++; return { 'hashboards-info': Array.from({ length: 5 }, (_, i) => ({ hb_sn: `HB-${i}` })) } },
    getHashboardStatus: async serial => {
      reads++
      peak = Math.max(peak, ++active)
      await new Promise(resolve => releases.push(resolve))
      active--
      return { 'hashboard-stats': { hb_sn: serial, asics: [{ index: 0 }] } }
    }
  }
  const client = fixture(api)
  const first = client.getAsicStats()
  const second = client.getAsicStats()
  for (let i = 0; i < 5; i++) {
    while (!releases.length) await new Promise(resolve => setImmediate(resolve))
    releases.pop()()
  }
  const [a, b] = await Promise.all([first, second])
  t.is(peak, 2)
  t.is(inventories, 1)
  t.is(reads, 5)
  t.alike(a.hashboards.map(board => board.serial_number), ['HB-0', 'HB-1', 'HB-2', 'HB-3', 'HB-4'])
  a.hashboards[0].asics[0].index = 999
  t.is(b.hashboards[0].asics[0].index, 0, 'callers receive independent projections')
  client.api.getHashboardStatus = async () => ({ 'hashboard-stats': { asics: [{ index: 4 }] } })
  const next = await client.getAsicStats()
  t.is(inventories, 2, 'even a 5000 ms legacy cache setting does not retain ASIC collections')
  t.is(next.hashboards[0].asics[0].index, 4)
  await fixture({ ...api, getHashboardStatus: async () => ({ 'hashboard-stats': { asics: [] } }) }).getAsicStats()
  t.is(inventories, 3, 'reads remain device-local')
})

test('failed ASIC inventory reads are retried on the next pull', async t => {
  let calls = 0
  const client = fixture({
    getHashboardInfo: async () => {
      if (++calls === 1) throw new Error('ERR_REQUEST_TIMEOUT')
      return { 'hashboards-info': [] }
    }
  })
  await t.exception(client.getAsicStats(), /ERR_REQUEST_TIMEOUT/)
  t.alike(await client.getAsicStats(), { hashboards: [] })
  t.is(calls, 2)
})

test('a mining write separates subsequent ASIC pulls from older outstanding readings', async t => {
  const pending = []
  let reads = 0
  const client = fixture({
    getHashboardStatus: async () => {
      reads++
      return new Promise((resolve, reject) => pending.push({ resolve, reject }))
    },
    stopMining: async () => ({})
  })
  const old = client.getAsicStats()
  while (pending.length < 1) await new Promise(resolve => setImmediate(resolve))
  await client.setPowerMode('sleep')
  const current = client.getAsicStats()
  while (pending.length < 2) await new Promise(resolve => setImmediate(resolve))
  pending[0].reject(new Error('ERR_REQUEST_TIMEOUT'))
  t.is((await old).hashboards[0].error, 'ERR_ASIC_STATS_UNAVAILABLE')
  const overlapping = client.getAsicStats()
  pending[1].resolve({ 'hashboard-stats': { status: 'Stopped', asics: [{ index: 0, hashrate_ghs: 0 }] } })
  const [a, b] = await Promise.all([current, overlapping])
  t.is(reads, 2, 'old completion does not evict the newer outstanding collection')
  t.alike(a, b)
  t.is(a.hashboards[0].status, 'Stopped')
  t.is(a.hashboards[0].asics[0].hashrate_ths, 0)
})
