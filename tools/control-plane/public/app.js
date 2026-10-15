/* global document, fetch, FormData, FileReader, crypto */
import { parseParams, commandResult, preview } from './model.mjs'

const $ = selector => document.querySelector(selector)
const state = { contract: null, config: null, channel: null, command: null, readings: new Map(), reading: new Set(), activity: [], sending: false, pending: null }

function element (tag, text, className) {
  const node = document.createElement(tag)
  if (text !== undefined) node.textContent = text
  if (className) node.className = className
  return node
}

async function request (url, options) {
  const response = await fetch(url, options)
  const text = await response.text()
  let body
  try { body = JSON.parse(text) } catch { body = { error: text || `HTTP ${response.status}` } }
  if (body === null || typeof body !== 'object') body = { error: 'Gateway returned an unexpected JSON response', value: body }
  return { body, httpStatus: response.status }
}

function requireSuccess (result) {
  if (result.httpStatus < 200 || result.httpStatus >= 300 || result.body.error) throw new Error(result.body.error || result.body.message || `HTTP ${result.httpStatus}`)
  return result.body
}

function setError (selector, message) {
  const node = $(selector)
  node.textContent = message || ''
  node.hidden = !message
}

function showView (view) {
  for (const name of ['telemetry', 'commands', 'activity', 'contract']) $(`#${name}-view`).hidden = name !== view
  for (const button of document.querySelectorAll('[data-view]')) button.classList.toggle('active', button.dataset.view === view)
}

function renderLists () {
  for (const [kind, entries, selected, search, list] of [
    ['telemetry', state.contract?.capabilities.telemetry || [], state.channel, '#telemetry-search', '#telemetry-list'],
    ['command', state.contract?.capabilities.commands || [], state.command, '#command-search', '#command-list']
  ]) {
    const query = $(search).value.toLowerCase()
    $(list).replaceChildren()
    for (const entry of entries.filter(entry => `${entry.name} ${entry.description}`.toLowerCase().includes(query))) {
      const button = element('button', entry.name, selected?.name === entry.name ? 'active' : '')
      button.type = 'button'
      button.setAttribute('aria-pressed', String(selected?.name === entry.name))
      if (entry.unit) button.append(element('small', entry.unit))
      button.addEventListener('click', () => kind === 'telemetry' ? selectChannel(entry) : selectCommand(entry))
      $(list).append(button)
    }
  }
}

function nested (value) {
  if (value === null || typeof value !== 'object') return element('span', value === null ? 'null' : String(value))
  const details = element('details')
  details.append(element('summary', Array.isArray(value) ? `${value.length} items` : `${Object.keys(value).length} fields`))
  let rendered = false
  details.addEventListener('toggle', () => {
    if (details.open && !rendered) {
      details.append(structured(value))
      rendered = true
    }
  })
  return details
}

function structured (value) {
  if (value === null || typeof value !== 'object') return nested(value)
  if (Array.isArray(value) && value.length === 0) return element('p', 'No reported entries.', 'muted')
  const table = element('table')
  if (Array.isArray(value) && value.every(item => item && typeof item === 'object' && !Array.isArray(item))) {
    const keys = [...new Set(value.flatMap(item => Object.keys(item)))]
    const head = element('tr')
    for (const key of keys) head.append(element('th', key))
    const thead = element('thead')
    thead.append(head)
    table.append(thead)
    const tbody = element('tbody')
    for (const item of value) {
      const row = element('tr')
      for (const key of keys) {
        const cell = element('td')
        cell.append(Object.hasOwn(item, key) ? nested(item[key]) : element('span', '—'))
        row.append(cell)
      }
      tbody.append(row)
    }
    table.append(tbody)
  } else {
    const tbody = element('tbody')
    for (const [key, entry] of Object.entries(value)) {
      const row = element('tr')
      const cell = element('td')
      cell.append(nested(entry))
      row.append(element('th', key), cell)
      tbody.append(row)
    }
    table.append(tbody)
  }
  return table
}

function renderReading () {
  const channel = state.channel
  if (!channel) return
  $('#channel-title').textContent = channel.name
  $('#channel-description').textContent = channel.description
  $('#read-channel').disabled = state.reading.has(channel.name)
  $('#read-channel').textContent = state.reading.has(channel.name) ? 'Reading…' : 'Read telemetry ↗'
  const reading = state.readings.get(channel.name)
  $('#read-status').textContent = state.reading.has(channel.name) ? 'Reading from device…' : reading ? `HTTP ${reading.httpStatus} · ${new Date(reading.at).toLocaleTimeString()}` : 'Readings are fetched on demand.'
  const output = $('#telemetry-output')
  output.replaceChildren()
  if (!reading) return output.append(element('p', 'Read this channel to inspect its current value.', 'empty'))
  if (reading.httpStatus >= 400 || reading.body.error) return output.append(element('pre', preview(reading.body), 'error'))
  if ($('#raw-toggle').checked) return output.append(element('pre', preview(reading.body)))
  const value = Object.hasOwn(reading.body, 'value') ? reading.body.value : reading.body
  if (value === null || typeof value !== 'object') {
    const display = element('div', String(value), 'scalar')
    if (channel.unit) display.append(element('small', channel.unit))
    output.append(display)
  } else output.append(structured(value))
}

function selectChannel (channel) {
  state.channel = channel
  renderLists()
  renderReading()
}

function renderSummary (snap) {
  const stats = snap?.stats
  const fields = [
    ['Mining state', stats?.status, ''],
    ['Hashrate', stats?.hashrate_mhs?.avg === undefined ? undefined : (stats.hashrate_mhs.avg / 1e6).toFixed(1), 'TH/s'],
    ['Consumption', stats?.power_w === undefined ? undefined : (stats.power_w / 1000).toFixed(2), 'kW'],
    ['Temperature', stats?.temperature_c?.avg?.toFixed(1), '°C'],
    ['Performance policy', snap?.config?.performance_mode, '']
  ]
  $('#summary').replaceChildren()
  for (const [label, value, unit] of fields) {
    const card = element('div', undefined, 'metric')
    const display = element('div', value ?? '—', 'metric-value')
    if (unit) display.append(element('small', unit))
    card.append(element('div', label, 'metric-label'), display)
    $('#summary').append(card)
  }
}

function record (kind, name, requestBody, response, httpStatus) {
  state.activity.unshift({ kind, name, at: Date.now(), request: requestBody ? preview(requestBody) : null, response: preview(response), httpStatus })
  state.activity.length = Math.min(state.activity.length, 30)
  $('#activity-count').textContent = state.activity.length
  $('#activity-list').replaceChildren()
  for (const entry of state.activity) {
    const item = element('details', undefined, 'activity-item')
    const heading = element('summary', undefined, 'activity-heading')
    heading.append(element('span', `${entry.kind.toUpperCase()} / ${entry.name} · HTTP ${entry.httpStatus}`), element('time', new Date(entry.at).toLocaleTimeString()))
    item.append(heading)
    if (entry.request) item.append(element('h3', 'Request'), element('pre', entry.request))
    item.append(element('h3', 'Response'), element('pre', entry.response))
    $('#activity-list').append(item)
  }
}

async function readChannel (channel = state.channel) {
  if (!channel || state.reading.has(channel.name)) return
  state.reading.add(channel.name)
  renderReading()
  try {
    const result = await request(`/api/telemetry/${encodeURIComponent(channel.name)}`)
    state.readings.set(channel.name, { ...result, at: Date.now() })
    record('read', channel.name, null, result.body, result.httpStatus)
    if (channel.name === 'snap' && result.httpStatus === 200 && !result.body.error) renderSummary(result.body.value)
  } catch (error) {
    state.readings.set(channel.name, { httpStatus: 0, body: { error: error.message }, at: Date.now() })
    record('read', channel.name, null, { error: error.message }, 0)
  } finally {
    state.reading.delete(channel.name)
    renderReading()
  }
}

function parameterInput (parameter) {
  const field = element('div', undefined, `field${parameter.type === 'object' ? ' structured' : ''}`)
  const label = element('label', parameter.name)
  label.htmlFor = `param-${parameter.name}`
  label.append(element('small', parameter.required ? 'required' : 'optional'))
  field.append(label)
  let input
  if (parameter.enum || parameter.type === 'boolean') {
    input = element('select')
    const blank = element('option', parameter.required ? 'Choose a value…' : 'Omit / use device default')
    blank.value = ''
    input.append(blank)
    for (const value of parameter.enum || ['true', 'false']) {
      const option = element('option', String(value))
      option.value = String(value)
      input.append(option)
    }
  } else {
    input = element(parameter.type === 'object' ? 'textarea' : 'input')
    if (parameter.type === 'number') {
      input.type = 'number'
      input.step = 'any'
      if (parameter.min !== undefined) input.min = parameter.min
      if (parameter.max !== undefined) input.max = parameter.max
    }
    if (parameter.type === 'object') {
      input.placeholder = parameter.name === 'pools' ? '[{"url":"stratum+tcp://pool.example:3333","worker_name":"account.worker"}]' : parameter.name === 'network' ? '{"dhcp":true}' : '{…}'
      input.spellcheck = false
    }
  }
  input.name = parameter.name
  input.id = `param-${parameter.name}`
  input.required = Boolean(parameter.required)
  field.append(input)
  if (parameter.type === 'object') field.append(element('span', 'Enter a JSON object or array. Leave optional fields blank to omit them.', 'hint'))
  if (parameter.name === 'firmware') {
    field.append(element('span', 'Leave blank for OTA, or choose a .swu file to prepare its size, SHA-256 and base64 payload. Gateway and MDK transport size limits still apply.', 'hint'))
    const fileInput = element('input')
    fileInput.type = 'file'
    fileInput.accept = '.swu'
    fileInput.setAttribute('aria-label', 'Firmware image')
    const preparationStatus = element('span', '', 'hint')
    preparationStatus.setAttribute('aria-live', 'polite')
    let preparation = 0
    const setValidity = message => {
      input.setCustomValidity(message)
      fileInput.setCustomValidity(message)
    }
    input.addEventListener('input', () => setValidity(''))
    fileInput.addEventListener('change', async () => {
      const version = ++preparation
      const file = fileInput.files[0]
      input.value = ''
      input.readOnly = false
      setValidity('')
      preparationStatus.textContent = ''
      setError('#form-error', '')
      if (!file) return
      input.readOnly = true
      setValidity('Wait for the firmware image to finish preparing.')
      preparationStatus.textContent = 'Preparing firmware image…'
      try {
        if (file.size > 12 * 1024 * 1024 - 4096) throw new Error('This file exceeds the local proxy’s 16 MiB JSON limit. OTA remains available; larger uploads need a transport configured for their size.')
        const buffer = await file.arrayBuffer()
        const digest = await crypto.subtle.digest('SHA-256', buffer)
        const sha256 = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
        const data = await new Promise((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => resolve(reader.result.split(',')[1])
          reader.onerror = reject
          reader.readAsDataURL(file)
        })
        if (version !== preparation) return
        input.value = JSON.stringify({ filename: file.name, encoding: 'base64', size: file.size, sha256, data })
        setValidity('')
        preparationStatus.textContent = `Prepared ${file.name} · ${file.size.toLocaleString()} bytes`
      } catch (error) {
        if (version !== preparation) return
        setValidity(error.message)
        preparationStatus.textContent = 'Image preparation failed. Choose another file, edit the JSON, or clear the file selection to use OTA.'
        setError('#form-error', error.message)
      } finally {
        if (version === preparation) input.readOnly = false
      }
    })
    field.append(fileInput, preparationStatus)
  }
  return field
}

function selectCommand (command) {
  state.command = command
  renderLists()
  $('#command-title').textContent = command.name
  $('#command-description').textContent = command.description
  $('#command-constraints').textContent = command.constraints || 'No additional constraints declared.'
  $('#parameter-fields').replaceChildren(...(command.params || []).map(parameterInput))
  if (!command.params?.length) $('#parameter-fields').append(element('p', 'This command takes no parameters.', 'muted'))
  $('#review-command').disabled = state.sending
  setError('#form-error', '')
}

async function sendCommand (payload) {
  state.sending = true
  $('#review-command').disabled = true
  $('#command-status').className = 'muted'
  $('#command-status').textContent = `Sending ${payload.command} once…`
  $('#command-output').hidden = true
  try {
    const result = await request('/api/command', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
    const verdict = commandResult(result.body, result.httpStatus)
    $('#command-status').className = verdict.ok ? 'success' : 'error'
    $('#command-status').textContent = `${payload.command}: ${verdict.message}${verdict.uncertain ? ' — outcome uncertain; inspect telemetry before another write.' : ''}`
    $('#command-output').textContent = preview(result.body)
    $('#command-output').hidden = false
    record('command', payload.command, payload, result.body, result.httpStatus)
    const snap = state.contract.capabilities.telemetry.find(channel => channel.name === 'snap')
    if (snap) await readChannel(snap)
  } catch (error) {
    const message = `${payload.command}: connection lost; outcome unknown. Read device state before another write. No automatic retry.`
    $('#command-status').className = 'error'
    $('#command-status').textContent = message
    record('command', payload.command, payload, { error: message }, 0)
  } finally {
    state.sending = false
    $('#review-command').disabled = !state.command
  }
}

async function connect () {
  setError('#global-error', '')
  $('#connection').textContent = 'Connecting to MDK…'
  $('#connection-dot').classList.remove('connected')
  try {
    const [configResult, contractResult] = await Promise.all([request('/api/config'), request('/api/capabilities')])
    state.config = requireSuccess(configResult)
    state.contract = requireSuccess(contractResult)
    $('#device-id').textContent = state.config.deviceId
    $('#gateway-url').textContent = state.config.gateway
    $('#connection').textContent = 'MDK gateway connected'
    $('#connection-dot').classList.add('connected')
    $('#telemetry-count').textContent = state.contract.capabilities.telemetry.length
    $('#command-count').textContent = state.contract.capabilities.commands.length
    $('#contract-output').textContent = preview(state.contract)
    const channels = state.contract.capabilities.telemetry
    selectChannel(channels.find(channel => channel.name === state.channel?.name) || channels.find(channel => channel.name === 'snap') || channels[0])
    const commands = state.contract.capabilities.commands
    selectCommand(commands.find(command => command.name === state.command?.name) || commands.find(command => command.name === 'setPerformanceMode') || commands[0])
    const snap = channels.find(channel => channel.name === 'snap')
    if (snap) await readChannel(snap)
  } catch (error) {
    $('#connection').textContent = 'Gateway unavailable'
    $('#read-channel').disabled = true
    $('#review-command').disabled = true
    setError('#global-error', error.message)
  }
}

for (const button of document.querySelectorAll('[data-view]')) button.addEventListener('click', () => showView(button.dataset.view))
$('#telemetry-search').addEventListener('input', renderLists)
$('#command-search').addEventListener('input', renderLists)
$('#raw-toggle').addEventListener('change', renderReading)
$('#read-channel').addEventListener('click', () => readChannel())
$('#reconnect').addEventListener('click', connect)
$('#refresh-contract').addEventListener('click', connect)
$('#command-form').addEventListener('submit', event => {
  event.preventDefault()
  if (!state.command || state.sending) return
  setError('#form-error', '')
  try {
    const values = Object.fromEntries(new FormData(event.target))
    state.pending = { command: state.command.name, params: parseParams(state.command, values) }
    $('#confirm-title').textContent = `Send ${state.command.name}?`
    $('#confirm-target').textContent = `Device: ${state.config.deviceId} · ${state.config.gateway}`
    $('#confirm-payload').textContent = preview(state.pending)
    $('#confirm-dialog').returnValue = ''
    $('#confirm-dialog').showModal()
  } catch (error) { setError('#form-error', error.message) }
})
$('#confirm-dialog').addEventListener('close', () => {
  const payload = state.pending
  state.pending = null
  if ($('#confirm-dialog').returnValue === 'send' && payload && !state.sending) sendCommand(payload)
})
$('#read-workers').addEventListener('click', async () => {
  try {
    const result = await request('/api/workers')
    $('#workers-output').textContent = preview(result.body)
    record('read', 'workers', null, result.body, result.httpStatus)
  } catch (error) { $('#workers-output').textContent = error.message }
})
renderSummary(null)
connect()
