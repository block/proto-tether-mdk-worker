'use strict'

const { isIP } = require('node:net')

function parseBootstrap (value) {
  if (value === undefined) return undefined
  return value.split(',').map(entry => {
    const match = /^(?:\[([^\]]+)\]|([^:\s]+)):(\d+)$/.exec(entry.trim())
    if (!match) throw new Error('ERR_DHT_BOOTSTRAP_INVALID')
    const host = match[1] || match[2]
    const port = Number(match[3])
    const hostname = host.length <= 253 && host.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))
    if ((match[1] ? isIP(host) !== 6 : !isIP(host) && !hostname) || port < 1 || port > 65535) {
      throw new Error('ERR_DHT_BOOTSTRAP_INVALID')
    }
    return { host, port }
  })
}

module.exports = parseBootstrap
