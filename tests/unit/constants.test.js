'use strict'

const test = require('brittle')
const constants = require('../../lib/constants')

test('exports transport defaults', (t) => {
  t.is(constants.DEFAULT_PORT, 80)
  t.is(constants.DEFAULT_PROTOCOL, 'http')
  t.is(constants.DEFAULT_TIMEOUT, 10000)
  t.is(constants.API_PREFIX, '/api/v1')
})
