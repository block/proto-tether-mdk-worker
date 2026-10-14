'use strict'

class ApiV1 {
  constructor (http) {
    if (!http || typeof http.request !== 'function') throw new Error('ERR_HTTP_CLIENT_REQUIRED')
    this.http = http
  }

  async getSystemInfo () {
    const data = await this.http.request('/system')
    requireEnvelope(data, 'system-info', 'ERR_SYSTEM_RESPONSE_INVALID')
    return data
  }

  async getNetworkInformation () {
    const data = await this.http.request('/network')
    requireEnvelope(data, 'network-info', 'ERR_NETWORK_RESPONSE_INVALID')
    return data
  }

  async getMiningTarget () {
    const { status, data } = await this.http.request('/mining/target', { includeStatus: true })
    if (status === 204) throw new Error('ERR_MINING_STATISTICS_UNAVAILABLE')
    requireObject(data, 'ERR_POWER_TARGET_RESPONSE_INVALID')
    return data
  }

  async getCooling () {
    const data = await this.http.request('/cooling')
    requireEnvelope(data, 'cooling-status', 'ERR_COOLING_RESPONSE_INVALID')
    return data
  }

  async getMiningStatus () {
    const { status, data } = await this.http.request('/mining', { includeStatus: true })
    if (status === 204) return { status: 'Uninitialized' }
    const mining = requireEnvelope(data, 'mining-status', 'ERR_MINING_RESPONSE_INVALID')
    if (typeof mining.status !== 'string' || !mining.status) throw new Error('ERR_MINING_RESPONSE_INVALID')
    return mining
  }

  async getTelemetry (levels = ['miner', 'hashboard']) {
    const value = Array.isArray(levels) ? levels.join(',') : levels
    const data = await this.http.request(`/telemetry?level=${encodeURIComponent(value)}`)
    requireObject(data, 'ERR_TELEMETRY_RESPONSE_INVALID')
    return data
  }

  async getErrors () {
    const data = await this.http.request('/errors')
    if (!Array.isArray(data) || !data.every(isObject)) throw new Error('ERR_ERRORS_RESPONSE_INVALID')
    return data
  }

  async getPools () {
    const data = await this.http.request('/pools')
    if (!isObject(data) || !Array.isArray(data.pools) || !data.pools.every(isObject)) {
      throw new Error('ERR_POOLS_RESPONSE_INVALID')
    }
    return data.pools
  }

  async getPowerSupplies () {
    const data = await this.http.request('/hardware/psus')
    if (!isObject(data) || !Array.isArray(data['psus-info']) || !data['psus-info'].every(isObject)) {
      throw new Error('ERR_PSUS_RESPONSE_INVALID')
    }
    return data
  }

  async getHashrateHistory (duration = '1h') {
    const data = await this.http.request(`/hashrate?duration=${encodeURIComponent(duration)}`)
    const history = requireEnvelope(data, 'hashrate-data', 'ERR_HASHRATE_RESPONSE_INVALID')
    if (!Array.isArray(history.data) || !history.data.every(isObject) || !isObject(history.aggregates)) {
      throw new Error('ERR_HASHRATE_RESPONSE_INVALID')
    }
    return data
  }

  async getLogs (source = 'miner_sw', lines = 100) {
    const query = new URLSearchParams({ source, lines: String(lines) })
    const data = await this.http.request(`/system/logs?${query}`)
    const logs = requireEnvelope(data, 'logs', 'ERR_LOGS_RESPONSE_INVALID')
    if (typeof logs.source !== 'string' || !Number.isInteger(logs.lines) ||
        !Array.isArray(logs.content) || !logs.content.every(line => typeof line === 'string')) {
      throw new Error('ERR_LOGS_RESPONSE_INVALID')
    }
    return data
  }

  setNetwork (network) {
    return this.http.request('/network', { method: 'PUT', body: { 'network-config': network } })
  }

  startFirmwareUpdate () {
    return this.http.request('/system/update', {
      method: 'POST',
      includeStatus: true,
      retryAuth: false,
      freshAuth: true,
      responseType: 'none'
    })
  }

  uploadFirmware (bytes, filename) {
    const body = new FormData()
    body.append('file', new Blob([bytes], { type: 'application/octet-stream' }), filename)
    return this.http.request('/system/update', {
      method: 'PUT',
      body,
      includeStatus: true,
      retryAuth: false,
      freshAuth: true,
      responseType: 'none',
      timeout: 1800000
    })
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

function requireEnvelope (data, name, error) {
  if (!isObject(data) || !isObject(data[name])) throw new Error(error)
  return data[name]
}

function requireObject (value, error) {
  if (!isObject(value)) throw new Error(error)
  return value
}

function isObject (value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

module.exports = { ApiV1 }
