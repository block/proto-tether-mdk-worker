'use strict'

const { STATUS, POWER_MODE, MAX_CACHE_MS, MAX_POWER_TARGET_WATTS, REBOOT_COOLDOWN_MS } = require('./constants')
const maintenance = require('./maintenance')

const ERROR_SOURCES = new Set(['rig', 'fan', 'psu', 'hashboard'])
const COOLING_MODES = new Set(['Unknown', 'Off', 'Auto', 'Manual'])
const HASHRATE_DURATIONS = new Set(['1h', '12h', '24h', '48h', '5d'])
const MINER_METRIC_UNITS = Object.freeze({
  hashrate: 'TH/s',
  temperature: '°C',
  power: 'W',
  efficiency: 'J/TH'
})

const MINING_STATUS = Object.freeze({
  Uninitialized: STATUS.NOT_MINING,
  PoweringOn: STATUS.NOT_MINING,
  Mining: STATUS.MINING,
  DegradedMining: STATUS.ERROR,
  PoweringOff: STATUS.NOT_MINING,
  Stopped: STATUS.SLEEPING,
  Curtailed: STATUS.SLEEPING,
  NoPools: STATUS.ERROR,
  Error: STATUS.ERROR
})

function invalid (code) {
  throw new Error(code)
}

function requireObject (value, code) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid(code)
  return value
}

function requireArray (value, code) {
  if (!Array.isArray(value)) invalid(code)
  return value
}

function requireFinite (value, code, nonNegative = false) {
  if (typeof value !== 'number' || !Number.isFinite(value) || (nonNegative && value < 0)) invalid(code)
  return value
}

function requireCount (value, code) {
  if (!Number.isSafeInteger(value) || value < 0) invalid(code)
  return value
}

function requireIndex (value, code) {
  if (!Number.isInteger(value) || value < 0) invalid(code)
  return value
}

function requireString (value, code) {
  if (typeof value !== 'string' || !value.trim()) invalid(code)
  return value
}

function optionalString (value, code) {
  if (value !== undefined && typeof value !== 'string') invalid(code)
  return value
}

function optionalErrorSource (value) {
  if (value === undefined) return undefined
  if (!ERROR_SOURCES.has(value)) invalid('ERR_ERRORS_RESPONSE_INVALID')
  return value
}

function optionalInteger (value) {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value)) invalid('ERR_ERRORS_RESPONSE_INVALID')
  return value
}

function normalizePoolUrl (value, code) {
  const normalized = requireString(value, code).trim()
  let parsed
  try {
    parsed = new URL(normalized)
  } catch {
    invalid(code)
  }
  if (!parsed.hostname || parsed.username || parsed.password) invalid(code)
  return normalized
}

function errorMetadata (error) {
  return {
    name: 'firmware_error',
    source: optionalErrorSource(error.source),
    slot: optionalInteger(error.slot),
    timestamp: optionalInteger(error.timestamp)
  }
}

function boardTemperature (board) {
  requireObject(board, 'ERR_TELEMETRY_RESPONSE_INVALID')
  const value = requireObject(board.temperature, 'ERR_TELEMETRY_RESPONSE_INVALID')
  if (value.unit !== '°C') invalid('ERR_TELEMETRY_RESPONSE_INVALID')
  return {
    index: requireIndex(board.index, 'ERR_TELEMETRY_RESPONSE_INVALID'),
    inlet: requireFinite(value.inlet, 'ERR_TELEMETRY_RESPONSE_INVALID'),
    outlet: requireFinite(value.outlet, 'ERR_TELEMETRY_RESPONSE_INVALID'),
    average: requireFinite(value.average, 'ERR_TELEMETRY_RESPONSE_INVALID')
  }
}

function systemIdentity (system) {
  const info = requireObject(system['system-info'], 'ERR_SYSTEM_RESPONSE_INVALID')
  optionalString(info.product_name, 'ERR_SYSTEM_RESPONSE_INVALID')
  optionalString(info.model, 'ERR_SYSTEM_RESPONSE_INVALID')
  optionalString(info.cb_sn, 'ERR_SYSTEM_RESPONSE_INVALID')
  return info
}

function networkConfig (network) {
  const info = requireObject(network['network-info'], 'ERR_NETWORK_RESPONSE_INVALID')
  if (typeof info.dhcp !== 'boolean') invalid('ERR_NETWORK_RESPONSE_INVALID')
  return {
    mode: info.dhcp ? 'dhcp' : 'static',
    ip_address: requireString(info.ip, 'ERR_NETWORK_RESPONSE_INVALID'),
    ip_gw: requireString(info.gateway, 'ERR_NETWORK_RESPONSE_INVALID'),
    ip_netmask: requireString(info.netmask, 'ERR_NETWORK_RESPONSE_INVALID')
  }
}

function deviceNetworkInfo (network) {
  const info = requireObject(network['network-info'], 'ERR_NETWORK_RESPONSE_INVALID')
  const result = {}
  if (info.dhcp !== undefined) {
    if (typeof info.dhcp !== 'boolean') invalid('ERR_NETWORK_RESPONSE_INVALID')
    result.mode = info.dhcp ? 'dhcp' : 'static'
  }
  for (const [field, output] of [
    ['ip', 'ip_address'], ['gateway', 'ip_gw'], ['netmask', 'ip_netmask'], ['mac', 'mac'], ['hostname', 'hostname']
  ]) {
    const value = optionalString(info[field], 'ERR_NETWORK_RESPONSE_INVALID')
    if (value !== undefined && value.trim()) result[output] = value
  }
  return result
}

function psuInfo (psu) {
  const code = 'ERR_PSUS_RESPONSE_INVALID'
  requireObject(psu, code)
  const result = {}
  for (const [field, output] of [
    ['psu_sn', 'serial_number'], ['manufacturer', 'manufacturer'], ['model', 'model'],
    ['vendor', 'vendor'], ['hw_revision', 'hw_revision']
  ]) {
    if (psu[field] !== undefined) result[output] = optionalString(psu[field], code)
  }
  if (psu.slot !== undefined) result.slot = requireCount(psu.slot, code)
  if (psu.firmware !== undefined) {
    const firmware = requireObject(psu.firmware, code)
    result.firmware = {}
    for (const field of ['app_version', 'bootloader_version']) {
      if (firmware[field] !== undefined) result.firmware[field] = optionalString(firmware[field], code)
    }
  }
  if (psu.power !== undefined) {
    const power = requireObject(psu.power, code)
    result.power = {}
    for (const [field, output] of [
      ['input_voltage_mv', 'input_voltage_v'], ['output_voltage_mv', 'output_voltage_v'],
      ['input_current_ma', 'input_current_a'], ['output_current_ma', 'output_current_a'],
      ['input_power_mw', 'input_power_w'], ['output_power_mw', 'output_power_w']
    ]) {
      if (power[field] !== undefined) result.power[output] = requireFinite(power[field], code, true) / 1000
    }
  }
  if (psu.temperatures !== undefined) {
    result.temperatures = requireArray(psu.temperatures, code).map(temperature => {
      requireObject(temperature, code)
      const reading = {}
      if (temperature.temperature_type !== undefined) reading.type = optionalString(temperature.temperature_type, code)
      if (temperature.temperature_c !== undefined) reading.temperature_c = requireFinite(temperature.temperature_c, code)
      return reading
    })
  }
  return result
}

function hashrateHistory (history, duration) {
  const code = 'ERR_HASHRATE_RESPONSE_INVALID'
  requireObject(history, code)
  if (history.duration !== duration) invalid(code)
  const result = {
    duration: history.duration,
    // The history schema declares no unit. Keep firmware values unchanged;
    // interpreting them as TH/s or synthesizing real-time windows would guess.
    data: requireArray(history.data, code).map(point => {
      requireObject(point, code)
      return {
        datetime: requireCount(point.datetime, code),
        value: point.value === null ? null : requireFinite(point.value, code, true)
      }
    })
  }
  if (history.aggregates !== undefined) {
    const aggregates = requireObject(history.aggregates, code)
    result.aggregates = {}
    for (const field of ['min', 'avg', 'max']) {
      if (aggregates[field] === undefined) continue
      result.aggregates[field] = field !== 'min' && aggregates[field] === null
        ? null
        : requireFinite(aggregates[field], code, true)
    }
  }
  return result
}

class ProtoRigClient {
  constructor ({ id, api, cacheMs = 100 }) {
    if (!id) throw new Error('ERR_DEVICE_ID_REQUIRED')
    if (!api) throw new Error('ERR_API_CLIENT_REQUIRED')
    if (!Number.isFinite(cacheMs) || cacheMs < 0 || cacheMs > MAX_CACHE_MS) {
      throw new Error('ERR_CACHE_DURATION_INVALID')
    }
    this.id = id
    this.api = api
    this.cacheMs = cacheMs
    this.reads = new Map()
    this.lastRebootAttemptAt = null
    this.rebootPending = false
  }

  _read (key, load) {
    const now = Date.now()
    const current = this.reads.get(key)
    if (current && (current.pending || current.expires > now)) return current.promise
    const entry = { pending: true, expires: 0 }
    entry.promise = Promise.resolve().then(load).then(value => {
      entry.pending = false
      entry.expires = Date.now() + this.cacheMs
      return value
    }, err => {
      this.reads.delete(key)
      throw err
    })
    this.reads.set(key, entry)
    return entry.promise
  }

  _invalidate (keys) {
    if (!keys) return this.reads.clear()
    for (const key of keys) this.reads.delete(key)
  }

  async _write (keys, write) {
    this._invalidate(keys)
    try {
      return await write()
    } finally {
      this._invalidate(keys)
    }
  }

  _mining () {
    return this._read('mining', async () => {
      const mining = requireObject(await this.api.getMiningStatus(), 'ERR_MINING_RESPONSE_INVALID')
      requireString(mining.status, 'ERR_MINING_RESPONSE_INVALID')
      if (!Object.hasOwn(MINING_STATUS, mining.status)) invalid('ERR_MINING_RESPONSE_INVALID')
      return mining
    })
  }

  _telemetry () {
    return this._read('telemetry', async () => requireObject(
      await this.api.getTelemetry(['miner', 'hashboard']),
      'ERR_TELEMETRY_RESPONSE_INVALID'
    ))
  }

  _pools () {
    return this._read('pools', async () => {
      const pools = requireArray(await this.api.getPools(), 'ERR_POOLS_RESPONSE_INVALID')
      if (!pools.every(pool => pool !== null && typeof pool === 'object' && !Array.isArray(pool))) {
        invalid('ERR_POOLS_RESPONSE_INVALID')
      }
      return pools
    })
  }

  _errors () {
    return this._read('errors', async () => {
      const errors = requireArray(await this.api.getErrors(), 'ERR_ERRORS_RESPONSE_INVALID')
      if (!errors.every(error => error !== null && typeof error === 'object' && !Array.isArray(error))) {
        invalid('ERR_ERRORS_RESPONSE_INVALID')
      }
      return errors
    })
  }

  _target () {
    return this._read('target', async () => requireObject(
      await this.api.getMiningTarget(),
      'ERR_POWER_TARGET_RESPONSE_INVALID'
    ))
  }

  _cooling () {
    return this._read('cooling', async () => requireObject(
      await this.api.getCooling(),
      'ERR_COOLING_RESPONSE_INVALID'
    ))
  }

  _system () {
    return this._read('system', async () => requireObject(
      await this.api.getSystemInfo(),
      'ERR_SYSTEM_RESPONSE_INVALID'
    ))
  }

  _network () {
    return this._read('network', async () => requireObject(
      await this.api.getNetworkInformation(),
      'ERR_NETWORK_RESPONSE_INVALID'
    ))
  }

  _status (mining, errors) {
    return errors.length ? STATUS.ERROR : MINING_STATUS[mining.status]
  }

  _powerMode (mining) {
    return ['Stopped', 'Curtailed', 'PoweringOff'].includes(mining.status) ? POWER_MODE.SLEEP : POWER_MODE.NORMAL
  }

  _minerValue (telemetry, name, nonNegative = true) {
    const miner = requireObject(telemetry.miner, 'ERR_TELEMETRY_RESPONSE_INVALID')
    const metric = requireObject(miner[name], 'ERR_TELEMETRY_RESPONSE_INVALID')
    if (metric.unit !== MINER_METRIC_UNITS[name]) invalid('ERR_TELEMETRY_RESPONSE_INVALID')
    return requireFinite(metric.value, 'ERR_TELEMETRY_RESPONSE_INVALID', nonNegative)
  }

  _poolValue (pool, name) {
    return requireCount(pool[name], 'ERR_POOLS_RESPONSE_INVALID')
  }

  _poolStale (pool) {
    return pool.stale === undefined ? 0 : this._poolValue(pool, 'stale')
  }

  _poolStatus (pool) {
    const url = normalizePoolUrl(pool.url, 'ERR_POOLS_RESPONSE_INVALID')
    optionalString(pool.user, 'ERR_POOLS_RESPONSE_INVALID')
    optionalString(pool.status, 'ERR_POOLS_RESPONSE_INVALID')
    return {
      pool: url,
      accepted: this._poolValue(pool, 'accepted'),
      rejected: this._poolValue(pool, 'rejected'),
      stale: this._poolStale(pool),
      status: pool.status
    }
  }

  _coolingStatus (cooling) {
    return requireObject(cooling['cooling-status'], 'ERR_COOLING_RESPONSE_INVALID')
  }

  async getHashrateAvg () { return this._minerValue(await this._telemetry(), 'hashrate') }
  async getPower () { return this._minerValue(await this._telemetry(), 'power') }
  async getTemperature () { return this._minerValue(await this._telemetry(), 'temperature', false) }
  async getEfficiency () { return this._minerValue(await this._telemetry(), 'efficiency') }
  async getStatus () { return this._status(await this._mining(), await this._errors()) }
  async getUptime () {
    const seconds = requireFinite((await this._mining()).reboot_uptime_s, 'ERR_MINING_RESPONSE_INVALID', true)
    return requireFinite(seconds * 1000, 'ERR_MINING_RESPONSE_INVALID', true)
  }

  async getAcceptedShares () {
    return (await this._pools()).reduce((total, pool) => requireCount(
      total + this._poolValue(pool, 'accepted'),
      'ERR_POOLS_RESPONSE_INVALID'
    ), 0)
  }

  async getRejectedShares () {
    return (await this._pools()).reduce((total, pool) => requireCount(
      total + this._poolValue(pool, 'rejected'),
      'ERR_POOLS_RESPONSE_INVALID'
    ), 0)
  }

  async getPowerMode () { return this._powerMode(await this._mining()) }
  async getPowerTarget () { return requireFinite((await this._target()).power_target_watts, 'ERR_POWER_TARGET_RESPONSE_INVALID', true) }

  async getErrors () {
    return (await this._errors()).map(error => {
      const result = { name: 'firmware_error' }
      const code = optionalString(error.error_code, 'ERR_ERRORS_RESPONSE_INVALID')
      if (code !== undefined && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(code)) result.code = code
      for (const [key, value] of Object.entries(errorMetadata(error))) {
        if (value !== undefined) result[key] = value
      }
      return result
    })
  }

  downloadLogs (params) { return maintenance.downloadLogs(this, params) }
  setNetwork (network) { return maintenance.setNetwork(this, network) }
  updateFirmware (firmware) { return maintenance.updateFirmware(this, firmware) }

  async getPools () {
    return (await this._pools()).map(pool => {
      const basic = this._poolStatus(pool)
      const result = { url: basic.pool, accepted: basic.accepted, rejected: basic.rejected }
      if (pool.stale !== undefined) result.stale = basic.stale
      if (pool.user !== undefined) result.username = pool.user
      for (const key of ['status', 'name', 'protocol']) {
        if (pool[key] !== undefined) result[key] = optionalString(pool[key], 'ERR_POOLS_RESPONSE_INVALID')
      }
      for (const key of ['id', 'priority', 'invalid', 'duplicate']) {
        if (pool[key] !== undefined) result[key] = requireCount(pool[key], 'ERR_POOLS_RESPONSE_INVALID')
      }
      return result
    })
  }

  async getPoolUrl () {
    const pools = await this._pools()
    const pool = pools.find(pool => pool.status === 'Active') || pools[0]
    return pool ? normalizePoolUrl(pool.url, 'ERR_POOLS_RESPONSE_INVALID') : ''
  }

  async getPsuInfo () {
    const payload = await this._read('psus', async () => requireObject(
      await this.api.getPowerSupplies(),
      'ERR_PSUS_RESPONSE_INVALID'
    ))
    return { psus: requireArray(payload['psus-info'], 'ERR_PSUS_RESPONSE_INVALID').map(psuInfo) }
  }

  async getHashrateHistory (params = {}) {
    requireObject(params, 'ERR_HASHRATE_DURATION_INVALID')
    if (Object.keys(params).some(key => key !== 'duration')) invalid('ERR_HASHRATE_DURATION_INVALID')
    const duration = params.duration === undefined ? '1h' : params.duration
    if (!HASHRATE_DURATIONS.has(duration)) invalid('ERR_HASHRATE_DURATION_INVALID')
    const payload = await this._read(`hashrate-history:${duration}`, async () => requireObject(
      await this.api.getHashrateHistory(duration),
      'ERR_HASHRATE_RESPONSE_INVALID'
    ))
    return hashrateHistory(payload['hashrate-data'], duration)
  }

  async getHashboards () {
    const telemetry = await this._telemetry()
    return requireArray(telemetry.hashboards, 'ERR_TELEMETRY_RESPONSE_INVALID').map(board => {
      const temperature = boardTemperature(board)
      const result = {
        index: temperature.index,
        temperature_c: { inlet: temperature.inlet, outlet: temperature.outlet, avg: temperature.average }
      }
      if (board.serial_number !== undefined) result.serial_number = optionalString(board.serial_number, 'ERR_TELEMETRY_RESPONSE_INVALID')
      for (const [field, output, unit] of [
        ['hashrate', 'hashrate_ths', 'TH/s'], ['power', 'power_w', 'W'], ['efficiency', 'efficiency_w_ths', 'J/TH'],
        ['voltage', 'voltage_v', 'V'], ['current', 'current_a', 'A']
      ]) {
        if (board[field] === undefined) continue
        const metric = requireObject(board[field], 'ERR_TELEMETRY_RESPONSE_INVALID')
        if (metric.unit !== unit) invalid('ERR_TELEMETRY_RESPONSE_INVALID')
        result[output] = requireFinite(metric.value, 'ERR_TELEMETRY_RESPONSE_INVALID', true)
      }
      return result
    })
  }

  async getDeviceInfo () {
    const [system, network] = await Promise.all([this._system(), this._network()])
    const info = systemIdentity(system)
    const result = { device_id: this.id }
    for (const [field, output] of [
      ['product_name', 'product_name'], ['manufacturer', 'manufacturer'], ['model', 'model'], ['cb_sn', 'serial_number']
    ]) {
      if (info[field] !== undefined) result[output] = optionalString(info[field], 'ERR_SYSTEM_RESPONSE_INVALID')
    }
    result.network = deviceNetworkInfo(network)
    return result
  }

  async getFirmwareInfo () {
    const system = await this._system()
    const info = requireObject(system['system-info'], 'ERR_SYSTEM_RESPONSE_INVALID')
    const result = {}
    for (const key of ['os', 'mining_driver_sw', 'pool_interface_sw', 'web_server', 'web_dashboard', 'hashboard_firmware']) {
      if (info[key] === undefined) continue
      const component = requireObject(info[key], 'ERR_SYSTEM_RESPONSE_INVALID')
      const fields = key === 'os' ? ['name', 'version', 'git_hash', 'variant', 'build_datetime_utc', 'machine'] : ['name', 'version']
      result[key] = {}
      for (const field of fields) {
        if (component[field] !== undefined) result[key][field] = optionalString(component[field], 'ERR_SYSTEM_RESPONSE_INVALID')
      }
    }
    return result
  }

  async reboot () {
    if (this.rebootPending) throw new Error('ERR_COMMAND_IN_PROGRESS')
    const now = Date.now()
    if (this.lastRebootAttemptAt !== null && now - this.lastRebootAttemptAt < REBOOT_COOLDOWN_MS) {
      throw new Error('ERR_COMMAND_COOLDOWN')
    }

    // A timeout may mean the rig accepted the reboot. Consume the cooldown
    // before I/O, and retain it on failure as well as success.
    this.lastRebootAttemptAt = now
    this.rebootPending = true
    try {
      const data = await this._write(null, () => this.api.reboot())
      return { ...(data || {}), success: true }
    } finally {
      this.rebootPending = false
    }
  }

  async setLED (enabled) {
    if (typeof enabled !== 'boolean') throw new Error('ERR_SET_LED_ENABLED_INVALID')
    const data = await this.api.setLED(enabled)
    return { ...(data || {}), success: true }
  }

  async setPowerMode (mode) {
    let write
    if (mode === POWER_MODE.NORMAL) write = () => this.api.startMining()
    else if (mode === POWER_MODE.SLEEP) write = () => this.api.stopMining()
    else throw new Error('ERR_SET_POWER_MODE_INVALID')

    const data = await this._write(['mining', 'telemetry', 'errors'], write)
    return { ...(data || {}), success: true }
  }

  async setPowerTarget (watts) {
    if (!Number.isFinite(watts)) throw new Error('ERR_POWER_TARGET_INVALID')
    const normalized = Math.round(watts)
    if (!Number.isSafeInteger(normalized) || normalized <= 0) throw new Error('ERR_POWER_TARGET_INVALID')

    const target = await this.api.getMiningTarget()
    const min = target && target.power_target_min_watts
    const max = target && target.power_target_max_watts
    if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) ||
      min <= 0 || max < min || max > MAX_POWER_TARGET_WATTS) {
      throw new Error('ERR_POWER_TARGET_RESPONSE_INVALID')
    }
    if (normalized < min || normalized > max) {
      throw new Error(`ERR_POWER_TARGET_OUT_OF_RANGE: ${min}-${max}`)
    }

    const updated = await this._write(
      ['target', 'mining', 'telemetry'],
      () => this.api.setPowerTarget(normalized)
    )
    return { success: true, target: updated }
  }

  async setupPools (pools, appendId = true) {
    if (!Array.isArray(pools) || pools.length < 1 || pools.length > 3) throw new Error('ERR_POOLS_INVALID')
    if (typeof appendId !== 'boolean') throw new Error('ERR_APPEND_ID_INVALID')

    const body = pools.map((pool, priority) => {
      if (pool === null || typeof pool !== 'object' || Array.isArray(pool)) throw new Error('ERR_POOL_ENTRY_INVALID')
      const url = normalizePoolUrl(pool.url, 'ERR_POOL_ENTRY_INVALID')
      const workerName = requireString(pool.worker_name, 'ERR_POOL_ENTRY_INVALID').trim()
      optionalString(pool.worker_password, 'ERR_POOL_ENTRY_INVALID')
      optionalString(pool.pool, 'ERR_POOL_ENTRY_INVALID')
      return {
        url,
        username: appendId ? `${workerName}.${this.id}` : workerName,
        password: pool.worker_password || '',
        name: pool.pool || '',
        priority
      }
    })
    await this._write(['pools', 'mining', 'errors'], () => this.api.setPools(body))
    return { success: true }
  }

  async getFanSpeed () {
    const status = this._coolingStatus(await this._cooling())
    const fans = requireArray(status.fans, 'ERR_COOLING_RESPONSE_INVALID')
    const total = fans.reduce((sum, fan) => {
      requireObject(fan, 'ERR_COOLING_RESPONSE_INVALID')
      return requireFinite(
        sum + requireFinite(fan.rpm, 'ERR_COOLING_RESPONSE_INVALID', true),
        'ERR_COOLING_RESPONSE_INVALID',
        true
      )
    }, 0)
    return fans.length ? Math.round(total / fans.length) : 0
  }

  async getFans () {
    const status = this._coolingStatus(await this._cooling())
    return requireArray(status.fans, 'ERR_COOLING_RESPONSE_INVALID').map(fan => {
      requireObject(fan, 'ERR_COOLING_RESPONSE_INVALID')
      const result = { rpm: requireFinite(fan.rpm, 'ERR_COOLING_RESPONSE_INVALID', true) }
      if (fan.slot !== undefined) result.slot = requireCount(fan.slot, 'ERR_COOLING_RESPONSE_INVALID')
      if (fan.percentage !== undefined) {
        if (!Number.isInteger(fan.percentage) || fan.percentage < 0 || fan.percentage > 100) {
          invalid('ERR_COOLING_RESPONSE_INVALID')
        }
        result.percentage = fan.percentage
      }
      return result
    })
  }

  async getSnap () {
    const [mining, telemetry, pools, errors, target, system, cooling, network] = await Promise.all([
      this._mining(), this._telemetry(), this._pools(), this._errors(),
      this._target(), this._system(), this._cooling(), this._network()
    ])

    const temperature = this._minerValue(telemetry, 'temperature', false)
    const power = this._minerValue(telemetry, 'power')
    const efficiency = this._minerValue(telemetry, 'efficiency')
    const hashrate = this._minerValue(telemetry, 'hashrate')
    const hashrateMhs = requireFinite(hashrate * 1000000, 'ERR_TELEMETRY_RESPONSE_INVALID', true)

    const boards = requireArray(telemetry.hashboards, 'ERR_TELEMETRY_RESPONSE_INVALID')
    const boardTemperatures = boards.map(boardTemperature)
    const boardInlets = boardTemperatures.map(board => board.inlet)
    const boardOutlets = boardTemperatures.map(board => board.outlet)

    const coolingStatus = this._coolingStatus(cooling)
    // Project each fan to the one field the snapshot declares. Republishing the
    // device object would carry every undeclared sibling key with it.
    const fans = requireArray(coolingStatus.fans, 'ERR_COOLING_RESPONSE_INVALID').map(fan => {
      requireObject(fan, 'ERR_COOLING_RESPONSE_INVALID')
      return { rpm: requireFinite(fan.rpm, 'ERR_COOLING_RESPONSE_INVALID', true) }
    })
    if (coolingStatus.fan_mode !== undefined && !COOLING_MODES.has(coolingStatus.fan_mode)) {
      invalid('ERR_COOLING_RESPONSE_INVALID')
    }
    if (coolingStatus.speed_percentage !== undefined &&
      (!Number.isInteger(coolingStatus.speed_percentage) ||
        coolingStatus.speed_percentage < 0 || coolingStatus.speed_percentage > 100)) {
      invalid('ERR_COOLING_RESPONSE_INVALID')
    }

    const systemInfo = systemIdentity(system)
    let firmwareVersion
    if (systemInfo.os !== undefined) {
      const os = requireObject(systemInfo.os, 'ERR_SYSTEM_RESPONSE_INVALID')
      firmwareVersion = optionalString(os.version, 'ERR_SYSTEM_RESPONSE_INVALID')
    }

    const networkConfiguration = networkConfig(network)

    const powerTarget = requireFinite(target.power_target_watts, 'ERR_POWER_TARGET_RESPONSE_INVALID', true)
    optionalString(target.performance_mode, 'ERR_POWER_TARGET_RESPONSE_INVALID')

    const poolStatus = pools.map(pool => this._poolStatus(pool))
    const shares = poolStatus.reduce((totals, pool) => ({
      accepted: requireCount(totals.accepted + pool.accepted, 'ERR_POOLS_RESPONSE_INVALID'),
      rejected: requireCount(totals.rejected + pool.rejected, 'ERR_POOLS_RESPONSE_INVALID'),
      stale: requireCount(totals.stale + pool.stale, 'ERR_POOLS_RESPONSE_INVALID')
    }), { accepted: 0, rejected: 0, stale: 0 })

    // Only reboot_uptime_s is accepted. R2 firmware also exposes
    // system-info.uptime_seconds, but that is the OS clock: it runs a few
    // seconds ahead at steady state and keeps climbing across a miner restart
    // that does not reboot the host. Falling back to it would report days of
    // uptime for a process that just came up -- precisely when an operator is
    // watching for the restart -- and would make the snapshot disagree with
    // getUptime() on the same device.
    const uptimeMs = requireFinite(
      requireFinite(mining.reboot_uptime_s, 'ERR_MINING_RESPONSE_INVALID', true) * 1000,
      'ERR_MINING_RESPONSE_INVALID',
      true
    )
    const powerMode = this._powerMode(mining)

    return {
      stats: {
        status: this._status(mining, errors),
        errors: errors.length
          ? errors.map(errorMetadata)
          : undefined,
        uptime_ms: uptimeMs,
        power_w: power,
        efficiency_w_ths: efficiency,
        all_pools_shares: shares,
        pool_status: poolStatus,
        // The public API exposes one instantaneous reading and no windowed
        // history. Copying it into t_5s/t_5m/t_30m would report fabricated
        // stability, so those windows stay undefined rather than synthesized.
        hashrate_mhs: { avg: hashrateMhs },
        temperature_c: {
          ambient: boardInlets.length ? Math.min(...boardInlets) : temperature,
          max: boardOutlets.length ? Math.max(...boardOutlets) : temperature,
          avg: temperature,
          temp: boardTemperatures.map(board => ({ index: board.index, pcbInlet: board.inlet, pcbOutlet: board.outlet })),
          chips: boardTemperatures.map(board => ({ index: board.index, max: board.outlet, avg: board.average }))
        },
        cooling: {
          mode: coolingStatus.fan_mode,
          speed_percentage: coolingStatus.speed_percentage,
          fans
        }
      },
      config: {
        network_config: networkConfiguration,
        pool_config: pools.map(pool => ({
          url: normalizePoolUrl(pool.url, 'ERR_POOLS_RESPONSE_INVALID'),
          username: pool.user
        })),
        power_mode: powerMode,
        power_target_watts: powerTarget,
        performance_mode: target.performance_mode,
        suspended: powerMode === POWER_MODE.SLEEP,
        firmware_ver: firmwareVersion,
        product_name: systemInfo.product_name,
        model: systemInfo.model,
        serial_number: systemInfo.cb_sn
      }
    }
  }
}

module.exports = { ProtoRigClient, MINING_STATUS }
