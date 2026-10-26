'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { createRequire } = require('node:module')

const runtimeModule = process.env.MDK_REPO
  ? path.join(path.resolve(process.env.MDK_REPO), 'backend/core/mdk-worker')
  : '@tetherto/mdk/backend/core/mdk-worker'
const requireFromRuntime = createRequire(require.resolve(runtimeModule))
const DHT = requireFromRuntime('hyperdht')
const HyperswarmRPC = requireFromRuntime('@hyperswarm/rpc')
const { build, serialize, deserialize, validate } = requireFromRuntime('../kernel/lib/protocol/envelope')
const { ACTIONS, MESSAGE_TYPES } = requireFromRuntime('../kernel/lib/protocol/actions')

function readClientKeyPair (seedFile) {
  if (!seedFile) throw new Error('MDK_CLIENT_SEED_FILE is required')
  const fd = fs.openSync(seedFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  try {
    const stat = fs.fstatSync(fd)
    if (!stat.isFile() || stat.size !== 32 || (stat.mode & 0o077) || stat.uid !== process.getuid()) {
      throw new Error('Client seed must be a private 32-byte file owned by the current user')
    }
    return DHT.keyPair(fs.readFileSync(fd))
  } finally {
    fs.closeSync(fd)
  }
}

function createWorkerClient ({ publicKey, workerId = 'proto-worker', keyPair, bootstrap }) {
  if (!/^[a-f0-9]{64}$/i.test(publicKey || '')) throw new Error('MDK_WORKER_KEY must be a 32-byte hex public key')
  const dht = new DHT({ keyPair, ...(bootstrap ? { bootstrap } : {}) })
  const rpc = new HyperswarmRPC({ dht })
  const key = Buffer.from(publicKey, 'hex')
  const request = async (action, deviceId, payload, responseAction, timeout = 30000) => {
    const envelope = build({ action, type: MESSAGE_TYPES.REQUEST, sender: 'proto-control-plane', target: workerId, deviceId, payload })
    const response = deserialize(await rpc.request(key, 'mdk', serialize(envelope), { timeout }))
    if (!validate(response).valid || response.type !== MESSAGE_TYPES.RESPONSE || response.action !== responseAction ||
        response.sender !== workerId || response.target !== envelope.sender || response.deviceId !== deviceId) {
      throw new Error('Invalid worker response')
    }
    return response.payload
  }
  return {
    endpoint: `worker:${publicKey}`,
    capabilities: async () => (await request(ACTIONS.CAPABILITY_REQUEST, null, {}, ACTIONS.CAPABILITY_RESPONSE)).contract,
    identity: () => request(ACTIONS.IDENTITY_REQUEST, null, {}, ACTIONS.IDENTITY_RESPONSE),
    telemetry: (deviceId, type) => request(ACTIONS.TELEMETRY_PULL, deviceId, { query: { type } }, ACTIONS.TELEMETRY_RESPONSE),
    command: async (deviceId, command, params) => {
      const commandId = randomUUID()
      const result = await request(ACTIONS.COMMAND_REQUEST, deviceId, { commandId, command, params }, ACTIONS.COMMAND_RESULT, 30 * 60 * 1000)
      if (result.commandId !== commandId) throw new Error('Invalid command response')
      return result
    },
    close: async () => { await rpc.destroy(); await dht.destroy() }
  }
}

module.exports = { createWorkerClient, readClientKeyPair }
