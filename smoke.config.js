'use strict'

const { createServer } = require('./mock/server')

module.exports = {
  async setup () {
    const mock = createServer({ password: 'test-password' })
    const address = await mock.ready
    return {
      config: { address: '127.0.0.1', port: address.port, password: 'test-password', type: 'miner-proto-r2' },
      commands: {
        setLED: { enabled: true },
        setPowerMode: { mode: 'normal' },
        setPowerTarget: { watts: 2800 },
        setupPools: { pools: [{ url: 'stratum+tcp://pool.example:3333', worker_name: 'worker', worker_password: 'x' }] },
        reboot: {},
        downloadLogs: { source: 'miner_sw', lines: 10 },
        setNetwork: { network: { dhcp: true, hostname: 'smoke-rig' } },
        updateFirmware: {}
      },
      teardown: () => mock.close()
    }
  }
}
