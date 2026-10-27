# Proto Tether MDK Worker

## Overview

Proto Tether MDK Worker hosts Proto R2 Rig miners in Tether MDK through `WorkerRuntimeV2`. It maps the released public Proto Rig MDK HTTP API v1 to MDK telemetry and commands.

The worker authenticates with JWT bearer tokens. It reads telemetry, reports normalized MDK values, and sends operator commands that can affect physical hardware.

## Requirements

- Node.js 24 or newer.
- npm 11 for the MDK workspace installation.
- Tether MDK with `WorkerRuntimeV2`.
- Network access from the host to each Proto R2 Rig public API v1 endpoint.
- A device password or token from secret management.
- A host-supplied MDK checkout or installed `@tetherto/mdk` monorepo. The standalone `@tetherto/mdk-worker` package is not yet published; this worker does not bundle the runtime.

Do not commit credentials, access tokens, refresh tokens, or pool passwords. Device addresses are host-only values, not URLs, and cannot contain userinfo, a port, path, query, or fragment.

## Host the worker

Install the worker and a pinned MDK checkout from the repository directory:

```bash
npm ci --ignore-scripts
git clone --branch v0.10.0 --depth 1 https://github.com/tetherto/mdk ../mdk
npm run setup:mdk -- ../mdk
```

The setup script supports both the minimum MDK revision's per-package installer and the root workspace introduced in MDK v0.9. For the workspace layout it installs the worker, Kernel, and client packages and their dependencies for hosting and integration tests.

Start the bundled single-device host. Supply the address, password, and trusted Kernel transport keys through your environment or secret management:

```bash
MDK_REPO=../mdk npm run host
```

The host requires `PROTO_RIG_ADDRESS`, `PROTO_RIG_PASSWORD`, and `PROTO_TRUSTED_KERNEL_KEYS`. The last setting is a comma-separated list of 64-character hex public keys. The host rejects missing or malformed keys before opening runtime resources and rejects RPC connections from every other peer. When `PROTO_KERNEL_TOPIC` is set, the discovery swarm shares the worker's RPC public key with any peer on that topic; discovery does not grant RPC access. Authenticate the keys through your deployment configuration.

Use the Kernel's **outbound DHT transport key**, which differs from the RPC server key returned by `kernel.getPublicKey()`. With the supported MDK Kernel started, obtain it programmatically:

```js
const transportKey = kernel.hrpcListener.getDht().defaultKeyPair.publicKey.toString('hex')
```

Set `PROTO_TRUSTED_KERNEL_KEYS` to that value on the worker host. Keep the Kernel's identity storage persistent, and update the allowlist and restart the worker when rotating the Kernel's transport identity. Optional environment settings:

| Setting | Default | Purpose |
| --- | --- | --- |
| `PROTO_RIG_PORT` | `80` | Rig API port. |
| `PROTO_RIG_PROTOCOL` | `http` | `http` or `https`; see [Transport security](#transport-security). |
| `PROTO_WORKER_ID` | `proto-worker` | Worker identity reported to Kernel. |
| `PROTO_DEVICE_ID` | `proto-r2-1` | Device identity used for command and telemetry routing. |
| `PROTO_STORE_DIR` | `store/proto-worker` in this repository | Persistent DHT/RPC seed directory. Use a separate directory per worker host. |
| `PROTO_KERNEL_TOPIC` | unset | Hex discovery topic matching your Kernel, when using DHT discovery. |
| `PROTO_DHT_BOOTSTRAP` | public HyperDHT bootstrap | Comma-separated `host:port` bootstrap endpoints for a private DHT or local test network. |

The host exclusively locks its seed directory with `.proto-worker.lock` before opening devices or runtime transports. A second host using that directory fails with `ERR_WORKER_STORE_LOCKED`. Clean shutdown releases the lock. After a crash, confirm that no host still uses the directory before removing the leftover lock file and restarting; the host does not automatically steal stale locks.

The host prints its worker ID and RPC public key, and stops the runtime on `SIGINT` or `SIGTERM`. Startup confirms the host is listening; it does not authenticate with the rig or establish that the rig is healthy. Use the read-only hardware check below to verify the device. No hardware commands run at startup.

For multiple devices or a host that shares a process with Kernel, use `host/index.js`:

```js
'use strict'

const path = require('node:path')
const { startProtoWorker } = require('./host')

async function main () {
  const address = process.env.PROTO_RIG_ADDRESS
  const password = process.env.PROTO_RIG_PASSWORD

  if (!address) throw new Error('ERR_ADDRESS_REQUIRED')
  if (!password) throw new Error('ERR_PASSWORD_REQUIRED')
  const trustedKernelKeys = process.env.PROTO_TRUSTED_KERNEL_KEYS?.split(',').map(key => key.trim())

  const worker = await startProtoWorker({
    workerId: 'proto-worker',
    trustedKernelKeys,
    storeDir: path.resolve(__dirname, 'store/proto-worker'),
    kernelTopic: process.env.PROTO_KERNEL_TOPIC || null,
    devices: [
      {
        deviceId: 'proto-r2-1',
        config: {
          address,
          port: process.env.PROTO_RIG_PORT === undefined ? 80 : Number(process.env.PROTO_RIG_PORT),
          password
        }
      }
    ]
  })

  const stop = () => worker.stop().catch(() => {
    console.error('ERR_WORKER_SHUTDOWN_FAILED')
    process.exitCode = 1
  })
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)

  // If Kernel lives in this process, register directly:
  // await kernel.registerWorker(worker.runtime.getPublicKey())
}

main().catch(err => {
  console.error(err.message)
  process.exitCode = 1
})
```

Run this example with `MDK_REPO` pointing to the checkout. Alternatively, install the monorepo as `@tetherto/mdk`; the host resolves `@tetherto/mdk/backend/core/mdk-worker` when `MDK_REPO` is unset. Follow MDK's [Test a Worker guide](https://docs.mdk.tether.io/guides/workers/test-a-worker) for that installation and Kernel bootstrap.

Register the runtime's public key with an existing Kernel using `await kernel.registerWorker(worker.runtime.getPublicKey())`, or configure the same discovery topic on both processes. Registration and discovery do not authorize inbound peers; the worker's `trustedKernelKeys` must include that Kernel's outbound transport identity. For a shared process, pass `[kernel.hrpcListener.getDht().defaultKeyPair.publicKey]` after starting Kernel. The option accepts an array of 64-character hex strings or 32-byte Buffers. Keep `storeDir` on persistent storage to preserve the worker public key across restarts. A new seed directory creates a new identity. The host helper always loads this repository's contract directory and requires a non-empty `storeDir`.

Use this bundled host for network access to rigs. It maps trusted keys into native MDK admission on newer releases and installs a peer firewall before listening on older releases. On those older releases, including the minimum revision and pinned v0.10.0, instantiating upstream `WorkerRuntimeV2` directly does not enforce an allowlist. The adapter retains the inherited dispatch and device lifecycle, and CI verifies it against the supported runtime matrix.

## Optional development console

The optional bundled development console connects directly to the authorized
worker over MDK RPC. It exercises every published telemetry channel and command
without a Kernel, Gateway, or site app, and proves that direct authorized worker
RPC works. The actual MDK site UI uses the Kernel, Gateway, and app integration;
this console does not verify that chain. MDK's `full-site` example is
[deprecated](https://github.com/tetherto/mdk/pull/58#issuecomment-6361638817);
its site API is no longer a dependency. Follow the [development console guide](tools/control-plane/README.md)
to create a client identity, authorize it in the worker host, and open the console
with `npm run console`. Open the tokenized URL printed at startup (the default
port is `3041`). Commands require a request preview and explicit confirmation. `npm run control` remains an alias.

## Test

The contract and integration tests load MDK core from a checkout of
[`tetherto/mdk`](https://github.com/tetherto/mdk), so that repository must be
present and its core dependencies installed before `npm test` will pass. Clone
it alongside this one:

```bash
git clone https://github.com/tetherto/mdk ../mdk
npm run setup:mdk -- ../mdk
```

Then run all checks — lint, unit tests, and integration tests — pointing
`MDK_REPO` at that checkout:

```bash
MDK_REPO=../mdk npm test
```

`MDK_REPO` defaults to `/tmp/mdk-latest` when unset. Individual suites are
available as `npm run lint`, `npm run test:unit`, and `npm run test:integration`.
Run `MDK_REPO=../mdk npm run test:kernel` for the separate mock-only Kernel-chain
check. It verifies worker registration reaches `READY`, SDK telemetry and
capabilities, validation before worker dispatch, and command results moving from
queued to terminal state. On older MDK revisions, terminal results are observed
through the in-process Kernel `command:done` event; modern revisions query the
SDK's `getCommandStatus`. This check uses a mock rig and does not exercise the
browser site UI or hardware.

CI tests the minimum supported MDK commit `633ee07905a6af1d9e0c44b770df09eb0ac432b4`, pinned v0.10.0 (`7f5cae88f67cd0ebedaa325778f9209135de1b8f`), and upstream `main`. It runs on pull requests, pushes to `main`, manual dispatch, and weekly on Mondays at 06:00 UTC. The integration suite exercises real HRPC over a local DHT test network, persistent identity across restart, and host shutdown, in addition to in-process dispatch and mock HTTP behavior.

Run the local mock for development:

```bash
PROTO_RIG_PASSWORD="$PROTO_RIG_PASSWORD" npm run mock
```

The mock binds to loopback and implements the public API v1 behavior used by this worker.

The contract declares 22 telemetry channels. Separate `errors`, `pools`, `pool_url`, `hashboards`, `fans`, `device_info`, `firmware_info`, `psu_info`, and `asic_stats` queries expose diagnostics and inventory without collecting a full snapshot. ASIC diagnostics read current inventory and chip statistics with at most two board requests in parallel. Overlapping ASIC pulls share work; completed readings are never cached. Other channels retain their existing source caches and write invalidation. The existing `snap` shape is unchanged. The worker does not retrieve miner history; historical storage belongs to the MDK host. See [Telemetry](USAGE.md#telemetry) for field shapes and units.

Ten commands expose mining controls and maintenance, including device-reported min/max watt presets, native MaximumHashrate/Efficiency policy selection, redacted log tails, DHCP/static IPv4 configuration, and OTA or `.swu` firmware updates. Firmware results confirm acceptance only; verify installation separately. See [Commands](USAGE.md#commands) for parameters and failure semantics.

The worker-owned `health` channel returns only `{ status }`: `OK` when device status is normal, including the API's `204 No mining statistics` startup state; `DEGRADED` for active firmware errors; or `OFFLINE` when the status read fails. Declaring this handler prevents the minimum supported runtime from installing a credential-bearing fallback. The health channel never publishes device options, environment, runtime configuration, credentials, tokens, or transport-failure details, including inside aggregate metrics.

## Read-only hardware check

Use the live read-only script to verify authentication and telemetry without sending write commands:

```bash
PROTO_RIG_PASSWORD="$PROTO_RIG_PASSWORD" node scripts/test-live-readonly.js "$PROTO_RIG_ADDRESS" "${PROTO_RIG_PORT:-80}"
```

The script prints JSON with `deviceId`, `status`, `hashrateThs`, `powerW`, `temperatureC`, and `powerTargetW`. It exits with `ERR_ADDRESS_REQUIRED` when no address is passed. It exits with `ERR_PASSWORD_REQUIRED` when `PROTO_RIG_PASSWORD` is unset.

## Safety

Treat command calls as physical operations. Verify thermal state, power limits, and pool configuration before issuing commands.

Reboot attempts have an enforced five-minute per-device cooldown. Failed attempts, including timeouts with unknown outcomes, consume the cooldown, and concurrent reboots are rejected. This guard lives in the device instance and resets when the host restarts; it is not a durable record of hardware operations.

HTTP redirects are rejected for reads, authentication, and writes. They surface as `ERR_DEVICE_CONNECTION`; a redirect cannot resend a physical operation or convert it into a successful read. Custom `fetchImpl` implementations must honor the supplied `redirect: 'error'` policy.

Any authenticated request, including a write, may replay once only after an explicit HTTP 401 and successful credential renewal. A timeout, disconnect, malformed response, or other ambiguous write outcome is never retried. Affected read caches are invalidated before and after an attempted write; read the device state before deciding the next operator action.

Do not store credentials or pool passwords in source control. Load them from secret management at runtime.

### Transport security

`protocol` defaults to `http`, so the device password and the JWTs derived from it cross the network in cleartext. Anyone who can observe the path between the host and the rig can read them. Treat the management network as the trust boundary and keep rigs off shared or routed segments.

Most Proto rigs also serve the API over HTTPS, but they commonly present self-signed or otherwise unverifiable certificates. This worker calls `globalThis.fetch`, which verifies certificates by default, so setting `protocol: 'https'` against such a rig fails the TLS handshake and surfaces as `ERR_DEVICE_CONNECTION`. There is no CA or certificate-verification option yet; reaching those rigs today means supplying your own `fetchImpl` carrying an explicit TLS policy.

Such a policy needs more than a trust anchor. Observed R2 certificates carry no Subject Alternative Name, and their Common Name is the device serial rather than a hostname, so hostname verification cannot succeed against an IP address even when the certificate itself is trusted. A working `fetchImpl` has to override `checkServerIdentity` — for example by pinning the certificate fingerprint, which is stable given these certificates are issued at manufacture with multi-year lifetimes.

Note that unverified TLS buys encryption without authentication. It stops passive interception but not an active machine-in-the-middle on the same LAN, so it is not a substitute for network isolation.

## License

This project is licensed under the Apache License, Version 2.0. See `LICENSE` and `NOTICE`.
