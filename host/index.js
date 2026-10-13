'use strict'

const path = require('node:path')

// MDK's runtime is distributed through its monorepo until the standalone
// @tetherto/mdk-worker package is published. A checkout works as well.
const runtimeModule = process.env.MDK_REPO
  ? path.join(path.resolve(process.env.MDK_REPO), 'backend/core/mdk-worker')
  : '@tetherto/mdk/backend/core/mdk-worker'
const { WorkerRuntimeV2 } = require(runtimeModule)

async function startProtoWorker (options = {}) {
  if (typeof options.storeDir !== 'string' || !options.storeDir.trim()) {
    throw new Error('ERR_WORKER_STORE_DIR_REQUIRED')
  }
  const runtime = new WorkerRuntimeV2(path.resolve(__dirname, '..'), options)
  try {
    await runtime.start()
  } catch (err) {
    await runtime.stop()
    throw err
  }

  let stopping
  return {
    runtime,
    stop: () => {
      if (!stopping) stopping = runtime.stop()
      return stopping
    }
  }
}

module.exports = { startProtoWorker }
