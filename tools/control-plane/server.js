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

function createControlPlane ({ gateway = 'http://127.0.0.1:3007', deviceId = 'proto-rig-1' } = {}) {
  const upstream = new URL(gateway)
  if (!['http:', 'https:'].includes(upstream.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(upstream.hostname) || upstream.username || upstream.password) {
    throw new Error('Gateway must be a loopback HTTP URL without credentials')
  }
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
      if (req.method === 'GET' && url.pathname === '/api/config') return json(200, { gateway: upstream.origin, deviceId })
      let target
      let body
      if (req.method === 'GET' && url.pathname === '/api/capabilities') target = '/site/capabilities'
      else if (req.method === 'GET' && url.pathname === '/api/workers') target = '/site/workers'
      else if (req.method === 'GET' && /^\/api\/telemetry\/[a-zA-Z0-9_-]+$/.test(url.pathname)) {
        target = `/site/devices/${encodeURIComponent(deviceId)}/telemetry/${url.pathname.split('/').at(-1)}`
      } else if (req.method === 'POST' && url.pathname === '/api/command') {
        if (req.headers.origin && !hosts.some(host => req.headers.origin === `http://${host}`)) return json(403, { error: 'Cross-origin commands are not accepted' })
        if (req.headers['sec-fetch-site'] === 'cross-site') return json(403, { error: 'Cross-site commands are not accepted' })
        if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') return json(415, { error: 'Commands require application/json' })
        const chunks = []
        let size = 0
        for await (const chunk of req) {
          size += chunk.length
          if (size > 16 * 1024 * 1024) return json(413, { error: 'Request exceeds the control plane limit of 16 MiB; the gateway may impose a smaller limit' })
          chunks.push(chunk)
        }
        body = Buffer.concat(chunks).toString('utf8')
        let command
        try { command = JSON.parse(body) } catch { return json(400, { error: 'Invalid command JSON' }) }
        if (!command || typeof command.command !== 'string' || !command.params || typeof command.params !== 'object' || Array.isArray(command.params)) return json(400, { error: 'Expected {command, params: {...}}' })
        target = `/site/miners/${encodeURIComponent(deviceId)}/command`
      } else return json(404, { error: 'Route not found' })
      const response = await fetch(new URL(target, upstream), {
        method: req.method,
        headers: body ? { 'content-type': 'application/json' } : {},
        body,
        redirect: 'error',
        signal: AbortSignal.timeout(body ? 30 * 60 * 1000 : 30000)
      })
      const content = await response.text()
      res.writeHead(response.status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(content)
    } catch {
      json(502, { error: bodyWasCommand(req) ? 'Gateway request failed. Command outcome is unknown; read device state before another write. This request was not retried.' : 'Gateway unavailable. Start the local MDK stack, then reconnect.' })
    }
  })
  return server
}

function bodyWasCommand (req) {
  return req.method === 'POST'
}

if (require.main === module) {
  const port = Number(process.env.CONTROL_PORT || 3041)
  const server = createControlPlane({ gateway: process.env.MDK_GATEWAY_URL, deviceId: process.env.MDK_DEVICE_ID })
  server.on('error', error => { console.error(error.message); process.exitCode = 1 })
  server.listen(port, '127.0.0.1', () => console.log(`Proto control plane: http://127.0.0.1:${server.address().port}`))
}

module.exports = { createControlPlane }
