'use strict'

const path = require('node:path')
const { startProtoWorker } = require('./index')
const { ProtoHttpClient } = require('../lib/http-client')
const { DEFAULT_PORT, DEFAULT_PROTOCOL } = require('../lib/constants')

async function main () {
  const address = process.env.PROTO_RIG_ADDRESS
  const password = process.env.PROTO_RIG_PASSWORD
  if (!address) throw new Error('ERR_ADDRESS_REQUIRED')
  if (!password) throw new Error('ERR_PASSWORD_REQUIRED')

  const config = {
    address,
    password,
    port: process.env.PROTO_RIG_PORT === undefined ? DEFAULT_PORT : Number(process.env.PROTO_RIG_PORT),
    protocol: process.env.PROTO_RIG_PROTOCOL || DEFAULT_PROTOCOL
  }
  // Validate the connection config before opening the runtime. This constructor
  // performs no device I/O; commands remain operator-driven.
  new ProtoHttpClient(config) // eslint-disable-line no-new
  const workerId = process.env.PROTO_WORKER_ID || 'proto-worker'
  const worker = await startProtoWorker({
    workerId,
    kernelTopic: process.env.PROTO_KERNEL_TOPIC || null,
    storeDir: path.resolve(process.env.PROTO_STORE_DIR || path.join(__dirname, '../store/proto-worker')),
    devices: [{ deviceId: process.env.PROTO_DEVICE_ID || 'proto-r2-1', config }]
  })

  const stop = async () => {
    process.removeListener('SIGINT', stop)
    process.removeListener('SIGTERM', stop)
    try {
      await worker.stop()
    } catch {
      console.error('ERR_WORKER_SHUTDOWN_FAILED')
      process.exitCode = 1
    }
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  console.log(JSON.stringify({ workerId, publicKey: worker.runtime.getPublicKey().toString('hex') }))
}

main().catch(err => {
  console.error(/ERR_[A-Z0-9_]+/.exec(err.message)?.[0] || 'ERR_WORKER_STARTUP_FAILED')
  process.exitCode = 1
})
