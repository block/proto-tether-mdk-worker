'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { randomBytes } = require('node:crypto')
const { createRequire } = require('node:module')
const { setTimeout: delay } = require('node:timers/promises')
const test = require('brittle')
const { createServer } = require('../../mock/server')

const MDK_REPO = path.resolve(process.env.MDK_REPO || '/tmp/mdk-latest')
process.env.MDK_REPO = MDK_REPO
const { startProtoWorker } = require('../../host')
const { createKernel } = require(path.join(MDK_REPO, 'backend/core/kernel'))
const { createRawMdkClient } = require(path.join(MDK_REPO, 'backend/core/client'))
const requireFromRuntime = createRequire(path.join(MDK_REPO, 'backend/core/mdk-worker/package.json'))
const DHT = requireFromRuntime('hyperdht')
const createTestnet = requireFromRuntime('hyperdht/testnet')

test('Kernel registers Proto and routes SDK telemetry and command results over authorized HRPC', { timeout: 60000 }, async t => {
  const testnet = await createTestnet(3, t.teardown)
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proto-kernel-'))
  t.teardown(() => fs.rmSync(root, { recursive: true, force: true }), { order: 100 })
  const mock = createServer()
  t.teardown(() => mock.close(), { order: 10 })
  const address = await mock.ready
  const seed = randomBytes(32)
  const kernel = createKernel({
    root,
    db: path.join(root, 'kernel-db'),
    listeners: { hrpc: { bootstrap: testnet.bootstrap, whitelist: [DHT.keyPair(seed).publicKey.toString('hex')] } },
    discovery: { mode: 'local', dir: path.join(root, 'worker-keys') },
    cadences: { telemetryPullMs: 60000, healthPingMs: 60000, statePullMs: 60000 }
  })
  t.teardown(() => kernel.stop(), { order: -10 })
  await kernel.init()
  await kernel.start()
  const worker = await startProtoWorker({
    workerId: 'proto-kernel-worker',
    storeDir: path.join(root, 'worker'),
    bootstrap: testnet.bootstrap,
    trustedKernelKeys: [kernel.hrpcListener.getDht().defaultKeyPair.publicKey],
    devices: [{ deviceId: 'proto-kernel-1', config: { address: '127.0.0.1', port: address.port, password: 'test-password' } }]
  })
  t.teardown(() => worker.stop())
  const dispatched = []
  const handleRequest = worker.runtime.handleRequest.bind(worker.runtime)
  worker.runtime.handleRequest = envelope => {
    if (envelope.action === 'command.request') dispatched.push(envelope.payload.command)
    return handleRequest(envelope)
  }
  const client = createRawMdkClient({ hrpc: { key: kernel.getPublicKey(), seed, bootstrap: testnet.bootstrap } })
  t.teardown(() => client.close(), { order: -20 })
  await client.connect()
  await kernel.registerWorker(worker.runtime.getPublicKey())
  const ready = await client.waitForWorkers({ count: 1, timeoutMs: 10000, intervalMs: 50 })
  t.is(ready[0].workerId, 'proto-kernel-worker')
  t.is(ready[0].state, 'READY')
  t.alike(ready[0].deviceIds, ['proto-kernel-1'])

  const contract = await client.getCapabilities('proto-kernel-1')
  t.is(contract.capabilities.telemetry.length, 22)
  t.ok(contract.capabilities.commands.some(entry => entry.name === 'setLED'))
  for (const entry of [...contract.capabilities.telemetry, ...contract.capabilities.commands]) {
    t.is(entry.handler, undefined, 'Kernel publishes capabilities without private handler paths')
  }
  const hashrate = await client.pullTelemetry('proto-kernel-1', 'hashrate_avg')
  t.is(hashrate.name, 'hashrate_avg')
  t.is(hashrate.value, 95.5)
  const metrics = await client.pullTelemetry('proto-kernel-1', 'metrics')
  t.is(metrics.metrics.power, 3250)
  t.alike(metrics.metrics.health, { status: 'OK' })
  const wire = JSON.stringify({ contract, hashrate, metrics })
  for (const secret of ['test-password', 'mock-access-', 'mock-refresh-']) t.is(wire.includes(secret), false)

  for (const [command, params, error] of [
    ['setPowerTarget', { watts: 12001 }, 'ERR_PARAM_RANGE'],
    ['setPowerTarget', { watts: '3300' }, 'ERR_PARAM_TYPE'],
    ['notACommand', {}, 'ERR_COMMAND_NOT_IN_CAPABILITIES']
  ]) {
    const result = await client.sendCommand('proto-kernel-1', command, params)
    t.ok(result.error.startsWith(error), `${command} is rejected by Kernel with ${error}`)
  }
  t.alike(dispatched, [], 'Kernel rejects invalid commands before worker dispatch')
  t.is(mock.state.led, false)

  const completed = new Map()
  const onDone = result => completed.set(result.commandId, result)
  kernel.stateMachine.on('command:done', onDone)
  t.teardown(() => kernel.stateMachine.off('command:done', onDone), { order: -30 })
  const queued = await client.sendCommand('proto-kernel-1', 'setLED', { enabled: true })
  t.is(queued.status, 'QUEUED', 'SDK acceptance is distinct from terminal execution')
  const success = await commandResult(client, completed, queued.commandId)
  t.is(success.status, 'SUCCESS')
  t.alike(success.result, { locating: true, success: true })
  t.is(mock.state.led, true, 'the Kernel-mediated command reaches the mock device')

  const invalid = await client.sendCommand('proto-kernel-1', 'setNetwork', { network: { dhcp: false } })
  t.is(invalid.status, 'QUEUED', 'device-specific validation occurs after Kernel acceptance')
  const failed = await commandResult(client, completed, invalid.commandId)
  t.is(failed.status, 'FAILED')
  t.is(failed.error, 'ERR_NETWORK_CONFIG_INVALID')
  t.alike(dispatched, ['setLED', 'setNetwork'])
  t.is(mock.state.writeAttempts['/api/v1/network'], undefined, 'worker validation prevents a network write')

  if (typeof kernel.allowKey === 'function') {
    const readerSeed = randomBytes(32)
    kernel.allowKey(DHT.keyPair(readerSeed).publicKey, ['read'])
    const reader = createRawMdkClient({ hrpc: { key: kernel.getPublicKey(), seed: readerSeed, bootstrap: testnet.bootstrap } })
    t.teardown(() => reader.close(), { order: -20 })
    await reader.connect()
    t.is((await reader.pullTelemetry('proto-kernel-1', 'hashrate_avg')).value, 95.5)
    const refused = await reader.sendCommand('proto-kernel-1', 'setLED', { enabled: false })
    t.ok(refused.error.startsWith('ERR_KERNEL_ACTION_FORBIDDEN'))
    t.alike(dispatched, ['setLED', 'setNetwork'], 'read-only callers cannot dispatch commands')
    t.is(mock.state.led, true)
  }
})

async function commandResult (client, completed, commandId) {
  // Older MDK deletes settled commands; its in-process event is the result API.
  // Current MDK retains results and exposes them through the client SDK.
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    const result = typeof client.getCommandStatus === 'function'
      ? await client.getCommandStatus(commandId)
      : completed.get(commandId)
    const status = result?.status || result?.state
    if (['SUCCESS', 'FAILED', 'TIMEOUT'].includes(status)) return { ...result, status }
    await delay(25)
  }
  throw new Error('ERR_KERNEL_COMMAND_RESULT_TIMEOUT')
}
