'use strict'

const path = require('node:path')
const { AuthorizedWorkerRuntime } = require('./runtime')

async function startProtoWorker (options = {}) {
  if (typeof options.storeDir !== 'string' || !options.storeDir.trim()) {
    throw new Error('ERR_WORKER_STORE_DIR_REQUIRED')
  }
  const runtime = new AuthorizedWorkerRuntime(path.resolve(__dirname, '..'), options)
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
