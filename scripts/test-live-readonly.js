#!/usr/bin/env node
'use strict'

const { ProtoHttpClient } = require('../lib/http-client')
const { ApiV1 } = require('../lib/api-v1')
const { ProtoRigClient } = require('../lib/proto-rig-client')

async function main () {
  const address = process.argv[2]
  const port = process.argv[3] === undefined ? undefined : Number(process.argv[3])
  const password = process.env.PROTO_RIG_PASSWORD

  if (!address) throw new Error('ERR_ADDRESS_REQUIRED')
  if (!password) throw new Error('ERR_PASSWORD_REQUIRED')

  const deviceId = 'proto-live-readonly'
  const http = new ProtoHttpClient({ address, port, password })
  const api = new ApiV1(http)
  const client = new ProtoRigClient({ id: deviceId, api })

  const result = {
    deviceId,
    status: await client.getStatus(),
    hashrateThs: await client.getHashrateAvg(),
    powerW: await client.getPower(),
    temperatureC: await client.getTemperature(),
    powerTargetW: await client.getPowerTarget()
  }

  console.log(JSON.stringify(result, null, 2))
}

main().catch(err => {
  console.error(err && err.message ? err.message : 'ERR_LIVE_READONLY')
  process.exitCode = 1
})
