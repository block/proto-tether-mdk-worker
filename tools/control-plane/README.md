# Local Proto control plane

A browser console for exercising the worker through a running MDK gateway. The
channel list and command forms come from the published worker contract, so new
capabilities appear after reconnecting. No frontend build or extra dependencies
are needed; use Node.js 24 or later.

Start your MDK stack, then run this from the worker repository:

```sh
npm run control
```

Open <http://127.0.0.1:3041>. Defaults target `proto-rig-1` through the local gateway
at `http://127.0.0.1:3007`. Override them when needed:

```sh
MDK_DEVICE_ID=my-device MDK_GATEWAY_URL=http://127.0.0.1:3007 CONTROL_PORT=3041 npm run control
```

The server binds to `127.0.0.1` and accepts only loopback gateway URLs. Rig
credentials stay in your worker host; they are never entered in this console.

## Use it

- **Telemetry:** choose any published channel and click **Read telemetry**. Nested
  arrays and objects expand into tables. **Raw response** shows the full MDK envelope.
  A snapshot is read on connection and after commands to refresh the summary.
- **Commands:** choose a command, supply its declared parameters, review the exact
  command and device, then click **Send command**. Optional blank fields are omitted;
  boolean `false` is preserved. Object parameters accept JSON objects or arrays.
- **Activity:** inspect the latest 30 requests and responses. Parameters containing
  credentials and firmware base64 are redacted. Activity is kept only in tab memory.
- **Contract:** inspect live capabilities, constraints and errors, or read worker status.

Commands operate on the connected rig. HTTP success is displayed separately from
the MDK command result: a `FAILED` MDK result remains a failure even with HTTP 200.
No command is retried automatically. After a timeout, lost connection or unverified
write, inspect device telemetry before deciding whether to issue another command.

For `updateFirmware`, leave the optional firmware parameter blank to request OTA,
or select a `.swu` file to prepare its base64 payload and SHA-256. The local proxy
accepts JSON up to 16 MiB; the gateway and MDK transport can impose smaller limits.
Larger uploads require a transport configured for their size. An accepted firmware
command does not confirm installation or reboot completion.

Stop this console with Ctrl+C. It runs independently of the MDK stack.
