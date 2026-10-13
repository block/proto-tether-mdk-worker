'use strict'

const path = require('node:path')
const test = require('brittle')

const MDK_REPO = path.resolve(process.env.MDK_REPO || '/tmp/mdk-latest')
const { loadContract } = require(path.join(MDK_REPO, 'backend/core/mdk-worker/lib/contract-loader'))
const WORKER_DIR = path.resolve(__dirname, '../..')

test('contract loads every V2 handler and strips private paths', (t) => {
  const loaded = loadContract(WORKER_DIR)
  t.is(loaded.entries.telemetry.size, 13)
  t.is(loaded.entries.commands.size, 5)
  t.is(loaded.contract.metadata.provider, 'proto')
  t.ok(loaded.entries.telemetry.has('health'))

  const setPowerTarget = loaded.publishedContract.capabilities.commands.find(command => command.name === 'setPowerTarget')
  const watts = setPowerTarget.params.find(param => param.name === 'watts')
  t.alike({ min: watts.min, max: watts.max }, { min: 1, max: 12000 })

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
    'ERR_APPEND_ID_INVALID'
  ]) t.ok(loaded.publishedContract.capabilities.errors[error], `contract declares ${error}`)
})
