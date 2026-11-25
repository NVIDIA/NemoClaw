<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Accessing Agent Interfaces

The NVIDIA OpenShell gateway manages sandbox access.
Agents run inside their sandboxes.
You reach them through OpenShell commands, not published host ports.

## Selecting the Gateway and Workspace

Use an OpenShell CLI matching the deployment implementation revision on the client host.
For the [first-deployment tutorial](../get-started/first-deployment.md), use the OpenShell version its [prerequisites](../get-started/prerequisites.md#before-the-first-deployment) name.
These selectors choose an existing OpenShell gateway and deployment.
They don't create services or provision credentials.
Run them in every terminal used for forwarding or sandbox commands, from any directory.

For a managed Kubernetes or OpenShift gateway, first create its profile as [Reaching the Gateway From the OpenShell CLI](../build-deploy/kubernetes.md#reaching-the-gateway-from-the-openshell-cli) shows, then select it as below.

For an existing authenticated gateway profile supplied by its operator, follow these steps:

1. Clear any endpoint override.

   ```sh
   unset OPENSHELL_GATEWAY_ENDPOINT
   ```

2. Select the operator-provided profile.

   ```sh
   export OPENSHELL_GATEWAY=REPLACE_WITH_PROFILE_NAME
   ```

The profile's endpoint must be the address that plan prints as the **OpenShell gateway**, or, for a managed Kubernetes or OpenShift gateway that isn't published, your port forward's.
Its stored authentication must grant access to the deployment workspace.
The endpoint override takes precedence over the profile, which is why this example clears it.
NemoClaw's YAML credential and TLS environment references don't configure the OpenShell CLI's stored profile or credentials.
To create a profile for an authenticated gateway, including its issuer or mTLS client certificates, follow [OpenShell's authentication guide](https://github.com/ai-openshell/openshell/blob/152c59d3178039e3fbb4a5595f9fff7216a6be92/docs/how-it-works/gateways/authentication.mdx).

For an existing plaintext loopback gateway instead, follow these steps:

1. Clear the profile selector.

   ```sh
   unset OPENSHELL_GATEWAY
   ```

2. Select the gateway's actual endpoint.

   ```sh
   export OPENSHELL_GATEWAY_ENDPOINT=http://127.0.0.1:17671
   ```

   Replace the example port with the one plan prints for the **OpenShell gateway**.
Use this variant only when that gateway is already listening on the client host's loopback interface.
Don't replace an authenticated remote endpoint with plaintext or disable TLS verification to make access work.

Use the **OpenShell gateway** and **OpenShell workspace** selectors from the plan or apply result. If you need them again, follow these steps:

1. Run plan from the directory containing the applied YAML, with the same state directory and credential environment.

   ```sh
   nemoclaw plan deployment.yaml --state-dir .nemoclaw --non-interactive
   ```

   Plan does not change runtime resources.

2. Confirm that the reported gateway matches the selected endpoint or profile.

3. Select the reported workspace in each client terminal.

   ```sh
   export OPENSHELL_WORKSPACE=REPLACE_WITH_REPORTED_WORKSPACE
   ```

   The workspace derives from `metadata.uid`.

JSON results expose the same values as `connection.gatewayEndpoint` and `connection.workspace`.
A managed Kubernetes or OpenShift gateway without `expose` has no address: the text reports it as `not published`, and JSON omits `gatewayEndpoint`.
These selectors describe the configured target, including when a plan is incomplete.
They don't establish access or create an authenticated OpenShell CLI profile.
The gateway selectors follow the [pinned OpenShell CLI parser and resolver](https://github.com/ai-openshell/openshell/blob/152c59d3178039e3fbb4a5595f9fff7216a6be92/crates/openshell-cli/src/main.rs).
The forward or sandbox command below verifies access to the selected workspace.
Setting an environment variable alone doesn't.
On an authentication or missing-sandbox error, check the endpoint, workspace, sandbox name, and operator-provided credentials before changing deployment state.

## Invoking an Agent

After [selecting the gateway and workspace](#selecting-the-gateway-and-workspace), send requests through `openshell sandbox exec`.
Plan and apply print a command for each agent with a recorded runtime ID, as in this illustrative output:

```text
Agents:
  In each terminal, select this deployment's gateway and workspace:
    unset OPENSHELL_GATEWAY
    export OPENSHELL_GATEWAY_ENDPOINT=http://127.0.0.1:17671
    export OPENSHELL_WORKSPACE=nc-1234567890abcdef
  claw: agent main, runtime RUNTIME_ID
    Invoke:   openshell sandbox exec -n claw --no-tty -- fabric-agent-ctl invoke --agent main --runtime-id RUNTIME_ID --input FILE
  FILE is a file in the sandbox holding one JSON value, such as a prompt string; --input - reads it from stdin; see docs/agents-inference/agents.md.
```

JSON results carry the same facts under `agents`, keyed by sandbox name: `agent`, the agent's name, and `runtimeId`.
If an apply result also lists interfaces, the CLI prints the gateway and workspace selection once under **Agents**, not again under **Agent interfaces**.
A plan lists them under **Agents, as last applied**: its changes can replace a runtime, and the next apply reports the new ID.
A plan omits that section when no agent has a recorded runtime, such as before the first apply.
Otherwise, an agent without a recorded runtime is listed with `no runtime recorded` and has no `runtimeId`.
[Run one request](agents.md#running-one-agent-request) shows the command and its input.
The selected NVIDIA NeMo Fabric adapter owns how the harness handles the request.

## Forwarding a Native Service

An adapter can serve a native listener inside its sandbox.
Reach it from a private terminal on the client host:

1. [Select the gateway and workspace](#selecting-the-gateway-and-workspace) in that terminal.

2. Forward the sandbox's loopback service, bound to client loopback.

   ```sh
   openshell forward service REPLACE_WITH_SANDBOX --target-port REPLACE_WITH_PORT --local 127.0.0.1:REPLACE_WITH_PORT
   ```

   The command stays in the foreground and forwards through the authenticated OpenShell connection.

3. Follow the selected adapter's authentication requirements before using the service.

4. Stop forwarding with Ctrl+C when finished.
   This doesn't stop the sandbox or its Fabric runtime.

Apply prints this command for each interface that an agent's configuration enables.
See [Reaching an Agent Interface](#reaching-an-agent-interface).

## Reaching an Agent Interface

The agent's Fabric runtime serves OpenClaw's Control UI and Hermes's API server and dashboard inside its sandbox, on loopback ports that you choose.
Fabric's adapters start them, generate their tokens, and stop them with the runtime.
NemoClaw checks the settings while planning and tells you how to reach each interface after apply.
The [Fabric OpenClaw guide](https://github.com/NVIDIA/NeMo-Fabric/blob/76bde16c40747062001bd6ea5f5d13cadab3d706/docs/integrations/harness/openclaw/openclaw-dashboard.mdx#serve-the-control-ui) and [Fabric Hermes native interfaces guide](https://github.com/NVIDIA/NeMo-Fabric/blob/76bde16c40747062001bd6ea5f5d13cadab3d706/docs/integrations/harness/hermes/hermes.mdx#select-execution-paths) document each interface's behavior.

### Enabling an Interface

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
| Hermes | `terminal`, the terminal UI; experimental in Fabric | `port` (required, the dashboard's port when both are on), `enabled` | No | The `Terminal` command signs in |

An interface is on while it's present, unless it sets `enabled: false`.
OpenClaw reserves the ports from `port` through `port + 110`, and its `port` can't be combined with `port_range`.
Hermes's `startup_timeout_seconds` setting, 60 by default and at most 75, bounds how long its interfaces have to start.

Planning asks Fabric whether the image's adapter accepts the configuration, interfaces included.
It rejects an interface or field that the adapter doesn't declare, a missing required field, a wrong type, and an out-of-range value, naming the field you wrote.
For example: `sandbox/claw: adapter/nvidia.fabric.openclaw compatibility rejected; fabric_configuration: spec.sandboxes[claw].harness.settings.interfaces.api: is not declared by the adapter settings schema`.
Fabric stops at the first refused harness setting, so fix it and plan again.
A plan that passes doesn't establish that the agent starts: Fabric still finds a port that's already in use, and the agent fails to start if an enabled interface can't start.
Changing an agent's settings, including its interfaces, replaces its sandbox, deleting its files and conversations.

### Forwarding, Reading the Token, and Signing In

After apply, NemoClaw lists each enabled interface with the commands to reach it, and never prints a token.
The following illustrative excerpt shows interface selection commands in isolation.
In an apply result that also reports a recorded agent runtime, the **Agents** block supplies those commands instead:

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
    Terminal: openshell sandbox exec -n claw --tty -- openclaw tui --url ws://127.0.0.1:18789 --token TOKEN, replacing TOKEN with the token
```

JSON results carry the same facts under `interfaces`.
The gateway selection follows [Selecting the Gateway and Workspace](#selecting-the-gateway-and-workspace).
For a gateway that needs an OpenShell profile, the output asks for your profile's name.

1. [Select the gateway and workspace](#selecting-the-gateway-and-workspace) in the terminal that will run the forward.
2. Run the `Forward` command in that terminal and keep it running. Bind it to loopback; stopping the forward does not stop the runtime.
3. Select the same gateway and workspace in a separate private terminal.
4. If the interface requires a token, read it with the `Token` command in that terminal. Do not paste a token into shell history or shared logs.
   The token is at `/sandbox/artifacts/.fabric/ADAPTER/runtimes/RUNTIME_ID/interfaces/NAME.token`, where `RUNTIME_ID` is the agent's runtime ID that the deployment state records.
   For an agent that [keeps its state](../build-deploy/state.md#agent-files), such as Hermes or OpenClaw, it's at `/sandbox/artifacts/.fabric/state/ADAPTER_ID/AGENT/interfaces/NAME.token` for every runtime.
   The adapter generates it each time the runtime starts and writes it once its interfaces are up, readable only by the sandbox's user.
   Stopping the runtime removes it.
   After the runtime restarts, apply prints a new path.
   Repeat this step to read the new token.
5. Sign in using the method for the selected interface:

   - OpenClaw: Open `http://127.0.0.1:PORT/#token=TOKEN` in a browser.
     The Control UI removes the token from the address bar.
     OpenClaw accepts any loopback origin with the token, so a forward to another local port also works.
   - Hermes's API server: Send `Authorization: Bearer TOKEN` with each request, for example to `http://127.0.0.1:PORT/v1/models`.
   - Hermes's dashboard: Open `http://127.0.0.1:PORT/`.
     It has no sign-in.
     Anyone who can reach its forward can use it.

6. Send a short request through the signed-in interface to verify the model replies.
   A successful forward or sign-in alone doesn't establish inference.

NemoClaw stores no interface tokens in its state.
Hermes's API server and browser chat call the model the agent's configuration names, with its key.

### Who Can Use an Interface

The interface's location and authentication determine which actors can reach it:

- **The agent's own tools.** Tools that the agent runs in its sandbox run as the same user as its runtime, so they can read and change the token files and reach the interfaces' ports.
  The agent can sign in to its own interfaces and use their configuration, cron, and plugin features, which can change what it does outside the guardrails of its harness, though not OpenShell's policy.
- **Hermes's dashboard.** Anyone who can reach its forward can use it, including its browser chat, which runs the agent without approvals.
  Its gateway actions, such as restarting the gateway, start Hermes processes that replace the one Fabric started and can keep running after the runtime stops.
- **Forwards and exposed URLs.** Prefer `openshell forward service`: the gateway authorizes each forwarded connection for your identity and workspace.
  A [service exposure](#exposing-a-service-through-the-gateway) skips that authorization, so the interface's own sign-in is all that protects it, and Hermes's dashboard has none.

Configuration changed through an interface isn't kept: the adapter regenerates the harness's configuration at each start.
Conversations in an interface aren't promised to share history with requests sent through `fabric-agent-ctl invoke`.

### OpenClaw's Terminal UI

OpenClaw's terminal UI, `openclaw tui`, is a client of the Gateway that serves the Control UI, so it needs the `dashboard` interface and signs in with its token.
Apply prints the command that opens it on the dashboard's `Terminal` line, and JSON results carry the command it runs in the sandbox as `terminal`.
Run it from a terminal on the client host with the gateway and workspace selected.
It needs no forward.
Keep the token out of shell history:

1. Read the token into a variable with the `Token` command.

   ```sh
   TOKEN=$(openshell sandbox exec -n claw --no-tty -- cat /sandbox/artifacts/.fabric/openclaw/runtimes/RUNTIME_ID/interfaces/dashboard.token)
   ```

2. Open the terminal UI.

   ```sh
   openshell sandbox exec -n claw --tty -- openclaw tui --url ws://127.0.0.1:18789 --token "$TOKEN"
   ```

3. Press Ctrl+D to quit when finished.
   Opening the terminal UI again reconnects to the same session and shows its history.

4. Clear the client terminal's token variable after the terminal UI exits.

   ```sh
   unset TOKEN
   ```

The token changes each time the runtime starts.
Repeat the token-reading step after a restart.
The agent's own tools can read the token, as [Who Can Use an Interface](#who-can-use-an-interface) describes.

OpenShell opens the pseudo-terminal of `openshell sandbox exec --tty` and hands it to the command, so the terminal UI works without `/dev/pts` in the sandbox's filesystem policy.
Hermes's browser chat opens its own pseudo-terminal, so it needs `/dev/pts`, as [Hermes's Browser Chat](#hermess-browser-chat) describes.

### Hermes's Terminal UI

Hermes's `terminal` interface attaches Hermes's terminal UI to the backend that serves browser chat, which the agent's runtime starts.
Fabric marks this interface experimental: its `terminal` setting, the attachment files, and the attach helper might change between Fabric releases without compatibility.
See [Fabric's Hermes terminal guide](https://github.com/NVIDIA/NeMo-Fabric/blob/76bde16c40747062001bd6ea5f5d13cadab3d706/docs/integrations/harness/hermes/hermes-tui.mdx).
Fabric tracks what it takes for the interface to stop being experimental in [NVIDIA/NeMo-Fabric#656](https://github.com/NVIDIA/NeMo-Fabric/issues/656).
Give it the dashboard's port, so that both use one backend process:

```yaml
sandboxes:
  hermes:
    harness:
      kind: nvidia.fabric.hermes
      settings:
        interfaces:
          dashboard:
            port: 9119
          terminal:
            port: 9119
```

Without the dashboard, Fabric starts the backend on the terminal's port without the browser pages.
Apply prints the command that opens the terminal UI on the interface's `Terminal` line, and JSON results carry the command it runs in the sandbox as `terminal`:

```text
  hermes/terminal
    Sign in:  the Terminal command reads the runtime's credential itself
    Terminal: openshell sandbox exec -n hermes --tty -- /opt/fabric/bin/python -m nemo_fabric_adapters.hermes.terminal --connection /sandbox/artifacts/.fabric/state/nvidia.fabric.hermes/AGENT/interfaces/tui.json
```

Run it from a terminal on the client host with the gateway and workspace selected.
It needs no forward and no token.
Fabric's attach helper reads the backend's port and token from the runtime's `tui.json` and `tui.token` in the agent's [kept state](../build-deploy/state.md#agent-files), which only the sandbox's user can read, and starts the terminal UI on that backend.
It fails if the backend doesn't accept the token, and never starts a backend of its own.
Anyone who can run commands in the sandbox, including the agent's own tools, can open it.

Each terminal UI starts a new conversation in the agent's Hermes home, with the agent's configuration, skills, and model.
It doesn't continue the conversations of `fabric-agent-ctl invoke` or browser chat.
Press Ctrl+D to quit.
Quitting leaves the runtime and the backend running.
Stopping the runtime stops the backend and removes the attachment files, so open the terminal UI again after the runtime restarts.
What an open terminal UI does when its runtime stops isn't settled yet ([NVIDIA/NeMo-Fabric#656](https://github.com/NVIDIA/NeMo-Fabric/issues/656)).

### Hermes's Browser Chat

Browser chat runs Hermes's terminal UI in a pseudo-terminal, which needs read-write access to `/dev/pts`, where the `ptmx` device that `/dev/ptmx` links to lives.
The Hermes image's default filesystem policy grants read-write `/dev/pts` and `/dev/ptmx`, so a Hermes sandbox that omits `network` or declares `tier: isolated` can use browser chat.
Other agent images' default policies grant neither.

With those devices writable, every process in the Hermes sandbox, including the agent's own tools, can open pseudo-terminals.
The image's catalog label lists the defaults under `runtime.policy.filesystem_policy`.

An [explicit policy](../security/sandbox-network.md#choosing-a-policy) replaces the image's defaults.
For browser chat, its `filesystem_policy.read_write` must list `/dev/pts`.
`/dev/ptmx` alone isn't enough, and without `/dev/pts` the chat fails with `out of pty devices`.
The API server and the rest of the dashboard work either way.

### Interface Failures

Only the agent's runtime check decides whether NemoClaw finds the agent running.
OpenClaw's Gateway is the runtime itself and serves the Control UI, so a Control UI failure is a runtime failure.
A Hermes interface process that exits leaves the agent running: plan reports no change, neither Fabric nor NemoClaw restarts the process or reports its failure, and the interface returns when the runtime next starts.

## Exposing a Service Through the Gateway

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
OpenShell checks the names when it creates the sandbox or exposes a service.
See its [service exposure rules](https://github.com/ai-openshell/openshell/blob/152c59d3178039e3fbb4a5595f9fff7216a6be92/docs/how-it-works/sandboxes/overview.mdx#expose-long-running-services).
A sandbox takes at most 32 exposures.
Adding, changing, or removing an exposure updates the running sandbox's endpoints in place, as `openshell service expose` and `openshell service delete` do, so the sandbox keeps its files and conversations.
Apply also restores a declared endpoint that was changed or deleted on the gateway, and leaves endpoints under other names alone.
In HCL, use `openshell_sandbox`'s [`service` blocks](../references/provider.md#openshell-resources-and-data-sources).

Requests to the URL skip OpenShell's gateway authentication: they use no OIDC or CLI login, and only the gateway listener's TLS, including any required client certificate, applies.
The service must listen on loopback and authenticate its own clients.
`BEARER_PASSTHROUGH` delivers the caller's bearer token to the service, so use it only for a service trusted with that credential.
A successful apply lists the URL the gateway reports for each exposure under **Service URLs**, as `sandbox/service: URL`.
A gateway that doesn't route services reports none, as a [managed Kubernetes gateway](../build-deploy/kubernetes.md#deploying-with-a-managed-gateway) doesn't by default.
The unnamed endpoint is listed as `sandbox: URL`.
JSON results key them by sandbox and service name under `serviceUrls`, with `""` for the unnamed endpoint.
An unchanged apply lists them again.

## Diagnosing Failures

Check gateway authorization, the UID-derived workspace, sandbox name, and native service state independently.
Inspect the [native logs](../observability/troubleshooting.md#reading-native-service-logs) through the retained sandbox binding.
A working forward doesn't establish that the native service has valid authentication or a working model connection.

NemoClaw compares the retained public Fabric configuration with the runtime host's configuration and preserves resource identities on failure.
Fabric owns configuration validation and native diagnostics.
Configuration failures name the sandbox and report a fixed stage, code, and runtime state.
Fabric's own message is left out of the output, because it can repeat what the harness printed, including secrets NemoClaw can't recognize to redact.
NemoClaw keeps it in `diagnostics/fabric-SANDBOX.json` in the deployment's state directory, and the error names that file: `Fabric's message is in PATH`.
On Linux and macOS, only the state directory's owner can read the file.
Inspect it privately before sharing excerpts.
A later failure in the same sandbox replaces it.
Correct the reported conflict before reapplying.
Don't delete retained state to hide drift.
