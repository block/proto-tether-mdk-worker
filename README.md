# Proto Tether MDK Worker

## Overview

Proto Tether MDK Worker hosts Proto R2 Rig miners in Tether MDK through `WorkerRuntimeV2`. It maps the released public Proto Rig MDK HTTP API v1 to MDK telemetry and commands.

The worker authenticates with JWT bearer tokens. It reads telemetry, reports normalized MDK values, and sends operator commands that can affect physical hardware.

## Requirements

- Node.js 24 or newer.
- Tether MDK with `WorkerRuntimeV2`.
- Network access from the host to each Proto R2 Rig public API v1 endpoint.
- A device password or token from secret management.
- The host application must supply `@tetherto/mdk-worker`; this worker intentionally does not bundle the runtime.

Do not commit credentials, access tokens, refresh tokens, or pool passwords. Device addresses are host-only values, not URLs, and cannot contain userinfo, a port, path, query, or fragment.

## Host the worker

Install dependencies from the repository directory:

```bash
npm install
```

Host one device with `WorkerRuntimeV2`. Read the password from the environment. Set the address through deployment configuration or the environment.

```js
'use strict'

const path = require('node:path')
const { WorkerRuntimeV2 } = require('@tetherto/mdk-worker')

async function main () {
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

  await runtime.start()
}

main().catch(err => {
  console.error(err.message)
  process.exitCode = 1
})
```

Keep `repositoryDirectory` pointed at this repository. The host-supplied runtime loads `mdk-contract.json` and the handler files from that directory.

## Test

The contract and integration tests load MDK core from a checkout of
[`tetherto/mdk`](https://github.com/tetherto/mdk), so that repository must be
present and its core dependencies installed before `npm test` will pass. Clone
it alongside this one:

```bash
git clone https://github.com/tetherto/mdk ../mdk
(cd ../mdk/backend/core && ./install-packages.sh)
```

Then run all checks — lint, unit tests, and integration tests — pointing
`MDK_REPO` at that checkout:

```bash
MDK_REPO=../mdk npm test
```

`MDK_REPO` defaults to `/tmp/mdk-latest` when unset. Individual suites are
available as `npm run lint`, `npm run test:unit`, and `npm run test:integration`.
CI runs the same commands against both the minimum supported MDK commit and
upstream `main`.

Run the local mock for development:

```bash
PROTO_RIG_PASSWORD="$PROTO_RIG_PASSWORD" npm run mock
```

The mock binds to loopback and implements the public API v1 behavior used by this worker.

The contract declares 13 telemetry channels. Its worker-owned `health` channel returns only `{ status }`: `OK` when device status is normal, `DEGRADED` for active firmware errors, or `OFFLINE` when the status read fails. Declaring this handler prevents the minimum supported runtime from installing a credential-bearing fallback. Direct health and aggregate metrics responses never publish device options, environment, runtime configuration, credentials, tokens, or failure details.

## Read-only hardware check

Use the live read-only script to verify authentication and telemetry without sending write commands:

```bash
PROTO_RIG_PASSWORD="$PROTO_RIG_PASSWORD" node scripts/test-live-readonly.js "$PROTO_RIG_ADDRESS" "${PROTO_RIG_PORT:-80}"
```

The script prints JSON with `deviceId`, `status`, `hashrateThs`, `powerW`, `temperatureC`, and `powerTargetW`. It exits with `ERR_ADDRESS_REQUIRED` when no address is passed. It exits with `ERR_PASSWORD_REQUIRED` when `PROTO_RIG_PASSWORD` is unset.

## Safety

Treat command calls as physical operations. Verify thermal state, power limits, and pool configuration before issuing commands.

Any authenticated request, including a write, may replay once only after an explicit HTTP 401 and successful credential renewal. A timeout, disconnect, malformed response, or other ambiguous write outcome is never retried. Affected read caches are invalidated before and after an attempted write; read the device state before deciding the next operator action.

Do not store credentials or pool passwords in source control. Load them from secret management at runtime.

### Transport security

`protocol` defaults to `http`, so the device password and the JWTs derived from it cross the network in cleartext. Anyone who can observe the path between the host and the rig can read them. Treat the management network as the trust boundary and keep rigs off shared or routed segments.

Most Proto rigs also serve the API over HTTPS, but they commonly present self-signed or otherwise unverifiable certificates. This worker calls `globalThis.fetch`, which verifies certificates by default, so setting `protocol: 'https'` against such a rig fails the TLS handshake and surfaces as `ERR_DEVICE_CONNECTION`. There is no CA or certificate-verification option yet; reaching those rigs today means supplying your own `fetchImpl` carrying an explicit TLS policy.

Such a policy needs more than a trust anchor. Observed R2 certificates carry no Subject Alternative Name, and their Common Name is the device serial rather than a hostname, so hostname verification cannot succeed against an IP address even when the certificate itself is trusted. A working `fetchImpl` has to override `checkServerIdentity` — for example by pinning the certificate fingerprint, which is stable given these certificates are issued at manufacture with multi-year lifetimes.

Note that unverified TLS buys encryption without authentication. It stops passive interception but not an active machine-in-the-middle on the same LAN, so it is not a substitute for network isolation.

## License

This project is licensed under the Apache License, Version 2.0. See `LICENSE` and `NOTICE`.
