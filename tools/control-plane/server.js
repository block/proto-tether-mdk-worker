'use strict'

const http = require('node:http')
const fs = require('node:fs/promises')
const path = require('node:path')

const ASSETS = {
  '/': ['index.html', 'text/html'],
  '/app.js': ['app.js', 'text/javascript'],
  '/model.mjs': ['model.mjs', 'text/javascript'],
  '/styles.css': ['styles.css', 'text/css']
}

function createControlPlane ({ client, deviceId = 'proto-r2-1' } = {}) {
  if (!client) throw new Error('Worker client is required')
  if (typeof deviceId !== 'string' || !deviceId.trim()) throw new Error('Device ID is required')
  const server = http.createServer(async (req, res) => {
    const port = server.address().port
    const hosts = [`127.0.0.1:${port}`, `localhost:${port}`]
    const json = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify(body))
    }
    if (!hosts.includes(req.headers.host)) return json(403, { error: 'Unrecognized local host' })
    res.setHeader('x-content-type-options', 'nosniff')
    res.setHeader('referrer-policy', 'no-referrer')
    res.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'")
    const url = new URL(req.url, `http://${req.headers.host}`)
    try {
      if (req.method === 'GET' && ASSETS[url.pathname]) {
        const [file, type] = ASSETS[url.pathname]
        const content = await fs.readFile(path.join(__dirname, 'public', file))
        res.writeHead(200, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' })
        return res.end(content)
      }
      if (req.method === 'GET' && url.pathname === '/api/config') return json(200, { endpoint: client.endpoint, deviceId })
      let result
      if (req.method === 'GET' && url.pathname === '/api/capabilities') result = await client.capabilities()
      else if (req.method === 'GET' && url.pathname === '/api/identity') result = await client.identity()
      else if (req.method === 'GET' && /^\/api\/telemetry\/[a-zA-Z0-9_-]+$/.test(url.pathname)) {
        result = await client.telemetry(deviceId, url.pathname.split('/').at(-1))
      } else if (req.method === 'POST' && url.pathname === '/api/command') {
        if (req.headers.origin && !hosts.some(host => req.headers.origin === `http://${host}`)) return json(403, { error: 'Cross-origin commands are not accepted' })
        if (req.headers['sec-fetch-site'] === 'cross-site') return json(403, { error: 'Cross-site commands are not accepted' })
        if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') return json(415, { error: 'Commands require application/json' })
        const chunks = []
        let size = 0
        for await (const chunk of req) {
          size += chunk.length
          if (size > 16 * 1024 * 1024) return json(413, { error: 'Request exceeds the development console limit of 16 MiB; the MDK transport may impose a smaller limit' })
          chunks.push(chunk)
        }
        const body = Buffer.concat(chunks).toString('utf8')
        let command
        try { command = JSON.parse(body) } catch { return json(400, { error: 'Invalid command JSON' }) }
        if (!command || typeof command.command !== 'string' || !command.params || typeof command.params !== 'object' || Array.isArray(command.params)) return json(400, { error: 'Expected {command, params: {...}}' })
        result = await client.command(deviceId, command.command, command.params)
      } else return json(404, { error: 'Route not found' })
      json(200, result)
    } catch {
      json(502, { error: bodyWasCommand(req) ? 'Worker request failed. Command outcome is unknown; read device state before another write. This request was not retried.' : 'Worker unavailable. Check the worker key and trusted client identity, then reconnect.' })
    }
  })
  return server
}

function bodyWasCommand (req) {
  return req.method === 'POST'
}

if (require.main === module) {
  main().catch(() => { console.error('ERR_CONTROL_STARTUP_FAILED: check MDK_REPO, MDK_CLIENT_SEED_FILE and MDK_WORKER_KEY'); process.exitCode = 1 })
}

async function main () {
  const { createWorkerClient, readClientKeyPair } = require('./worker-client')
  const keyPair = readClientKeyPair(process.env.MDK_CLIENT_SEED_FILE)
  if (process.argv.includes('--client-key')) {
    console.log(keyPair.publicKey.toString('hex'))
    return
  }
  const port = Number(process.env.CONTROL_PORT || 3041)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid CONTROL_PORT')
  const client = createWorkerClient({ publicKey: process.env.MDK_WORKER_KEY, workerId: process.env.PROTO_WORKER_ID, keyPair })
  let server
  try {
    server = createControlPlane({ client, deviceId: process.env.PROTO_DEVICE_ID })
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, '127.0.0.1', () => {
        server.removeListener('error', reject)
        resolve()
      })
    })
  } catch (error) {
    await client.close()
    throw error
  }
  let stopping
  const stop = () => {
    if (!stopping) {
      stopping = (async () => {
        server.closeAllConnections()
        await new Promise(resolve => server.close(resolve))
        await client.close()
      })().catch(() => { console.error('ERR_CONTROL_SHUTDOWN_FAILED'); process.exitCode = 1 })
    }
    return stopping
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  console.log(`Proto development console: http://127.0.0.1:${server.address().port}`)
}

module.exports = { createControlPlane }
