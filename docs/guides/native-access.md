# Use native agent interfaces

Use OpenShell to enter the sandbox and the agent's native CLI to interact with it.
NemoClaw owns deployment operations; it has no invocation or channel API.

## Messaging prerequisites and limits

The ordinary OpenShell deployment still has fixed isolated egress and does not provide messaging secret mounts or retained sandbox storage.
The Docker fixture supplies those prerequisites locally.
Real Telegram/WhatsApp deployment still needs those generic infrastructure facilities and real-account qualification.
The adapter no longer declares channel-specific requirements, installs messaging dependencies, performs enrollment, or manages channel state on the user's behalf.
The current image already contains the pinned native Telegram plugin.

The Hermes and Deep Agents adapters provide agent execution; they do not provide native messaging gateways.
Use a harness's own available interfaces or Fabric's existing SDK.
The SDK's `Fabric.run` starts and stops a new runtime; it does not attach to the runtime hosted by NemoClaw.

## Access OpenClaw

[Deploy the OpenClaw Fabric recipe](fabric.md) using [fabric-openclaw.yaml](../../examples/fabric-openclaw.yaml).
The existing OpenShell CLI supplies sandbox access:

```sh
openshell --gateway-endpoint GATEWAY --workspace WORKSPACE sandbox connect assistant
```

`GATEWAY` is the deployment gateway endpoint; use the corresponding OpenShell credentials for authenticated gateways.
`WORKSPACE` is the owned workspace name recorded in the deployment's `terraform.tfstate` (`nemoclaw_workspace.deployment`).
This workspace is an OpenShell resource, not the filesystem workspace directory.
The sandbox name is the one from YAML.
Inside the sandbox, use OpenClaw directly.
Channel enrollment commands require the infrastructure described above; they are not a working Telegram setup procedure for the current deployment:

| Task | Native command |
| --- | --- |
| Configure a channel | `openclaw channels add` |
| Probe channel status | `openclaw channels status --probe` |
| List Telegram pairing requests | `openclaw pairing list telegram` |
| Approve an intended sender's pairing code | `openclaw pairing approve telegram CODE` |
| Open the terminal interface | `openclaw tui` |

For noninteractive access, OpenShell 0.0.116 also supports:

```sh
openshell --gateway-endpoint GATEWAY --workspace WORKSPACE sandbox exec --name assistant -- openclaw channels status --probe
```

These are upstream OpenShell/OpenClaw commands.
They do not pass through a NemoClaw runtime API.
The native gateway stays on sandbox loopback.
No public listener or port forwarding is enabled by this experiment.
Gateway authentication, remote user access, UI setup and channel enrollment follow native harness behavior.

## Configuration and lifecycle ownership

The image sets the native CLI's state/config paths to `/sandbox/.openclaw` and `/sandbox/.openclaw/openclaw.json`; the Fabric adapter uses the same paths.
It seeds configuration only when absent.
Existing native settings are preserved on startup; changes to channels, pairing, plugins and session settings are not translated into another schema.
The native gateway handles its own configuration reloads.

NemoClaw's readiness checks still verify the provisioned loopback gateway endpoint, primary OpenShell inference route and workspace.
Changing these deployment-owned settings through the native CLI causes readiness/reconciliation to fail instead of silently overwriting the file.
The adapter holds an exclusive state lock while its gateway runs.
Fabric still owns process start/stop through its existing contract.
SDK-originated adapter calls retain their timeout and no-replay behavior; native CLI/channel requests use native OpenClaw execution and delivery semantics.

Native messages are not Fabric invocation records.
Native state and logs are the source of truth for their sessions and delivery.
OpenClaw configuration is not included in NemoClaw's YAML export; retain/back up its native state separately.

The image initially disables cron, heartbeat, automatic updates, and memory indexing.
Later native settings belong to OpenClaw.
The native home is `/sandbox/.openclaw`; the filesystem workspace is `/sandbox/workspace`.
Both are needed for native state continuity during recreation.
The ordinary OpenShell teardown removes both; the Docker fixture retains them explicitly.

Refer to [native messaging tests](../validation/native-messaging.md) for tested behavior and its limits.
