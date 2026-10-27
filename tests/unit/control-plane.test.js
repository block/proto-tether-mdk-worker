'use strict'

const test = require('brittle')
const fs = require('node:fs')
const vm = require('node:vm')

test('development console forms preserve false and zero, omit optional blanks and parse structured parameters', async t => {
  const { parseParams } = await import('../../tools/control-plane/public/model.mjs')
  const command = {
    params: [
      { name: 'enabled', type: 'boolean', required: true },
      { name: 'count', type: 'number', min: 0, max: 10 },
      { name: 'pools', type: 'object', required: true },
      { name: 'optional', type: 'string' }
    ]
  }
  t.alike(parseParams(command, { enabled: 'false', count: '0', pools: '[{"url":"stratum+tcp://example:3333"}]', optional: '' }), {
    enabled: false, count: 0, pools: [{ url: 'stratum+tcp://example:3333' }]
  })
  for (const values of [
    { enabled: '', pools: '[]' }, { enabled: 'false', count: '11', pools: '[]' },
    { enabled: 'false', count: 'NaN', pools: '[]' }, { enabled: 'false', pools: '{' }
  ]) t.exception(() => parseParams(command, values))
  t.exception(() => parseParams({ params: [{ name: 'mode', type: 'string', enum: ['normal', 'sleep'], required: true }] }, { mode: 'high' }))
})

test('development console distinguishes HTTP success from MDK command failure and redacts previews', async t => {
  const { commandResult, preview } = await import('../../tools/control-plane/public/model.mjs')
  t.is(commandResult({ status: 'SUCCESS', result: { success: true } }, 200).ok, true)
  t.is(commandResult({ status: 'FAILED', error: 'ERR_POWER_TARGET_WRITE_UNVERIFIED' }, 200).ok, false)
  t.is(commandResult({ status: 'FAILED', error: 'ERR_POWER_TARGET_WRITE_UNVERIFIED' }, 200).uncertain, true)
  t.is(commandResult({ status: 'SUCCESS' }, 503).ok, false)
  const output = preview({ pools: [{ worker_password: 'private-value' }], firmware: { encoding: 'base64', data: 'secret-payload' } })
  t.is(output.includes('private-value'), false)
  t.is(output.includes('secret-payload'), false)
})

test('development console classifies complete ambiguous error codes and preserves readable proxy messages', async t => {
  const { commandResult } = await import('../../tools/control-plane/public/model.mjs')
  for (const code of [
    'ERR_DEVICE_CONNECTION', 'ERR_HTTP_RESPONSE', 'ERR_REQUEST_TIMEOUT', 'ERR_RESPONSE_INVALID_JSON',
    'ERR_POWER_TARGET_WRITE_UNVERIFIED', 'ERR_FIRMWARE_RESPONSE_INVALID', 'ERR_CONTROL_COMMAND_OUTCOME_UNKNOWN'
  ]) t.is(commandResult({ error: `${code}: request failed` }, 502).uncertain, true, code)
  for (const error of [
    'ERR_UNKNOWN_COMMAND: unsupported command', 'ERR_REQUEST_TIMEOUT_INVALID: invalid timeout',
    'ERR_DEVICE_CONNECTION_INVALID', 'unknown command', 'ERR_UNKNOWN_COMMAND: ERR_REQUEST_TIMEOUT is not applicable'
  ]) t.is(commandResult({ error }, 502).uncertain, false, error)
  const result = commandResult({ error: 'ERR_CONTROL_COMMAND_OUTCOME_UNKNOWN', message: 'Worker request failed; outcome unknown.' }, 502)
  t.is(result.message, 'Worker request failed; outcome unknown.')
  t.is(result.uncertain, true)
})

test('development console command lifecycle requires confirmation and consumes each payload once', async t => {
  const { commandLifecycle } = await import('../../tools/control-plane/public/model.mjs')
  const idle = { phase: 'idle', pending: null }
  const payload = { command: 'setPerformanceMode', params: { mode: 'normal' } }
  t.is(commandLifecycle(idle, { type: 'close', confirmed: true }), idle)
  const reviewing = commandLifecycle(idle, { type: 'review', payload })
  t.alike(reviewing, { phase: 'reviewing', pending: payload })
  t.is(commandLifecycle(reviewing, { type: 'review', payload }), reviewing)
  t.alike(commandLifecycle(reviewing, { type: 'close', confirmed: false }), idle, 'Cancel does not send')
  t.alike(commandLifecycle(reviewing, { type: 'cancel' }), idle, 'Escape does not send')
  const sending = commandLifecycle(reviewing, { type: 'close', confirmed: true })
  t.alike(sending, { phase: 'sending', pending: payload })
  for (const event of [{ type: 'review', payload }, { type: 'close', confirmed: true }, { type: 'cancel' }]) {
    t.is(commandLifecycle(sending, event), sending, `${event.type} cannot send again or cancel an in-flight command`)
  }
  t.alike(commandLifecycle(sending, { type: 'complete' }), idle)
  t.alike(commandLifecycle(commandLifecycle(reviewing, { type: 'cancel' }), { type: 'close', confirmed: true }), idle, 'A late close after Escape cannot send')
})

async function consoleApp (options = {}) {
  class Node {
    constructor () {
      this.children = []
      this.listeners = {}
      this.classList = { remove () {}, add () {}, toggle () {} }
    }

    append (...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node) } }
    prepend (node) { node.parent = this; this.children.unshift(node) }
    replaceChildren (...nodes) { this.children = []; this.append(...nodes) }
    get lastElementChild () { return this.children.at(-1) }
    remove () { this.parent.children.splice(this.parent.children.indexOf(this), 1) }
    addEventListener (name, listener) { (this.listeners[name] ||= []).push(listener) }
    dispatch (name, event = {}) { for (const listener of this.listeners[name] || []) listener(event) }
    showModal () { this.open = true }
  }
  const nodes = new Map()
  const node = selector => {
    if (!nodes.has(selector)) nodes.set(selector, new Node())
    return nodes.get(selector)
  }
  const storage = options.storage || new Map()
  const requests = []
  const replaced = []
  const windowEvents = new Node()
  const context = {
    model: await import('../../tools/control-plane/public/model.mjs'),
    document: { querySelector: node, querySelectorAll: () => [], createElement: () => new Node() },
    location: { hash: options.hash || '', pathname: '/', search: '' },
    history: { replaceState: (...args) => { replaced.push(args); context.location.hash = '' } },
    addEventListener: (...args) => windowEvents.addEventListener(...args),
    sessionStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    FormData: class { * [Symbol.iterator] () {} },
    fetch: (url, init) => {
      requests.push({ url, ...init })
      if (url === '/api/config' || url === '/api/capabilities') return new Promise(() => {})
      return options.fetch ? options.fetch(url, init) : Promise.resolve({ status: 200, text: async () => '{}' })
    }
  }
  const source = fs.readFileSync(require.resolve('../../tools/control-plane/public/app.js'), 'utf8')
    .replace(/^import (.+) from '.\/model.mjs'$/m, 'const $1 = model')
  vm.runInNewContext(`${source}\nglobalThis.app = { state, record, readChannel, request }`, context)
  return { ...context.app, node, requests, storage, replaced, location: context.location, dispatch: (...args) => windowEvents.dispatch(...args) }
}

test('development console attaches its per-tab token to every request and scrubs the launch fragment', async t => {
  const app = await consoleApp({ hash: '#launch-token' })
  t.is(app.storage.get('control-token'), 'launch-token')
  t.alike(app.replaced[0].slice(1), ['', '/'])
  await app.request('/api/command', { method: 'POST', headers: { 'content-type': 'application/json' } })
  t.is(app.requests.length, 3)
  for (const request of app.requests) t.is(request.headers['x-control-token'], 'launch-token', request.url)
  t.is(app.requests[2].headers['content-type'], 'application/json')
  const refreshed = await consoleApp({ storage: app.storage })
  for (const request of refreshed.requests) t.is(request.headers['x-control-token'], 'launch-token', 'Refresh retains the per-tab token')
  t.is(refreshed.replaced.length, 0)
})

test('development console consumes a new launch token during same-document navigation without sending commands', async t => {
  const app = await consoleApp({ hash: '#old-launch-token' })
  const sending = { phase: 'sending', pending: { command: 'setPerformanceMode', params: {} } }
  app.state.commandFlow = sending
  app.location.hash = '#new-launch-token'
  app.dispatch('hashchange')
  t.is(app.storage.get('control-token'), 'new-launch-token')
  t.is(app.location.hash, '')
  t.is(app.replaced.length, 2)
  t.is(app.requests.length, 4, 'Token navigation reconnects')
  await app.request('/api/identity')
  for (const request of app.requests.slice(2)) t.is(request.headers['x-control-token'], 'new-launch-token', request.url)
  t.is(app.requests.filter(request => request.url === '/api/command').length, 0)
  t.is(app.state.commandFlow, sending, 'Token navigation preserves the in-flight command lifecycle')
  app.dispatch('hashchange')
  t.is(app.requests.length, 5, 'An empty fragment does not reconnect')
})

test('development console preserves expanded Activity and unrelated telemetry DOM while recording reads', async t => {
  const app = await consoleApp()
  app.record('read', 'first', null, {}, 200)
  const first = app.node('#activity-list').children[0]
  first.open = true
  app.record('read', 'second', null, {}, 200)
  t.is(app.node('#activity-list').children[1], first)
  t.is(first.open, true)
  for (let i = 0; i < 29; i++) app.record('read', String(i), null, {}, 200)
  t.is(app.node('#activity-list').children.length, 30)
  t.is(app.node('#activity-list').children.includes(first), false, 'Only entries beyond the limit are removed')
  app.state.channel = { name: 'asic_stats' }
  const expanded = app.node('#telemetry-output')
  expanded.append({ open: true })
  const child = expanded.children[0]
  const reading = app.readChannel({ name: 'snap' })
  t.is(expanded.children[0], child, 'Starting a background read preserves selected telemetry')
  await reading
  t.is(expanded.children[0], child, 'Completing a background read preserves selected telemetry')
  t.is(child.open, true)
})

test('development console handlers cancel safely and send one request despite duplicate events', async t => {
  let respond
  const app = await consoleApp({ fetch: () => new Promise(resolve => { respond = resolve }) })
  app.state.command = { name: 'setPerformanceMode', params: [] }
  app.state.config = { deviceId: 'rig', endpoint: 'worker' }
  app.state.contract = { capabilities: { telemetry: [] } }
  const submit = () => app.node('#command-form').dispatch('submit', { preventDefault () {}, target: {} })
  const close = value => {
    app.node('#confirm-dialog').returnValue = value
    app.node('#confirm-dialog').dispatch('close')
  }
  const writes = () => app.requests.filter(request => request.url === '/api/command')
  submit()
  close('cancel')
  t.is(writes().length, 0, 'Cancel does not send')
  submit()
  app.node('#confirm-dialog').dispatch('cancel')
  close('send')
  t.is(writes().length, 0, 'Escape prevents even a stale confirmed close from sending')
  submit()
  close('send')
  t.is(writes().length, 1)
  t.is(app.state.commandFlow.phase, 'sending')
  submit()
  close('send')
  app.node('#confirm-dialog').dispatch('cancel')
  t.is(writes().length, 1, 'Duplicate submit, close and cancel cannot send again')
  t.is(app.state.commandFlow.phase, 'sending')
  respond({ status: 200, text: async () => JSON.stringify({ status: 'SUCCESS' }) })
  await new Promise(resolve => setImmediate(resolve))
  t.is(app.state.commandFlow.phase, 'idle')
  t.is(app.node('#review-command').disabled, false)
})
