'use strict'

const path = require('node:path')
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

test('V2 handlers translate real mock telemetry', async (t) => {
  const { instance } = await fixture(t)
  t.is(await instance.telemetry.get('hashrate_avg')({}), 95.5)
  t.is(await instance.telemetry.get('power')({}), 3250)
  t.is(await instance.telemetry.get('status')({}), 'mining')
  t.is(await instance.telemetry.get('fan_speed')({}), 5050)
  const snap = await instance.telemetry.get('snap')({})
  t.is(snap.config.model, 'R2')
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
