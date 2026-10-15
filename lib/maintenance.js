'use strict'

const { createHash } = require('node:crypto')
const { isIP } = require('node:net')

const LOG_SOURCES = new Set(['os', 'pool_sw', 'miner_sw', 'miner_web_server'])
const MAX_FIRMWARE_BYTES = 512 * 1024 * 1024

function object (value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function fail (code) {
  throw new Error(code)
}

function redactLogLine (client, line) {
  const http = client.api.http
  for (const secret of [http?.password, http?.accessToken, http?.refreshToken]) {
    if (typeof secret === 'string' && secret) line = line.replaceAll(secret, '[REDACTED]')
  }
  return line
    .replace(/(\bBearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]')
    .replace(/((?:worker[_-]?password|password|access[_-]?token|refresh[_-]?token|api[_-]?key)\s*["']?\s*[:=]\s*)(?:"(?:\\[\s\S]|[^"\\])*(?:"|\\?$)|'(?:\\[\s\S]|[^'\\])*(?:'|\\?$)|[^\s"',;]+)/gi, '$1[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED]')
}

async function downloadLogs (client, params = {}) {
  if (!object(params)) fail('ERR_LOGS_PARAMETERS_INVALID')
  const source = params.source === undefined ? 'miner_sw' : params.source
  const lines = params.lines === undefined ? 100 : params.lines
  if (!LOG_SOURCES.has(source) || !Number.isSafeInteger(lines) || lines < 1 || lines > 10000) fail('ERR_LOGS_PARAMETERS_INVALID')
  const response = await client.api.getLogs(source, lines)
  const logs = response?.logs
  if (!object(logs) || !Array.isArray(logs.content) || logs.content.length > lines ||
      logs.content.some(line => typeof line !== 'string') ||
      (logs.source !== undefined && logs.source !== source) ||
      (logs.lines !== undefined && logs.lines !== logs.content.length)) fail('ERR_LOGS_RESPONSE_INVALID')
  return { source, lines: logs.content.length, content: logs.content.map(line => redactLogLine(client, line)) }
}

function networkConfig (network) {
  if (!object(network) || typeof network.dhcp !== 'boolean' ||
      Object.keys(network).some(key => !['dhcp', 'ip', 'netmask', 'gateway', 'hostname'].includes(key))) fail('ERR_NETWORK_CONFIG_INVALID')
  const config = { dhcp: network.dhcp }
  if (network.hostname !== undefined) {
    if (typeof network.hostname !== 'string' || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(network.hostname)) fail('ERR_NETWORK_CONFIG_INVALID')
    config.hostname = network.hostname
  }
  if (network.dhcp) {
    if (['ip', 'netmask', 'gateway'].some(key => network[key] !== undefined)) fail('ERR_NETWORK_CONFIG_INVALID')
    return config
  }
  if (typeof network.ip !== 'string' || isIP(network.ip) !== 4 ||
      typeof network.netmask !== 'string' || isIP(network.netmask) !== 4) fail('ERR_NETWORK_CONFIG_INVALID')
  const mask = network.netmask.split('.').reduce((value, octet) => ((value << 8) | Number(octet)) >>> 0, 0)
  const inverse = (~mask) >>> 0
  if ((inverse & ((inverse + 1) >>> 0)) !== 0) fail('ERR_NETWORK_CONFIG_INVALID')
  config.ip = network.ip
  config.netmask = network.netmask
  if (network.gateway !== undefined) {
    if (typeof network.gateway !== 'string' || isIP(network.gateway) !== 4) fail('ERR_NETWORK_CONFIG_INVALID')
    config.gateway = network.gateway
  }
  return config
}

async function setNetwork (client, network) {
  const config = networkConfig(network)
  await client._write(['network', 'system'], () => client.api.setNetwork(config))
  return { success: true }
}

function firmwareBytes (firmware) {
  if (!object(firmware) ||
      typeof firmware.filename !== 'string' || firmware.filename.length <= 4 || !/\.swu$/i.test(firmware.filename) ||
      firmware.filename.includes('/') || firmware.filename.includes('\\') ||
      [...firmware.filename].some(char => char.charCodeAt(0) < 32) ||
      firmware.encoding !== 'base64' ||
      !Number.isSafeInteger(firmware.size) || firmware.size < 1 || firmware.size > MAX_FIRMWARE_BYTES ||
      typeof firmware.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(firmware.sha256) ||
      typeof firmware.data !== 'string' || firmware.data.length !== Math.ceil(firmware.size / 3) * 4) fail('ERR_FIRMWARE_PAYLOAD_INVALID')
  const bytes = Buffer.from(firmware.data, 'base64')
  if (bytes.length !== firmware.size || bytes.toString('base64') !== firmware.data ||
      createHash('sha256').update(bytes).digest('hex') !== firmware.sha256.toLowerCase()) fail('ERR_FIRMWARE_PAYLOAD_INVALID')
  return bytes
}

async function updateFirmware (client, firmware) {
  if (client.firmwareUpdatePending) fail('ERR_COMMAND_IN_PROGRESS')
  const bytes = firmware === undefined ? null : firmwareBytes(firmware)
  client.firmwareUpdatePending = true
  try {
    const result = await client._write(null, () => bytes
      ? client.api.uploadFirmware(bytes, firmware.filename)
      : client.api.startFirmwareUpdate())
    if (result?.status !== (bytes ? 200 : 202)) fail('ERR_FIRMWARE_RESPONSE_INVALID')
    return { accepted: true, completed: false, mode: bytes ? 'upload' : 'ota' }
  } finally {
    client.firmwareUpdatePending = false
  }
}

module.exports = { downloadLogs, setNetwork, updateFirmware }
