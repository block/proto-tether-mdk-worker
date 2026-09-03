'use strict'

const path = require('node:path')
const http = require('node:http')
const { spawn } = require('node:child_process')
const test = require('brittle')
const { createServer } = require('../../mock/server')

const MDK_REPO = path.resolve(process.env.MDK_REPO || '/tmp/mdk-latest')
const { loadContract } = require(path.join(MDK_REPO, 'backend/core/mdk-worker/lib/contract-loader'))
const { createInstance } = require(path.join(MDK_REPO, 'backend/core/mdk-worker/lib/instance-loader'))
const WORKER_DIR = path.resolve(__dirname, '../..')

async function fixture (t, mockOpts = {}, deviceOpts = {}) {
  const mock = createServer(mockOpts)
  const address = await mock.ready
  t.teardown(() => mock.close())
  const { dir, entries } = loadContract(WORKER_DIR)
  const instance = createInstance({
    dir,
    entries,
    device: {
      id: 'R2-T1',
      opts: Object.freeze({ address: '127.0.0.1', port: address.port, password: 'test-password', ...deviceOpts }),
      env: Object.freeze({}),
      config: Object.freeze({}),
      workerId: 'proto-test',
      logger: () => {}
    }
  })
  return { mock, instance }
}

test('V2 handlers translate real mock telemetry and normalized snapshot values', async (t) => {
  const { instance } = await fixture(t)
  t.is(await instance.telemetry.get('hashrate_avg')({}), 95.5)
  t.is(await instance.telemetry.get('power')({}), 3250)
  t.is(await instance.telemetry.get('temperature')({}), 65.5)
  t.is(await instance.telemetry.get('efficiency')({}), 34.03)
  t.is(await instance.telemetry.get('status')({}), 'mining')
  t.is(await instance.telemetry.get('uptime')({}), 521000)
  t.is(await instance.telemetry.get('accepted_shares')({}), 10)
  t.is(await instance.telemetry.get('rejected_shares')({}), 1)
  t.is(await instance.telemetry.get('power_target')({}), 3300)
  t.is(await instance.telemetry.get('fan_speed')({}), 5050)
  const snap = await instance.telemetry.get('snap')({})
  t.is(snap.stats.uptime_ms, 521000)
  t.is(snap.stats.hashrate_mhs.avg, 95500000)
  t.is(snap.stats.temperature_c.max, 70)
  t.is(snap.config.network_config.mode, 'dhcp')
  t.is(snap.config.network_config.ip_address, '192.0.2.10')
  t.is(snap.config.network_config.ip_gw, '192.0.2.1')
  t.is(snap.config.network_config.ip_netmask, '255.255.255.0')
  t.is(snap.config.model, 'R2')
  const serialized = JSON.stringify(snap)
  t.is(serialized.includes('password'), false)
  t.is(serialized.includes('token'), false)
  t.is(serialized.includes('secret'), false)
})

test('V2 handlers execute real mock commands', async (t) => {
  const { mock, instance } = await fixture(t)
  await instance.commands.get('setLED')({ enabled: true })
  await instance.commands.get('setPowerTarget')({ watts: 2800 })
  await instance.commands.get('setPowerMode')({ mode: 'sleep' })
  await instance.commands.get('setupPools')({ pools: [{ url: 'stratum+tcp://new-pool:3333', worker_name: 'account', worker_password: 'x' }] })
  await instance.commands.get('reboot')({})
  t.is(mock.state.led, true)
  t.is(mock.state.target.power_target_watts, 2800)
  t.is(mock.state.mining.status, 'Stopped')
  t.is(mock.state.pools[0].user, 'account.R2-T1')
  t.is(mock.state.rebooted, true)
})

test('expired token renews once and returns telemetry', async (t) => {
  const { mock, instance } = await fixture(t, { expireFirstToken: true })
  t.is(await instance.telemetry.get('power')({}), 3250)
  t.is(mock.state.loginCount, 1)
  t.is(mock.state.refreshCount, 1)
})

test('bad credentials return a redacted authentication error', async (t) => {
  const { instance } = await fixture(t, {}, { password: 'wrong-password' })
  let authError
  await t.exception(instance.telemetry.get('status')({}).catch((err) => {
    authError = err
    throw err
  }), /ERR_AUTHENTICATION_FAILED/)
  t.is(authError.message.includes('wrong-password'), false)
})

test('delayed and malformed reads return stable errors', async (t) => {
  const delayed = await fixture(t, { delayMs: 25 }, { accessToken: 'mock-access-1', password: undefined, timeout: 5 })
  await t.exception(delayed.instance.telemetry.get('power')({}), /ERR_REQUEST_TIMEOUT/)

  const malformed = await fixture(t, { malformedPaths: ['/api/v1/telemetry'] })
  await t.exception(malformed.instance.telemetry.get('power')({}), /ERR_RESPONSE_INVALID_JSON/)

  const unavailable = await fixture(t, { statusByPath: { '/api/v1/telemetry': 503 } })
  await t.exception(unavailable.instance.telemetry.get('power')({}), /ERR_HTTP_RESPONSE: 503/)
})

test('an ambiguous write connection outcome is never retried', async (t) => {
  const { mock, instance } = await fixture(t, { disconnectPaths: ['/api/v1/mining/target'] })
  await t.exception(instance.commands.get('setPowerTarget')({ watts: 2800 }), /ERR_DEVICE_CONNECTION/)
  t.is(mock.state.writeAttempts['/api/v1/mining/target'], 1)
})

test('mock returns a stable bad request for malformed request JSON', async (t) => {
  const mock = createServer()
  const address = await mock.ready
  t.teardown(() => mock.close())
  const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{'
  })

  t.is(response.status, 400)
  t.alike(await response.json(), { error: 'ERR_MOCK_BAD_REQUEST' })
})

test('mock returns a stable response when route handling rejects', async (t) => {
  const mock = createServer()
  const address = await mock.ready
  t.teardown(() => mock.close())
  const base = `http://127.0.0.1:${address.port}`
  const login = await fetch(`${base}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'test-password' })
  })
  const token = (await login.json()).access_token

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 100)
  let response
  try {
    response = await fetch(`${base}/api/v1/pools`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ pools: [] }),
      signal: controller.signal
    })
  } finally {
    clearTimeout(timer)
  }

  t.is(response.status, 500)
  t.alike(await response.json(), { error: 'ERR_MOCK_REQUEST_FAILED' })
})

test('mock runner reports stable non-secret startup failures', async (t) => {
  const blocker = http.createServer((req, res) => res.end('occupied'))
  await new Promise(resolve => blocker.listen(0, '127.0.0.1', resolve))
  t.teardown(() => blocker.close())

  const child = spawn(process.execPath, [path.join(WORKER_DIR, 'scripts/run-mock.js')], {
    env: { ...process.env, PORT: String(blocker.address().port), PROTO_RIG_PASSWORD: 'startup-secret' },
    stdio: ['ignore', 'pipe', 'pipe']
  })

  const result = await collectChild(child)
  t.is(result.code, 1)
  t.ok(result.stderr.includes('ERR_MOCK_STARTUP_FAILED'))
  t.is(result.stderr.includes('startup-secret'), false)
  t.is(result.stdout.includes('startup-secret'), false)
})

function collectChild (child) {
  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', reject)
    child.on('close', code => resolve({ code, stdout, stderr }))
  })
}
