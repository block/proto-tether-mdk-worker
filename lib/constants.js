'use strict'

const STATUS = Object.freeze({
  MINING: 'mining',
  NOT_MINING: 'not_mining',
  SLEEPING: 'sleeping',
  ERROR: 'error'
})

const POWER_MODE = Object.freeze({ NORMAL: 'normal', SLEEP: 'sleep' })

module.exports = {
  STATUS,
  POWER_MODE,
  DEFAULT_PORT: 80,
  DEFAULT_PROTOCOL: 'http',
  DEFAULT_TIMEOUT: 10000,
  API_PREFIX: '/api/v1'
}
