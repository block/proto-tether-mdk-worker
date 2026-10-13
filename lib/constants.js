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
  // Node clamps setTimeout delays above this to 1ms, so a larger request
  // timeout would silently become the shortest possible one.
  MAX_TIMEOUT: 2147483647,
  MAX_CACHE_MS: 5000,
  MAX_POWER_TARGET_WATTS: 12000,
  REBOOT_COOLDOWN_MS: 5 * 60 * 1000,
  API_PREFIX: '/api/v1'
}
