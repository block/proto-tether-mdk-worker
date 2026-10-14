'use strict'

const path = require('node:path')
const fs = require('node:fs/promises')
const { AuthorizedWorkerRuntime } = require('./runtime')

async function startProtoWorker (options = {}) {
  if (typeof options.storeDir !== 'string' || !options.storeDir.trim()) {
    throw new Error('ERR_WORKER_STORE_DIR_REQUIRED')
  }
  const runtime = new AuthorizedWorkerRuntime(path.resolve(__dirname, '..'), options)
  // Acquire before contexts or seeds open. A crash deliberately leaves the lock
  // behind: operators must establish that its owner is stopped before removal.
  await fs.mkdir(options.storeDir, { recursive: true })
  const lockPath = path.join(options.storeDir, '.proto-worker.lock')
  let lock
  try {
    lock = await fs.open(lockPath, 'wx', 0o600)
  } catch (err) {
    if (err.code === 'EEXIST') throw new Error('ERR_WORKER_STORE_LOCKED')
    throw err
  }
  const releaseLock = async () => {
    await lock.close()
    await fs.unlink(lockPath)
  }
  try {
    await runtime.start()
  } catch (err) {
    // Retain the lock if cleanup fails; another host must not reuse live seeds.
    await runtime.stop()
    await releaseLock()
    throw err
  }

  let stopping
  return {
    runtime,
    stop: () => {
      if (!stopping) stopping = runtime.stop().then(releaseLock)
      return stopping
    }
  }
}

module.exports = { startProtoWorker }
