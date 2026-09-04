'use strict'

const { getClient } = require('../client')

module.exports = async function health () {
  try {
    const device = await getClient()
    return { status: (await device.getStatus()) === 'error' ? 'DEGRADED' : 'OK' }
  } catch {
    return { status: 'OFFLINE' }
  }
}
