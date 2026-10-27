'use strict'

const path = require('node:path')
const { createRequire } = require('node:module')
const test = require('brittle')

const runtimeModule = process.env.MDK_REPO
  ? path.join(path.resolve(process.env.MDK_REPO), 'backend/core/mdk-worker')
  : '@tetherto/mdk/backend/core/mdk-worker'
const requireFromRuntime = createRequire(require.resolve(runtimeModule))
const { WorkerRuntime } = requireFromRuntime('./index')
const { AuthorizedWorkerRuntime } = require('../../host/runtime')
const nativeAdmission = typeof WorkerRuntime.prototype.allowKey === 'function'

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

test('legacy host adapter mirrors the audited upstream startup lifecycle', { skip: nativeAdmission }, (t) => {
  const normalize = source => source.replace(/\s+/g, ' ').trim()
  t.is(normalize(WorkerRuntime.prototype.start.toString()), normalize(knownStart), 'upstream startup drift requires re-syncing the authorization adapter')
})

test('host delegates startup to MDK when native caller admission is available', { skip: !nativeAdmission }, async t => {
  const runtime = new AuthorizedWorkerRuntime(path.resolve(__dirname, '../..'), {
    workerId: 'native-admission-test',
    devices: [],
    allowEmptyDevices: true,
    trustedKernelKeys: ['ab'.repeat(32)],
    allowedKeys: ['cd'.repeat(32)],
    allowAll: true
  })
  t.alike(runtime.getAllowedKeys(), ['ab'.repeat(32)], 'only host-trusted transports are admitted')
  t.is(runtime._allowAll, false, 'host admission cannot be bypassed with allowAll')
  const start = WorkerRuntime.prototype.start
  t.teardown(() => { WorkerRuntime.prototype.start = start })
  const result = { publicKey: Buffer.alloc(32) }
  WorkerRuntime.prototype.start = async function () {
    t.is(this, runtime, 'upstream startup receives the authorized runtime')
    return result
  }
  t.is(await runtime.start(), result, 'the native startup result is preserved')
})
