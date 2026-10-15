export function parseParams (command, values) {
  const params = {}
  for (const parameter of command.params || []) {
    const { name, type, required, min, max } = parameter
    const raw = values[name]
    if (raw === undefined || raw === '') {
      if (required) throw new Error(`${name} is required`)
      continue
    }
    let value = raw
    if (type === 'number') {
      value = Number(raw)
      if (!Number.isFinite(value) || (min !== undefined && value < min) || (max !== undefined && value > max)) throw new Error(`${name} must be a number${min !== undefined ? ` ≥ ${min}` : ''}${max !== undefined ? ` ≤ ${max}` : ''}`)
    } else if (type === 'boolean') {
      if (!['true', 'false'].includes(raw)) throw new Error(`${name} must be true or false`)
      value = raw === 'true'
    } else if (type === 'object') {
      try { value = JSON.parse(raw) } catch { throw new Error(`${name} must contain valid JSON`) }
      if (value === null || typeof value !== 'object') throw new Error(`${name} must be a JSON object or array`)
    }
    if (parameter.enum && !parameter.enum.includes(value)) throw new Error(`${name} must be one of: ${parameter.enum.join(', ')}`)
    params[name] = value
  }
  return params
}

export function commandResult (body, httpStatus) {
  const ok = httpStatus >= 200 && httpStatus < 300 && body?.status === 'SUCCESS' && body.result?.success !== false
  const error = body?.error || body?.message || `HTTP ${httpStatus}`
  return { ok, message: ok ? 'Command succeeded' : String(error), uncertain: /UNVERIFIED|CONNECTION|TIMEOUT|HTTP_RESPONSE|FIRMWARE_RESPONSE_INVALID|INVALID_JSON|unknown/i.test(String(error)) }
}

export function preview (value) {
  return JSON.stringify(value, function (key, value) {
    if (/password|token|secret|authorization/i.test(key)) return '[redacted]'
    if (key === 'data' && this.encoding === 'base64') return '[base64 payload omitted]'
    return value
  }, 2)
}
