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
    t.is(capability.payload.contract.capabilities.telemetry.length, 13)
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
    t.is(Object.keys(metrics.payload.metrics).length, 13)

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
