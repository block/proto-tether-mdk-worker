'use strict'

const INVALID = 'ERR_ASIC_STATS_RESPONSE_INVALID'
const BOARD_CONCURRENCY = 2
const BOARD_STATUS = new Set(['Running', 'Stopped', 'Updating', 'Error', 'Overheated', 'Unknown'])

function invalid () { throw new Error(INVALID) }
function object (value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid()
  return value
}
function array (value) {
  if (!Array.isArray(value)) invalid()
  return value
}
function string (value) {
  if (typeof value !== 'string' || !value.trim()) invalid()
  return value
}
function count (value) {
  if (!Number.isSafeInteger(value) || value < 0) invalid()
  return value
}

function inventoryBoard (source) {
  object(source)
  const serial = string(source.hb_sn)
  if (serial === '.' || serial === '..') invalid()
  const board = { serial_number: serial }
  for (const [field, output] of [['slot', 'slot'], ['mining_asic_count', 'expected_asic_count']]) {
    if (source[field] !== undefined) board[output] = count(source[field])
  }
  for (const [field, output] of [['board', 'board_type'], ['mining_asic', 'asic_type']]) {
    if (source[field] !== undefined) board[output] = string(source[field])
  }
  return board
}

function asicStats (source) {
  object(source)
  const asic = { index: count(source.index) }
  if (source.id !== undefined) asic.id = string(source.id)
  for (const field of ['row', 'column']) {
    if (source[field] !== undefined) asic[field] = count(source[field])
  }
  for (const [field, output, divisor] of [
    ['freq_mhz', 'frequency_mhz', 1], ['temp_c', 'temperature_c', 1],
    ['voltage_mv', 'voltage_v', 1000], ['hashrate_ghs', 'hashrate_ths', 1000],
    ['ideal_hashrate_ghs', 'ideal_hashrate_ths', 1000], ['error_rate', 'error_rate_pct', 1]
  ]) {
    const value = source[field]
    if (value === undefined) continue
    if (!Number.isFinite(value) || (field !== 'temp_c' && value < 0)) invalid()
    asic[output] = value / divisor
  }
  return asic
}

function boardStats (board, payload) {
  const source = object(object(payload)['hashboard-stats'])
  if (source.hb_sn !== undefined && source.hb_sn !== board.serial_number) invalid()
  const result = { ...board }
  if (source.slot !== undefined) result.slot = count(source.slot)
  if (source.status !== undefined) {
    if (!BOARD_STATUS.has(source.status)) invalid()
    result.status = source.status
  }
  if (source.asics !== undefined) {
    result.asics = array(source.asics).map(asicStats)
    if (new Set(result.asics.map(asic => asic.index)).size !== result.asics.length) invalid()
    result.reported_asic_count = result.asics.length
  }
  return result
}

async function readAsicStats (api) {
  const inventory = object(await api.getHashboardInfo())
  const boards = array(inventory['hashboards-info']).map(inventoryBoard)
  if (new Set(boards.map(board => board.serial_number)).size !== boards.length) invalid()
  const hashboards = new Array(boards.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(BOARD_CONCURRENCY, boards.length) }, async () => {
    while (next < boards.length) {
      const index = next++
      const board = boards[index]
      try {
        hashboards[index] = boardStats(board, await api.getHashboardStatus(board.serial_number))
      } catch (err) {
        hashboards[index] = { ...board, error: err.message === INVALID ? INVALID : 'ERR_ASIC_STATS_UNAVAILABLE' }
      }
    }
  }))
  return { hashboards }
}

module.exports = { readAsicStats }
