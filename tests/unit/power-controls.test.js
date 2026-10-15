'use strict'

const test = require('brittle')
const { ApiV1 } = require('../../lib/api-v1')
const { ProtoRigClient } = require('../../lib/proto-rig-client')

const TARGET_COMMANDS = [
  ['setPowerTarget', 2800, 'setPowerTarget'],
  ['setPowerPreset', 'min', 'setPowerTarget'],
  ['setPerformanceMode', 'Efficiency', 'setPerformanceMode']
]

function fixture (id = 'power-rig') {
  const target = { power_target_watts: 3300, power_target_min_watts: 400, power_target_max_watts: 6000, performance_mode: 'MaximumHashrate', balance_bays: true, hash_on_disconnect: true }
  const calls = []
  const api = {
    getMiningTarget: async () => { calls.push('read'); return { ...target } },
    setPowerTarget: async watts => { calls.push({ power_target_watts: watts }); target.power_target_watts = watts; return { ...target } },
    setPerformanceMode: async mode => { calls.push({ performance_mode: mode }); target.performance_mode = mode; return { ...target } }
  }
  return { client: new ProtoRigClient({ id, api, cacheMs: 5000 }), api, target, calls }
}

test('performance-mode adapter writes only the selected policy', async t => {
  const calls = []
  const api = new ApiV1({ request: async (path, options) => { calls.push([path, options]); return { performance_mode: options.body.performance_mode } } })
  t.alike(await api.setPerformanceMode('Efficiency'), { performance_mode: 'Efficiency' })
  t.alike(calls, [['/mining/target', { method: 'PUT', body: { performance_mode: 'Efficiency' } }]])
})

test('performance policy changes preserve watts and unrelated target settings', async t => {
  const { client, target, calls } = fixture()
  for (const mode of ['Efficiency', 'MaximumHashrate']) {
    const result = await client.setPerformanceMode(mode)
    t.is(result.success, true)
    t.is(result.target.performance_mode, mode)
    t.is(target.power_target_watts, 3300)
    t.is(target.balance_bays, true)
    t.is(target.hash_on_disconnect, true)
  }
  t.alike(calls, [{ performance_mode: 'Efficiency' }, { performance_mode: 'MaximumHashrate' }], 'policy changes do not read and overwrite a stale watt target')
})

test('power presets resolve current bounds once and preserve the performance policy', async t => {
  const { client, target, calls } = fixture()
  target.performance_mode = 'Efficiency'
  await client.getPowerTarget()
  calls.length = 0
  target.power_target_min_watts = 500
  const minimum = await client.setPowerPreset('min')
  t.is(minimum.target.power_target_watts, 500)
  t.alike(calls, ['read', { power_target_watts: 500 }], 'uses fresh bounds rather than the warmed source cache')
  t.is(await client.getPowerTarget(), 500, 'preset invalidates the previous target reading')
  calls.length = 0
  target.power_target_max_watts = 7000
  const maximum = await client.setPowerPreset('max')
  t.is(maximum.target.power_target_watts, 7000)
  t.alike(calls, ['read', { power_target_watts: 7000 }])
  t.is(target.performance_mode, 'Efficiency')
  t.is(target.balance_bays, true)
  t.is(target.hash_on_disconnect, true)
})

test('power-control parameters fail before device I/O', async t => {
  const { client, calls } = fixture()
  for (const mode of [undefined, null, '', 'high', 'efficiency', {}, 1]) await t.exception(client.setPerformanceMode(mode), /ERR_PERFORMANCE_MODE_INVALID/)
  for (const preset of [undefined, null, '', 'high', 'minimum', {}, 1]) await t.exception(client.setPowerPreset(preset), /ERR_POWER_PRESET_INVALID/)
  t.alike(calls, [])
})

test('both power presets reject missing malformed or unsafe bounds before writing', async t => {
  const invalid = [
    {}, { power_target_min_watts: 0, power_target_max_watts: 6000 },
    { power_target_min_watts: 400, power_target_max_watts: 12001 },
    { power_target_min_watts: 6000, power_target_max_watts: 400 },
    { power_target_min_watts: 400.5, power_target_max_watts: 6000 },
    { power_target_min_watts: 400, power_target_max_watts: '6000' }
  ]
  for (const preset of ['min', 'max']) {
    for (const bounds of invalid) {
      const { client, api, calls } = fixture()
      api.getMiningTarget = async () => bounds
      await t.exception(client.setPowerPreset(preset), /ERR_POWER_TARGET_RESPONSE_INVALID/)
      t.alike(calls, [])
    }
  }
})

test('failed power writes invalidate affected readings and are never retried', async t => {
  for (const [method, value, source] of [['setPerformanceMode', 'Efficiency', 'setPerformanceMode'], ['setPowerPreset', 'max', 'setPowerTarget']]) {
    const { client, api, target } = fixture()
    await client.getPowerTarget()
    let attempts = 0
    api[source] = async () => {
      attempts++
      target.power_target_watts = 2800
      throw new Error('ERR_DEVICE_CONNECTION')
    }
    await t.exception(client[method](value), /ERR_DEVICE_CONNECTION/)
    t.is(attempts, 1)
    t.is(await client.getPowerTarget(), 2800, 'post-failure verification reads the rig again')
  }
})

test('target commands reject overlapping writes per device and release the guard after success or failure', async t => {
  for (const [method, value, source] of TARGET_COMMANDS) {
    for (const fail of [false, true]) {
      const { client, api, calls } = fixture()
      const originalWrite = api[source]
      let release
      let started
      let entered = false
      const gate = new Promise(resolve => { release = resolve })
      const ready = new Promise(resolve => { started = resolve })
      api[source] = async value => {
        if (!entered) {
          entered = true
          started()
          await gate
          if (fail) throw new Error('ERR_DEVICE_CONNECTION')
        }
        return originalWrite(value)
      }
      const pending = client[method](value)
      const completion = fail ? t.exception(pending, /ERR_DEVICE_CONNECTION/) : pending
      await ready
      const before = calls.length
      for (const [other, parameter] of TARGET_COMMANDS) {
        await t.exception(client[other](parameter), /ERR_COMMAND_IN_PROGRESS/, `${method} excludes ${other}`)
      }
      t.is(calls.length, before, 'rejected overlap performs no device I/O')
      t.is((await fixture('another-power-rig').client.setPerformanceMode('Efficiency')).success, true, 'another device remains independent')
      release()
      await completion
      api[source] = originalWrite
      t.is((await client.setPerformanceMode('Efficiency')).success, true, 'the guard is released')
    }
  }
})

test('target exclusion starts before the fresh bounds read and releases after a read failure', async t => {
  const { client, api } = fixture()
  const read = api.getMiningTarget
  let release
  let started
  let entered = false
  const gate = new Promise(resolve => { release = resolve })
  const ready = new Promise(resolve => { started = resolve })
  api.getMiningTarget = async () => {
    if (!entered) {
      entered = true
      started()
      await gate
    }
    return read()
  }
  const pending = client.setPowerPreset('min')
  await ready
  for (const [method, value] of TARGET_COMMANDS) await t.exception(client[method](value), /ERR_COMMAND_IN_PROGRESS/)
  release()
  await pending
  api.getMiningTarget = async () => { throw new Error('ERR_REQUEST_TIMEOUT') }
  await t.exception(client.setPowerPreset('max'), /ERR_REQUEST_TIMEOUT/)
  api.getMiningTarget = read
  t.is((await client.setPowerPreset('max')).success, true)
})

test('target commands reject missing malformed or contradictory echoes without retrying', async t => {
  for (const [method, value, source] of TARGET_COMMANDS) {
    for (const response of [undefined, null, [], {}, 'ok', { power_target_watts: 999, performance_mode: 'MaximumHashrate' }]) {
      const { client, api } = fixture()
      const originalWrite = api[source]
      let attempts = 0
      api[source] = async () => { attempts++; return response }
      await t.exception(client[method](value), /ERR_POWER_TARGET_WRITE_UNVERIFIED/)
      t.is(attempts, 1, 'an unverified write is not replayed')
      api[source] = originalWrite
      t.is((await client[method](value)).success, true, 'verification failure releases the guard')
    }
  }
})

test('watt target writes detect unexpected changes to known preserved settings', async t => {
  for (const method of ['setPowerTarget', 'setPowerPreset']) {
    for (const field of ['performance_mode', 'balance_bays', 'hash_on_disconnect']) {
      const { client, api, target } = fixture()
      target.performance_mode = 'Efficiency'
      const originalWrite = api.setPowerTarget
      api.setPowerTarget = async watts => {
        const updated = await originalWrite(watts)
        updated[field] = field === 'performance_mode' ? 'MaximumHashrate' : false
        return updated
      }
      await t.exception(client[method](method === 'setPowerTarget' ? 2800 : 'max'), /ERR_POWER_TARGET_WRITE_UNVERIFIED/, field)
    }
  }
})
