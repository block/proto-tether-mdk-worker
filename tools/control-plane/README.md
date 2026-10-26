# Optional Proto development console

A development console for exercising the worker directly over authorized MDK RPC.
The channel list and command forms come from the published worker contract. No
frontend build, Kernel, Gateway, or site app is needed; use Node.js 24 or later
and install MDK as described in the repository README.

This console is optional. It proves direct authorized worker RPC; the actual MDK
site UI uses the Kernel, Gateway, and app integration. Run
`MDK_REPO=../mdk npm run test:kernel` separately to check worker registration reaches
`READY`, SDK telemetry and capabilities, validation before worker dispatch, and
queued-to-terminal command results against a mock rig. Older MDK revisions expose
terminal results through the in-process Kernel `command:done` event; modern
revisions query the SDK's `getCommandStatus`. That check does not exercise the
browser site UI or hardware.

MDK's `full-site` example is [deprecated](https://github.com/tetherto/mdk/pull/58#issuecomment-6361638817).
The current [MVP site](https://github.com/tetherto/mdk/tree/main/examples/mvp-site)
is a separate demo; its site API does not provide this console's generic worker operations.

## Connect

Create a dedicated persistent client identity once from the worker repository.
The ignored `store/` directory keeps its private seed out of version control:

```sh
mkdir -p store/control-plane
(umask 077; openssl rand -out store/control-plane/client.seed 32)
export MDK_REPO=../mdk
export MDK_CLIENT_SEED_FILE="$PWD/store/control-plane/client.seed"
node tools/control-plane/server.js --client-key
```

Keep this seed private and reuse it across console restarts. Re-running the
`openssl` command replaces the identity and requires updating the worker's trust
configuration. The last command prints only the public client transport key.

In the terminal running the worker, include that public key in
`PROTO_TRUSTED_KERNEL_KEYS` (alongside any trusted Kernel keys), supply the rig
address and password through your environment, and start the host:

```sh
export PROTO_TRUSTED_KERNEL_KEYS='<console public client key>'
MDK_REPO=../mdk npm run host
```

Copy `publicKey` from the host's startup JSON. Back in the console terminal:

```sh
export MDK_WORKER_KEY='<worker publicKey>'
npm run console
```

Open <http://127.0.0.1:3041>. Defaults match the bundled host:
`PROTO_WORKER_ID=proto-worker` and `PROTO_DEVICE_ID=proto-r2-1`. Set the same IDs
in both terminals when overriding them. `CONTROL_PORT` changes the console's HTTP
port. The server binds to `127.0.0.1`; rig credentials stay in the worker host.
`npm run control` remains an alias for `npm run console`. Existing identity paths
under `store/control-plane/` remain valid.

## Use it

- **Telemetry:** choose any published channel and click **Read telemetry**. Nested
  arrays and objects expand into tables. **Raw response** shows the full MDK envelope.
  A snapshot is read on connection and after commands to refresh the summary.
- **Commands:** choose a command, supply its declared parameters, review the exact
  command and device, then click **Send command**. Optional blank fields are omitted;
  boolean `false` is preserved. Object parameters accept JSON objects or arrays.
- **Activity:** inspect the latest 30 requests and responses. Parameters containing
  credentials and firmware base64 are redacted. Activity is kept only in tab memory.
- **Contract:** inspect live capabilities, constraints and errors, or read worker identity.

Commands operate on the connected rig. HTTP success is displayed separately from
the MDK command result: a `FAILED` MDK result remains a failure even with HTTP 200.
No command is retried automatically. After a timeout, lost connection or unverified
write, inspect device telemetry before deciding whether to issue another command.

For `updateFirmware`, leave the optional firmware parameter blank to request OTA,
or select a `.swu` file to prepare its base64 payload and SHA-256. The local proxy
accepts JSON up to 16 MiB; the MDK transport can impose smaller limits.
Larger uploads require a transport configured for their size. An accepted firmware
command does not confirm installation or reboot completion.

Stop this console with Ctrl+C. The worker host runs independently and remains available.
