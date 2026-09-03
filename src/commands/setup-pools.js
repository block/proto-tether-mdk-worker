'use strict'
const withDevice = require('../with-device')
module.exports = withDevice((device, params) => device.setupPools(params.pools, params.appendId))
