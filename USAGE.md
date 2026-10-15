# Proto Tether MDK Worker usage

## Runtime configuration

Configure each device in `WorkerRuntimeV2` with a `deviceId` and a `config` object.

The bundled host in `host/index.js` exposes `startProtoWorker({ workerId, devices, storeDir, trustedKernelKeys, kernelTopic, ...runtimeOptions })`, returning `{ runtime, stop }`. `storeDir` is required and holds the runtime's persistent identity seeds. `trustedKernelKeys` is a required non-empty array of 64-character hex strings or 32-byte Buffers representing allowed Kernel outbound DHT transport keys. An MDK Kernel's RPC server key is a different identity; use `kernel.hrpcListener.getDht().defaultKeyPair.publicKey` after starting Kernel. Only those transport peers can reach any RPC handler, regardless of the envelope's sender name. `stop()` is idempotent. Set `MDK_REPO` to a checkout, or supply the installed `@tetherto/mdk` monorepo. See [Host the worker](README.md#host-the-worker) for installation, environment settings, and Kernel registration. The worker runtime package is not yet published separately.

Device options:

| Option | Required | Description |
| --- | --- | --- |
| `address` | Yes | Non-empty host-only string for the Proto Rig public API v1 endpoint. Userinfo, ports, paths, queries, and fragments are rejected; configure the port separately. |
| `port` | No | HTTP port. Defaults to `80`. |
| `protocol` | No | `http` or `https`. Defaults to `http` to match the public API, which means credentials and tokens travel in cleartext. `https` requires a rig with a verifiable certificate or a custom `fetchImpl`; see [Transport security](README.md#transport-security). |
| `fetchImpl` | No | Fetch-compatible function supplied programmatically in device config. Defaults to `globalThis.fetch`. Custom implementations must honor `redirect: 'error'` and the abort signal. Use a custom implementation only to apply an explicit TLS trust and hostname policy. |
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
| `errors` | `` | array | Active firmware error metadata and identifier-like codes, with raw messages omitted. |
| `pools` | `` | array | Credential-free pool configuration, runtime status, and share counters. |
| `hashboards` | `` | array | Measured per-board temperatures and available hashrate, power, efficiency, voltage, and current. |
| `device_info` | `` | object | Device identity and non-secret network configuration. |
| `firmware_info` | `` | object | OS version/build metadata and reported software component versions. |
| `psu_info` | `` | object | Power supply inventory, firmware versions, electrical readings, and temperatures. |
| `fans` | `` | array | Individual measured fan RPM with optional slot and percentage. |
| `pool_url` | `` | string | Active pool URL, falling back to the first configured pool; an empty string if none. |
| `asic_stats` | `` | object | Current chip measurements and identities, grouped by hashboard. |

Query these channels with `telemetry.pull`, addressing a device and setting `payload.query.type` to the channel name, for example `{ "query": { "type": "errors" } }`. They are also included in aggregate `metrics`. Each uses only its own source endpoints; a failed mining-statistics or power-target read does not prevent querying device or firmware information. HTTP failures remain errors, rather than being reported as empty data; `asic_stats` isolates status-read failures per board as described below. Missing optional fields are omitted in wire JSON.

| Channel | Returned fields |
| --- | --- |
| `errors` | Array of `{ name: 'firmware_error', code?, source?, slot?, timestamp? }`. `code` comes from `error_code` only when it matches `[A-Za-z][A-Za-z0-9_]{0,63}`; other string codes and raw messages are omitted. `timestamp` is the firmware's Unix-seconds timestamp. Empty array means no active errors. |
| `pools` | Array of `{ url, username?, accepted, rejected, stale?, status?, id?, priority?, name?, protocol? }`. Share counts are non-negative safe integers; `stale` is omitted when firmware does not report it. Passwords, authority keys, and undeclared siblings are omitted. URLs with userinfo are rejected. This read shape differs from `setupPools` input fields below. |
| `hashboards` | Array of `{ index, serial_number?, temperature_c: { inlet, outlet, avg }, hashrate_ths?, power_w?, efficiency_w_ths?, voltage_v?, current_a? }`. Optional metrics are returned only when firmware supplies a valid value with the declared source unit. Temperatures are measured board inlet/outlet/average values, not inferred ASIC chip temperatures. No frequencies, per-ASIC detail, or synthesized time windows are reported. |
| `device_info` | `{ device_id, product_name?, manufacturer?, model?, serial_number?, network: { mode?, ip_address?, ip_gw?, ip_netmask?, mac?, hostname? } }`. Network mode is `dhcp` or `static` when firmware reports `dhcp`. Missing or blank network strings are omitted; malformed present types and a missing `network-info` object remain errors. |
| `firmware_info` | Optional `os` object with `name`, `version`, `git_hash`, `variant`, `build_datetime_utc`, and `machine`; optional `mining_driver_sw`, `pool_interface_sw`, `web_server`, `web_dashboard`, and `hashboard_firmware` objects with `name` and `version`. Present leaves must be strings. OS runtime status and free-form update messages are omitted. |
| `psu_info` | `{ psus: [...] }`, with optional per-supply `serial_number`, `slot`, `manufacturer`, `model`, `vendor`, `hw_revision`, `firmware: { app_version?, bootloader_version? }`, `power: { input_voltage_v?, output_voltage_v?, input_current_a?, output_current_a?, input_power_w?, output_power_w? }`, and `temperatures: [{ type?, temperature_c? }]`. Electrical readings are converted from firmware milliunits to volts, amps, and watts. Missing fields stay absent; no reported supplies returns `{ psus: [] }`. Credentials, free-form messages, update status, and undeclared fields are omitted. Malformed responses report `ERR_PSUS_RESPONSE_INVALID`. |

`fans` returns `[{ rpm, slot?, percentage? }]`, with percentage from 0 through 100. `pool_url` prefers a pool whose status is `Active`, then the first configured pool, and rejects URLs containing userinfo. Both channels share their source caches with existing cooling/pool reads.

Query ASIC diagnostics with `{ "query": { "type": "asic_stats" } }`. The response is:

```json
{
  "hashboards": [{
    "serial_number": "HB001",
    "slot": 1,
    "board_type": "B4_192",
    "asic_type": "MC3",
    "expected_asic_count": 192,
    "status": "Running",
    "reported_asic_count": 1,
    "asics": [{
      "index": 7,
      "id": "A7",
      "row": 0,
      "column": 7,
      "frequency_mhz": 650,
      "temperature_c": 45.5,
      "voltage_v": 0.3085,
      "hashrate_ths": 0.3005,
      "ideal_hashrate_ths": 0.32,
      "error_rate_pct": 0.1
    }]
  }]
}
```

Only `serial_number` is always present on each board. `index` is required on each returned ASIC; IDs, coordinates and measurements are included only when reported. Chip identity is the combination of board serial and explicit ASIC index, not its position in the response array. Slot is the physical board slot. Expected count comes from inventory; reported count is the number of returned ASIC records and is omitted if the firmware omits the ASIC array. An empty array means zero records were reported, not that the worker diagnosed dead chips. No alarm thresholds or health classifications are inferred. Error rate is the firmware's reported percentage; its sampling window is unspecified. Temperatures may be negative; present null or malformed measurements are rejected rather than converted to zero.

Each ASIC collection reads `/hashboards` once, then `/hashboards/{serial}` once per board, with at most two board reads in flight. Inventory order is preserved. Concurrent pulls for the same device share the outstanding collection, but receive independent result objects. No completed ASIC response or inventory is retained, regardless of `cacheMs`; each subsequent pull reads the rig again. Mining-mode and power-target writes invalidate any outstanding shared ASIC collection for subsequent readers.

A failed board returns its inventory metadata and `error: "ERR_ASIC_STATS_UNAVAILABLE"`; a malformed board response returns `error: "ERR_ASIC_STATS_RESPONSE_INVALID"`. Failed boards have no ASIC readings or reported count, while successful boards remain available. Invalid inventory fails the channel. Free-form errors, logs, firmware-update messages and undeclared fields are omitted.

Aggregate `metrics` includes `asic_stats`, so it incurs these board reads on each collection. The existing `snap` and `hashboards` channels remain unchanged and do not fetch ASIC details. Declaring a channel does not automatically persist it: a host that needs ASIC history must explicitly collect and store these current readings. This worker does not call miner history endpoints; `hashrate_history` has been removed.

These additions provide the diagnostic channel names exposed by the [Antminer contract](https://github.com/bitmain-official/antminer-mdk-worker/blob/4fd776b4a048a1bc8284ec2eceed82b4631f960c/mdk-contract.json) and [WhatsMiner contract](https://github.com/whatsminer/whatsminer-mdk-worker/blob/a47fa82020454f9bfa9963ccaaa319b7948e8aa2/mdk-contract.json), using fields reported by [Proto public API v1](https://block.github.io/proto-fleet/proto-api-docs/). The existing `snap` response and its field validation remain unchanged. No extra performance modes or ASIC-level diagnostics are synthesized.

`status` uses MDK status values. Mining maps to `mining`. Stopped and Curtailed map to `sleeping`. PoweringOff maps to `not_mining`. Active device errors map to `error`. Other non-mining startup states map to `not_mining`. A documented `204 No mining statistics` response is handled as the `Uninitialized` startup state; a power-target read in that state reports `ERR_MINING_STATISTICS_UNAVAILABLE`.

`power_mode` uses MDK power mode values. Stopped, Curtailed, and PoweringOff map to `sleep`. Other states map to `normal`.

`snap` includes miner statistics, non-secret network metadata, credential-free pool URLs and usernames, power mode, power target, firmware version, product name, model, and serial number. It does not include passwords or bearer tokens. A pool URL returned by firmware with userinfo is rejected with `ERR_POOLS_RESPONSE_INVALID` rather than published.

`health` is explicitly declared and implemented by this worker. It reports `DEGRADED` for active firmware errors and `OFFLINE` when the device status cannot be read, without including failure details. It never includes device options, environment values, runtime configuration, credentials, URLs, or tokens. This declaration overrides the unsafe fallback present in the minimum supported `WorkerRuntimeV2`, including during aggregate `metrics` collection.

## Commands

Commands call public API v1 endpoints and return serializable MDK command results through `WorkerRuntimeV2`. `downloadLogs` is a read; the other commands change device state. Address the device and send `{ "commandId": "unique-id", "command": "setNetwork", "params": { "network": { "dhcp": true } } }` in a `command.request` payload. Named parameters are preferred; the runtime also maps positional `value`/`args` inputs using the contract's parameter order.

| Command | Parameters | Effect |
| --- | --- | --- |
| `reboot` | none | Restarts the R2 Rig controller. Enforces a five-minute cooldown per device after every attempt, including ambiguous failures. Rejects an in-flight reboot with `ERR_COMMAND_IN_PROGRESS` and an attempt during cooldown with `ERR_COMMAND_COOLDOWN`. |
| `setPowerMode` | `mode`: `normal` or `sleep` | Starts mining for `normal` or stops mining for `sleep`. |
| `setPowerTarget` | `watts`: number from `1` through `12000` | The published R2 contract rejects values above its model-wide ceiling. The handler rounds to the exact transmitted integer, then checks finite positive safe-integer device bounds before writing. Missing, malformed, unsafe, or inverted bounds fail closed. |
| `setPowerPreset` | `preset`: `min` or `max` | Sets watts to the freshly read device minimum or maximum. Uses the same bounds validation and 12000 W ceiling as `setPowerTarget`; preserves the performance policy. |
| `setPerformanceMode` | `mode`: `MaximumHashrate` or `Efficiency` | Selects Proto's performance policy while preserving watts and other target settings. |
| `setLED` | `enabled`: boolean | Turns the control-board locate LED on or off for physical identification. |
| `setupPools` | `pools`: one to three entries, `appendId`: optional boolean | Replaces configured mining pools. The worker appends `deviceId` to each worker name unless `appendId` is `false`. |
| `downloadLogs` | `source`: optional `os`, `pool_sw`, `miner_sw` (default), or `miner_web_server`; `lines`: optional integer `1`–`10000` (default `100`) | Returns `{ source, lines, content }`, counting actual returned lines. Known configured/current device credentials, bearer tokens, and recognized credential fields are redacted. Free-form logs still need review before sharing. |
| `setNetwork` | `network`: `{ dhcp, ip?, netmask?, gateway?, hostname? }` | Applies DHCP or static IPv4 settings and returns `{ success: true }` on a successful HTTP response. The rig may move to another address or disconnect. |
| `updateFirmware` | `firmware`: optional `{ filename, encoding: "base64", size, sha256, data }`; omit for OTA | OTA sends a bodyless POST; upload sends the decoded `.swu` bytes as multipart form data. Returns `{ accepted: true, completed: false, mode: "ota"\|"upload" }`. This confirms acceptance, not successful installation. |

`setPowerMode` controls whether mining runs. `setPerformanceMode` controls how mining uses its watt target: `MaximumHashrate` maximizes hashrate at that target, while `Efficiency` optimizes J/TH at or below it. `setPowerPreset` selects a watt target from the device's reported bounds; it is not a performance policy. Neither new command starts or stops mining. The current policy remains visible in `snap.config.performance_mode`.

For example, send `{"commandId":"policy-1","command":"setPerformanceMode","params":{"mode":"Efficiency"}}` to select efficiency, or `{"commandId":"power-1","command":"setPowerPreset","params":{"preset":"max"}}` to select the current maximum watt target. Both return `{success: true, target: ...}` after a successful API response. Each write updates only its own target field, preserving other settings. Invalid policies/presets fail before I/O with `ERR_PERFORMANCE_MODE_INVALID`/`ERR_POWER_PRESET_INVALID`. Presets read bounds once per command without using the telemetry cache and reject missing or unsafe bounds before writing. HTTP failures propagate, and ambiguous writes are never automatically retried. Verify cooling before increasing power or switching policy.

For `setNetwork`, `dhcp` is required and boolean. Static mode requires IPv4 `ip` and contiguous IPv4 `netmask`, with optional IPv4 `gateway`. DHCP mode rejects those three fields. An optional `hostname` must be a single DNS label of 1–63 letters, digits, or internal hyphens. Unknown fields are rejected before I/O with `ERR_NETWORK_CONFIG_INVALID`. Preserve the previous settings and verify the rig's reachability independently after changing them.

For firmware upload, `filename` must be a basename ending in `.swu`. `size` is an integer byte count from `1` through `536870912` (512 MiB), `sha256` is 64 hexadecimal characters, and `data` must be canonical base64 with matching decoded size and hash. Invalid images fail before device I/O with `ERR_FIRMWARE_PAYLOAD_INVALID`. Base64 increases message size by roughly one third; the host, Kernel, and transport may impose smaller limits. The upload HTTP timeout is 30 minutes, so callers must allow sufficient time and avoid automatic retries. Firmware credentials are renewed before sending when a password or refresh token is configured; access-token-only configurations use their existing token. Update writes never replay after a `401`, timeout, or disconnect. Concurrent updates on one device fail with `ERR_COMMAND_IN_PROGRESS`. The guard is process-local and does not deduplicate commands across restarts. Verify firmware state after any ambiguous outcome before issuing another update.

OTA acceptance requires HTTP `202`; upload acceptance requires HTTP `200`. Other successful status codes report `ERR_FIRMWARE_RESPONSE_INVALID` and require device verification before another attempt. Log parameter/response validation uses `ERR_LOGS_PARAMETERS_INVALID` and `ERR_LOGS_RESPONSE_INVALID`.

Each pool entry uses:

| Field | Required | Description |
| --- | --- | --- |
| `url` | Yes | Trimmed non-empty URL with a scheme and host. Released stratum-style schemes are accepted; URL userinfo is rejected. |
| `worker_name` | Yes | Trimmed non-empty worker name before optional device ID suffix. |
| `worker_password` | No | Pool password from secret management. |
| `pool` | No | Pool label. |

`appendId` must be boolean. `worker_password` and `pool`, when supplied, must be strings. All pool inputs are validated before network access. Pool passwords appear only in outbound write bodies, never command results, logs, telemetry, or snapshots.

Preserve the previous pool configuration before changing mining destinations. Verify cooling and device limits before increasing power.

The reboot cooldown is process-local and resets when a new device instance is created after host restart. The Kernel may automatically retry a command after a timeout or transport error, and its WAL recovery can re-queue dispatched or executing commands after a shared-process restart. An attempt that reached the rig before restart can therefore be sent again to a fresh worker within five minutes. Preserve operator awareness of recent hardware operations across restarts; the runtime's identity seed storage does not persist the cooldown or provide durable command deduplication.

## Failure semantics

The HTTP client authenticates initially with a configured access token or by logging in with the device password. A refresh token is renewal material, not a standalone initial credential. Authenticated requests other than firmware updates, including other writes, may replay once only after an explicit HTTP 401 and successful token renewal. This is the sole retry path. Firmware updates renew credentials before sending when renewal material is available and disable that replay. Login and refresh `401` or `403` responses are reported as authentication failures; server failures retain their HTTP status and do not trigger a password fallback.

The worker's HTTP client does not retry non-401 HTTP responses, connection errors, request timeouts, malformed JSON, malformed successful responses, or any other ambiguous outcome. A timeout or disconnect during a write has an unknown physical outcome. The Kernel's transport retry and WAL recovery are separate from this HTTP policy; configure orchestration to avoid replaying ambiguous physical commands across worker restarts. Read current device state before sending another write.

Before and in `finally` after each attempted write, the worker invalidates affected reads: all reads for `reboot` and `updateFirmware`; mining/telemetry/errors/ASIC reads for `setPowerMode`; target/mining/telemetry/ASIC reads for `setPowerTarget`, `setPowerPreset` and `setPerformanceMode`; pools/mining/errors for `setupPools`; and network/system for `setNetwork`. `setLED` has no exposed read key. This ensures post-failure verification reaches firmware rather than stale cache.

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
