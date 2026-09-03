'use strict'

const { createServer } = require('../mock/server')

const port = Number(process.env.PORT) || 14032
const password = process.env.PROTO_RIG_PASSWORD || 'test-password'
const mock = createServer({ host: '127.0.0.1', port, password })

mock.ready.then(address => {
  console.log(`Proto Rig API v1 mock listening at http://${address.address}:${address.port}`)
})

async function stop () {
  await mock.close()
  process.exit(0)
}
process.once('SIGINT', stop)
process.once('SIGTERM', stop)
