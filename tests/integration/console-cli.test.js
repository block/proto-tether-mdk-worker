'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const { randomBytes } = require('node:crypto')
const { createRequire } = require('node:module')
const { spawn } = require('node:child_process')
const test = require('brittle')
const { createServer } = require('../../mock/server')

const MDK_REPO = path.resolve(process.env.MDK_REPO || '/tmp/mdk-latest')
process.env.MDK_REPO = MDK_REPO
const { startProtoWorker } = require('../../host')
const { readClientKeyPair } = require('../../tools/control-plane/worker-client')
const requireFromRuntime = createRequire(path.join(MDK_REPO, 'backend/core/mdk-worker/package.json'))
const createTestnet = requireFromRuntime('hyperdht/testnet')
const CONSOLE = path.resolve(__dirname, '../../tools/control-plane/server.js')

test('console CLI joins the configured private DHT and rotates its API token on each launch', { timeout: 30000 }, async t => {
  const testnet = await createTestnet(3, t.teardown)
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proto-console-cli-'))
  t.teardown(() => fs.rmSync(root, { recursive: true, force: true }), { order: 100 })
  const seedFile = path.join(root, 'client.seed')
  fs.writeFileSync(seedFile, randomBytes(32), { mode: 0o600 })
  const keyPair = readClientKeyPair(seedFile)
  const mock = createServer()
  t.teardown(() => mock.close())
  const address = await mock.ready
  const worker = await startProtoWorker({
    workerId: 'proto-worker',
    storeDir: path.join(root, 'worker'),
    bootstrap: testnet.bootstrap,
    trustedKernelKeys: [keyPair.publicKey],
    devices: [{ deviceId: 'proto-r2-1', config: { address: '127.0.0.1', port: address.port, password: 'test-password' } }]
  })
  t.teardown(() => worker.stop())
  const env = {
    MDK_REPO,
    MDK_CLIENT_SEED_FILE: seedFile,
    MDK_WORKER_KEY: worker.runtime.getPublicKey().toString('hex'),
    PROTO_WORKER_ID: 'proto-worker',
    PROTO_DEVICE_ID: 'proto-r2-1',
    PROTO_DHT_BOOTSTRAP: testnet.bootstrap.map(node => `${node.host}:${node.port}`).join(',')
  }
  const first = await launchConsole(t, env)
  t.is((await fetch(`${first.base}/api/capabilities`)).status, 401)
  const headers = { 'x-control-token': first.token }
  t.is((await (await fetch(`${first.base}/api/telemetry/hashrate_avg`, { headers })).json()).value, 95.5, 'the real CLI reaches a worker on a private DHT')
  const written = await fetch(`${first.base}/api/command`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ command: 'setLED', params: { enabled: true } })
  })
  t.is((await written.json()).status, 'SUCCESS')
  t.is(mock.state.led, true)
  const second = await launchConsole(t, env)
  t.is(second.token === first.token, false, 'access tokens are per launch, not derived from the persistent client seed')
  t.is((await fetch(`${second.base}/api/capabilities`, { headers })).status, 401, 'a previous launch token grants no API access')
  t.is((await fetch(`${second.base}/api/config`, { headers: { 'x-control-token': second.token } })).status, 200, 'the replacement launch token authenticates without sharing a live DHT connection')

  // Reuse the proven RPC connection so a holepunch failure cannot mask response validation.
  worker.runtime.workerId = 'different-worker-id'
  try {
    const response = await fetch(`${first.base}/api/capabilities`, { headers })
    t.is(response.status, 502)
    t.is((await response.json()).error, 'ERR_CONTROL_WORKER_UNAVAILABLE')
  } finally {
    worker.runtime.workerId = 'proto-worker'
  }
  await first.stop()
  t.is(first.stderr().trim(), 'ERR_CONTROL_WORKER_UNAVAILABLE: ERR_CONTROL_WORKER_RESPONSE_INVALID', 'request diagnostics identify a worker identity mismatch over the established connection')
})

test('console CLI reports a busy port without leaking its private seed or a launch token', { timeout: 10000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proto-console-busy-'))
  t.teardown(() => fs.rmSync(root, { recursive: true, force: true }), { order: 100 })
  const seedFile = path.join(root, 'client.seed')
  fs.writeFileSync(seedFile, randomBytes(32), { mode: 0o600 })
  const occupied = http.createServer()
  await new Promise(resolve => occupied.listen(0, '127.0.0.1', resolve))
  t.teardown(() => new Promise(resolve => occupied.close(resolve)))
  const child = spawn(process.execPath, [CONSOLE], {
    env: { ...process.env, MDK_REPO, MDK_CLIENT_SEED_FILE: seedFile, MDK_WORKER_KEY: 'ab'.repeat(32), CONTROL_PORT: String(occupied.address().port) },
    timeout: 3000
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  const exit = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal }))
  })
  t.alike(exit, { code: 1, signal: null })
  t.is(stdout, '')
  t.is(stderr, 'ERR_CONTROL_STARTUP_FAILED: EADDRINUSE\n')
})

async function launchConsole (t, env) {
  const reservation = http.createServer()
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve))
  const port = reservation.address().port
  await new Promise(resolve => reservation.close(resolve))
  const child = spawn(process.execPath, [CONSOLE], { env: { ...process.env, ...env, CONTROL_PORT: String(port) } })
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += chunk })
  const exited = new Promise(resolve => child.once('close', resolve))
  const stop = async () => { child.kill('SIGTERM'); await exited }
  t.teardown(stop, { order: -20 })
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ERR_TEST_CONSOLE_START_TIMEOUT')), 5000)
    let stdout = ''
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('close', () => { clearTimeout(timer); reject(new Error('ERR_TEST_CONSOLE_STARTUP_FAILED')) })
    child.stdout.on('data', chunk => {
      stdout += chunk
      const match = /http:\/\/127\.0\.0\.1:\d+\/#([a-f0-9]{64})/.exec(stdout)
      if (!match) return
      clearTimeout(timer)
      resolve({ base: `http://127.0.0.1:${port}`, token: match[1], stderr: () => stderr, stop })
    })
  })
}
