# Proto Tether MDK Worker usage

## Runtime configuration

Configure each device in `WorkerRuntimeV2` with a `deviceId` and a `config` object.

The bundled host in `host/index.js` exposes `startProtoWorker({ workerId, devices, storeDir, kernelTopic, ...runtimeOptions })`, returning `{ runtime, stop }`. `storeDir` is required and holds the runtime's persistent identity seeds. `stop()` is idempotent. Set `MDK_REPO` to a checkout, or supply the installed `@tetherto/mdk` monorepo. See [Host the worker](README.md#host-the-worker) for installation, environment settings, and Kernel registration. The worker runtime package is not yet published separately.

Device options:

| Option | Required | Description |
| --- | --- | --- |
| `address` | Yes | Non-empty host-only string for the Proto Rig public API v1 endpoint. Userinfo, ports, paths, queries, and fragments are rejected; configure the port separately. |
| `port` | No | HTTP port. Defaults to `80`. |
| `protocol` | No | `http` or `https`. Defaults to `http` to match the public API, which means credentials and tokens travel in cleartext. `https` requires a rig with a verifiable certificate or a custom `fetchImpl`; see [Transport security](README.md#transport-security). |
| `fetchImpl` | No | Fetch-compatible function supplied programmatically in device config. Defaults to `globalThis.fetch`. Use a custom implementation only to apply an explicit TLS trust and hostname policy. |
| `timeout` | No | Request timeout in whole milliseconds from `1` through `2147483647`. Defaults to `10000`. |
| `password` | Conditional | Device password. Use secret management. Required when `accessToken` is absent. Supports initial login and renewal after a rejected access token. |
| `accessToken` | Conditional | Existing bearer access token. Use secret management. Required when `password` is absent. Without a password or refresh token, an explicit `401` ends authentication. |
| `refreshToken` | No | Existing refresh token used for renewal. Use secret management. It does not authenticate by itself; configure `password` or `accessToken` as well. |
| `cacheMs` | No | Finite read cache window from `0` through the conservative public maximum `5000` milliseconds. Defaults to `100`. |

Supported credential combinations are password-only, access-token-only, access token with a refresh token, access token with a password fallback, or password with a refresh token. Refresh-token-only configuration is rejected at startup.

Never commit credentials, tokens, or pool passwords. Do not place them in examples, fixtures, or checked-in configuration.

`type` may appear in host or smoke-test metadata. This worker does not consume `type`. `mdk-contract.json` does not declare a `type` config field. The table above enumerates all worker-consumed options.

## Telemetry

The worker exposes these telemetry values from `mdk-contract.json`:

| Name | Unit | Type | Description |
| --- | --- | --- | --- |
| `hashrate_avg` | `TH/s` | number | Average miner hashrate reported by the current telemetry endpoint. |
| `power` | `W` | number | Current miner power consumption. |
| `temperature` | `C` | number | Current aggregate miner temperature. |
| `efficiency` | `W/TH` | number | Current miner energy efficiency. Firmware reports the equivalent J/TH value. |
| `status` | `` | string | Mining state normalized to Tether MDK status values. |
| `uptime` | `ms` | number | Elapsed time since system reboot in milliseconds. |
| `accepted_shares` | `` | number | Total accepted shares across configured pools. |
| `rejected_shares` | `` | number | Total rejected shares across configured pools. |
| `power_mode` | `` | string | Current Tether MDK power mode: normal while operating and sleep while stopped or curtailed. |
| `power_target` | `W` | number | Configured mining power target in watts. |
| `fan_speed` | `RPM` | number | Average speed of all cooling fans. |
| `snap` | `` | object | Structured miner statistics and non-secret configuration metadata. |
| `health` | `` | object | Credential-safe device health: `{ status: 'OK' }`, `{ status: 'DEGRADED' }`, or `{ status: 'OFFLINE' }`. |

`status` uses MDK status values. Mining maps to `mining`. Stopped and Curtailed map to `sleeping`. PoweringOff maps to `not_mining`. Active device errors map to `error`. Other non-mining startup states map to `not_mining`. A documented `204 No mining statistics` response is handled as the `Uninitialized` startup state; a power-target read in that state reports `ERR_MINING_STATISTICS_UNAVAILABLE`.

`power_mode` uses MDK power mode values. Stopped, Curtailed, and PoweringOff map to `sleep`. Other states map to `normal`.

`snap` includes miner statistics, non-secret network metadata, credential-free pool URLs and usernames, power mode, power target, firmware version, product name, model, and serial number. It does not include passwords or bearer tokens. A pool URL returned by firmware with userinfo is rejected with `ERR_POOLS_RESPONSE_INVALID` rather than published.

`health` is explicitly declared and implemented by this worker. It reports `DEGRADED` for active firmware errors and `OFFLINE` when the device status cannot be read, without including failure details. It never includes device options, environment values, runtime configuration, credentials, URLs, or tokens. This declaration overrides the unsafe fallback present in the minimum supported `WorkerRuntimeV2`, including during aggregate `metrics` collection.

## Commands

Commands call public API v1 write endpoints. They return serializable MDK command results through `WorkerRuntimeV2`.

| Command | Parameters | Effect |
| --- | --- | --- |
| `reboot` | none | Restarts the R2 Rig controller. Enforces a five-minute cooldown per device after every attempt, including ambiguous failures. Rejects an in-flight reboot with `ERR_COMMAND_IN_PROGRESS` and an attempt during cooldown with `ERR_COMMAND_COOLDOWN`. |
| `setPowerMode` | `mode`: `normal` or `sleep` | Starts mining for `normal` or stops mining for `sleep`. |
| `setPowerTarget` | `watts`: number from `1` through `12000` | The published R2 contract rejects values above its model-wide ceiling. The handler rounds to the exact transmitted integer, then checks finite positive safe-integer device bounds before writing. Missing, malformed, unsafe, or inverted bounds fail closed. |
| `setLED` | `enabled`: boolean | Turns the control-board locate LED on or off for physical identification. |
| `setupPools` | `pools`: one to three entries, `appendId`: optional boolean | Replaces configured mining pools. The worker appends `deviceId` to each worker name unless `appendId` is `false`. |

Each pool entry uses:

| Field | Required | Description |
| --- | --- | --- |
| `url` | Yes | Trimmed non-empty URL with a scheme and host. Released stratum-style schemes are accepted; URL userinfo is rejected. |
| `worker_name` | Yes | Trimmed non-empty worker name before optional device ID suffix. |
| `worker_password` | No | Pool password from secret management. |
| `pool` | No | Pool label. |

`appendId` must be boolean. `worker_password` and `pool`, when supplied, must be strings. All pool inputs are validated before network access. Pool passwords appear only in outbound write bodies, never command results, logs, telemetry, or snapshots.

Preserve the previous pool configuration before changing mining destinations. Verify cooling and device limits before increasing power.

The reboot cooldown is process-local and resets when a new device instance is created after host restart. Preserve operator awareness of recent hardware operations across restarts; the runtime's identity seed storage does not persist the cooldown.

## Failure semantics

The HTTP client authenticates initially with a configured access token or by logging in with the device password. A refresh token is renewal material, not a standalone initial credential. Any authenticated request, including a write, may replay once only after an explicit HTTP 401 and successful token renewal. This is the sole retry path. Login and refresh `401` or `403` responses are reported as authentication failures; server failures retain their HTTP status and do not trigger a password fallback.

The worker does not retry non-401 HTTP responses, connection errors, request timeouts, malformed JSON, malformed successful responses, or any other ambiguous outcome. A timeout or disconnect during a write has an unknown physical outcome and must not trigger an automatic retry. Read current device state before sending another write.

Before and in `finally` after each attempted write, the worker invalidates affected reads: all reads for `reboot`; mining/telemetry/errors for `setPowerMode`; target/mining/telemetry for `setPowerTarget`; and pools/mining/errors for `setupPools`. `setLED` has no exposed read key. This ensures post-failure verification reaches firmware rather than stale cache.

The worker reports stable contract-declared `ERR_*` messages and redacts credentials and response data from errors. Malformed 2xx read payloads use endpoint response-validation errors. Treat `ERR_DEVICE_CONNECTION`, `ERR_HTTP_RESPONSE`, `ERR_REQUEST_TIMEOUT`, and `ERR_RESPONSE_INVALID_JSON` during a write as ambiguous hardware outcomes.

## Mock

Run the local public API v1 mock during development:

```bash
PROTO_RIG_PASSWORD="$PROTO_RIG_PASSWORD" PORT=14032 npm run mock
```

Point a worker device at loopback and the selected port. Keep the mock password in the environment, not in source control.

Use the read-only check against the mock to exercise the read path:

```bash
PROTO_RIG_PASSWORD="$PROTO_RIG_PASSWORD" node scripts/test-live-readonly.js 127.0.0.1 14032
```
