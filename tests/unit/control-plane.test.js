'use strict'

const test = require('brittle')

test('development console forms preserve false and zero, omit optional blanks and parse structured parameters', async t => {
  const { parseParams } = await import('../../tools/control-plane/public/model.mjs')
  const command = {
    params: [
      { name: 'enabled', type: 'boolean', required: true },
      { name: 'count', type: 'number', min: 0, max: 10 },
      { name: 'pools', type: 'object', required: true },
      { name: 'optional', type: 'string' }
    ]
  }
  t.alike(parseParams(command, { enabled: 'false', count: '0', pools: '[{"url":"stratum+tcp://example:3333"}]', optional: '' }), {
    enabled: false, count: 0, pools: [{ url: 'stratum+tcp://example:3333' }]
  })
  for (const values of [
    { enabled: '', pools: '[]' }, { enabled: 'false', count: '11', pools: '[]' },
    { enabled: 'false', count: 'NaN', pools: '[]' }, { enabled: 'false', pools: '{' }
  ]) t.exception(() => parseParams(command, values))
  t.exception(() => parseParams({ params: [{ name: 'mode', type: 'string', enum: ['normal', 'sleep'], required: true }] }, { mode: 'high' }))
})

test('development console distinguishes HTTP success from MDK command failure and redacts previews', async t => {
  const { commandResult, preview } = await import('../../tools/control-plane/public/model.mjs')
  t.is(commandResult({ status: 'SUCCESS', result: { success: true } }, 200).ok, true)
  t.is(commandResult({ status: 'FAILED', error: 'ERR_POWER_TARGET_WRITE_UNVERIFIED' }, 200).ok, false)
  t.is(commandResult({ status: 'FAILED', error: 'ERR_POWER_TARGET_WRITE_UNVERIFIED' }, 200).uncertain, true)
  t.is(commandResult({ status: 'SUCCESS' }, 503).ok, false)
  const output = preview({ pools: [{ worker_password: 'private-value' }], firmware: { encoding: 'base64', data: 'secret-payload' } })
  t.is(output.includes('private-value'), false)
  t.is(output.includes('secret-payload'), false)
})
