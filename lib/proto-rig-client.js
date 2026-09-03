'use strict'

const { STATUS, POWER_MODE, MAX_CACHE_MS } = require('./constants')

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

function requireString (value, code) {
  if (typeof value !== 'string' || !value.trim()) invalid(code)
  return value
}

function optionalString (value, code) {
  if (value !== undefined && typeof value !== 'string') invalid(code)
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
    return errors.length ? STATUS.ERROR : (MINING_STATUS[mining.status] || STATUS.NOT_MINING)
  }

  _powerMode (mining) {
    return ['Stopped', 'Curtailed', 'PoweringOff'].includes(mining.status) ? POWER_MODE.SLEEP : POWER_MODE.NORMAL
  }

  _minerValue (telemetry, name, nonNegative = true) {
    const miner = requireObject(telemetry.miner, 'ERR_TELEMETRY_RESPONSE_INVALID')
    const metric = requireObject(miner[name], 'ERR_TELEMETRY_RESPONSE_INVALID')
    return requireFinite(metric.value, 'ERR_TELEMETRY_RESPONSE_INVALID', nonNegative)
  }

  _poolValue (pool, name) {
    return requireFinite(pool[name], 'ERR_POOLS_RESPONSE_INVALID', true)
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
    return (await this._pools()).reduce((total, pool) => requireFinite(
      total + this._poolValue(pool, 'accepted'),
      'ERR_POOLS_RESPONSE_INVALID',
      true
    ), 0)
  }

  async getRejectedShares () {
    return (await this._pools()).reduce((total, pool) => requireFinite(
      total + this._poolValue(pool, 'rejected'),
      'ERR_POOLS_RESPONSE_INVALID',
      true
    ), 0)
  }

  async getPowerMode () { return this._powerMode(await this._mining()) }
  async getPowerTarget () { return requireFinite((await this._target()).power_target_watts, 'ERR_POWER_TARGET_RESPONSE_INVALID', true) }

  async reboot () {
    const data = await this._write(null, () => this.api.reboot())
    return { success: true, ...(data || {}) }
  }

  async setLED (enabled) {
    if (typeof enabled !== 'boolean') throw new Error('ERR_SET_LED_ENABLED_INVALID')
    const data = await this.api.setLED(enabled)
    return { success: true, ...(data || {}) }
  }

  async setPowerMode (mode) {
    let write
    if (mode === POWER_MODE.NORMAL) write = () => this.api.startMining()
    else if (mode === POWER_MODE.SLEEP) write = () => this.api.stopMining()
    else throw new Error('ERR_SET_POWER_MODE_INVALID')

    const data = await this._write(['mining', 'telemetry', 'errors'], write)
    return { success: true, ...(data || {}) }
  }

  async setPowerTarget (watts) {
    if (!Number.isFinite(watts)) throw new Error('ERR_POWER_TARGET_INVALID')
    const normalized = Math.round(watts)
    if (!Number.isSafeInteger(normalized) || normalized <= 0) throw new Error('ERR_POWER_TARGET_INVALID')

    const target = await this.api.getMiningTarget()
    const min = target && target.power_target_min_watts
    const max = target && target.power_target_max_watts
    if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min <= 0 || max < min) {
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
    const boardTemperatures = boards.map(board => {
      requireObject(board, 'ERR_TELEMETRY_RESPONSE_INVALID')
      const value = requireObject(board.temperature, 'ERR_TELEMETRY_RESPONSE_INVALID')
      return {
        index: board.index,
        inlet: requireFinite(value.inlet, 'ERR_TELEMETRY_RESPONSE_INVALID'),
        outlet: requireFinite(value.outlet, 'ERR_TELEMETRY_RESPONSE_INVALID'),
        average: requireFinite(value.average, 'ERR_TELEMETRY_RESPONSE_INVALID')
      }
    })
    const boardInlets = boardTemperatures.map(board => board.inlet)
    const boardOutlets = boardTemperatures.map(board => board.outlet)

    const coolingStatus = this._coolingStatus(cooling)
    const fans = requireArray(coolingStatus.fans, 'ERR_COOLING_RESPONSE_INVALID')
    for (const fan of fans) {
      requireObject(fan, 'ERR_COOLING_RESPONSE_INVALID')
      requireFinite(fan.rpm, 'ERR_COOLING_RESPONSE_INVALID', true)
    }
    optionalString(coolingStatus.fan_mode, 'ERR_COOLING_RESPONSE_INVALID')
    if (coolingStatus.speed_percentage !== undefined) {
      requireFinite(coolingStatus.speed_percentage, 'ERR_COOLING_RESPONSE_INVALID', true)
    }

    const systemInfo = requireObject(system['system-info'], 'ERR_SYSTEM_RESPONSE_INVALID')
    optionalString(systemInfo.product_name, 'ERR_SYSTEM_RESPONSE_INVALID')
    optionalString(systemInfo.model, 'ERR_SYSTEM_RESPONSE_INVALID')
    optionalString(systemInfo.cb_sn, 'ERR_SYSTEM_RESPONSE_INVALID')
    let firmwareVersion
    if (systemInfo.os !== undefined) {
      const os = requireObject(systemInfo.os, 'ERR_SYSTEM_RESPONSE_INVALID')
      firmwareVersion = optionalString(os.version, 'ERR_SYSTEM_RESPONSE_INVALID')
    }

    const networkInfo = requireObject(network['network-info'], 'ERR_NETWORK_RESPONSE_INVALID')
    if (typeof networkInfo.dhcp !== 'boolean') invalid('ERR_NETWORK_RESPONSE_INVALID')
    requireString(networkInfo.ip, 'ERR_NETWORK_RESPONSE_INVALID')
    requireString(networkInfo.gateway, 'ERR_NETWORK_RESPONSE_INVALID')
    requireString(networkInfo.netmask, 'ERR_NETWORK_RESPONSE_INVALID')

    const powerTarget = requireFinite(target.power_target_watts, 'ERR_POWER_TARGET_RESPONSE_INVALID', true)
    optionalString(target.performance_mode, 'ERR_POWER_TARGET_RESPONSE_INVALID')

    const poolStatus = pools.map(pool => {
      const url = normalizePoolUrl(pool.url, 'ERR_POOLS_RESPONSE_INVALID')
      optionalString(pool.user, 'ERR_POOLS_RESPONSE_INVALID')
      optionalString(pool.status, 'ERR_POOLS_RESPONSE_INVALID')
      return {
        pool: url,
        accepted: this._poolValue(pool, 'accepted'),
        rejected: this._poolValue(pool, 'rejected'),
        stale: this._poolValue(pool, 'stale'),
        status: pool.status
      }
    })
    const shares = poolStatus.reduce((totals, pool) => ({
      accepted: requireFinite(totals.accepted + pool.accepted, 'ERR_POOLS_RESPONSE_INVALID', true),
      rejected: requireFinite(totals.rejected + pool.rejected, 'ERR_POOLS_RESPONSE_INVALID', true),
      stale: requireFinite(totals.stale + pool.stale, 'ERR_POOLS_RESPONSE_INVALID', true)
    }), { accepted: 0, rejected: 0, stale: 0 })

    const uptimeSeconds = mining.reboot_uptime_s === undefined ? systemInfo.uptime_seconds : mining.reboot_uptime_s
    const uptimeMs = requireFinite(
      requireFinite(uptimeSeconds, 'ERR_MINING_RESPONSE_INVALID', true) * 1000,
      'ERR_MINING_RESPONSE_INVALID',
      true
    )
    const powerMode = this._powerMode(mining)

    return {
      stats: {
        status: this._status(mining, errors),
        errors: errors.length
          ? errors.map(error => ({
            name: error.error_code || 'unknown',
            code: error.error_code,
            message: error.message,
            source: error.source,
            slot: error.slot,
            timestamp: error.timestamp
          }))
          : undefined,
        uptime_ms: uptimeMs,
        power_w: power,
        efficiency_w_ths: efficiency,
        all_pools_shares: shares,
        pool_status: poolStatus,
        hashrate_mhs: { avg: hashrateMhs, t_5s: hashrateMhs, t_5m: hashrateMhs, t_30m: hashrateMhs },
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
        network_config: {
          mode: networkInfo.dhcp ? 'dhcp' : 'static',
          ip_address: networkInfo.ip,
          ip_gw: networkInfo.gateway,
          ip_netmask: networkInfo.netmask
        },
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
