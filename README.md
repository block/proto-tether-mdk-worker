# Proto Tether MDK Worker

## Overview

Proto Tether MDK Worker hosts Proto R2 Rig miners in Tether MDK through `WorkerRuntimeV2`. It maps the released public Proto Rig MDK HTTP API v1 to MDK telemetry and commands.

The worker authenticates with JWT bearer tokens. It reads telemetry, reports normalized MDK values, and sends operator commands that can affect physical hardware.

## Requirements

- Node.js 24 or newer.
- Tether MDK with `WorkerRuntimeV2`.
- Network access from the host to each Proto R2 Rig public API v1 endpoint.
- A device password or token from secret management.

Do not commit credentials, access tokens, refresh tokens, or pool passwords.

## Host the worker

Install dependencies from the repository directory:

```bash
npm install
```

Host one device with `WorkerRuntimeV2`. Read the password from the environment. Set the address through deployment configuration or the environment.

```js
'use strict'

const path = require('node:path')
const WorkerRuntimeV2 = require('@tetherto/mdk-worker/worker-runtime-v2')

const repositoryDirectory = path.resolve(__dirname)
const address = process.env.PROTO_RIG_ADDRESS
const password = process.env.PROTO_RIG_PASSWORD

if (!address) throw new Error('ERR_ADDRESS_REQUIRED')
if (!password) throw new Error('ERR_PASSWORD_REQUIRED')

const runtime = new WorkerRuntimeV2(repositoryDirectory, {
  workerId: 'proto-worker',
  devices: [
    {
      deviceId: 'proto-r2-1',
      config: {
        address,
        port: Number(process.env.PROTO_RIG_PORT) || 80,
        password
      }
    }
  ]
})

runtime.start()
```

Keep `repositoryDirectory` pointed at this repository. The runtime loads `mdk-contract.json` and the handler files from that directory.

## Test

Run all checks:

```bash
npm test
```

Run the local mock for development:

```bash
PROTO_RIG_PASSWORD="$PROTO_RIG_PASSWORD" npm run mock
```

The mock binds to loopback and implements the public API v1 behavior used by this worker.

## Read-only hardware check

Use the live read-only script to verify authentication and telemetry without sending write commands:

```bash
PROTO_RIG_PASSWORD="$PROTO_RIG_PASSWORD" node scripts/test-live-readonly.js "$PROTO_RIG_ADDRESS" "${PROTO_RIG_PORT:-80}"
```

The script prints JSON with `deviceId`, `status`, `hashrateThs`, `powerW`, `temperatureC`, and `powerTargetW`. It exits with `ERR_ADDRESS_REQUIRED` when no address is passed. It exits with `ERR_PASSWORD_REQUIRED` when `PROTO_RIG_PASSWORD` is unset.

## Safety

Treat command calls as physical operations. Verify thermal state, power limits, and pool configuration before issuing commands.

A timeout or disconnect during a write has an unknown physical outcome. Do not retry the write automatically. Read the device state first, then decide the next operator action.

Do not store credentials or pool passwords in source control. Load them from secret management at runtime.

## License

This project is licensed under the Apache License, Version 2.0. See `LICENSE` and `NOTICE`.
