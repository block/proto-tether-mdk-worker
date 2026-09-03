'use strict'

class ApiV1 {
  constructor (http) {
    if (!http || typeof http.request !== 'function') throw new Error('ERR_HTTP_CLIENT_REQUIRED')
    this.http = http
  }

  getSystemInfo () {
    return this.http.request('/system')
  }

  getNetworkInformation () {
    return this.http.request('/network')
  }

  getMiningTarget () {
    return this.http.request('/mining/target')
  }

  getCooling () {
    return this.http.request('/cooling')
  }

  async getMiningStatus () {
    const data = await this.http.request('/mining')
    return data && data['mining-status'] ? data['mining-status'] : data
  }

  getTelemetry (levels = ['miner', 'hashboard']) {
    const value = Array.isArray(levels) ? levels.join(',') : levels
    return this.http.request(`/telemetry?level=${encodeURIComponent(value)}`)
  }

  async getErrors () {
    const data = await this.http.request('/errors')
    if (!Array.isArray(data)) throw new Error('ERR_ERRORS_RESPONSE_INVALID')
    return data
  }

  async getPools () {
    const data = await this.http.request('/pools')
    if (!data || !Array.isArray(data.pools)) throw new Error('ERR_POOLS_RESPONSE_INVALID')
    return data.pools
  }

  reboot () {
    return this.http.request('/system/reboot', { method: 'POST' })
  }

  setLED (enabled) {
    const query = new URLSearchParams({ enable: String(enabled), led_on_time: '0' })
    return this.http.request(`/system/locate?${query}`, { method: 'POST' })
  }

  setPowerTarget (watts) {
    return this.http.request('/mining/target', { method: 'PUT', body: { power_target_watts: watts } })
  }

  startMining () {
    return this.http.request('/mining/start', { method: 'POST' })
  }

  stopMining () {
    return this.http.request('/mining/stop', { method: 'POST' })
  }

  setPools (pools) {
    return this.http.request('/pools', { method: 'POST', body: pools })
  }
}

module.exports = { ApiV1 }
