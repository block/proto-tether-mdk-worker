'use strict'

const { createHash } = require('node:crypto')
const test = require('brittle')
const { ProtoRigClient } = require('../../lib/proto-rig-client')
const maintenance = require('../../lib/maintenance')

function client (api = {}) {
  return new ProtoRigClient({ id: 'R2-001', api })
}

function firmware () {
  const bytes = Buffer.from('070701simulated-swu\0binary')
  return { filename: 'update.swu', encoding: 'base64', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), data: bytes.toString('base64') }
}

test('log command returns a projected tail and redacts credentials', async (t) => {
  let args
  const device = client({
    http: { password: 'rig-secret', accessToken: 'access-secret', refreshToken: 'refresh-secret' },
    getLogs: async (...values) => {
      args = values
      return { logs: { source: 'miner_sw', lines: 4, content: ['rig-secret access-secret refresh-secret', 'password=pool-secret', 'Bearer test-key-do-not-use', 'fan running'], token: 'hidden' } }
    }
  })
  t.alike(await maintenance.downloadLogs(device), { source: 'miner_sw', lines: 4, content: ['[REDACTED] [REDACTED] [REDACTED]', 'password=[REDACTED]', 'Bearer [REDACTED]', 'fan running'] })
  t.alike(args, ['miner_sw', 100])
  for (const params of [{ source: 'unknown' }, { lines: 0 }, { lines: 10001 }, { lines: 1.5 }]) {
    await t.exception(maintenance.downloadLogs(device, params), /ERR_LOGS_PARAMETERS_INVALID/)
  }
  for (const logs of [{ source: 'os', lines: 1, content: ['x'] }, { source: 'miner_sw', lines: 2, content: ['x'] }, { source: 'miner_sw', lines: 1, content: [false] }]) {
    await t.exception(maintenance.downloadLogs(client({ getLogs: async () => ({ logs }) })), /ERR_LOGS_RESPONSE_INVALID/)
  }
})

test('network writes validate the exact Proto configuration and invalidate inventory', async (t) => {
  let sent
  const device = client({ setNetwork: async network => { sent = network } })
  device.reads.set('network', { promise: Promise.resolve({}), expires: Infinity })
  device.reads.set('system', { promise: Promise.resolve({}), expires: Infinity })
  t.alike(await maintenance.setNetwork(device, { dhcp: false, ip: '192.0.2.10', netmask: '255.255.255.0', hostname: 'rig-1' }), { success: true })
  t.alike(sent, { dhcp: false, ip: '192.0.2.10', netmask: '255.255.255.0', hostname: 'rig-1' })
  t.is(device.reads.has('network'), false)
  t.is(device.reads.has('system'), false)
  t.alike(await maintenance.setNetwork(device, { dhcp: true }), { success: true })
  for (const network of [null, {}, { dhcp: 'yes' }, { dhcp: true, ip: '192.0.2.10' }, { dhcp: true, dns: '192.0.2.1' }, { dhcp: false, ip: 'bad', netmask: '255.255.255.0' }, { dhcp: false, ip: '192.0.2.10', netmask: '255.0.255.0' }, { dhcp: true, hostname: '../bad' }]) {
    await t.exception(maintenance.setNetwork(device, network), /ERR_NETWORK_CONFIG_INVALID/)
  }
  const failed = client({ setNetwork: async () => { throw new Error('ERR_DEVICE_CONNECTION') } })
  failed.reads.set('network', {})
  await t.exception(maintenance.setNetwork(failed, { dhcp: true }), /ERR_DEVICE_CONNECTION/)
  t.is(failed.reads.has('network'), false, 'ambiguous network writes clear prior state')
})

test('log redaction consumes quoted credentials, escaped quotes and unterminated values', async (t) => {
  const cases = [
    ['password="FAKE words, punctuation; and spaces"', 'password=[REDACTED]'],
    ["worker_password='FAKE words; and punctuation'", 'worker_password=[REDACTED]'],
    [String.raw`{"access_token":"FAKE escaped \" quote, tail"}`, '{"access_token":[REDACTED]}'],
    [String.raw`api_key='FAKE escaped \' quote; tail'`, 'api_key=[REDACTED]'],
    ['refresh-token="FAKE unterminated tail', 'refresh-token=[REDACTED]'],
    ['password="FAKE trailing slash' + String.fromCharCode(92), 'password=[REDACTED]'],
    ['password="" other=ok', 'password=[REDACTED] other=ok'],
    ['password="FAKE one" api_key=FAKE-two', 'password=[REDACTED] api_key=[REDACTED]']
  ]
  const device = client({ getLogs: async () => ({ logs: { source: 'miner_sw', lines: cases.length, content: cases.map(([line]) => line) } }) })
  t.alike((await device.downloadLogs()).content, cases.map(([, expected]) => expected))
})

test('firmware update distinguishes acceptance from installation and invalidates all reads', async (t) => {
  const ota = client({ startFirmwareUpdate: async () => ({ status: 202, data: null }) })
  ota.reads.set('psus', {})
  t.alike(await maintenance.updateFirmware(ota), { accepted: true, completed: false, mode: 'ota' })
  t.is(ota.reads.size, 0)
  let bytes
  let name
  const upload = client({ uploadFirmware: async (data, filename) => { bytes = data; name = filename; return { status: 200, data: null } } })
  const image = firmware()
  t.alike(await maintenance.updateFirmware(upload, image), { accepted: true, completed: false, mode: 'upload' })
  t.alike(bytes, Buffer.from(image.data, 'base64'))
  t.is(name, image.filename)
  for (const change of [{ filename: '../update.swu' }, { filename: 'update.zip' }, { encoding: 'hex' }, { size: 0 }, { size: image.size + 1 }, { sha256: '0'.repeat(64) }, { data: image.data + ' ' }]) {
    let writes = 0
    const rejected = client({ uploadFirmware: async () => { writes++ } })
    await t.exception(maintenance.updateFirmware(rejected, { ...image, ...change }), /ERR_FIRMWARE_PAYLOAD_INVALID/)
    t.is(writes, 0, 'invalid images fail before device I/O')
  }
  await t.exception(maintenance.updateFirmware(client({ startFirmwareUpdate: async () => ({ status: 200 }) })), /ERR_FIRMWARE_RESPONSE_INVALID/)
})

test('firmware command rejects overlap and propagates ambiguous outcomes without retry', async (t) => {
  let release
  let attempts = 0
  const device = client({
    startFirmwareUpdate: () => {
      attempts++
      return new Promise((resolve, reject) => { release = reject })
    }
  })
  device.reads.set('history:1h', {})
  const running = maintenance.updateFirmware(device)
  await Promise.resolve()
  await t.exception(maintenance.updateFirmware(device), /ERR_COMMAND_IN_PROGRESS/)
  release(new Error('ERR_DEVICE_CONNECTION'))
  await t.exception(running, /ERR_DEVICE_CONNECTION/)
  t.is(attempts, 1)
  t.is(device.reads.size, 0)
  device.api.startFirmwareUpdate = async () => ({ status: 202 })
  t.alike(await maintenance.updateFirmware(device), { accepted: true, completed: false, mode: 'ota' }, 'a finished failed attempt releases the local overlap guard')
})
