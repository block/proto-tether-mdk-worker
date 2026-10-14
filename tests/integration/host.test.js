'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createRequire } = require('node:module')
const { spawn } = require('node:child_process')
const test = require('brittle')
const { createServer } = require('../../mock/server')

const MDK_REPO = path.resolve(process.env.MDK_REPO || '/tmp/mdk-latest')
process.env.MDK_REPO = MDK_REPO
const { startProtoWorker } = require('../../host')
const requireFromRuntime = createRequire(path.join(MDK_REPO, 'backend/core/mdk-worker/package.json'))
const createTestnet = requireFromRuntime('hyperdht/testnet')
const HyperswarmRPC = requireFromRuntime('@hyperswarm/rpc')
const DHT = requireFromRuntime('hyperdht')
const { build, serialize, deserialize } = require(path.join(MDK_REPO, 'backend/core/kernel/lib/protocol/envelope'))
const WORKER_DIR = path.resolve(__dirname, '../..')

function temporaryStore (t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proto-host-'))
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }), { order: 100 })
  return dir
}

test('host serves real HRPC, isolates devices, and retains its identity after restart', { timeout: 60000 }, async (t) => {
  const testnet = await createTestnet(3, t.teardown)
  const first = createServer({ password: 'first-host-secret' })
  const second = createServer({ password: 'second-host-secret', tokenSeq: 100 })
  t.teardown(() => first.close())
  t.teardown(() => second.close())
  const [firstAddress, secondAddress] = await Promise.all([first.ready, second.ready])
  second.state.telemetry.miner.power.value = 2400

  // The Kernel uses separate DHT and RPC server identities. Incoming worker
  // connections authenticate its DHT transport key, not its RPC server key.
  const callerDht = new DHT({ bootstrap: testnet.bootstrap })
  t.teardown(() => callerDht.destroy())
  const rpc = new HyperswarmRPC({ dht: callerDht })
  t.teardown(() => rpc.destroy())

  const options = {
    workerId: 'proto-host-test',
    storeDir: temporaryStore(t),
    bootstrap: testnet.bootstrap,
    trustedKernelKeys: [callerDht.defaultKeyPair.publicKey.toString('hex')],
    devices: [
      { deviceId: 'proto-1', config: { address: '127.0.0.1', port: firstAddress.port, password: 'first-host-secret' } },
      { deviceId: 'proto-2', config: { address: '127.0.0.1', port: secondAddress.port, password: 'second-host-secret' } }
    ]
  }
  const worker = await startProtoWorker(options)
  t.teardown(() => worker.stop())
  const originalKey = worker.runtime.getPublicKey()
  const intruder = new HyperswarmRPC({ bootstrap: testnet.bootstrap })
  t.teardown(() => intruder.destroy())
  for (const [action, deviceId, payload] of [
    ['identity.request', null, {}],
    ['command.request', 'proto-1', { commandId: 'spoofed', command: 'setLED', params: { enabled: true } }]
  ]) {
    const spoofed = build({ action, type: 'request', sender: 'proto-host-caller', target: options.workerId, deviceId, payload })
    await t.exception(intruder.request(originalKey, 'mdk', serialize(spoofed), { timeout: 1500 }), 'untrusted transport cannot impersonate an allowed sender')
  }
  t.is(first.state.led, false, 'an unauthorized command never reaches the rig')
  t.is(callerDht.defaultKeyPair.publicKey.equals(rpc.defaultKeyPair.publicKey), false, 'allowlist uses the client transport identity')
  const send = async (action, deviceId = null, payload = {}) => {
    const envelope = build({ action, type: 'request', sender: 'proto-host-caller', target: options.workerId, deviceId, payload })
    const response = deserialize(await rpc.request(originalKey, 'mdk', serialize(envelope)))
    t.is(response.type, 'response')
    t.is(response.sender, options.workerId)
    t.is(response.target, 'proto-host-caller')
    t.is(response.deviceId, deviceId)
    return response
  }

  const identity = await send('identity.request')
  t.alike(identity.payload.devices, [{ deviceId: 'proto-1' }, { deviceId: 'proto-2' }])
  const capabilities = await send('capability.request')
  t.is(capabilities.payload.contract.metadata.provider, 'proto')
  const pools = capabilities.payload.contract.capabilities.commands.find(command => command.name === 'setupPools')
  const poolHelp = `${pools.description} ${pools.constraints}`
  t.ok(poolHelp.includes('worker_name'), 'wire capability publishes the pool input vocabulary')
  t.ok(poolHelp.includes('appendId defaults to true'), 'wire capability publishes the worker suffix default')
  const poolExample = JSON.parse(poolHelp.match(/Example pools: (\[.*?\])\./)[1])
  const configuredPools = await send('command.request', 'proto-2', { commandId: 'pools-wire', command: 'setupPools', params: { pools: poolExample } })
  t.is(configuredPools.payload.status, 'SUCCESS', 'published pool example works through HRPC')
  for (const entry of [...capabilities.payload.contract.capabilities.telemetry, ...capabilities.payload.contract.capabilities.commands]) {
    t.is(entry.handler, undefined)
  }
  const power = await send('telemetry.pull', 'proto-2', { query: { type: 'power' } })
  t.is(power.payload.value, 2400)
  const metrics = await send('telemetry.pull', 'proto-1', { query: { type: 'metrics' } })
  t.alike(metrics.payload.metrics.health, { status: 'OK' })
  const serialized = JSON.stringify(metrics)
  for (const secret of ['first-host-secret', 'password', 'mock-access-', 'mock-refresh-']) {
    t.is(serialized.includes(secret), false, `wire telemetry omits ${secret}`)
  }
  const led = await send('command.request', 'proto-2', { commandId: 'led-wire', command: 'setLED', params: { enabled: true } })
  t.is(led.payload.status, 'SUCCESS')
  t.is(second.state.led, true)
  t.is(first.state.led, false)
  const invalid = await send('command.request', 'proto-1', { commandId: 'target-wire', command: 'setPowerTarget', params: { watts: 200 } })
  t.is(invalid.payload.status, 'FAILED')
  t.ok(invalid.payload.error.startsWith('ERR_POWER_TARGET_OUT_OF_RANGE'))
  const reboot = (deviceId, commandId) => send('command.request', deviceId, { commandId, command: 'reboot', params: {} })
  t.is((await reboot('proto-1', 'reboot-first')).payload.status, 'SUCCESS')
  const repeated = await reboot('proto-1', 'reboot-repeated')
  t.is(repeated.payload.status, 'FAILED')
  t.is(repeated.payload.error, 'ERR_COMMAND_COOLDOWN')
  t.is((await reboot('proto-2', 'reboot-other-device')).payload.status, 'SUCCESS')
  t.is(first.state.writeAttempts['/api/v1/system/reboot'], 1)
  t.is(second.state.writeAttempts['/api/v1/system/reboot'], 1)

  await rpc.destroy()
  await worker.stop()
  await worker.stop()
  t.is(worker.runtime.getPublicKey(), null)
  const restarted = await startProtoWorker({ ...options, trustedKernelKeys: [callerDht.defaultKeyPair.publicKey] })
  t.teardown(() => restarted.stop())
  t.alike(restarted.runtime.getPublicKey(), originalKey, 'persisted seeds retain the RPC identity')
  const reconnected = new HyperswarmRPC({ dht: callerDht })
  t.teardown(() => reconnected.destroy())
  const request = build({ action: 'telemetry.pull', type: 'request', sender: 'proto-host-caller', deviceId: 'proto-2', payload: { query: { type: 'power' } } })
  const afterRestart = deserialize(await reconnected.request(originalKey, 'mdk', serialize(request)))
  t.is(afterRestart.payload.value, 2400, 'a reconnected caller reaches the same persistent identity')
})

test('host rejects missing persistent storage before creating a runtime', async (t) => {
  await t.exception(startProtoWorker({ workerId: 'proto-host', devices: [] }), /ERR_WORKER_STORE_DIR_REQUIRED/)
})

test('host requires valid trusted transport keys before opening runtime resources', async (t) => {
  const storeDir = path.join(temporaryStore(t), 'unopened')
  for (const [trustedKernelKeys, error] of [
    [undefined, 'ERR_TRUSTED_KERNEL_KEYS_REQUIRED'],
    [[], 'ERR_TRUSTED_KERNEL_KEYS_REQUIRED'],
    [null, 'ERR_TRUSTED_KERNEL_KEYS_INVALID'],
    ['ab'.repeat(32), 'ERR_TRUSTED_KERNEL_KEYS_INVALID'],
    [['not-a-key'], 'ERR_TRUSTED_KERNEL_KEYS_INVALID'],
    [[Buffer.alloc(31)], 'ERR_TRUSTED_KERNEL_KEYS_INVALID'],
    [['ab'.repeat(32), ''], 'ERR_TRUSTED_KERNEL_KEYS_INVALID']
  ]) {
    await t.exception(startProtoWorker({ workerId: 'proto-host', devices: [], storeDir, trustedKernelKeys }), new RegExp(error))
    t.is(fs.existsSync(storeDir), false, 'validation precedes seed creation')
  }
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  test(`host runner shuts down cleanly on ${signal} without publishing credentials`, { timeout: 30000 }, async (t) => {
    const child = spawn(process.execPath, [path.join(WORKER_DIR, 'host/run.js')], {
      env: {
        ...process.env,
        MDK_REPO,
        PROTO_RIG_ADDRESS: '127.0.0.1',
        PROTO_RIG_PASSWORD: 'runner-secret',
        PROTO_RIG_PORT: '80',
        PROTO_WORKER_ID: 'proto-worker',
        PROTO_DEVICE_ID: 'proto-r2-1',
        PROTO_KERNEL_TOPIC: '',
        PROTO_TRUSTED_KERNEL_KEYS: 'ab'.repeat(32),
        PROTO_STORE_DIR: temporaryStore(t)
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    t.teardown(() => child.kill('SIGKILL'), { force: true })
    let stdout = ''
    let stderr = ''
    child.stderr.on('data', chunk => { stderr += chunk })
    const exited = new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code, exitSignal) => resolve({ code, signal: exitSignal }))
    })
    const ready = new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', () => reject(new Error('host exited before readiness')))
      child.stdout.on('data', chunk => {
        stdout += chunk
        if (stdout.includes('\n')) resolve(JSON.parse(stdout.split('\n')[0]))
      })
    })
    const identity = await ready
    t.is(identity.workerId, 'proto-worker')
    t.ok(/^[a-f0-9]{64}$/.test(identity.publicKey))
    child.kill(signal)
    t.alike(await exited, { code: 0, signal: null })
    t.is(stderr, '')
    t.is(stdout.includes('runner-secret'), false)
  })
}

test('host runner rejects invalid connection configuration with non-secret errors', async (t) => {
  for (const [config, error] of [
    [{ PROTO_RIG_ADDRESS: '' }, 'ERR_ADDRESS_REQUIRED'],
    [{ PROTO_RIG_PASSWORD: '' }, 'ERR_PASSWORD_REQUIRED'],
    [{ PROTO_RIG_PORT: 'invalid' }, 'ERR_DEVICE_PORT_INVALID'],
    [{ PROTO_TRUSTED_KERNEL_KEYS: '' }, 'ERR_TRUSTED_KERNEL_KEYS_REQUIRED'],
    [{ PROTO_TRUSTED_KERNEL_KEYS: 'secret-invalid-key' }, 'ERR_TRUSTED_KERNEL_KEYS_INVALID']
  ]) {
    const child = spawn(process.execPath, [path.join(WORKER_DIR, 'host/run.js')], {
      env: { ...process.env, MDK_REPO, PROTO_RIG_ADDRESS: '127.0.0.1', PROTO_RIG_PASSWORD: 'startup-secret', PROTO_RIG_PORT: '80', PROTO_TRUSTED_KERNEL_KEYS: 'ab'.repeat(32), ...config },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', resolve)
    })
    t.is(code, 1)
    t.is(stdout, '')
    t.is(stderr, `${error}\n`)
  }
})
