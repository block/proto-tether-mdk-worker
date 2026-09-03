'use strict'
const withDevice = require('../with-device')
module.exports = withDevice(device => device.getTemperature())
