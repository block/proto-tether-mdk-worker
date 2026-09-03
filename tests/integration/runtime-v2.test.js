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

test('WorkerRuntimeV2 keeps device state isolated and publishes clean envelopes', async (t) => {
  const first = createServer({ password: 'first-password', tokenSeq: 0 })
  const second = createServer({ password: 'second-password', tokenSeq: 100 })
  const [firstAddress, secondAddress] = await Promise.all([first.ready, second.ready])

  first.state.telemetry.miner.hashrate.value = 95.5
  first.state.telemetry.miner.power.value = 3250
  first.state.telemetry.miner.temperature.value = 65.5
  second.state.telemetry.miner.hashrate.value = 87.25
  second.state.telemetry.miner.power.value = 2400
  second.state.telemetry.miner.temperature.value = 61.25

  const runtime = new WorkerRuntimeV2(WORKER_DIR, {
    workerId: 'proto-test',
    devices: [
      { deviceId: 'proto-1', config: { address: '127.0.0.1', port: firstAddress.port, password: 'first-password' } },
      { deviceId: 'proto-2', config: { address: '127.0.0.1', port: secondAddress.port, password: 'second-password' } }
    ]
  })

  try {
    await runtime.start()

    const identity = await runtime.handleRequest(request(ACTIONS.IDENTITY_REQUEST, null))
    t.is(identity.action, ACTIONS.IDENTITY_RESPONSE)
    t.alike(identity.payload.devices.map(item => item.deviceId), ['proto-1', 'proto-2'])

    const capability = await runtime.handleRequest(request(ACTIONS.CAPABILITY_REQUEST, null))
    t.is(capability.action, ACTIONS.CAPABILITY_RESPONSE)
    t.is(capability.payload.contract.metadata.provider, 'proto')
    for (const entry of capability.payload.contract.capabilities.telemetry) t.is(entry.handler, undefined)
    for (const entry of capability.payload.contract.capabilities.commands) t.is(entry.handler, undefined)

    const hashrate = await runtime.handleRequest(request(ACTIONS.TELEMETRY_PULL, 'proto-1', {
      query: { type: 'hashrate_avg' }
    }))
    t.is(hashrate.action, ACTIONS.TELEMETRY_RESPONSE)
    t.is(hashrate.payload.deviceId, 'proto-1')
    t.is(hashrate.payload.value, 95.5)

    const power = await runtime.handleRequest(request(ACTIONS.TELEMETRY_PULL, 'proto-2', {
      query: { type: 'power' }
    }))
    t.is(power.action, ACTIONS.TELEMETRY_RESPONSE)
    t.is(power.payload.deviceId, 'proto-2')
    t.is(power.payload.value, 2400)

    const led = await runtime.handleRequest(request(ACTIONS.COMMAND_REQUEST, 'proto-2', {
      commandId: 'led-1',
      command: 'setLED',
      params: { enabled: true }
    }))
    t.is(led.action, ACTIONS.COMMAND_RESULT)
    t.is(led.payload.status, 'SUCCESS')
    t.is(second.state.led, true)
    t.is(first.state.led, false)

    const target = await runtime.handleRequest(request(ACTIONS.COMMAND_REQUEST, 'proto-1', {
      commandId: 'target-1',
      command: 'setPowerTarget',
      params: { watts: 200 }
    }))
    t.is(target.action, ACTIONS.COMMAND_RESULT)
    t.is(target.payload.status, 'FAILED')
    t.ok(/ERR_POWER_TARGET_OUT_OF_RANGE/.test(target.payload.error))

    t.alike(uniqueAuthHeaders(first.state), ['Bearer mock-access-1'])
    t.alike(uniqueAuthHeaders(second.state), ['Bearer mock-access-101'])
  } finally {
    await runtime.stop()
    await Promise.all([first.close(), second.close()])
  }
})
