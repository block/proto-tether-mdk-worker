'use strict'

const test = require('brittle')
const parseBootstrap = require('../../lib/dht-bootstrap')

test('host and console share the DHT bootstrap address format', t => {
  t.is(parseBootstrap(undefined), undefined)
  t.alike(parseBootstrap('127.0.0.1:1234, bootstrap.example:65535, [::1]:5678'), [
    { host: '127.0.0.1', port: 1234 },
    { host: 'bootstrap.example', port: 65535 },
    { host: '::1', port: 5678 }
  ])
  for (const invalid of ['', '127.0.0.1:0', '127.0.0.1:65536', 'bad host:1234', '::1:1234', '[not-ipv6]:1234', 'https://example.com:1234']) {
    t.exception(() => parseBootstrap(invalid), /ERR_DHT_BOOTSTRAP_INVALID/)
  }
})
