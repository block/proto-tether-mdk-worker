'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { randomBytes, createHash } = require('node:crypto')
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
const Hyperswarm = requireFromRuntime('hyperswarm')
const DHT = requireFromRuntime('hyperdht')
const { build, serialize, deserialize } = require(path.join(MDK_REPO, 'backend/core/kernel/lib/protocol/envelope'))
const WORKER_DIR = path.resolve(__dirname, '../..')
const RPC_TIMEOUT = 10000

test('maintenance commands work over authorized HRPC with safe results and no firmware replay', { timeout: 60000 }, async (t) => {
  const testnet = await createTestnet(3, t.teardown)
  const statusByPath = {}
  const first = createServer({ statusByPath })
  const second = createServer({ tokenSeq: 100, disconnectPaths: ['/api/v1/system/update'] })
  t.teardown(() => first.close())
  t.teardown(() => second.close())
  const [firstAddress, secondAddress] = await Promise.all([first.ready, second.ready])
  first.state.logs.os = [
    'password=test-password', 'Bearer fake-test-bearer',
    'password="FAKE quoted, secret; tail"', "api_key='FAKE spaced; secret'",
    String.raw`refresh_token="FAKE escaped \" quote tail"`, 'fan running'
  ]
  const rpc = new HyperswarmRPC({ bootstrap: testnet.bootstrap })
  t.teardown(() => rpc.destroy())
  const worker = await startProtoWorker({
    workerId: 'proto-maintenance',
    bootstrap: testnet.bootstrap,
    storeDir: temporaryStore(t),
    trustedKernelKeys: [rpc.dht.defaultKeyPair.publicKey],
    devices: [
      { deviceId: 'maint-1', config: { address: '127.0.0.1', port: firstAddress.port, password: 'test-password', cacheMs: 5000 } },
      { deviceId: 'maint-2', config: { address: '127.0.0.1', port: secondAddress.port, password: 'test-password', cacheMs: 5000 } }
    ]
  })
  t.teardown(() => worker.stop())
  let sequence = 0
  const send = async (action, deviceId, payload) => deserialize(await rpc.request(worker.runtime.getPublicKey(), 'mdk', serialize(build({
    action, type: 'request', sender: 'maintenance-caller', target: 'proto-maintenance', deviceId, payload
  })), { timeout: RPC_TIMEOUT }))
  const command = async (name, params = {}, deviceId = 'maint-1') => {
    const commandId = `maintenance-${++sequence}`
    const response = await send('command.request', deviceId, { commandId, command: name, params })
    t.is(response.action, 'command.result')
    t.is(response.deviceId, deviceId)
    t.is(response.payload.commandId, commandId)
    return response.payload
  }
  const pull = async (type) => (await send('telemetry.pull', 'maint-1', { query: { type } })).payload.value
  const capabilities = (await send('capability.request', null, {})).payload.contract.capabilities
  const names = capabilities.commands.map(entry => entry.name)
  t.ok(['downloadLogs', 'setNetwork', 'updateFirmware'].every(name => names.includes(name)), 'maintenance commands are discoverable')
  // Keep a missing registration failure focused instead of invoking absent commands.
  if (!names.includes('updateFirmware')) return
  t.is(capabilities.commands.some(entry => entry.handler !== undefined), false)

  const logs = await command('downloadLogs', { source: 'os', lines: 6 })
  t.is(logs.status, 'SUCCESS')
  t.alike(logs.result, { source: 'os', lines: 6, content: ['password=[REDACTED]', 'Bearer [REDACTED]', 'password=[REDACTED]', 'api_key=[REDACTED]', 'refresh_token=[REDACTED]', 'fan running'] })
  t.alike((await command('downloadLogs', { args: ['os', 1] })).result, { source: 'os', lines: 1, content: ['fan running'] }, 'positional parameters follow contract order')
  t.alike((await command('downloadLogs')).result, { source: 'miner_sw', lines: 1, content: ['Mock mining started'] })
  t.alike((await command('downloadLogs', {}, 'maint-2')).result, { source: 'miner_sw', lines: 1, content: ['Mock mining started'] })

  t.is((await pull('device_info')).network.hostname, 'proto-r2-mock')
  await pull('firmware_info')
  first.state.system.os.version = 'changed-after-cached-read'
  const network = { dhcp: false, ip: '192.0.2.25', netmask: '255.255.255.0', gateway: '192.0.2.1', hostname: 'updated-rig' }
  const configured = await command('setNetwork', { value: network })
  t.is(configured.status, 'SUCCESS')
  t.alike(configured.result, { success: true })
  t.is((await pull('device_info')).network.hostname, 'updated-rig', 'network writes invalidate the device information cache')
  t.is((await pull('firmware_info')).os.version, 'changed-after-cached-read', 'network writes invalidate system information too')
  t.is(second.state.network.hostname, 'proto-r2-mock', 'writes stay isolated to the addressed device')

  const ota = await command('updateFirmware')
  t.is(ota.status, 'SUCCESS')
  t.alike(ota.result, { accepted: true, completed: false, mode: 'ota' })
  const bytes = Buffer.from([0, 255, 128, 13, 10, 1])
  const firmware = { filename: 'fixture.swu', encoding: 'base64', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), data: bytes.toString('base64') }
  const upload = await command('updateFirmware', { value: firmware })
  t.is(upload.status, 'SUCCESS')
  t.alike(upload.result, { accepted: true, completed: false, mode: 'upload' })
  t.alike(first.state.updates, [{ mode: 'ota' }, { mode: 'upload', filename: 'fixture.swu', size: bytes.length, sha256: firmware.sha256 }])
  t.is(first.state.writeAttempts['/api/v1/system/update'], 2, 'OTA and upload each make one firmware write')
  t.is((await pull('firmware_info')).os.version, 'changed-after-cached-read')

  for (const [name, params, error] of [
    ['downloadLogs', { lines: 0 }, 'ERR_LOGS_PARAMETERS_INVALID'],
    ['setNetwork', { network: { dhcp: false } }, 'ERR_NETWORK_CONFIG_INVALID'],
    ['updateFirmware', { firmware: { ...firmware, sha256: '0'.repeat(64) } }, 'ERR_FIRMWARE_PAYLOAD_INVALID']
  ]) {
    const before = first.state.requests.length
    const result = await command(name, params)
    t.is(result.status, 'FAILED')
    t.is(result.error, error)
    t.is(first.state.requests.length, before, `${name} rejects invalid parameters before device I/O`)
  }

  statusByPath['/api/v1/network'] = 503
  const failedNetwork = await command('setNetwork', { network: { dhcp: true } })
  t.is(failedNetwork.status, 'FAILED')
  t.is(failedNetwork.error, 'ERR_HTTP_RESPONSE: 503')
  delete statusByPath['/api/v1/network']
  first.state.network.hostname = 'verified-after-failure'
  t.is((await pull('device_info')).network.hostname, 'verified-after-failure', 'a failed network write also clears cached reads')
  for (const status of [401, 409]) {
    statusByPath['/api/v1/system/update'] = status
    const before = first.state.writeAttempts['/api/v1/system/update']
    const result = await command('updateFirmware')
    t.is(result.status, 'FAILED')
    t.is(result.error, status === 401 ? 'ERR_AUTHENTICATION_FAILED' : 'ERR_HTTP_RESPONSE: 409')
    t.is(first.state.writeAttempts['/api/v1/system/update'], before + 1, 'firmware failures do not replay the write')
  }
  const disconnected = await command('updateFirmware', { firmware }, 'maint-2')
  t.is(disconnected.status, 'FAILED')
  t.is(disconnected.error, 'ERR_DEVICE_CONNECTION')
  t.is(second.state.writeAttempts['/api/v1/system/update'], 1, 'an ambiguous upload is never replayed')
  t.alike(second.state.updates, [])
  const wire = JSON.stringify({ logs, configured, ota, upload, failedNetwork, disconnected })
  for (const secret of ['test-password', 'fake-test-bearer', 'FAKE', 'mock-access-', 'mock-refresh-', firmware.data, firmware.sha256]) {
    t.is(wire.includes(secret), false, `command results omit ${secret}`)
  }
})

function temporaryStore (t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proto-host-'))
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }), { order: 100 })
  return dir
}

async function assertTransportRejected (t, rpc, key, request) {
  const client = rpc.connect(key)
  let transportError
  client.stream.on('error', err => { transportError = err })
  await t.exception(client.request('mdk', request, { timeout: RPC_TIMEOUT }), { code: 'CHANNEL_CLOSED' }, 'untrusted RPC closes instead of reaching its request timeout')
  t.is(transportError?.code, 'PEER_CONNECTION_FAILED', 'the DHT rejects the untrusted transport connection')
  client.destroy()
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
  const intruderDht = new DHT({ bootstrap: testnet.bootstrap })
  t.teardown(() => intruderDht.destroy())
  const intruder = new HyperswarmRPC({ dht: intruderDht })
  t.teardown(() => intruder.destroy())
  const controlDht = new DHT({ bootstrap: testnet.bootstrap })
  t.teardown(() => controlDht.destroy())
  const controlRpc = new HyperswarmRPC({ dht: controlDht })
  t.teardown(() => controlRpc.destroy())
  const control = controlRpc.createServer()
  control.respond('mdk', req => req)
  await control.listen()
  for (const [action, deviceId, payload] of [
    ['identity.request', null, {}],
    ['command.request', 'proto-1', { commandId: 'spoofed', command: 'setLED', params: { enabled: true } }]
  ]) {
    const spoofed = build({ action, type: 'request', sender: 'proto-host-caller', target: options.workerId, deviceId, payload })
    const request = serialize(spoofed)
    t.alike(await intruder.request(control.publicKey, 'mdk', request, { timeout: RPC_TIMEOUT }), request, 'the same intruder reaches an unfiltered server within the same timeout')
    await assertTransportRejected(t, intruder, originalKey, request)
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
  await intruder.destroy()
  await worker.stop()
  t.is(first.state.led, false, 'after client destruction and host shutdown no unauthorized LED write arrived')
  t.is(first.state.writeAttempts['/api/v1/system/locate'], undefined, 'the unauthorized LED command never produced a write attempt')
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

test('detail channels work over authorized HRPC with independent sources and safe projections', { timeout: 60000 }, async (t) => {
  const testnet = await createTestnet(3, t.teardown)
  const statusByPath = { '/api/v1/mining': 204, '/api/v1/mining/target': 503 }
  const first = createServer({ password: 'detail-first-password', statusByPath })
  const second = createServer({ password: 'detail-second-password', tokenSeq: 100 })
  t.teardown(() => first.close())
  t.teardown(() => second.close())
  const [firstAddress, secondAddress] = await Promise.all([first.ready, second.ready])
  first.state.errors = [{ source: 'fan', slot: 0, error_code: 'FanSlow', timestamp: 1764160757, message: 'CHANNEL-WIRE-SECRET' }]
  first.state.pools[0].password = 'CHANNEL-WIRE-SECRET'
  first.state.system.os.status = { token: 'CHANNEL-WIRE-SECRET' }
  first.state.system.os.accessToken = 'CHANNEL-WIRE-SECRET'
  first.state.telemetry.hashboards[0].secret = 'CHANNEL-WIRE-SECRET'
  first.state.telemetry.hashboards[0].hashrate.secret = 'CHANNEL-WIRE-SECRET'
  second.state.system.cb_sn = 'R2-SECOND'
  second.state.network.gateway = ' \t '
  second.state.telemetry.hashboards[0].hashrate.value = 20

  const rpc = new HyperswarmRPC({ bootstrap: testnet.bootstrap })
  t.teardown(() => rpc.destroy())
  const worker = await startProtoWorker({
    workerId: 'proto-details',
    bootstrap: testnet.bootstrap,
    storeDir: temporaryStore(t),
    trustedKernelKeys: [rpc.dht.defaultKeyPair.publicKey],
    devices: [
      { deviceId: 'detail-1', config: { address: '127.0.0.1', port: firstAddress.port, password: 'detail-first-password', cacheMs: 5000 } },
      { deviceId: 'detail-2', config: { address: '127.0.0.1', port: secondAddress.port, password: 'detail-second-password', cacheMs: 5000 } }
    ]
  })
  t.teardown(() => worker.stop())
  const send = async (action, deviceId, payload) => deserialize(await rpc.request(worker.runtime.getPublicKey(), 'mdk', serialize(build({
    action, type: 'request', sender: 'detail-caller', target: 'proto-details', deviceId, payload
  }))))
  const pull = (type, deviceId = 'detail-1') => send('telemetry.pull', deviceId, { query: { type } })
  const values = {}
  for (const name of ['errors', 'pools', 'hashboards', 'device_info', 'firmware_info']) {
    const response = await pull(name)
    t.is(response.payload.name, name)
    t.is(response.payload.error, undefined, `${name} succeeds without mining statistics`)
    values[name] = response.payload.value
  }
  t.alike(values.errors, [{ name: 'firmware_error', code: 'FanSlow', source: 'fan', slot: 0, timestamp: 1764160757 }])
  t.is(values.pools[0].username, 'worker')
  t.is(Object.hasOwn(values.pools[0], 'stale'), false, 'unreported stale shares remain absent on the wire')
  t.is(values.hashboards[0].hashrate_ths, 47.75)
  t.alike(values.hashboards[0].temperature_c, { inlet: 45, outlet: 68, avg: 56 })
  t.is(values.device_info.device_id, 'detail-1')
  t.is(values.device_info.network.hostname, 'proto-r2-mock')
  t.is(values.firmware_info.os.version, '1.8.2')
  t.is(values.firmware_info.mining_driver_sw.version, '1.8.2')

  for (const pathname of ['/api/v1/errors', '/api/v1/pools', '/api/v1/telemetry', '/api/v1/system', '/api/v1/network']) {
    t.is(first.state.requests.filter(request => request.method === 'GET' && request.path === pathname).length, 1, `${pathname} is shared by direct queries`)
  }
  t.is(first.state.requests.some(request => ['/api/v1/mining', '/api/v1/mining/target'].includes(request.path)), false, 'detail queries do not collect a full snapshot')
  const secondInfo = (await pull('device_info', 'detail-2')).payload.value
  t.is(secondInfo.serial_number, 'R2-SECOND', 'missing network readings preserve identity on the wire')
  t.is(Object.hasOwn(secondInfo.network, 'ip_gw'), false, 'blank gateway stays absent on the wire')
  t.is((await pull('hashboards', 'detail-2')).payload.value[0].hashrate_ths, 20, 'board state stays isolated by device')
  t.alike((await pull('errors', 'detail-2')).payload.value, [])

  const metrics = await pull('metrics')
  t.is(Object.keys(metrics.payload.metrics).length, 22)
  t.ok(metrics.payload.metrics.snap.error, 'a snapshot failure stays isolated to its channel')
  t.alike(metrics.payload.metrics.errors, values.errors)
  t.alike(metrics.payload.metrics.firmware_info, values.firmware_info)
  const wire = JSON.stringify({ values, metrics })
  for (const forbidden of ['CHANNEL-WIRE-SECRET', 'detail-first-password', 'mock-access-', 'mock-refresh-', 'accessToken', 'password']) {
    t.is(wire.includes(forbidden), false, `detail wire responses omit ${forbidden}`)
  }

  const command = await send('command.request', 'detail-1', { commandId: 'update-detail-pool', command: 'setupPools', params: { pools: [{ url: 'stratum+tcp://new-pool.example:3333', worker_name: 'new-account' }], appendId: false } })
  t.is(command.payload.status, 'SUCCESS')
  const updated = await pull('pools')
  t.is(updated.payload.value[0].url, 'stratum+tcp://new-pool.example:3333')
  t.is(updated.payload.value[0].username, 'new-account', 'pool writes invalidate the new channel cache')
})

test('HTTP failures remain errors for direct and aggregate detail telemetry over HRPC', { timeout: 60000 }, async (t) => {
  const testnet = await createTestnet(3, t.teardown)
  const statusByPath = {}
  const rig = createServer({ statusByPath })
  t.teardown(() => rig.close())
  const address = await rig.ready
  const rpc = new HyperswarmRPC({ bootstrap: testnet.bootstrap })
  t.teardown(() => rpc.destroy())
  const worker = await startProtoWorker({
    workerId: 'proto-http-failure',
    bootstrap: testnet.bootstrap,
    storeDir: temporaryStore(t),
    trustedKernelKeys: [rpc.dht.defaultKeyPair.publicKey],
    devices: [{ deviceId: 'failure-1', config: { address: '127.0.0.1', port: address.port, password: 'test-password', cacheMs: 0 } }]
  })
  t.teardown(() => worker.stop())
  const pull = async (type) => deserialize(await rpc.request(worker.runtime.getPublicKey(), 'mdk', serialize(build({
    action: 'telemetry.pull', type: 'request', sender: 'failure-caller', target: 'proto-http-failure', deviceId: 'failure-1', payload: { query: { type } }
  }))))

  t.alike((await pull('errors')).payload.value, [], 'a successful empty errors response means no active errors')
  for (const [name, independent] of [['errors', 'pools'], ['pools', 'errors']]) {
    const pathname = `/api/v1/${name}`
    statusByPath[pathname] = 503
    const direct = await pull(name)
    t.is(direct.payload.error, 'ERR_HTTP_RESPONSE: 503', `${name} reports its HTTP failure`)
    t.is(Object.hasOwn(direct.payload, 'value'), false, `${name} never reports failed reads as empty values`)
    const aggregate = (await pull('metrics')).payload.metrics
    t.alike(aggregate[name], { error: 'ERR_HTTP_RESPONSE: 503' }, `${name} remains an error inside metrics`)
    t.ok(Array.isArray(aggregate[independent]), `${independent} still succeeds independently`)
    t.is(aggregate.power, 3250, 'independent scalar telemetry still succeeds')
    delete statusByPath[pathname]
  }
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

test('topic discovery publishes the RPC key while RPC remains restricted to trusted transports', { timeout: 60000 }, async (t) => {
  const testnet = await createTestnet(3, t.teardown)
  const callerDht = new DHT({ bootstrap: testnet.bootstrap })
  const intruderDht = new DHT({ bootstrap: testnet.bootstrap })
  t.teardown(() => callerDht.destroy())
  t.teardown(() => intruderDht.destroy())
  const topic = randomBytes(32)
  const worker = await startProtoWorker({
    workerId: 'discovery-host',
    storeDir: temporaryStore(t),
    bootstrap: testnet.bootstrap,
    trustedKernelKeys: [callerDht.defaultKeyPair.publicKey],
    kernelTopic: topic,
    devices: [],
    allowEmptyDevices: true
  })
  t.teardown(() => worker.stop())
  const discover = async (dht) => {
    const swarm = new Hyperswarm({ dht })
    t.teardown(() => swarm.destroy())
    let timer
    const key = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('ERR_DISCOVERY_TIMED_OUT')), 10000)
      swarm.once('connection', stream => {
        let received = Buffer.alloc(0)
        stream.on('error', reject)
        stream.on('data', chunk => {
          received = Buffer.concat([received, chunk])
          if (received.length >= 32) resolve(received)
        })
      })
    })
    swarm.join(topic, { server: false, client: true })
    return key.finally(() => clearTimeout(timer))
  }
  const [trustedKey, untrustedKey] = await Promise.all([discover(callerDht), discover(intruderDht)])
  t.alike(trustedKey, worker.runtime.getPublicKey(), 'client-only trusted discovery reads the RPC identity')
  t.alike(untrustedKey, trustedKey, 'topic discovery shares the key with an untrusted peer too')
  const rpc = new HyperswarmRPC({ dht: callerDht })
  const intruder = new HyperswarmRPC({ dht: intruderDht })
  t.teardown(() => rpc.destroy())
  t.teardown(() => intruder.destroy())
  const request = serialize(build({ action: 'identity.request', type: 'request', sender: 'discovery-caller', target: 'discovery-host', payload: {} }))
  const identity = deserialize(await rpc.request(trustedKey, 'mdk', request, { timeout: 1500 }))
  t.is(identity.action, 'identity.response')
  t.is(identity.payload.workerId, 'discovery-host')
  await assertTransportRejected(t, intruder, untrustedKey, request)
})

test('persistent store lock rejects concurrent hosts and releases after stop', { timeout: 30000 }, async (t) => {
  const testnet = await createTestnet(3, t.teardown)
  const options = { workerId: 'lock-host', devices: [], allowEmptyDevices: true, storeDir: temporaryStore(t), bootstrap: testnet.bootstrap, trustedKernelKeys: ['ab'.repeat(32)] }
  const worker = await startProtoWorker(options)
  t.teardown(() => worker.stop())
  const lockPath = path.join(options.storeDir, '.proto-worker.lock')
  t.is(fs.statSync(lockPath).mode & 0o777, 0o600, 'the lock file is private')
  const originalSeeds = ['seedDht', 'seedRpc'].map(name => fs.readFileSync(path.join(options.storeDir, name)))
  await t.exception(startProtoWorker({ ...options, workerId: 'other-host' }), /ERR_WORKER_STORE_LOCKED/)
  t.alike(['seedDht', 'seedRpc'].map(name => fs.readFileSync(path.join(options.storeDir, name))), originalSeeds, 'a refused host does not overwrite seeds')
  const child = spawn(process.execPath, [path.join(WORKER_DIR, 'host/run.js')], {
    env: { ...process.env, MDK_REPO, PROTO_RIG_ADDRESS: '127.0.0.1', PROTO_RIG_PASSWORD: 'lock-secret', PROTO_TRUSTED_KERNEL_KEYS: 'ab'.repeat(32), PROTO_STORE_DIR: options.storeDir, PROTO_DHT_BOOTSTRAP: testnet.bootstrap.map(({ host, port }) => `${host}:${port}`).join(',') },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  t.teardown(() => child.kill('SIGKILL'), { force: true })
  let stderr = ''
  let stdout = ''
  child.stderr.on('data', chunk => { stderr += chunk })
  child.stdout.on('data', chunk => { stdout += chunk })
  t.is(await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  }), 1, 'a second process also refuses the occupied store')
  t.is(stderr, 'ERR_WORKER_STORE_LOCKED\n')
  t.is(stdout, '', 'the refused process never announces readiness')
  await Promise.all([worker.stop(), worker.stop()])
  t.is(fs.existsSync(lockPath), false)
  const restarted = await startProtoWorker(options)
  t.teardown(() => restarted.stop())
  t.alike(['seedDht', 'seedRpc'].map(name => fs.readFileSync(path.join(options.storeDir, name))), originalSeeds)
})

test('startup failure releases the store lock; an existing crash lock fails closed', { timeout: 30000 }, async (t) => {
  const testnet = await createTestnet(3, t.teardown)
  const options = { workerId: 'failed-host', devices: [], allowEmptyDevices: true, storeDir: temporaryStore(t), bootstrap: testnet.bootstrap, trustedKernelKeys: ['ab'.repeat(32)] }
  const lockPath = path.join(options.storeDir, '.proto-worker.lock')
  const seedPath = path.join(options.storeDir, 'seedDht')
  fs.mkdirSync(seedPath)
  await t.exception(startProtoWorker(options), { code: 'EISDIR' }, 'seed read failure triggers startup cleanup')
  t.is(fs.existsSync(lockPath), false, 'failed startup releases its acquired lock')
  fs.rmdirSync(seedPath)
  fs.writeFileSync(lockPath, 'stale owner', { mode: 0o600 })
  await t.exception(startProtoWorker(options), /ERR_WORKER_STORE_LOCKED/, 'an existing lock is never automatically stolen')
  t.is(fs.readFileSync(lockPath, 'utf8'), 'stale owner')
  t.is(fs.existsSync(seedPath), false, 'lock contention is checked before seeds open')
  fs.unlinkSync(lockPath)
  const worker = await startProtoWorker(options)
  t.teardown(() => worker.stop())
  t.ok(worker.runtime.getPublicKey(), 'startup succeeds after deliberate operator lock recovery')
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  test(`host runner shuts down cleanly on ${signal} without publishing credentials`, { timeout: 30000 }, async (t) => {
    const testnet = await createTestnet(3, t.teardown)
    const storeDir = temporaryStore(t)
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
        PROTO_STORE_DIR: storeDir,
        PROTO_DHT_BOOTSTRAP: testnet.nodes.map(node => ` 127.0.0.1:${node.address().port} `).join(',')
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
    t.is(fs.existsSync(path.join(storeDir, '.proto-worker.lock')), false, 'clean shutdown releases the store lock')
  })
}

test('host runner rejects invalid connection configuration with non-secret errors', async (t) => {
  for (const [config, error] of [
    [{ PROTO_RIG_ADDRESS: '' }, 'ERR_ADDRESS_REQUIRED'],
    [{ PROTO_RIG_PASSWORD: '' }, 'ERR_PASSWORD_REQUIRED'],
    [{ PROTO_RIG_PORT: 'invalid' }, 'ERR_DEVICE_PORT_INVALID'],
    [{ PROTO_TRUSTED_KERNEL_KEYS: '' }, 'ERR_TRUSTED_KERNEL_KEYS_REQUIRED'],
    [{ PROTO_TRUSTED_KERNEL_KEYS: 'secret-invalid-key' }, 'ERR_TRUSTED_KERNEL_KEYS_INVALID'],
    ...['', '127.0.0.1', ':1234', '127.0.0.1:0', '127.0.0.1:65536', 'host:abc', 'host:1,', 'bad host:1', '[host]:1', '::1:1234', '-host:1'].map(PROTO_DHT_BOOTSTRAP => [{ PROTO_DHT_BOOTSTRAP }, 'ERR_DHT_BOOTSTRAP_INVALID'])
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
