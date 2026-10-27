'use strict'

const path = require('node:path')
const { createRequire } = require('node:module')

// Resolve transport dependencies from the installed MDK, so the adapter uses
// exactly the same versions as the runtime in either supported layout.
const runtimeModule = process.env.MDK_REPO
  ? path.join(path.resolve(process.env.MDK_REPO), 'backend/core/mdk-worker')
  : '@tetherto/mdk/backend/core/mdk-worker'
const requireFromRuntime = createRequire(require.resolve(runtimeModule))
const { WorkerRuntimeV2 } = requireFromRuntime('./index')
const DHT = requireFromRuntime('hyperdht')
const HyperswarmRPC = requireFromRuntime('@hyperswarm/rpc')
const debug = requireFromRuntime('debug')('mdk:worker:runtime')
const { serialize, deserialize } = requireFromRuntime('../kernel/lib/protocol/envelope')

class AuthorizedWorkerRuntime extends WorkerRuntimeV2 {
  constructor (dir, options) {
    const trustedKeys = validateTrustedKeys(options.trustedKernelKeys)
    super(dir, { ...options, allowedKeys: [...trustedKeys], allowAll: false })
    this._peerFirewall = remotePublicKey => !Buffer.isBuffer(remotePublicKey) || !trustedKeys.has(remotePublicKey.toString('hex'))
  }

  // Newer MDK owns admission, envelope validation and public error handling.
  // Older releases need the transport adapter to install a firewall before listen.
  async start () {
    if (typeof super.allowKey === 'function') return super.start()
    await this._openContexts()
    const seedDht = await this._getOrCreateSeed('seedDht')
    const seedRpc = await this._getOrCreateSeed('seedRpc')
    this._dht = new DHT({ keyPair: DHT.keyPair(seedDht), ...(this._bootstrap ? { bootstrap: this._bootstrap } : {}) })
    this._rpc = new HyperswarmRPC({ dht: this._dht, seed: seedRpc })
    this._server = this._rpc.createServer({ firewall: this._peerFirewall })
    this._server.respond('mdk', async reqBuf => {
      try {
        return serialize(await this.handleRequest(deserialize(reqBuf)))
      } catch (err) {
        debug('request error: %s', err.message)
        return serialize({ error: err.message })
      }
    })
    await this._server.listen()
    debug('runtime RPC listening (key: %s...)', this._server.publicKey.toString('hex').slice(0, 16))
    if (this.kernelTopic) await this._joinDiscoveryTopic()
    return { publicKey: this._server.publicKey }
  }
}

function validateTrustedKeys (keys) {
  if (keys === undefined || (Array.isArray(keys) && keys.length === 0)) {
    throw new Error('ERR_TRUSTED_KERNEL_KEYS_REQUIRED')
  }
  if (!Array.isArray(keys)) throw new Error('ERR_TRUSTED_KERNEL_KEYS_INVALID')
  return new Set(keys.map(key => {
    if (Buffer.isBuffer(key) && key.length === 32) return key.toString('hex')
    if (typeof key === 'string' && /^[a-f0-9]{64}$/i.test(key)) return key.toLowerCase()
    throw new Error('ERR_TRUSTED_KERNEL_KEYS_INVALID')
  }))
}

module.exports = { AuthorizedWorkerRuntime }
