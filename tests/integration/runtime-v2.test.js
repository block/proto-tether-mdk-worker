'use strict'

const path = require('node:path')
const test = require('brittle')
const { createServer } = require('../../mock/server')

const MDK_REPO = path.resolve(process.env.MDK_REPO || '/tmp/mdk-latest')
const WorkerRuntimeV2 = require(path.join(MDK_REPO, 'backend/core/mdk-worker/lib/worker-runtime-v2'))
const { build } = require(path.join(MDK_REPO, 'backend/core/kernel/lib/protocol/envelope'))
const { ACTIONS, MESSAGE_TYPES } = require(path.join(MDK_REPO, 'backend/core/kernel/lib/protocol/actions'))
const WORKER_DIR = path.resolve(__dirname, '../..')

function request (action, deviceId, payload = {}) {
  return build({ action, type: MESSAGE_TYPES.REQUEST, sender: 'runtime-test', target: 'proto-test', deviceId, payload })
}

function seenAuthHeaders (state) {
  return state.requests
    .map(request => request.authorization)
    .filter(Boolean)
}

function uniqueAuthHeaders (state) {
  return [...new Set(seenAuthHeaders(state))]
}

function createCleanupStack (t) {
  const cleanups = []
  let cleaned = false

  async function cleanupAll () {
    if (cleaned) return
    cleaned = true
    await closeCleanups(cleanups)
  }

  t.teardown(cleanupAll)
  return {
    add: cleanup => {
      cleanups.push(cleanup)
    },
    cleanupAll
  }
}

async function closeCleanups (cleanups) {
  const results = await Promise.allSettled([...cleanups].reverse().map(cleanup => Promise.resolve().then(cleanup)))
  const errors = results.filter(result => result.status === 'rejected')
  if (errors.length) throw errors[0].reason
}

function assertResponseEnvelope (t, response, requestEnvelope, action, deviceId) {
  t.ok(typeof response.id === 'string')
  t.is(response.id === requestEnvelope.id, false)
  t.is(response.version, requestEnvelope.version)
  t.is(response.type, MESSAGE_TYPES.RESPONSE)
  t.is(response.action, action)
  t.is(response.sender, 'proto-test')
  t.is(response.target, requestEnvelope.sender)
  t.is(response.deviceId, deviceId)
}

test('cleanup stack closes every resource and surfaces failures', async (t) => {
  const calls = []
  await t.exception(closeCleanups([
    () => { calls.push('first') },
    () => { calls.push('second'); throw new Error('close-two') },
    async () => { calls.push('third') }
  ]), /close-two/)
  t.alike(calls, ['third', 'second', 'first'])
})

test('WorkerRuntimeV2 keeps device state isolated and publishes clean envelopes', async (t) => {
  const cleanup = createCleanupStack(t)
  const first = createServer({ password: 'first-device-password', tokenSeq: 0 })
  cleanup.add(() => first.close())
  const second = createServer({ password: 'second-password', tokenSeq: 100 })
  cleanup.add(() => second.close())
  const [firstAddress, secondAddress] = await Promise.all([first.ready, second.ready])

  first.state.telemetry.miner.hashrate.value = 95.5
  first.state.telemetry.miner.power.value = 3250
  first.state.telemetry.miner.temperature.value = 65.5
  second.state.telemetry.miner.hashrate.value = 87.25
  second.state.telemetry.miner.power.value = 2400
  second.state.telemetry.miner.temperature.value = 61.25

  const runtime = new WorkerRuntimeV2(WORKER_DIR, {
    workerId: 'proto-test',
    env: { bearerToken: 'synthetic-env-bearer-secret' },
    config: { refreshToken: 'synthetic-config-refresh-secret', url: 'https://secret.invalid' },
    devices: [
      {
        deviceId: 'proto-1',
        config: {
          address: '127.0.0.1',
          port: firstAddress.port,
          password: 'first-device-password',
          accessToken: 'mock-access-1',
          refreshToken: 'mock-refresh-1'
        }
      },
      { deviceId: 'proto-2', config: { address: '127.0.0.1', port: secondAddress.port, password: 'second-password' } }
    ]
  })
  cleanup.add(() => runtime.stop())

  try {
    await runtime.start()

    const identityRequest = request(ACTIONS.IDENTITY_REQUEST, null)
    const identity = await runtime.handleRequest(identityRequest)
    assertResponseEnvelope(t, identity, identityRequest, ACTIONS.IDENTITY_RESPONSE, null)
    t.is(identity.payload.workerId, 'proto-test')
    t.alike(identity.payload.devices.map(item => item.deviceId), ['proto-1', 'proto-2'])

    const capabilityRequest = request(ACTIONS.CAPABILITY_REQUEST, null)
    const capability = await runtime.handleRequest(capabilityRequest)
    assertResponseEnvelope(t, capability, capabilityRequest, ACTIONS.CAPABILITY_RESPONSE, null)
    t.is(capability.payload.contract.metadata.provider, 'proto')
    t.is(capability.payload.contract.capabilities.telemetry.length, 22)
    t.ok(capability.payload.contract.capabilities.telemetry.some(entry => entry.name === 'health'))
    for (const entry of capability.payload.contract.capabilities.telemetry) t.is(entry.handler, undefined)
    for (const entry of capability.payload.contract.capabilities.commands) t.is(entry.handler, undefined)

    const healthRequest = request(ACTIONS.TELEMETRY_PULL, 'proto-1', {
      query: { type: 'health' }
    })
    const health = await runtime.handleRequest(healthRequest)
    assertResponseEnvelope(t, health, healthRequest, ACTIONS.TELEMETRY_RESPONSE, 'proto-1')
    t.is(health.payload.name, 'health')
    t.alike(health.payload.value, { status: 'OK' })

    const metricsRequest = request(ACTIONS.TELEMETRY_PULL, 'proto-1', {
      query: { type: 'metrics' }
    })
    const metrics = await runtime.handleRequest(metricsRequest)
    assertResponseEnvelope(t, metrics, metricsRequest, ACTIONS.TELEMETRY_RESPONSE, 'proto-1')
    t.alike(metrics.payload.metrics.health, { status: 'OK' })
    t.is(Object.keys(metrics.payload.metrics).length, 22)

    const serializedTelemetry = `${JSON.stringify(health)}\n${JSON.stringify(metrics)}`.toLowerCase()
    for (const forbidden of [
      'first-device-password',
      'mock-access-1',
      'mock-refresh-1',
      'synthetic-env-bearer-secret',
      'synthetic-config-refresh-secret',
      'accesstoken',
      'refreshtoken',
      'password'
    ]) t.is(serializedTelemetry.includes(forbidden), false, `telemetry omits ${forbidden}`)

    const hashrateRequest = request(ACTIONS.TELEMETRY_PULL, 'proto-1', {
      query: { type: 'hashrate_avg' }
    })
    const hashrate = await runtime.handleRequest(hashrateRequest)
    assertResponseEnvelope(t, hashrate, hashrateRequest, ACTIONS.TELEMETRY_RESPONSE, 'proto-1')
    t.is(hashrate.payload.deviceId, 'proto-1')
    t.is(hashrate.payload.name, 'hashrate_avg')
    t.is(hashrate.payload.value, 95.5)
    t.ok(typeof hashrate.payload.timestamp === 'number')

    const powerRequest = request(ACTIONS.TELEMETRY_PULL, 'proto-2', {
      query: { type: 'power' }
    })
    const power = await runtime.handleRequest(powerRequest)
    assertResponseEnvelope(t, power, powerRequest, ACTIONS.TELEMETRY_RESPONSE, 'proto-2')
    t.is(power.payload.deviceId, 'proto-2')
    t.is(power.payload.name, 'power')
    t.is(power.payload.value, 2400)
    t.ok(typeof power.payload.timestamp === 'number')

    const ledRequest = request(ACTIONS.COMMAND_REQUEST, 'proto-2', {
      commandId: 'led-1',
      command: 'setLED',
      params: { enabled: true }
    })
    const led = await runtime.handleRequest(ledRequest)
    assertResponseEnvelope(t, led, ledRequest, ACTIONS.COMMAND_RESULT, 'proto-2')
    t.is(led.payload.commandId, 'led-1')
    t.is(led.payload.status, 'SUCCESS')
    t.is(led.payload.result.success, true)
    t.is(second.state.led, true)
    t.is(first.state.led, false)

    const targetRequest = request(ACTIONS.COMMAND_REQUEST, 'proto-1', {
      commandId: 'target-1',
      command: 'setPowerTarget',
      params: { watts: 200 }
    })
    const target = await runtime.handleRequest(targetRequest)
    assertResponseEnvelope(t, target, targetRequest, ACTIONS.COMMAND_RESULT, 'proto-1')
    t.is(target.payload.commandId, 'target-1')
    t.is(target.payload.status, 'FAILED')
    t.ok(/ERR_POWER_TARGET_OUT_OF_RANGE/.test(target.payload.error))

    t.alike(uniqueAuthHeaders(first.state), ['Bearer mock-access-1'])
    t.alike(uniqueAuthHeaders(second.state), ['Bearer mock-access-101'])
  } finally {
    await cleanup.cleanupAll()
  }
})

test('native performance policies and min/max power presets preserve independent settings', async (t) => {
  const cleanup = createCleanupStack(t)
  const first = createServer()
  const second = createServer({ tokenSeq: 100 })
  cleanup.add(() => first.close())
  cleanup.add(() => second.close())
  const [one, two] = await Promise.all([first.ready, second.ready])
  Object.assign(first.state.target, { balance_bays: true, hash_on_disconnect: true })
  const runtime = new WorkerRuntimeV2(WORKER_DIR, {
    workerId: 'power-worker',
    devices: [
      { deviceId: 'power-1', config: { address: '127.0.0.1', port: one.port, password: 'test-password', cacheMs: 5000 } },
      { deviceId: 'power-2', config: { address: '127.0.0.1', port: two.port, password: 'test-password', cacheMs: 5000 } }
    ]
  })
  cleanup.add(() => runtime.stop())
  try {
    await runtime.start()
    let id = 0
    const command = async (name, params, deviceId = 'power-1') => (await runtime.handleRequest(request(ACTIONS.COMMAND_REQUEST, deviceId, {
      commandId: `power-${++id}`, command: name, params
    }))).payload
    const snap = async () => (await runtime.handleRequest(request(ACTIONS.TELEMETRY_PULL, 'power-1', { query: { type: 'snap' } }))).payload.value
    const initial = await snap()
    t.is(initial.config.performance_mode, 'MaximumHashrate')
    const efficiency = await command('setPerformanceMode', { mode: 'Efficiency' })
    t.is(efficiency.status, 'SUCCESS')
    t.is(efficiency.result.target.performance_mode, 'Efficiency')
    t.is(first.state.target.power_target_watts, 3300)
    t.is((await snap()).config.performance_mode, 'Efficiency', 'a warmed snapshot reads the new policy')
    first.state.target.power_target_min_watts = 500
    const minimum = await command('setPowerPreset', { preset: 'min' })
    t.is(minimum.status, 'SUCCESS')
    t.is(minimum.result.target.power_target_watts, 500, 'uses freshly reported bounds')
    t.is((await snap()).config.power_target_watts, 500)
    first.state.target.power_target_max_watts = 7000
    t.is((await command('setPowerPreset', { value: 'max' })).result.target.power_target_watts, 7000, 'positional preset maps through the contract')
    t.is((await command('setPerformanceMode', { args: ['MaximumHashrate'] })).status, 'SUCCESS')
    t.is(first.state.target.performance_mode, 'MaximumHashrate')
    t.is(first.state.target.power_target_watts, 7000)
    t.is(first.state.target.balance_bays, true)
    t.is(first.state.target.hash_on_disconnect, true)
    t.is(first.state.mining.status, 'Mining', 'target controls do not start or stop mining')
    t.is(second.state.target.power_target_watts, 3300, 'writes remain device-local')
    const before = first.state.requests.length
    t.is((await command('setPowerPreset', { preset: 'high' })).error, 'ERR_POWER_PRESET_INVALID')
    t.is((await command('setPerformanceMode', { mode: 'efficiency' })).error, 'ERR_PERFORMANCE_MODE_INVALID')
    t.is(first.state.requests.length, before, 'invalid parameters do not reach the device')
    second.state.mining.status = 'Stopped'
    t.is((await command('setPerformanceMode', { mode: 'Efficiency' }, 'power-2')).status, 'SUCCESS')
    t.is(second.state.target.performance_mode, 'Efficiency')
    t.is(second.state.mining.status, 'Stopped', 'policy changes do not start a stopped rig')
    t.is(first.state.target.performance_mode, 'MaximumHashrate')
  } finally {
    await cleanup.cleanupAll()
  }
})

test('target echo mismatches produce FAILED command results without retrying writes', async t => {
  const cleanup = createCleanupStack(t)
  const firmware = createServer()
  cleanup.add(() => firmware.close())
  const address = await firmware.ready
  let target = firmware.state.target
  Object.defineProperty(firmware.state, 'target', {
    get: () => target,
    set: updated => { target = { ...updated, performance_mode: 'MaximumHashrate' } }
  })
  const runtime = new WorkerRuntimeV2(WORKER_DIR, {
    workerId: 'unverified-power-worker',
    devices: [{ deviceId: 'power-1', config: { address: '127.0.0.1', port: address.port, password: 'test-password' } }]
  })
  cleanup.add(() => runtime.stop())
  try {
    await runtime.start()
    for (const [command, params] of [
      ['setPerformanceMode', { mode: 'Efficiency' }],
      ['setPowerPreset', { preset: 'min' }]
    ]) {
      target.performance_mode = 'Efficiency'
      const before = firmware.state.writeAttempts['/api/v1/mining/target'] || 0
      const result = (await runtime.handleRequest(request(ACTIONS.COMMAND_REQUEST, 'power-1', {
        commandId: command, command, params
      }))).payload
      t.is(result.status, 'FAILED')
      t.is(result.error, 'ERR_POWER_TARGET_WRITE_UNVERIFIED')
      t.is(firmware.state.writeAttempts['/api/v1/mining/target'], before + 1, 'the uncertain write is not replayed')
    }
    t.is(target.power_target_watts, target.power_target_min_watts, 'a failed verification does not undo the physical write')
  } finally {
    await cleanup.cleanupAll()
  }
})

test('health derives safe device state without exposing failures', async (t) => {
  const cleanup = createCleanupStack(t)
  const statusByPath = {}
  const firmware = createServer({ password: 'health-device-password', statusByPath })
  cleanup.add(() => firmware.close())
  const address = await firmware.ready

  const runtime = new WorkerRuntimeV2(WORKER_DIR, {
    workerId: 'proto-test',
    devices: [
      {
        deviceId: 'proto-health',
        config: { address: '127.0.0.1', port: address.port, password: 'health-device-password', cacheMs: 0 }
      },
      {
        deviceId: 'proto-misconfigured',
        config: { address: '127.0.0.1', port: address.port, cacheMs: 0 }
      }
    ]
  })
  cleanup.add(() => runtime.stop())

  try {
    await runtime.start()
    const health = async (deviceId = 'proto-health') => {
      const req = request(ACTIONS.TELEMETRY_PULL, deviceId, { query: { type: 'health' } })
      const response = await runtime.handleRequest(req)
      assertResponseEnvelope(t, response, req, ACTIONS.TELEMETRY_RESPONSE, deviceId)
      return response.payload.value
    }

    t.alike(await health(), { status: 'OK' })
    t.alike(await health('proto-misconfigured'), { status: 'OFFLINE' })

    statusByPath['/api/v1/mining'] = 204
    t.alike(await health(), { status: 'OK' })
    delete statusByPath['/api/v1/mining']

    firmware.state.errors = [{ source: 'fan', slot: 0, timestamp: 1764160757 }]
    t.alike(await health(), { status: 'DEGRADED' })

    statusByPath['/api/v1/errors'] = 503
    const offline = await health()
    t.alike(offline, { status: 'OFFLINE' })
    t.is(JSON.stringify(offline).includes('503'), false)
    t.is(JSON.stringify(offline).includes('health-device-password'), false)
  } finally {
    await cleanup.cleanupAll()
  }
})

test('psu_info is discoverable and reports isolated PSU reads and errors through the runtime', async (t) => {
  const cleanup = createCleanupStack(t)
  const statusByPath = { '/api/v1/mining': 503, '/api/v1/mining/target': 503 }
  const first = createServer({ statusByPath })
  const second = createServer({ tokenSeq: 100 })
  cleanup.add(() => first.close())
  cleanup.add(() => second.close())
  const [firstAddress, secondAddress] = await Promise.all([first.ready, second.ready])
  first.state.psus = [{
    psu_sn: 'PSU-FIRST',
    slot: 1,
    firmware: { app_version: 'psu-v1', message: 'PSU-WIRE-SECRET' },
    power: { input_voltage_mv: 240000, output_power_mw: 3146000, accessToken: 'PSU-WIRE-SECRET' },
    temperatures: [{ temperature_type: 'hotspot', temperature_c: 48 }],
    password: 'PSU-WIRE-SECRET'
  }]
  second.state.psus = []
  const expected = {
    psus: [{
      serial_number: 'PSU-FIRST',
      slot: 1,
      firmware: { app_version: 'psu-v1' },
      power: { input_voltage_v: 240, output_power_w: 3146 },
      temperatures: [{ type: 'hotspot', temperature_c: 48 }]
    }]
  }
  const runtime = new WorkerRuntimeV2(WORKER_DIR, {
    workerId: 'proto-test',
    devices: [
      { deviceId: 'psu-1', config: { address: '127.0.0.1', port: firstAddress.port, password: 'test-password', cacheMs: 0 } },
      { deviceId: 'psu-2', config: { address: '127.0.0.1', port: secondAddress.port, password: 'test-password', cacheMs: 0 } }
    ]
  })
  cleanup.add(() => runtime.stop())

  try {
    await runtime.start()
    const capability = await runtime.handleRequest(request(ACTIONS.CAPABILITY_REQUEST, null))
    const channel = capability.payload.contract.capabilities.telemetry.find(entry => entry.name === 'psu_info')
    t.is(channel?.type, 'object', 'PSU information is discoverable as object telemetry')
    t.is(channel?.handler, undefined, 'discovery omits the private handler path')
    const pull = (type, deviceId = 'psu-1') => runtime.handleRequest(request(ACTIONS.TELEMETRY_PULL, deviceId, { query: { type } }))
    const direct = await pull('psu_info')
    t.is(direct.payload.name, 'psu_info')
    t.alike(direct.payload.value, expected, 'direct reads project PSU details and convert milliunits')
    t.alike((await pull('psu_info', 'psu-2')).payload.value, { psus: [] }, 'empty PSU inventories remain isolated by device')
    t.alike(first.state.requests.filter(entry => entry.method === 'GET').map(entry => entry.path), ['/api/v1/hardware/psus'], 'PSU reads do not depend on mining or snapshot endpoints')

    const metrics = (await pull('metrics')).payload.metrics
    t.alike(metrics.psu_info, expected, 'aggregate metrics include the same PSU projection')
    const wire = JSON.stringify({ direct, metrics })
    for (const forbidden of ['PSU-WIRE-SECRET', 'test-password', 'mock-access-', 'mock-refresh-', 'accessToken', 'password']) {
      t.is(wire.includes(forbidden), false, `PSU telemetry omits ${forbidden}`)
    }

    statusByPath['/api/v1/hardware/psus'] = 503
    const failed = await pull('psu_info')
    t.is(failed.payload.error, 'ERR_HTTP_RESPONSE: 503')
    t.is(Object.hasOwn(failed.payload, 'value'), false, 'failed reads never become empty inventories')
    const failedMetrics = (await pull('metrics')).payload.metrics
    t.alike(failedMetrics.psu_info, { error: 'ERR_HTTP_RESPONSE: 503' })
    t.is(failedMetrics.power, 3250, 'a PSU failure does not suppress independent telemetry')
    delete statusByPath['/api/v1/hardware/psus']
    first.state.psus = null
    t.is((await pull('psu_info')).payload.error, 'ERR_PSUS_RESPONSE_INVALID', 'malformed successful responses keep their validation error')
    t.alike((await pull('psu_info', 'psu-2')).payload.value, { psus: [] }, 'another rig remains readable after a PSU failure')
  } finally {
    await cleanup.cleanupAll()
  }
})

test('current diagnostics support runtime discovery and independent failures', async (t) => {
  const cleanup = createCleanupStack(t)
  const statusByPath = { '/api/v1/mining': 503, '/api/v1/mining/target': 503 }
  const first = createServer({ statusByPath })
  const second = createServer({ tokenSeq: 100 })
  cleanup.add(() => first.close())
  cleanup.add(() => second.close())
  const [firstAddress, secondAddress] = await Promise.all([first.ready, second.ready])
  first.state.cooling.fans = [{ slot: 3, rpm: 4500, percentage: 60, password: 'DIAGNOSTIC-SECRET' }]
  second.state.cooling.fans = []
  second.state.pools = []
  const runtime = new WorkerRuntimeV2(WORKER_DIR, {
    workerId: 'proto-test',
    devices: [
      { deviceId: 'diag-1', config: { address: '127.0.0.1', port: firstAddress.port, password: 'test-password', cacheMs: 5000 } },
      { deviceId: 'diag-2', config: { address: '127.0.0.1', port: secondAddress.port, password: 'test-password', cacheMs: 0 } }
    ]
  })
  cleanup.add(() => runtime.stop())
  try {
    await runtime.start()
    const capability = await runtime.handleRequest(request(ACTIONS.CAPABILITY_REQUEST, null))
    const channels = capability.payload.contract.capabilities.telemetry
    for (const [name, type] of [['fans', 'array'], ['pool_url', 'string'], ['asic_stats', 'object']]) {
      t.is(channels.find(entry => entry.name === name)?.type, type, `${name} is discoverable`)
    }
    const pull = async (type, params = {}, deviceId = 'diag-1') => {
      const response = await runtime.handleRequest(request(ACTIONS.TELEMETRY_PULL, deviceId, { query: { type, ...params } }))
      return response.payload
    }
    const fans = await pull('fans')
    t.alike(fans.value, [{ rpm: 4500, slot: 3, percentage: 60 }])
    t.is((await pull('pool_url')).value, 'stratum+tcp://pool:3333')
    const asics = (await pull('asic_stats')).value
    t.alike(asics.hashboards.map(board => [board.serial_number, board.slot, board.expected_asic_count, board.reported_asic_count]), [['HB001', 1, 2, 2], ['HB002', 2, 1, 1]])
    t.alike(asics.hashboards[0].asics[0], {
      index: 0,
      id: 'A0',
      row: 0,
      column: 0,
      frequency_mhz: 650,
      temperature_c: 45.5,
      voltage_v: 0.3085,
      hashrate_ths: 0.3005,
      ideal_hashrate_ths: 0.32,
      error_rate_pct: 0.1
    })
    first.state.hashboardStats.HB001.asics[0].temp_c = 80
    t.is((await pull('asic_stats')).value.hashboards[0].asics[0].temperature_c, 80, 'independent pulls always read current values despite cacheMs=5000')
    const boardReads = first.state.requests.filter(entry => entry.path.startsWith('/api/v1/hashboards'))
    t.is(boardReads.length, 6, 'each collection reads inventory and one status per board')
    t.is(first.state.requests.some(entry => ['/api/v1/mining', '/api/v1/mining/target'].includes(entry.path)), false, 'detail reads do not collect a full snapshot')
    const before = first.state.requests.length
    t.ok((await pull('hashrate_history')).error.startsWith('ERR_UNKNOWN_QUERY_TYPE'), 'retired channel is unavailable')
    t.is(first.state.requests.length, before, 'retired history never reaches the miner')
    t.alike((await pull('fans', {}, 'diag-2')).value, [])
    t.is((await pull('pool_url', {}, 'diag-2')).value, '', 'no configured pool returns the declared string type')
    const metrics = (await pull('metrics')).metrics
    t.alike(metrics.fans, fans.value)
    t.is(metrics.pool_url, 'stratum+tcp://pool:3333')
    t.is(metrics.asic_stats.hashboards[0].asics[0].temperature_c, 80)
    t.is(Object.hasOwn(metrics, 'hashrate_history'), false)
    t.is(first.state.requests.some(entry => entry.path === '/api/v1/hashrate'), false, 'aggregate metrics never fetch miner history')
    t.is(JSON.stringify(metrics).includes('DIAGNOSTIC-SECRET'), false)
    second.state.hashboardStats.HB001.asics[0].temp_c = null
    const partial = (await pull('asic_stats', {}, 'diag-2')).value
    t.is(partial.hashboards[0].error, 'ERR_ASIC_STATS_RESPONSE_INVALID')
    t.is(partial.hashboards[0].asics, undefined, 'invalid readings are not published as zero')
    t.is(partial.hashboards[1].asics[0].temperature_c, 45.5, 'other boards and devices stay independent')
    statusByPath['/api/v1/hashboards/HB002'] = 503
    const failed = (await pull('metrics')).metrics
    t.is(failed.asic_stats.hashboards[1].error, 'ERR_ASIC_STATS_UNAVAILABLE')
    t.is(failed.asic_stats.hashboards[0].asics[0].temperature_c, 80)
    t.alike(failed.fans, fans.value, 'board failures do not break other channels')
    second.state.pools = [{ url: 'stratum+tcp://user:secret@pool:3333', accepted: 0, rejected: 0 }]
    t.is((await pull('pool_url', {}, 'diag-2')).error, 'ERR_POOLS_RESPONSE_INVALID')
    second.state.cooling.fans = [{ rpm: -1 }]
    t.is((await pull('fans', {}, 'diag-2')).error, 'ERR_COOLING_RESPONSE_INVALID')
  } finally {
    await cleanup.cleanupAll()
  }
})
