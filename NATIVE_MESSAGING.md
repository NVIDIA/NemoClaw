# Native harness interfaces with Fabric

NemoClaw has four commands: `plan`, `apply`, `export`, and `destroy`. `plan --destroy`
is a preview flag. Runtime requests and messaging configuration use existing native
interfaces. No new Fabric client, channel contract, or upstream Fabric changes are
required. OpenClaw itself is still supplied through our local Fabric adapter because
the pinned Fabric revision has no built-in OpenClaw adapter.

## OpenClaw access

Provision the image from `image/fabric/Dockerfile.openclaw` through the normal build
script and `examples/fabric-openclaw.yaml`. The existing OpenShell CLI supplies
sandbox access:

```sh
openshell --gateway-endpoint GATEWAY --workspace WORKSPACE sandbox connect assistant
```

`GATEWAY` is the deployment gateway endpoint; use the corresponding OpenShell
credentials for authenticated gateways. `WORKSPACE` is the owned workspace name
recorded in the deployment's `terraform.tfstate` (`nemoclaw_workspace.deployment`).
The sandbox name is the one from YAML. Inside the sandbox, use OpenClaw directly:

```sh
openclaw channels add
openclaw channels status --probe
openclaw pairing list telegram
openclaw pairing approve telegram CODE
openclaw tui
```

For noninteractive access, OpenShell 0.0.116 also supports:

```sh
openshell --gateway-endpoint GATEWAY --workspace WORKSPACE sandbox exec --name assistant -- openclaw channels status --probe
```

These are upstream OpenShell/OpenClaw commands. They do not pass through a NemoClaw
runtime API. The native gateway stays on sandbox loopback. No public listener or
port forwarding is enabled by this experiment. Gateway authentication, remote user
access, UI setup and channel enrollment follow native harness behavior.

## Configuration and lifecycle ownership

The image sets the native CLI's state/config paths to `/sandbox/.openclaw` and
`/sandbox/.openclaw/openclaw.json`; the Fabric adapter uses the same paths. It seeds
configuration only when absent. Existing native settings are preserved on startup;
changes to channels, pairing, plugins and session settings are not translated into
another schema. The native gateway handles its own configuration reloads.

NemoClaw's readiness checks still verify the provisioned loopback gateway endpoint,
primary OpenShell inference route and workspace. Changing these deployment-owned
settings through the native CLI causes readiness/reconciliation to fail instead of
silently overwriting the file. The adapter holds an exclusive state lock while its
gateway runs. Fabric still owns process start/stop through its existing contract.
SDK-originated adapter calls retain their timeout and no-replay behavior; native
CLI/channel requests use native OpenClaw execution and delivery semantics.

Native messages are not Fabric invocation records. Native state and logs are the
source of truth for their sessions and delivery. OpenClaw configuration is not
included in NemoClaw's YAML export; retain/back up its native state separately.

## Native qualification

```sh
python3 image/fabric/build.py --harness openclaw
python3 tools/openclaw-native-experiment.py
```

This runs the actual Fabric and OpenClaw processes with local TLS Telegram and model
protocol fixtures. All messaging operations use `openclaw config`, `openclaw pairing`,
`openclaw channels status`, or the native gateway CLI. There is no channel-control
extension in the image. The test verifies enrollment, unauthorized sender rejection,
two isolated conversations, real tool execution with independent file readback,
readiness checks that preserve native settings, recreation, disable and invalid
credential reporting while agent requests remain usable.

Only `/sandbox/.openclaw` and `/sandbox/workspace` survive recreation; the rest of
the sandbox is fresh. Both are required for native history/workspace continuity.
The containers have `--network none`. `NET_ADMIN` is used only in their isolated
namespace to add a loopback model alias compatible with native SSRF validation.
The fake token is writable solely for the negative credential test; no real token
is read. Containers are removed, and fixture traffic/process evidence remains under
`.local/openclaw-native-UUID`. These checks are not real Telegram qualification.

The opt-in `TestLiveFabric` separately checks direct OpenClaw CLI access through a
real OpenShell deployment and live inference. It changes native settings, performs
unchanged apply and export/reapply, verifies those settings survive, sends a native
agent request, and tears down its own resources. See `LOCAL_TEST.md`.

## Infrastructure limits

The ordinary OpenShell deployment still has fixed isolated egress and does not
provide messaging secret mounts or retained sandbox storage. The Docker fixture
supplies those prerequisites locally. Real Telegram/WhatsApp deployment still needs
those generic infrastructure facilities and real-account qualification. The adapter
no longer declares channel-specific requirements, installs messaging dependencies,
performs enrollment, or manages channel state on the user's behalf. The current
image already contains the pinned native Telegram plugin.

Hermes/Deep Agents support is unchanged at the execution layer; this experiment does
not turn their Fabric adapters into native messaging gateways. Use a harness's own
available interfaces or Fabric's existing SDK. The SDK's `Fabric.run` starts and
stops a new runtime; it does not attach to the runtime hosted by NemoClaw. We do not
introduce an attachment API or promise a uniform messaging experience across them.
