'use strict'

const { STATUS, POWER_MODE } = require('./constants')

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

class ProtoRigClient {
  constructor ({ id, api, cacheMs = 100 }) {
    if (!id) throw new Error('ERR_DEVICE_ID_REQUIRED')
    if (!api) throw new Error('ERR_API_CLIENT_REQUIRED')
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

  _mining () { return this._read('mining', () => this.api.getMiningStatus()) }
  _telemetry () { return this._read('telemetry', () => this.api.getTelemetry(['miner', 'hashboard'])) }
  _pools () { return this._read('pools', () => this.api.getPools()) }
  _errors () { return this._read('errors', () => this.api.getErrors()) }
  _target () { return this._read('target', () => this.api.getMiningTarget()) }
  _cooling () { return this._read('cooling', () => this.api.getCooling()) }
  _system () { return this._read('system', () => this.api.getSystemInfo()) }
  _network () { return this._read('network', () => this.api.getNetworkInformation()) }

  _status (mining, errors) {
    return errors.length ? STATUS.ERROR : (MINING_STATUS[mining.status] || STATUS.NOT_MINING)
  }

  _powerMode (mining) {
    return ['Stopped', 'Curtailed', 'PoweringOff'].includes(mining.status) ? POWER_MODE.SLEEP : POWER_MODE.NORMAL
  }

  async getHashrateAvg () { return Number((await this._telemetry())?.miner?.hashrate?.value) || 0 }
  async getPower () { return Number((await this._telemetry())?.miner?.power?.value) || 0 }
  async getTemperature () { return Number((await this._telemetry())?.miner?.temperature?.value) || 0 }
  async getEfficiency () { return Number((await this._telemetry())?.miner?.efficiency?.value) || 0 }
  async getStatus () { return this._status(await this._mining(), await this._errors()) }
  async getUptime () { return (Number((await this._mining()).reboot_uptime_s) || 0) * 1000 }
  async getAcceptedShares () { return (await this._pools()).reduce((n, pool) => n + (Number(pool.accepted) || 0), 0) }
  async getRejectedShares () { return (await this._pools()).reduce((n, pool) => n + (Number(pool.rejected) || 0), 0) }
  async getPowerMode () { return this._powerMode(await this._mining()) }
  async getPowerTarget () { return Number((await this._target()).power_target_watts) || 0 }

  async reboot () {
    const data = await this.api.reboot()
    return { success: true, ...(data || {}) }
  }

  async setLED (enabled) {
    if (typeof enabled !== 'boolean') throw new Error('ERR_SET_LED_ENABLED_INVALID')
    const data = await this.api.setLED(enabled)
    return { success: true, ...(data || {}) }
  }

  async setPowerMode (mode) {
    if (mode === POWER_MODE.NORMAL) {
      const data = await this.api.startMining()
      return { success: true, ...(data || {}) }
    }
    if (mode === POWER_MODE.SLEEP) {
      const data = await this.api.stopMining()
      return { success: true, ...(data || {}) }
    }
    throw new Error('ERR_SET_POWER_MODE_INVALID')
  }

  async setPowerTarget (watts) {
    if (!Number.isFinite(watts) || watts <= 0) throw new Error('ERR_POWER_TARGET_INVALID')
    const target = await this.api.getMiningTarget()
    const min = Number(target.power_target_min_watts)
    const max = Number(target.power_target_max_watts)
    if ((Number.isFinite(min) && watts < min) || (Number.isFinite(max) && watts > max)) {
      throw new Error(`ERR_POWER_TARGET_OUT_OF_RANGE: ${min}-${max}`)
    }
    const updated = await this.api.setPowerTarget(Math.round(watts))
    this.reads.delete('target')
    return { success: true, target: updated }
  }

  async setupPools (pools, appendId = true) {
    if (!Array.isArray(pools) || pools.length < 1 || pools.length > 3) throw new Error('ERR_POOLS_INVALID')
    const body = pools.map((pool, priority) => {
      if (!pool || typeof pool.url !== 'string' || typeof pool.worker_name !== 'string') throw new Error('ERR_POOL_ENTRY_INVALID')
      return {
        url: pool.url,
        username: appendId ? `${pool.worker_name}.${this.id}` : pool.worker_name,
        password: pool.worker_password || '',
        name: pool.pool || '',
        priority
      }
    })
    await this.api.setPools(body)
    this.reads.delete('pools')
    return { success: true }
  }

  async getFanSpeed () {
    const data = await this._cooling()
    const fans = data?.['cooling-status']?.fans || data?.fans || []
    return fans.length ? Math.round(fans.reduce((n, fan) => n + (Number(fan.rpm) || 0), 0) / fans.length) : 0
  }

  async getSnap () {
    const [mining, telemetry, pools, errors, target, system, cooling, network] = await Promise.all([
      this._mining(), this._telemetry(), this._pools(), this._errors(),
      this._target(), this._system(), this._cooling(), this._network()
    ])
    const miner = telemetry?.miner || {}
    const boards = Array.isArray(telemetry?.hashboards) ? telemetry.hashboards : []
    const boardInlets = boards.map(board => Number(board.temperature?.inlet)).filter(Number.isFinite)
    const boardOutlets = boards.map(board => Number(board.temperature?.outlet)).filter(Number.isFinite)
    const temperature = Number(miner.temperature?.value) || 0
    const hashrateMhs = (Number(miner.hashrate?.value) || 0) * 1000000
    const coolingStatus = cooling?.['cooling-status'] || cooling || {}
    const systemInfo = system?.['system-info'] || system || {}
    const networkInfo = network?.['network-info'] || network || {}
    const powerMode = this._powerMode(mining)
    const shares = pools.reduce((totals, pool) => ({
      accepted: totals.accepted + (Number(pool.accepted) || 0),
      rejected: totals.rejected + (Number(pool.rejected) || 0),
      stale: totals.stale + (Number(pool.stale) || 0)
    }), { accepted: 0, rejected: 0, stale: 0 })

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
        uptime_ms: (Number(mining.reboot_uptime_s ?? systemInfo.uptime_seconds) || 0) * 1000,
        power_w: Number(miner.power?.value ?? mining.power_usage_watts) || 0,
        efficiency_w_ths: Number(miner.efficiency?.value ?? mining.power_efficiency_jth) || 0,
        all_pools_shares: shares,
        pool_status: pools.map(pool => ({
          pool: pool.url,
          accepted: Number(pool.accepted) || 0,
          rejected: Number(pool.rejected) || 0,
          stale: Number(pool.stale) || 0,
          status: pool.status
        })),
        hashrate_mhs: { avg: hashrateMhs, t_5s: hashrateMhs, t_5m: hashrateMhs, t_30m: hashrateMhs },
        temperature_c: {
          ambient: boardInlets.length ? Math.min(...boardInlets) : temperature,
          max: boardOutlets.length ? Math.max(...boardOutlets) : temperature,
          avg: temperature,
          temp: boards.map(board => ({ index: board.index, pcbInlet: board.temperature?.inlet, pcbOutlet: board.temperature?.outlet })),
          chips: boards.map(board => ({ index: board.index, max: board.temperature?.outlet, avg: board.temperature?.average }))
        },
        cooling: {
          mode: coolingStatus.fan_mode,
          speed_percentage: coolingStatus.speed_percentage,
          fans: coolingStatus.fans || []
        }
      },
      config: {
        network_config: {
          mode: networkInfo.dhcp ? 'dhcp' : 'static',
          ip_address: networkInfo.ip,
          ip_gw: networkInfo.gateway,
          ip_netmask: networkInfo.netmask
        },
        pool_config: pools.map(pool => ({ url: pool.url, username: pool.user })),
        power_mode: powerMode,
        power_target_watts: target?.power_target_watts,
        performance_mode: target?.performance_mode,
        suspended: powerMode === POWER_MODE.SLEEP,
        firmware_ver: systemInfo.os?.version,
        product_name: systemInfo.product_name,
        model: systemInfo.model,
        serial_number: systemInfo.cb_sn
      }
    }
  }
}

module.exports = { ProtoRigClient, MINING_STATUS }
