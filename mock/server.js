'use strict'

const http = require('node:http')

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
        hashrate: { value: 95.5 },
        temperature: { value: 65.5 },
        power: { value: 3250 },
        efficiency: { value: 34.03 }
      },
      hashboards: [
        { index: 0, temperature: { inlet: 45, outlet: 68, average: 56 } },
        { index: 1, temperature: { inlet: 46, outlet: 70, average: 58 } }
      ]
    },
    pools: [
      { url: 'stratum+tcp://pool:3333', user: 'worker', password: 'secret', accepted: 10, rejected: 1, status: 'Active' }
    ],
    errors: [],
    cooling: {
      fan_mode: 'Auto',
      speed_percentage: 55,
      fans: [{ rpm: 5000 }, { rpm: 5100 }]
    },
    network: {
      dhcp: true,
      ip: '192.0.2.10',
      netmask: '255.255.255.0',
      gateway: '192.0.2.1'
    },
    // Mirrors the key set observed on R2 firmware. Most of these are fields the
    // worker deliberately does not publish; they are here so the snapshot tests
    // exercise the projection rather than a conveniently minimal payload.
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
  const body = await readBody(req)
  state.requests.push({ method: req.method, path: pathname, url: req.url, authorization: req.headers.authorization || null, body })

  if (controls.delayMs > 0) await delay(controls.delayMs)

  if (pathname === '/api/v1/auth/login' && req.method === 'POST') return login(res, state, body)
  if (pathname === '/api/v1/auth/refresh' && req.method === 'POST') return refresh(res, state, body)

  if (!authenticated(req, state)) return sendJson(res, 401, { error: 'unauthorized' })

  if (controls.statusByPath[pathname]) return sendJson(res, controls.statusByPath[pathname], { error: 'mock status' })
  if (controls.malformedPaths.has(pathname)) return sendMalformed(res)
  if (controls.disconnectPaths.has(pathname) && req.method !== 'GET' && req.method !== 'HEAD') {
    state.writeAttempts[pathname] = (state.writeAttempts[pathname] || 0) + 1
    return req.socket.destroy()
  }

  return route(req, res, state, url, pathname, body)
}

function route (req, res, state, url, pathname, body) {
  if (req.method === 'GET' && pathname === '/api/v1/mining') return sendJson(res, 200, { 'mining-status': state.mining })
  if (req.method === 'GET' && pathname === '/api/v1/mining/target') return sendJson(res, 200, state.target)
  if (req.method === 'PUT' && pathname === '/api/v1/mining/target') {
    state.writeAttempts[pathname] = (state.writeAttempts[pathname] || 0) + 1
    state.target = { ...state.target, power_target_watts: body.power_target_watts }
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
  if (req.method === 'GET' && pathname === '/api/v1/network') return sendJson(res, 200, { 'network-info': state.network })
  if (req.method === 'GET' && pathname === '/api/v1/system') return sendJson(res, 200, { 'system-info': state.system })
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
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('error', reject)
    req.on('end', () => {
      if (chunks.length === 0) return resolve(null)
      const text = Buffer.concat(chunks).toString('utf8')
      try {
        resolve(JSON.parse(text))
      } catch {
        reject(mockError(400))
      }
    })
  })
}

function sendJson (res, statusCode, body) {
  res.statusCode = statusCode
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(body))
}

function sendError (res, err) {
  if (res.headersSent) return res.destroy()
  const statusCode = err && err.statusCode === 400 ? 400 : 500
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
