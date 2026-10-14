'use strict'

const path = require('node:path')
const test = require('brittle')
const { ProtoRigClient } = require('../../lib/proto-rig-client')

const MDK_REPO = path.resolve(process.env.MDK_REPO || '/tmp/mdk-latest')
const { loadContract } = require(path.join(MDK_REPO, 'backend/core/mdk-worker/lib/contract-loader'))
const WORKER_DIR = path.resolve(__dirname, '../..')

test('contract loads every V2 handler and strips private paths', async (t) => {
  const loaded = loadContract(WORKER_DIR)
  t.is(loaded.entries.telemetry.size, 19)
  t.is(loaded.entries.commands.size, 5)
  t.is(loaded.contract.metadata.provider, 'proto')
  t.ok(loaded.entries.telemetry.has('health'))
  for (const [name, type] of [
    ['errors', 'array'], ['pools', 'array'], ['hashboards', 'array'],
    ['device_info', 'object'], ['firmware_info', 'object'], ['psu_info', 'object']
  ]) {
    t.ok(loaded.entries.telemetry.has(name), `contract loads ${name}`)
    t.is(loaded.publishedContract.capabilities.telemetry.find(entry => entry.name === name)?.type, type, `${name} has a discoverable result type`)
  }

  const setPowerTarget = loaded.publishedContract.capabilities.commands.find(command => command.name === 'setPowerTarget')
  const watts = setPowerTarget.params.find(param => param.name === 'watts')
  t.alike({ min: watts.min, max: watts.max }, { min: 1, max: 12000 })

  const setupPools = loaded.publishedContract.capabilities.commands.find(command => command.name === 'setupPools')
  const poolHelp = `${setupPools.description} ${setupPools.constraints}`
  t.ok(/required.*url.*worker_name.*strings/i.test(poolHelp), 'pool help names required entry fields and types')
  t.ok(/optional.*worker_password.*pool.*strings/i.test(poolHelp), 'pool help names optional entry fields and types')
  t.ok(/worker_password defaults to ""/.test(poolHelp), 'pool help publishes the password default')
  t.ok(/pool defaults to ""/.test(poolHelp), 'pool help publishes the pool name default')
  t.ok(/appendId defaults to true/.test(poolHelp), 'pool help publishes the appendId default')
  t.ok(/appends \.<deviceId> to worker_name/.test(poolHelp), 'pool help explains the device ID suffix')

  const example = poolHelp.match(/Example pools: (\[.*?\])\./)
  t.ok(example, 'pool help includes a JSON array example')
  if (example) {
    let body
    const client = new ProtoRigClient({ id: 'R2-001', api: { setPools: async value => { body = value } } })
    t.alike(await client.setupPools(JSON.parse(example[1])), { success: true }, 'published example is accepted by the handler')
    t.alike(body, [{
      url: 'stratum+tcp://pool.example:3333',
      username: 'account.worker.R2-001',
      password: '',
      name: '',
      priority: 0
    }], 'published example uses the documented defaults')
  }

  for (const item of [
    ...loaded.publishedContract.capabilities.telemetry,
    ...loaded.publishedContract.capabilities.commands
  ]) t.is(item.handler, undefined)

  for (const error of [
    'ERR_COMMAND_COOLDOWN',
    'ERR_COMMAND_IN_PROGRESS',
    'ERR_DEVICE_ADDRESS_INVALID',
    'ERR_DEVICE_CREDENTIALS_INVALID',
    'ERR_CACHE_DURATION_INVALID',
    'ERR_SYSTEM_RESPONSE_INVALID',
    'ERR_NETWORK_RESPONSE_INVALID',
    'ERR_MINING_RESPONSE_INVALID',
    'ERR_MINING_STATISTICS_UNAVAILABLE',
    'ERR_POWER_TARGET_RESPONSE_INVALID',
    'ERR_TELEMETRY_RESPONSE_INVALID',
    'ERR_COOLING_RESPONSE_INVALID',
    'ERR_PSUS_RESPONSE_INVALID',
    'ERR_APPEND_ID_INVALID'
  ]) t.ok(loaded.publishedContract.capabilities.errors[error], `contract declares ${error}`)
})
