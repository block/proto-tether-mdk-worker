'use strict'

const path = require('node:path')
const test = require('brittle')

const MDK_REPO = path.resolve(process.env.MDK_REPO || '/tmp/mdk-latest')
const { loadContract } = require(path.join(MDK_REPO, 'backend/core/mdk-worker/lib/contract-loader'))
const WORKER_DIR = path.resolve(__dirname, '../..')

test('contract loads every V2 handler and strips private paths', (t) => {
  const loaded = loadContract(WORKER_DIR)
  t.is(loaded.entries.telemetry.size, 12)
  t.is(loaded.entries.commands.size, 5)
  t.is(loaded.contract.metadata.provider, 'proto')
  for (const item of [
    ...loaded.publishedContract.capabilities.telemetry,
    ...loaded.publishedContract.capabilities.commands
  ]) t.is(item.handler, undefined)
})
