'use strict'

const path = require('node:path')
const { createRequire } = require('node:module')
const test = require('brittle')

const runtimeModule = process.env.MDK_REPO
  ? path.join(path.resolve(process.env.MDK_REPO), 'backend/core/mdk-worker')
  : '@tetherto/mdk/backend/core/mdk-worker'
const requireFromRuntime = createRequire(require.resolve(runtimeModule))
const { WorkerRuntime } = requireFromRuntime('./index')

// Audited at MDK 633ee079 and 7f5cae88. If upstream startup changes, review
// host/runtime.js against the new lifecycle before updating this expectation.
const knownStart = `async start () {
  await this._openContexts()
  const seedDht = await this._getOrCreateSeed('seedDht')
  const seedRpc = await this._getOrCreateSeed('seedRpc')
  this._dht = new DHT({ keyPair: DHT.keyPair(seedDht), ...(this._bootstrap ? { bootstrap: this._bootstrap } : {}) })
  this._rpc = new HyperswarmRPC({ dht: this._dht, seed: seedRpc })
  this._server = this._rpc.createServer()
  this._server.respond('mdk', async (reqBuf) => {
    try {
      const envelope = deserialize(reqBuf)
      const result = await this.handleRequest(envelope)
      return serialize(result)
    } catch (err) {
      debug('request error: %s', err.message)
      return serialize({ error: err.message })
    }
  })
  await this._server.listen()
  debug('runtime RPC listening (key: %s...)', this._server.publicKey.toString('hex').slice(0, 16))
  if (this.kernelTopic) {
    await this._joinDiscoveryTopic()
  }
  return { publicKey: this._server.publicKey }
}`

test('authorized host startup mirrors the audited upstream startup lifecycle', (t) => {
  const normalize = source => source.replace(/\s+/g, ' ').trim()
  t.is(normalize(WorkerRuntime.prototype.start.toString()), normalize(knownStart), 'upstream startup drift requires re-syncing the authorization adapter')
})
