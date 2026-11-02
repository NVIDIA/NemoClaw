<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Access Agent Interfaces

The OpenShell gateway manages sandbox access.
Agents run inside their sandboxes; you reach them through OpenShell commands, not published host ports.

## Select the Gateway and Workspace

Use the pinned OpenShell development CLI at the revision in [versions.json](../versions.json) on the client host.
These selectors choose an existing OpenShell gateway and deployment; they do not create services or provision credentials.
Run them in every terminal used for forwarding or sandbox commands, from any directory.

For a managed Kubernetes or OpenShift gateway, first create its profile as [Reach the Gateway from the OpenShell CLI](kubernetes.md#reach-the-gateway-from-the-openshell-cli) shows, then select it as below.

For an existing authenticated gateway profile supplied by its operator:

```sh
unset OPENSHELL_GATEWAY_ENDPOINT
export OPENSHELL_GATEWAY=REPLACE_WITH_PROFILE_NAME
```

The profile's endpoint must match `spec.gateway.endpoint` in the deployment YAML.
Its stored authentication must grant access to the deployment workspace.
The endpoint override takes precedence over the profile, which is why this example clears it.
NemoClaw's YAML credential and TLS environment references do not configure the OpenShell CLI's stored profile or credentials.
To create a profile for an authenticated gateway, including its issuer or mTLS client certificates, follow [OpenShell's authentication guide](https://github.com/NVIDIA/OpenShell/blob/ac7f615cd12d5cc49cb16eb1f5f10ffeb1e90f47/docs/how-it-works/gateways/authentication.mdx).

For an existing plaintext loopback gateway instead, select its actual endpoint directly:

```sh
unset OPENSHELL_GATEWAY
export OPENSHELL_GATEWAY_ENDPOINT=http://127.0.0.1:17671
```

Replace the example port with the one in your YAML.
Use this variant only when that gateway is already listening on the client host's loopback interface.
Do not replace an authenticated remote endpoint with plaintext or disable TLS verification to make access work.

Copy the **OpenShell gateway** and **OpenShell workspace** selectors from the plan or apply result.
To print them again without changing runtime resources, run from the directory containing the applied YAML, with the same state directory and credential environment:

```sh
nemoclaw plan deployment.yaml --state-dir .nemoclaw --non-interactive
```

The workspace derives from `metadata.uid`; copy the reported value into each client terminal:

```sh
export OPENSHELL_WORKSPACE=REPLACE_WITH_REPORTED_WORKSPACE
```

JSON results expose the same values as `connection.gatewayEndpoint` and `connection.workspace`.
These selectors describe the configured target, including when a plan is incomplete; they do not establish access or create an authenticated OpenShell CLI profile.
The gateway selectors follow the [pinned OpenShell CLI parser and resolver](https://github.com/NVIDIA/OpenShell/blob/ac7f615cd12d5cc49cb16eb1f5f10ffeb1e90f47/crates/openshell-cli/src/main.rs).
The forward or sandbox command below verifies access to the selected workspace; setting an environment variable alone does not.
On an authentication or missing-sandbox error, check the endpoint, workspace, sandbox name, and operator-provided credentials before changing deployment state.

## Invoke an Agent

After [selecting the gateway and workspace](#select-the-gateway-and-workspace), send requests through `openshell sandbox exec`.
[Run one request](agents.md#run-one-deep-agents-or-pi-request) shows the command and its input.
The selected Fabric adapter owns how the harness handles the request.

## Forward a Native Service

An adapter that serves a native listener inside the sandbox can be reached by forwarding it from a private terminal on the client host:

```sh
openshell forward service REPLACE_WITH_SANDBOX --target-port REPLACE_WITH_PORT --local 127.0.0.1:REPLACE_WITH_PORT
```

The foreground command forwards through the authenticated OpenShell connection to the sandbox's loopback service.
Keep forwarding bound to loopback, follow the adapter's authentication requirements, and stop forwarding with Ctrl-C.
Stopping a client forward does not stop the sandbox or its Fabric runtime.

Apply prints this command for each interface that an agent's configuration enables; see [Reach an Agent Interface](#reach-an-agent-interface).

## Reach an Agent Interface

OpenClaw's Control UI and Hermes's API server and dashboard are served by the agent's Fabric runtime inside its sandbox, on loopback ports that you choose.
Deep Agents Code's terminal is a launcher for `dcode`'s terminal UI, which you run in the sandbox.
Fabric's adapters start them, generate their tokens, and stop them with the runtime; NemoClaw checks the settings while planning and tells you how to reach each interface after apply.
The [Fabric OpenClaw adapter](https://github.com/NVIDIA/NeMo-Fabric/blob/ddf59e875d50d925991cd40c44dc63facf391bac/adapters/python/openclaw/README.md#serve-the-control-ui) and [Fabric Hermes adapter](https://github.com/NVIDIA/NeMo-Fabric/blob/ddf59e875d50d925991cd40c44dc63facf391bac/adapters/python/hermes/README.md#serve-the-api-server-and-dashboard) document each interface's behavior.

### Enable an Interface

Declare each interface under the agent's `harness.settings.interfaces` with an exact `port`:

```yaml
sandboxes:
  claw:
    harness:
      kind: nvidia.fabric.openclaw
      settings:
        interfaces:
          dashboard:
            port: 18789
  hermes:
    harness:
      kind: nvidia.fabric.hermes
      settings:
        interfaces:
          api:
            port: 8642
          dashboard:
            port: 9119
```

| Harness | Interface | Fields | Token | Sign-in |
|---|---|---|---|---|
| OpenClaw | `dashboard`, the Control UI with browser chat | `port` (required, at most 65425), `enabled` | Yes | `http://127.0.0.1:PORT/#token=TOKEN` |
| Hermes | `api`, the OpenAI-compatible API server | `port` (required), `enabled` | Yes | `Authorization: Bearer TOKEN` |
| Hermes | `dashboard`, with browser chat | `port` (required), `enabled` | No | None |
| Deep Agents Code | `terminal`, `dcode`'s terminal UI | `enabled` | No | None beyond OpenShell's: [open it](#open-deep-agents-codes-terminal) with `openshell sandbox exec` |

An interface is on while it is present, unless it sets `enabled: false`.
OpenClaw reserves the ports from `port` through `port + 110`, and its `port` can't be combined with `port_range`.
Hermes's `startup_timeout_seconds` setting, 60 by default and at most 75, bounds how long its interfaces have to start.

Planning checks each interface against its schema in the image's adapter descriptor.
It rejects an interface name or field that the adapter doesn't declare, for example `sandbox/claw: adapter/nvidia.fabric.openclaw compatibility rejected; harness_interfaces: harness.settings.interfaces.terminal: the image's adapter does not support this interface setting`, and a missing required field, a wrong type, or an out-of-range value, for example `harness_interfaces: harness.settings.interfaces.api.port: is required by the image's adapter`.
Fabric checks the rest when it starts the agent: settings outside the interfaces, combinations such as OpenClaw's `port` with `port_range`, and a port that is already in use. The agent fails to start if an enabled interface can't start.
Changing an agent's settings, including its interfaces, replaces its sandbox, deleting its files and conversations.

### Forward, Read the Token, and Sign In

After apply, NemoClaw lists each enabled interface with the commands to reach it, and never prints a token:

```text
Agent interfaces:
  In each terminal, select this deployment's gateway and workspace:
    unset OPENSHELL_GATEWAY
    export OPENSHELL_GATEWAY_ENDPOINT=http://127.0.0.1:17671
    export OPENSHELL_WORKSPACE=nc-1234567890abcdef
  claw/dashboard on port 18789
    Forward:  openshell forward service claw --target-port 18789 --local 127.0.0.1:18789
    Token:    openshell sandbox exec -n claw --no-tty -- cat /sandbox/artifacts/.fabric/openclaw/runtimes/RUNTIME_ID/interfaces/dashboard.token
    Sign in:  open http://127.0.0.1:18789/#token=TOKEN, replacing TOKEN with the token
```

JSON results carry the same facts under `interfaces`.
The gateway selection follows [Select the Gateway and Workspace](#select-the-gateway-and-workspace); for a gateway that needs an OpenShell profile, the output asks for your profile's name.

1. Run the forward in its own terminal and keep it running.
2. Read the token with the `Token` command, in another terminal with the same selection.
   The token is at `/sandbox/artifacts/.fabric/ADAPTER/runtimes/RUNTIME_ID/interfaces/NAME.token`, where `RUNTIME_ID` is the agent's runtime ID that the deployment state records.
   For an agent that [keeps its state](state.md#agent-files), such as Hermes, it is at `/sandbox/artifacts/.fabric/state/ADAPTER_ID/AGENT/interfaces/NAME.token` for every runtime.
   The adapter generates it each time the runtime starts and writes it once its interfaces are up, readable only by the sandbox's user; stopping the runtime removes it.
   After the runtime restarts, apply prints the new path; read the token again.
3. Sign in:
   - OpenClaw: open `http://127.0.0.1:PORT/#token=TOKEN` in a browser. The Control UI removes the token from the address bar. OpenClaw accepts any loopback origin with the token, so a forward to another local port also works.
   - Hermes's API server: send `Authorization: Bearer TOKEN` with each request, for example to `http://127.0.0.1:PORT/v1/models`.
   - Hermes's dashboard: open `http://127.0.0.1:PORT/`. It has no sign-in.

Keep tokens out of YAML, shell history, and shared logs; NemoClaw stores none in its state.
Hermes's API server and browser chat call the model the agent's configuration names, with its key.

### Open Deep Agents Code's Terminal

Enable the terminal in a Deep Agents Code sandbox's harness settings, as the [example](../examples/fabric-deepagents-code.yaml) does; it takes no port:

```yaml
harness:
  kind: nvidia.fabric.langchain.deepagents-code
  settings:
    approval_mode: auto
    interfaces:
      terminal: {}
```

After apply, NemoClaw prints the command that opens it, with the current runtime's launcher, and no forward or token:

```text
Agent interfaces:
  In each terminal, select this deployment's gateway and workspace:
    unset OPENSHELL_GATEWAY
    export OPENSHELL_GATEWAY_ENDPOINT=http://127.0.0.1:17681
    export OPENSHELL_WORKSPACE=nc-1234567890abcdef
  assistant/terminal
    Open:     openshell sandbox exec -n assistant --tty -- /sandbox/artifacts/.fabric/deepagents-code/runtimes/RUNTIME_ID/interfaces/terminal
              (on a noexec mount: openshell sandbox exec -n assistant --tty -- sh /sandbox/artifacts/.fabric/deepagents-code/runtimes/RUNTIME_ID/interfaces/terminal)
    Sign in:  none; anyone who can run openshell sandbox exec in this workspace can open it
```

JSON results carry the launcher's path as `launcher` and `signIn` as `sandbox_exec`.
Run the `Open` command from a terminal on the client host, with the gateway selection; if the artifacts directory is mounted `noexec`, run the `sh` form instead.
`openshell sandbox connect` attaches to the sandbox's main process, `fabric-agent-ctl serve`, not to a shell, so it can't open the terminal UI.
OpenShell's access control is the only authentication: anyone who can run `openshell sandbox exec` in the workspace can open the terminal UI.
Quit it with Ctrl-D.

The terminal UI opens a separate session from Fabric's invocations, sharing the runtime's `dcode` configuration, home, session store, and workspace:

- It uses the configured model and endpoint.
  The launcher holds no secret; `dcode` reads the model key from the variable the configuration names, which OpenShell sets in each `sandbox exec` session.
  For a provider with a credential, that variable holds OpenShell's placeholder, which OpenShell replaces with the key in requests to the endpoint.
- The first time it opens in a runtime's home, it asks for a name and then offers to choose a model; Escape skips both and keeps the configured model.
- It uses `dcode`'s own approval behavior, which asks before gated actions, not `approval_mode`, which applies only to invocations.
- It doesn't show invocations as they run, and it can't open the runtime's own thread.
  The runtime's ACP session is a `dcode` thread, whose ID is in `interfaces/terminal.running` beside the launcher, and it holds that thread while the runtime runs; `LAUNCHER -r THREAD_ID` fails with `Thread can't be resumed`, because the thread is open elsewhere, and once the runtime stops the launcher refuses to start.
  `openshell sandbox exec -n SANDBOX --tty -- LAUNCHER threads list` lists the runtime's thread with the terminal's own sessions.
- Each runtime has its own launcher path; after the runtime restarts, apply prints the new one.

The launcher refuses to start, printing `This NeMo Fabric runtime is not running.`, when `terminal.running` is absent: the adapter writes it once the runtime's session starts and removes it when the runtime stops.
Terminal sessions already open when the runtime stops keep running.
If the runtime's process is killed instead of stopped, the marker stays, and the launcher still opens a session with that runtime's configuration until the sandbox is replaced.

### Who Can Use an Interface

- **The agent's own tools.** Tools that the agent runs in its sandbox run as the same user as its runtime, so they can read and change the token files and reach the interfaces' ports. The agent can sign in to its own interfaces and use their configuration, cron, and plugin features, which can change what it does outside the guardrails of its harness, though not OpenShell's policy.
- **Hermes's dashboard.** Anyone who can reach its forward can use it, including its browser chat, which runs the agent without approvals. Its gateway actions, such as restarting the gateway, start Hermes processes that replace the one Fabric started and can keep running after the runtime stops.
- **Forwards and exposed URLs.** Prefer `openshell forward service`: the gateway authorizes each forwarded connection for your identity and workspace. A [service exposure](#expose-a-service-through-the-gateway) skips that authorization, so the interface's own sign-in is all that protects it, and Hermes's dashboard has none.
- **Deep Agents Code's terminal launcher.** The launcher is a file in `/sandbox/artifacts`, readable and writable by the agent's own tools. The agent can change what the launcher runs; it still runs inside the sandbox, under the sandbox's policy.
- **Deep Agents Code's terminal UI.** It starts its own agent server on `127.0.0.1` in the sandbox, on a port it chooses, without authentication, as `dcode` always does ([its threat model](https://github.com/langchain-ai/deepagents/blob/0cc119a70ac9df9aaac4ef0939a1141a92b75af0/libs/code/THREAT_MODEL.md), T6). While the terminal UI runs, any process in the sandbox, including the agent's tools, can use that server. Don't forward or expose it. Fabric's invocations use ACP over standard input and output and open no listener.

Configuration changed through an interface isn't kept: the adapter regenerates the harness's configuration at each start.
Conversations in an interface aren't promised to share history with requests sent through `fabric-agent-ctl invoke`.

### Hermes's Browser Chat

Browser chat runs Hermes's terminal UI in a pseudo-terminal, which needs read-write access to `/dev/pts`, where the `ptmx` device that `/dev/ptmx` links to lives.
The Hermes image's default filesystem policy grants read-write `/dev/pts` and `/dev/ptmx`, so a Hermes sandbox that omits `network` or declares `tier: isolated` can use browser chat.
Other agent images' default policies grant neither.

With those devices writable, every process in the Hermes sandbox, including the agent's own tools, can open pseudo-terminals.
The image's catalog label lists the defaults under `runtime.policy.filesystem_policy`.

An [explicit policy](sandbox-network.md#choose-a-policy) replaces the image's defaults.
For browser chat, its `filesystem_policy.read_write` must list `/dev/pts`; `/dev/ptmx` alone isn't enough, and without `/dev/pts` the chat fails with `out of pty devices`.
The API server and the rest of the dashboard work either way.

### Interface Failures

Only the agent's runtime check decides whether NemoClaw finds the agent running.
OpenClaw's Control UI is served by its Gateway, which is the runtime itself, so its failure is the runtime's.
A Hermes interface process that exits leaves the agent running: plan reports no change, neither Fabric nor NemoClaw restarts the process or reports its failure, and the interface returns when the runtime next starts.

## Expose a Service Through the Gateway

To make a sandbox's loopback listener reachable at a URL that OpenShell's gateway serves, declare it under the sandbox's `serviceExposures`, keyed by service name:

```yaml
sandboxes:
  assistant:
    serviceExposures:
      dashboard:
        targetPort: 18800
        authorizationMode: BEARER_PASSTHROUGH
```

Each entry maps to an OpenShell service exposure: its key is the service name, and it takes `targetPort` and an optional `authorizationMode` (`STRIP` or `BEARER_PASSTHROUGH`).
OpenShell applies `STRIP` when the mode is omitted, and the empty key `""` is the unnamed endpoint.
OpenShell checks the names when it creates the sandbox; see its [service exposure rules](https://github.com/NVIDIA/OpenShell/blob/ac7f615cd12d5cc49cb16eb1f5f10ffeb1e90f47/docs/how-it-works/sandboxes/overview.mdx#expose-long-running-services).
A sandbox takes at most 32 exposures.
Exposures belong to the sandbox's creation, so adding, changing, or removing one replaces the sandbox, deleting its files and conversations.
In HCL, use `openshell_sandbox`'s [`service` blocks](provider.md#openshell-resources-and-data-sources).

Requests to the URL skip OpenShell's gateway authentication: they use no OIDC or CLI login, and only the gateway listener's TLS, including any required client certificate, applies.
The service must listen on loopback and authenticate its own clients.
`BEARER_PASSTHROUGH` delivers the caller's bearer token to the service, so use it only for a service trusted with that credential.
A successful apply lists the URL the gateway reports for each exposure under **Service URLs**, as `sandbox/service: URL`; the unnamed endpoint is listed as `sandbox: URL`.
JSON results key them by sandbox and service name under `serviceUrls`, with `""` for the unnamed endpoint.
An unchanged apply lists them again.

## Diagnose Failures

Check gateway authorization, the UID-derived workspace, sandbox name, and native service state independently.
Inspect the [native logs](troubleshooting.md#read-native-service-logs) through the retained sandbox binding.
A working forward does not establish that the native service has valid authentication or a working model connection.

NemoClaw compares the retained public Fabric configuration with the runtime host's configuration and preserves resource identities on failure.
Fabric owns configuration validation and native diagnostics.
Configuration failures name the sandbox and report a fixed stage, code, and runtime state.
Fabric's own message is left out of the output, because it can repeat what the harness printed, including secrets NemoClaw can't recognize to redact.
NemoClaw keeps it in `diagnostics/fabric-SANDBOX.json` in the deployment's state directory, and the error names that file: `Fabric's message is in PATH`.
On Linux and macOS, only the state directory's owner can read the file.
Inspect it privately before sharing excerpts; a later failure in the same sandbox replaces it.
Correct the reported conflict before reapplying; do not delete retained state to hide drift.
