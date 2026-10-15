'use strict'

const http = require('node:http')
const { createHash } = require('node:crypto')

const MAX_BODY_BYTES = 512 * 1024 * 1024 + 1024 * 1024
const LOG_SOURCES = new Set(['os', 'pool_sw', 'miner_sw', 'miner_web_server'])

function createState (opts = {}) {
  const tokenSeq = opts.tokenSeq || 0
  const refreshSeq = opts.refreshSeq || 0
  return {
    password: opts.password || 'test-password',
    tokenSeq,
    refreshSeq,
    expireFirstToken: opts.expireFirstToken === true,
    currentAccessToken: `mock-access-${tokenSeq + 1}`,
    currentRefreshToken: `mock-refresh-${refreshSeq + 1}`,
    revokedAccessTokens: new Set(),
    requests: [],
    loginCount: 0,
    refreshCount: 0,
    writeAttempts: {},
    led: false,
    rebooted: false,
    updates: [],
    mining: {
      status: 'Mining',
      reboot_uptime_s: 521,
      power_usage_watts: 3250,
      power_efficiency_jth: 34.03
    },
    target: {
      power_target_watts: 3300,
      power_target_min_watts: 400,
      power_target_max_watts: 6000,
      performance_mode: 'MaximumHashrate'
    },
    telemetry: {
      miner: {
        hashrate: { value: 95.5, unit: 'TH/s' },
        temperature: { value: 65.5, unit: '°C' },
        power: { value: 3250, unit: 'W' },
        efficiency: { value: 34.03, unit: 'J/TH' }
      },
      hashboards: [
        {
          index: 0,
          serial_number: 'HB001',
          hashrate: { value: 47.75, unit: 'TH/s' },
          temperature: { unit: '°C', inlet: 45, outlet: 68, average: 56 },
          power: { value: 1625, unit: 'W' },
          efficiency: { value: 34.03, unit: 'J/TH' },
          voltage: { value: 12.1, unit: 'V' },
          current: { value: 134.3, unit: 'A' }
        },
        {
          index: 1,
          serial_number: 'HB002',
          hashrate: { value: 47.75, unit: 'TH/s' },
          temperature: { unit: '°C', inlet: 46, outlet: 70, average: 58 },
          power: { value: 1625, unit: 'W' },
          efficiency: { value: 34.03, unit: 'J/TH' }
        }
      ]
    },
    pools: [
      { url: 'stratum+tcp://pool:3333', user: 'worker', password: 'secret', accepted: 10, rejected: 1, status: 'Active' }
    ],
    errors: [],
    cooling: {
      fan_mode: 'Auto',
      speed_percentage: 55,
      fans: [{ slot: 1, rpm: 5000, percentage: 55 }, { slot: 2, rpm: 5100, percentage: 55 }]
    },
    // Synthetic diagnostics fixtures use only the published source fields.
    psus: [{
      psu_sn: 'MOCK-PSU-001',
      slot: 1,
      manufacturer: 'Simulator',
      hw_revision: 'mock-1',
      model: 'Mock PSU',
      vendor: 'Simulator',
      firmware: { app_version: 'mock-1', bootloader_version: 'mock-1' },
      power: {
        input_voltage_mv: 240000,
        output_voltage_mv: 12100,
        input_current_ma: 14000,
        output_current_ma: 260000,
        input_power_mw: 3250000,
        output_power_mw: 3146000
      },
      temperatures: [{ temperature_type: 'hotspot', temperature_c: 48 }]
    }],
    hashboardInfo: [
      { hb_sn: 'HB001', slot: 1, board: 'B4_192', mining_asic: 'MC3', mining_asic_count: 2 },
      { hb_sn: 'HB002', slot: 2, board: 'B4_192', mining_asic: 'MC3', mining_asic_count: 1 }
    ],
    hashboardStats: {
      HB001: { hb_sn: 'HB001', slot: 1, status: 'Running', asics: [mockAsic(0), mockAsic(1)] },
      HB002: { hb_sn: 'HB002', slot: 2, status: 'Running', asics: [mockAsic(0)] }
    },
    logs: {
      os: ['Mock kernel started'],
      pool_sw: ['Mock pool connected'],
      miner_sw: ['Mock mining started'],
      miner_web_server: ['Mock API ready']
    },
    network: {
      mac: '02:00:00:00:00:01',
      hostname: 'proto-r2-mock',
      dhcp: true,
      ip: '192.0.2.10',
      netmask: '255.255.255.0',
      gateway: '192.0.2.1'
    },
    // Mirrors the key set observed on R2 firmware, including undeclared runtime
    // and update fields so snapshot and detail tests exercise safe projection
    // rather than a conveniently minimal payload.
    // uptime_seconds tracks slightly ahead of mining.reboot_uptime_s because the
    // OS boots before the miner process starts.
    system: {
      model: 'R2',
      cb_sn: 'R2-001',
      product_name: 'Proto R2 Rig',
      manufacturer: 'Proto',
      uptime_seconds: 526,
      os: { version: '1.8.2' },
      mining_driver_sw: { name: 'mining-driver', version: '1.8.2' },
      pool_interface_sw: { name: 'pool-interface', version: '1.8.2' },
      web_server: { name: 'web-server', version: '1.8.2' },
      web_dashboard: { name: 'web-dashboard', version: '1.8.2' },
      hashboard_firmware: { version: '1.8.2' },
      board: { revision: 'rev-c' },
      soc: { model: 'soc-model' },
      sw_update_status: { status: 'Idle' }
    }
  }
}

function mockAsic (index) {
  return {
    index,
    id: `A${index}`,
    row: 0,
    column: index,
    freq_mhz: 650,
    temp_c: 45.5 + index,
    voltage_mv: 308.5,
    hashrate_ghs: 300.5,
    ideal_hashrate_ghs: 320,
    error_rate: 0.1
  }
}

function createServer (opts = {}) {
  const state = createState(opts)
  const malformedPaths = new Set(opts.malformedPaths || [])
  const disconnectPaths = new Set(opts.disconnectPaths || [])
  const statusByPath = opts.statusByPath || {}
  const server = http.createServer((req, res) => {
    handle(req, res, state, {
      delayMs: opts.delayMs || 0,
      malformedPaths,
      disconnectPaths,
      statusByPath
    }).catch(err => sendError(res, err))
  })

  const ready = new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(opts.port || 0, opts.host || '127.0.0.1', () => resolve(server.address()))
  })

  return {
    state,
    ready,
    close: () => new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()))
  }
}

async function handle (req, res, state, controls) {
  const url = new URL(req.url, 'http://127.0.0.1')
  const pathname = url.pathname
  const updateWrite = pathname === '/api/v1/system/update' && ['POST', 'PUT'].includes(req.method)
  if (updateWrite) state.writeAttempts[pathname] = (state.writeAttempts[pathname] || 0) + 1
  const body = await readBody(req)
  state.requests.push({
    method: req.method,
    path: pathname,
    url: req.url,
    authorization: updateWrite ? null : req.headers.authorization || null,
    body: updateWrite ? body && Buffer.isBuffer(body.file?.bytes) ? { file: uploadMetadata(body.file) } : null : body
  })

  if (controls.delayMs > 0) await delay(controls.delayMs)

  if (pathname === '/api/v1/auth/login' && req.method === 'POST') return login(res, state, body)
  if (pathname === '/api/v1/auth/refresh' && req.method === 'POST') return refresh(res, state, body)

  if (!authenticated(req, state)) return sendJson(res, 401, { error: 'unauthorized' })

  if (controls.statusByPath[pathname]) return sendJson(res, controls.statusByPath[pathname], { error: 'mock status' })
  if (controls.malformedPaths.has(pathname)) return sendMalformed(res)
  if (controls.disconnectPaths.has(pathname) && req.method !== 'GET' && req.method !== 'HEAD') {
    if (!updateWrite) state.writeAttempts[pathname] = (state.writeAttempts[pathname] || 0) + 1
    return req.socket.destroy()
  }

  return route(req, res, state, url, pathname, body)
}

function route (req, res, state, url, pathname, body) {
  if (req.method === 'GET' && pathname === '/api/v1/mining') return sendJson(res, 200, { 'mining-status': state.mining })
  if (req.method === 'GET' && pathname === '/api/v1/mining/target') return sendJson(res, 200, state.target)
  if (req.method === 'PUT' && pathname === '/api/v1/mining/target') {
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length === 0 ||
      Object.keys(body).some(key => !['power_target_watts', 'performance_mode'].includes(key))) throw mockError(400)
    if (body.power_target_watts !== undefined && (!Number.isSafeInteger(body.power_target_watts) ||
      body.power_target_watts < state.target.power_target_min_watts || body.power_target_watts > state.target.power_target_max_watts)) throw mockError(400)
    if (body.performance_mode !== undefined && !['MaximumHashrate', 'Efficiency'].includes(body.performance_mode)) throw mockError(400)
    state.writeAttempts[pathname] = (state.writeAttempts[pathname] || 0) + 1
    state.target = { ...state.target, ...body }
    return sendJson(res, 200, state.target)
  }
  if (req.method === 'POST' && pathname === '/api/v1/mining/start') {
    state.writeAttempts[pathname] = (state.writeAttempts[pathname] || 0) + 1
    state.mining.status = 'Mining'
    return sendJson(res, 200, { status: state.mining.status })
  }
  if (req.method === 'POST' && pathname === '/api/v1/mining/stop') {
    state.writeAttempts[pathname] = (state.writeAttempts[pathname] || 0) + 1
    state.mining.status = 'Stopped'
    return sendJson(res, 200, { status: state.mining.status })
  }
  if (req.method === 'GET' && pathname === '/api/v1/telemetry') return sendJson(res, 200, state.telemetry)
  if (req.method === 'GET' && pathname === '/api/v1/pools') return sendJson(res, 200, { pools: state.pools })
  if (req.method === 'POST' && pathname === '/api/v1/pools') {
    state.writeAttempts[pathname] = (state.writeAttempts[pathname] || 0) + 1
    state.pools = body.map(pool => ({
      url: pool.url,
      user: pool.username,
      password: pool.password || '',
      name: pool.name || '',
      priority: pool.priority,
      accepted: 0,
      rejected: 0,
      status: 'Active'
    }))
    return sendJson(res, 200, { pools: state.pools })
  }
  if (req.method === 'GET' && pathname === '/api/v1/errors') return sendJson(res, 200, state.errors)
  if (req.method === 'GET' && pathname === '/api/v1/cooling') return sendJson(res, 200, { 'cooling-status': state.cooling })
  if (req.method === 'GET' && pathname === '/api/v1/hardware/psus') return sendJson(res, 200, { 'psus-info': state.psus })
  if (req.method === 'GET' && pathname === '/api/v1/hashboards') {
    return sendJson(res, 200, { 'hashboards-info': state.hashboardInfo })
  }
  const boardPath = /^\/api\/v1\/hashboards\/([^/]+)$/.exec(pathname)
  if (req.method === 'GET' && boardPath) {
    const serial = decodeURIComponent(boardPath[1])
    if (!Object.hasOwn(state.hashboardStats, serial)) return sendJson(res, 404, { error: 'not found' })
    return sendJson(res, 200, { 'hashboard-stats': state.hashboardStats[serial] })
  }
  if (req.method === 'GET' && pathname === '/api/v1/system/logs') {
    const source = url.searchParams.get('source') || 'miner_sw'
    const lines = Number(url.searchParams.get('lines') ?? 100)
    if (!LOG_SOURCES.has(source) || !Number.isInteger(lines) || lines < 0 || lines > 10000) throw mockError(400)
    const content = lines === 0 ? [] : state.logs[source].slice(-lines)
    return sendJson(res, 200, { logs: { source, lines: content.length, content } })
  }
  if (req.method === 'GET' && pathname === '/api/v1/network') return sendJson(res, 200, { 'network-info': state.network })
  if (req.method === 'PUT' && pathname === '/api/v1/network') {
    const config = body && body['network-config']
    if (!config || typeof config.dhcp !== 'boolean' || Object.keys(config).some(key => !['dhcp', 'ip', 'netmask', 'gateway', 'hostname'].includes(key))) throw mockError(400)
    if (!config.dhcp && (typeof config.ip !== 'string' || typeof config.netmask !== 'string')) throw mockError(400)
    if (Object.entries(config).some(([key, value]) => key !== 'dhcp' && typeof value !== 'string')) throw mockError(400)
    state.writeAttempts[pathname] = (state.writeAttempts[pathname] || 0) + 1
    state.network = { ...state.network, ...config }
    return sendJson(res, 200, { 'network-info': state.network })
  }
  if (req.method === 'GET' && pathname === '/api/v1/system') return sendJson(res, 200, { 'system-info': state.system })
  if (pathname === '/api/v1/system/update' && req.method === 'POST') {
    if (body !== null) throw mockError(400)
    state.updates.push({ mode: 'ota' })
    res.statusCode = 202
    return res.end()
  }
  if (pathname === '/api/v1/system/update' && req.method === 'PUT') {
    if (!body || !Buffer.isBuffer(body.file?.bytes)) throw mockError(400)
    state.updates.push({ mode: 'upload', ...uploadMetadata(body.file) })
    res.statusCode = 200
    return res.end()
  }
  if (req.method === 'POST' && pathname === '/api/v1/system/reboot') {
    state.writeAttempts[pathname] = (state.writeAttempts[pathname] || 0) + 1
    state.rebooted = true
    return sendJson(res, 200, { rebooting: true })
  }
  if (req.method === 'POST' && pathname === '/api/v1/system/locate') {
    state.writeAttempts[pathname] = (state.writeAttempts[pathname] || 0) + 1
    state.led = url.searchParams.get('enable') === 'true'
    return sendJson(res, 200, { locating: state.led })
  }

  return sendJson(res, 404, { error: 'not found' })
}

function login (res, state, body) {
  if (!body || body.password !== state.password) return sendJson(res, 401, { error: 'unauthorized' })
  state.loginCount++
  state.tokenSeq++
  state.refreshSeq++
  state.currentAccessToken = `mock-access-${state.tokenSeq}`
  state.currentRefreshToken = `mock-refresh-${state.refreshSeq}`
  if (state.expireFirstToken && state.loginCount === 1) {
    state.revokedAccessTokens.add(state.currentAccessToken)
  }
  return sendJson(res, 200, {
    access_token: state.currentAccessToken,
    refresh_token: state.currentRefreshToken
  })
}

function refresh (res, state, body) {
  if (!body || body.refresh_token !== state.currentRefreshToken) {
    return sendJson(res, 401, { error: 'unauthorized' })
  }
  state.revokedAccessTokens.add(state.currentAccessToken)
  state.refreshCount++
  state.tokenSeq++
  state.refreshSeq++
  state.currentAccessToken = `mock-access-${state.tokenSeq}`
  state.currentRefreshToken = `mock-refresh-${state.refreshSeq}`
  return sendJson(res, 200, {
    access_token: state.currentAccessToken,
    refresh_token: state.currentRefreshToken
  })
}

function authenticated (req, state) {
  const token = bearer(req)
  return Boolean(token && token === state.currentAccessToken && !state.revokedAccessTokens.has(token))
}

function bearer (req) {
  const value = req.headers.authorization || ''
  const match = /^Bearer (.+)$/.exec(value)
  return match ? match[1] : null
}

function readBody (req) {
  return new Promise((resolve, reject) => {
    if (Number(req.headers['content-length']) > MAX_BODY_BYTES) {
      req.resume()
      reject(mockError(413))
      return
    }
    const chunks = []
    let size = 0
    req.on('data', chunk => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        chunks.length = 0
        reject(mockError(413))
        return
      }
      chunks.push(chunk)
    })
    req.on('error', reject)
    req.on('end', () => {
      if (chunks.length === 0) return resolve(null)
      if (size > MAX_BODY_BYTES) return
      const bytes = Buffer.concat(chunks)
      try {
        const contentType = req.headers['content-type'] || ''
        resolve(/^multipart\/form-data(?:;|$)/i.test(contentType)
          ? parseMultipart(bytes, contentType)
          : JSON.parse(bytes.toString('utf8')))
      } catch (err) {
        reject(err.statusCode ? err : mockError(400))
      }
    })
  })
}

// Parse one required binary file part without decoding its payload as text.
function parseMultipart (bytes, contentType) {
  const match = /(?:^|;)\s*boundary=(?:"([^"\r\n]+)"|([^;\s]+))/i.exec(contentType)
  const boundary = match && (match[1] || match[2])
  if (!boundary || boundary.length > 70 || !/^[\x20-\x7e]+$/.test(boundary)) throw mockError(400)
  const opening = Buffer.from(`--${boundary}\r\n`)
  if (!bytes.subarray(0, opening.length).equals(opening)) throw mockError(400)
  const headerEnd = bytes.indexOf(Buffer.from('\r\n\r\n'), opening.length)
  if (headerEnd < 0 || headerEnd - opening.length > 16384) throw mockError(400)
  const headers = bytes.subarray(opening.length, headerEnd).toString('latin1')
  const disposition = /^Content-Disposition:\s*form-data;\s*name="file";\s*filename="([^"\r\n]+)"\s*$/im.exec(headers)
  if (!disposition) throw mockError(400)
  const filename = disposition[1]
  if (!/^[^/\\]+\.swu$/i.test(filename) || Array.from(filename).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) throw mockError(400)
  const start = headerEnd + 4
  const delimiter = Buffer.from(`\r\n--${boundary}`)
  let end = bytes.indexOf(delimiter, start)
  while (end >= 0) {
    const suffix = bytes.subarray(end + delimiter.length, end + delimiter.length + 2).toString('ascii')
    if (suffix === '--' || suffix === '\r\n') break
    end = bytes.indexOf(delimiter, end + 1)
  }
  if (end < 0) throw mockError(400)
  const footer = bytes.subarray(end + delimiter.length)
  if (!footer.equals(Buffer.from('--')) && !footer.equals(Buffer.from('--\r\n'))) throw mockError(400)
  const file = bytes.subarray(start, end)
  if (file.length > 512 * 1024 * 1024) throw mockError(413)
  return { file: { filename, bytes: file } }
}

function uploadMetadata (file) {
  return { filename: file.filename, size: file.bytes.length, sha256: createHash('sha256').update(file.bytes).digest('hex') }
}

function sendJson (res, statusCode, body) {
  res.statusCode = statusCode
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(body))
}

function sendError (res, err) {
  if (res.headersSent) return res.destroy()
  const statusCode = err && [400, 413].includes(err.statusCode) ? err.statusCode : 500
  sendJson(res, statusCode, { error: statusCode === 400 ? 'ERR_MOCK_BAD_REQUEST' : 'ERR_MOCK_REQUEST_FAILED' })
}

function mockError (statusCode) {
  const err = new Error(statusCode === 400 ? 'ERR_MOCK_BAD_REQUEST' : 'ERR_MOCK_REQUEST_FAILED')
  err.statusCode = statusCode
  return err
}

function sendMalformed (res) {
  res.statusCode = 200
  res.setHeader('content-type', 'application/json')
  res.end('{')
}

function delay (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

module.exports = { createServer }
