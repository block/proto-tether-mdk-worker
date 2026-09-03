'use strict'

const { id, opts, logger } = require('@tetherto/mdk-worker/device')
const { ProtoHttpClient } = require('../lib/http-client')
const { ApiV1 } = require('../lib/api-v1')
const { ProtoRigClient } = require('../lib/proto-rig-client')

let clientPromise

async function createClient () {
  const http = new ProtoHttpClient(opts)
  const client = new ProtoRigClient({ id, api: new ApiV1(http), cacheMs: opts.cacheMs })
  logger('device %s configured', id)
  return client
}

function getClient () {
  if (!clientPromise) {
    clientPromise = createClient().catch(err => {
      clientPromise = null
      throw err
    })
  }
  return clientPromise
}

module.exports = { getClient }
