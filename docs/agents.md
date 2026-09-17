<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Agent Runtimes and Native Access

OpenClaw runs through Fabric, using `sandboxes[].harness: {kind: openclaw}`.
The default sandbox image is the pinned Fabric OpenClaw image.
Fabric owns the agent process inside the sandbox, while OpenShell owns isolation and inference routing.

Native channel enrollment, pairing, plugins, histories, and workspace data belong to the agent.
NemoClaw checks its reserved gateway and inference settings without replacing unrelated settings.

Use the [harness matrix](reference/fabric-harnesses.md) to choose an accepted `harness`, its management modes, and a maintained example.
API and native-interface requirements differ between harnesses.

The strict schema rejects unsupported combinations.
See [inference configuration](inference.md) for API selection, OpenClaw route tuning, and Hermes authentication.

## Configure the Shared Harness

Each sandbox selects one harness implementation.
Each sandbox must select exactly one configuration: inline `harness: {kind: openclaw}` or `harnessRef` from visible `harnesses` definitions.
Every agent is an instance of the sandbox-selected harness implementation; multiple agents may share one runtime process.
Agents retain their own inference choices, tools, and integrations.
Execution defaults, tracing, and native interfaces belong inside that configuration; they no longer belong to the first agent.
A shared definition reuses settings, not a running process across sandboxes.
See [shared harness definitions](configuration-references.md#reference-a-harness-configuration) for an example.

Agent-level `harness` and `harnessRef`, the former scalar `harness`, and agent-level `execution`, `observability`, and `interfaces` fields are rejected.
Move the harness selection to the sandbox and keep execution, observability, and interfaces inside the typed harness configuration.
Use the matching previous bundle for retained deployments; editing YAML does not migrate their state or native data.

## Choose Native Access

Start with the shared [first-deployment procedure](get-started.md) for bundle, image, YAML, state, and lifecycle concepts.
That procedure uses the OpenClaw dashboard; it is not a dashboard guide for every harness.

| Agent | Access and conversation behavior |
|---|---|
| OpenClaw | [Headless request](#run-one-headless-openclaw-request) or optional [dashboard](interfaces.md#openclaw-dashboard); Fabric owns a native gateway with a session per declared agent |
| Hermes | Default local adapter: [HTTP API, dashboard, and browser TUI](interfaces.md#hermes-api-dashboard-and-browser-tui), with separate API/dashboard conversations; experimental [Relay tracing](#hermes-relay-tracing) can accompany explicitly declared interfaces |
| Deep Agents | [One-shot Fabric invocation](#run-one-deep-agents-or-pi-request); starts a separate runtime using the named agent's route |
| Pi | [One-shot Fabric invocation](#run-one-deep-agents-or-pi-request) and a process-local conversation; see [Pi model selection](#pi-model-selection) before updates |
| Other Fabric harnesses | Fabric hosts the native process; a complete user-facing first-message/access procedure for each harness is **TBD** |

Use the deployment's gateway and workspace for OpenShell access; [interface selection](interfaces.md#select-the-gateway-and-workspace) explains how to identify them.
NemoClaw has no `launch`, `connect`, or invocation command.
Do not start a separate Fabric SDK `run` expecting to attach to the runtime already hosted by the deployment.
Native channel/plugin capabilities need their own prerequisites; see [integration gaps](#additional-agent-integrations).

### Multiple Deep Agents in One Sandbox

Declare each instance under the sandbox’s `agents`, with its own inference, tools, and integration references.
Each instance selects one model and has a separate Fabric runtime; all use the sandbox-selected Deep Agents harness.
With multiple agents, workspaces are `/sandbox/workspaces/<agent-name>` and artifacts are `/sandbox/artifacts/<agent-name>`.
Single-agent deployments retain `/sandbox/workspace` and `/sandbox/artifacts`.
These directories separate native state, not permissions or network access within the sandbox.

Apply checks every hosted configuration and reports each agent’s Fabric health separately.
A failed startup stops runtimes already started by that launch.
Changing the roster changes the immutable sandbox launch configuration; use a fresh deployment and an image built from this revision.
To invoke a specific agent through the SDK procedure below, pass its declared name to `configuration()`.

### Run One Deep Agents or Pi Request

Use an already applied Deep Agents or Pi deployment, a compatible current image, and an API/model you can invoke.
Its gateway and inference may be managed or external.
Follow its [harness matrix entry](reference/fabric-harnesses.md) and the shared [deployment procedure](usage.md) to create it first.
This call starts a separate Fabric runtime inside the sandbox and sends a real model request, which can incur charges.
It shares the selected agent’s workspace with its hosted runtime and can use that agent’s tools; it writes invocation artifacts to `/sandbox/sdk-smoke`.
Use an idle sandbox you own and preserve any files you need before running it.
It does not attach to or resume the hosted runtime's conversation.

After [selecting the gateway and workspace](interfaces.md#select-the-gateway-and-workspace), run this from any directory on the client host.
Replace the sandbox and agent names with those in your YAML; the command below uses `assistant` for both.
For a Deep Agents sandbox, replace the final `pi` argument with `deepagents`:

```sh
openshell sandbox exec -n assistant --timeout 360 --no-tty --no-login-shell -- /opt/fabric/bin/python -c '
import asyncio, json, sys
sys.path.insert(0, "/opt/nemoclaw")
from fabric import configuration
from nemo_fabric import Fabric, FabricConfig
config = configuration(sys.argv[1], sys.argv[2])
config["runtime"]["artifacts"] = "/sandbox/sdk-smoke"
result = asyncio.run(Fabric().run(
    FabricConfig.model_validate(config),
    input="Reply with exactly the word FOUR.",
    base_dir="/sandbox",
))
print(json.dumps(result.to_mapping()))
' assistant pi
```

This uses the selected agent’s default model.
For Pi with multiple routes, replace the `input` string with `{"prompt": "Reply with exactly the word FOUR.", "model": "smart"}`, using a declared route name.
Use the plain string for a single-model Pi deployment.

Verify JSON `status: "succeeded"`, no non-null `error`, and an actual `output.response` containing the requested reply.
A zero process exit or echoed prompt alone does not prove a successful agent response.
If execution fails or the connection is lost, inspect the returned error and retained invocation artifacts before deciding whether another model/tool call is safe; do not automatically replay an uncertain invocation.
Retire the sandbox using [deployment destroy](usage.md#destroy), which deletes its workspace and invocation artifacts.

This follows the [native access test](../crates/nemoclaw-e2e/tests/fabric_live.rs) and [retained Linux ARM64 result](validation/rust-fabric-live-linux-arm64.json) at revision `b549ccd43e6102b72aa9c65ee17abfe3c429fc0b`.
That result confirmed a short Deep Agents reply through OpenShell and preservation of the hosted runtime identity.
The [Spark example checks](validation/spark-examples-linux-arm64.md) add Pi and managed-model results.
Neither result qualifies conversation recovery or every model/tool combination.

### Run One Headless OpenClaw Request

Use an applied OpenClaw deployment with `harness.interfaces` omitted; for dashboard-enabled deployments, use the [authenticated dashboard](interfaces.md#openclaw-dashboard).
This command uses the existing native gateway and a named conversation separate from Fabric's hosted conversation.
It can invoke the agent's tools, change workspace files, and incur model charges.
Repeating the command continues this native conversation; its history remains in the sandbox until it is deleted.

After [selecting the gateway and workspace](interfaces.md#select-the-gateway-and-workspace), run this from any directory on the client host.
Replace the sandbox name `openclaw`, agent name `assistant`, and session key with your own values:

```sh
openshell sandbox exec -n openclaw --timeout 360 --no-tty --no-login-shell \
  --env OPENCLAW_HOME=/sandbox \
  --env OPENCLAW_STATE_DIR=/sandbox/.openclaw \
  --env OPENCLAW_CONFIG_PATH=/sandbox/.openclaw/openclaw.json \
  -- /usr/local/bin/node /app/openclaw.mjs agent \
  --agent assistant --session-key agent:assistant:spark-demo \
  --message "Reply with exactly the word FOUR." --timeout 300 --json
```

A new session uses the agent’s default model unless `--model` is supplied.
For multiple declared routes, append `--model oracle` to select that model alias for the request; use your declared route name.
Omitting `--deliver` keeps the reply in the terminal rather than delivering it through a native messaging channel.
Verify JSON `status: "ok"`, an actual reply in `result.payloads[].text`, and no `result.meta.error`, `result.meta.aborted`, or payload `isError`.
A gateway acknowledgment alone does not establish a completed agent response.
If the command fails or disconnects, inspect `/sandbox/.openclaw/gateway.log` before deciding whether another request is safe; do not automatically replay an uncertain tool invocation.
This headless path uses the sandbox-local gateway's existing authentication configuration and does not create or read a dashboard token.

## Native Controls at Initialization

The adapters write these settings when first creating native configuration:

| Runtime | Initial settings and meaning |
|---|---|
| OpenClaw | Nested native sandbox mode `off`; execution host `gateway` and mode `full`, inside the OpenShell sandbox; coding tool profile |
| OpenClaw | Memory search, cron, update checks, and automatic updates disabled |
| Hermes local adapter | Local terminal backend in `/sandbox/workspace`, manual approvals, and `agent.max_turns: 8`; these settings also apply with Relay and explicit interfaces |
| Hermes Relay without explicit interfaces | Upstream Fabric defaults `HERMES_YOLO_MODE=1` and `HERMES_ACCEPT_HOOKS=1` when unset; it does not install the local adapter's manual-approval configuration |

The nested OpenClaw sandbox setting does not disable the outer OpenShell sandbox.
These defaults do not guarantee that arbitrary native tools are harmless or supply missing integration prerequisites.
The [OpenClaw adapter](../image/fabric/openclaw_adapter.py) checks reserved gateway, inference, execution, and declared integration settings.
It also compares the full owned agent and tool sections; other native fields are not all checked for drift.
The default [local Hermes adapter](../image/fabric/hermes_adapter.py) compares the generated top-level configuration sections, including terminal, approval, and turn settings.
Readiness rejects conflicts in those checked fields; it does not continuously rewrite native configuration or enforce every initialization default.

## Multiple OpenClaw Agents and Tool Restrictions

A sandbox accepts one or more uniquely named OpenClaw agents.
Agents share one harness runtime and can select different [named model choices](inference.md#give-an-agent-multiple-model-choices).
Deep Agents also supports multiple agents, each with its own Fabric runtime. Other harnesses require one agent.
Plain-text OpenClaw Fabric invocations require exactly one declared agent.
With multiple OpenClaw agents, use an input object containing `agent` and `message`; there is no implicit default agent.
Native OpenClaw commands can select any declared agent by name.
The local Fabric adapter also accepts an input object with `agent` and `message` fields; it rejects undeclared names before invocation.

Build the selected harness image from this revision before using read-only policies; older Deep Agents and Pi images do not apply the mapping.
Follow [Build Agent Images](build.md#build-agent-images) and select its immutable digest.
Declare a read-only tool policy on an OpenClaw, Deep Agents, or Pi agent:

```yaml
tools:
  allow: [read]
```

Only this allowlist is supported; empty lists, other tools, wildcards, and additional grant fields are rejected.
The policy selects native `read` in OpenClaw/Pi and `read_file` in Deep Agents; other tool calls are blocked.
Omitting `tools` preserves the harness defaults.
OpenClaw also defaults to progressive discovery.
This policy restricts the agent's tools, not filesystem access for other processes in the shared sandbox.
Each OpenClaw agent has a distinct session and workspace at `/sandbox/workspaces/<agent-name>`, independent of declaration order.
Single-agent Deep Agents and Pi use `/sandbox/workspace`.
Those directories are not separate security boundaries.

An unrestricted OpenClaw agent can select tool disclosure instead of an allowlist:

```yaml
tools:
  disclosure: direct
```

`progressive` uses structured tool search with a default limit of 8 and a maximum of 20 results.
`direct` disables tool search and exposes permitted tools directly.
Disclosure changes tool presentation, not permissions; progressive search and calls retain the read-only allowlist.
The `allow` and `disclosure` forms are mutually exclusive.
OpenClaw configures disclosure once per gateway, so unrestricted agents in a sandbox must select the same mode.
An unrestricted agent that omits `tools` selects progressive; read-only agents use the shared mode without selecting it.
If every agent is read-only, the shared mode is progressive.
Conflicting modes are rejected before deployment.

For OpenClaw, NemoClaw owns the native agent roster, agent defaults, and tool configuration.
Startup, refresh, and export reject conflicting native settings without overwriting them.
Unrelated channels, pairing, and plugin settings remain native configuration.
Changing the declared roster, tool policy, or disclosure mode changes the sandbox launch specification; it is not an in-place permission update.

Build the updated OpenClaw image using the [runtime build procedure](#runtime-lifecycle) and put its printed immutable digest in `image.ref`.
Earlier images do not implement the agent-roster and disclosure interface.
Changing YAML alone does not update an existing image or migrate retained native configuration.

See [agent interfaces](interfaces.md) for OpenClaw and Hermes dashboard, API, and browser-TUI access.

## OpenClaw Execution Settings

Set optional execution defaults inside the selected `harness`:

```yaml
execution:
  timeoutSeconds: 900
  heartbeatEvery: 30m
```

For OpenClaw, `timeoutSeconds` sets the native agent-turn and provider-request budgets and defaults to 600 seconds when omitted.
Fabric's outer deadline includes time for the gateway response and cleanup.
Startup, readiness, and explicit inference probes retain [separate budgets](inference.md#understand-timeout-budgets).

Omitting `heartbeatEvery` leaves OpenClaw's native heartbeat defaults in place.
An explicit interval uses an isolated heartbeat session; `0m` disables heartbeat.
Use a whole number followed by `s`, `m`, or `h`.
See the [execution field reference](reference/configuration.md#agentexecution) for bounds.

Execution settings apply to the shared OpenClaw gateway defaults.
Select these settings once on the sandbox; use `harnessRef` to reuse a named configuration.
Other harnesses accept `execution.timeoutSeconds` as the Fabric invocation timeout, defaulting to 300 seconds; they reject `heartbeatEvery`.
Empty `execution` objects are rejected.
Export preserves explicit settings and leaves omitted fields absent.

Build the updated image using the [runtime build procedure](#runtime-lifecycle) and use its immutable digest in a fresh deployment.
Earlier images do not implement these execution settings or defaults.
Changing execution settings changes the sandbox launch specification; it is not an in-place update.
Startup, refresh, and export reject conflicting retained native timeout or heartbeat settings without overwriting them.
Restore the expected settings before retrying, or use a fresh deployment with separate state and storage.

## OpenClaw Tracing

Declare `observability` inside the selected OpenClaw `harness`:

```yaml
observability:
  otlp:
    enabled: true
    endpoint: http://host.openshell.internal:4318
    serviceName: my-agent
    sampleRate: 1
```

The collector must already be running and reachable from the sandbox at this host alias and port.
NemoClaw configures the native diagnostics plugin to send traces using OTLP/HTTP protobuf; it does not create the collector.
This profile excludes metrics, logs, collector credentials, and custom headers.
Omit `observability` to leave native telemetry unconfigured.
The [field reference](reference/configuration.md#otlptracing) defines the service-name and sampling bounds.

Enabling tracing adds the `nemoclaw-otlp` policy rule for the native Node executable to POST `/v1/traces` to the collector.
The rule is added to the selected sandbox policy; an explicit rule with that reserved name is rejected.
Export retains the tracing declaration, and refresh checks the resulting policy and native configuration without rewriting drift.
Configuration readiness does not establish collector delivery; verify incoming traces in your collector.

Use an image built with the updated [runtime build procedure](#runtime-lifecycle) and a fresh deployment when changing image or tracing intent.
The offline native test proves trace delivery to a disposable collector; it does not qualify a production collector or its retention settings.

## Hermes Relay Tracing

Enable the experimental tracing path inside the selected Hermes `harness`:

```yaml
observability:
  relay:
    enabled: true
```

Fabric enables Hermes' in-process NeMo Relay integration.
With explicit `interfaces`, it keeps the local API/dashboard adapter. Without `interfaces`, it selects the upstream Fabric adapter.
Relay writes ATOF events and an ATIF trajectory under `/sandbox/artifacts/relay`; it does not run as a sidecar or add network egress.
Full payload capture is disabled.
With native interfaces, ATOF events appear during conversation turns; ATIF export follows native session finalization or graceful process shutdown. An open conversation may not yet have a trajectory file.

To trace the native API and dashboard, combine the declaration above with `interfaces` from [the Hermes interfaces example](../examples/hermes-interfaces.yaml).
The native processes inherit Fabric's generated Relay configuration; API and dashboard conversations remain separate.
The local adapter keeps its manual-approval settings.
Relay also cannot be combined with OpenClaw's `otlp` setting; `enabled: false` is rejected, so omit the declaration to select the default mode.
With `interfaces` omitted, selecting the upstream adapter changes native approval behavior: the [pinned upstream adapter](https://github.com/NVIDIA/NeMo-Fabric/blob/51a28c1aefec56abd877070b6973d0a32a1e3003/adapters/python/hermes/src/nemo_fabric_adapters/hermes/adapter.py) defaults `HERMES_YOLO_MODE` and `HERMES_ACCEPT_HOOKS` to `1` when unset.
Do not rely on the local adapter's manual approvals when evaluating the upstream adapter.
Its native home is under the Fabric artifact root at `.fabric/hermes/runtimes/<runtime-id>`, rather than the local API/dashboard homes.

Build the current Hermes image with the [Fabric image procedure](inference.md#build-an-image-with-the-configuration-interface).
Adapt [the Hermes example](../examples/fabric-hermes.yaml) with your own image, deployment UID, external services and model, then add the declaration above inside its harness configuration.
Use a separate state directory and [plan/apply](usage.md) the new deployment.
Switching adapters changes the sandbox launch specification; ordinary apply refuses replacement, so use a fresh deployment rather than editing an existing sandbox in place.

After a native invocation, inspect artifact names from the client host with the [gateway and workspace selected](interfaces.md#select-the-gateway-and-workspace):

```sh
openshell sandbox exec -n assistant -- ls -R /sandbox/artifacts/relay
```

Replace `assistant` with your sandbox name.
Look for per-session `events.atof.jsonl` and `trajectory-*.atif.json` files; inspect their contents privately before sharing.
Full payload capture being disabled does not establish that every trace is free of private data.
Trace files live in the sandbox and are deleted with it; there is no managed collector or independent archival lifecycle.
Apply does not invoke Hermes or produce conversation traces.
An explicitly requested upstream Relay agent probe uses a normal prompt and updates its in-memory conversation history; that probe is not isolated from the conversation. The local API adapter retains its isolated probe behavior when Relay is enabled.
For Relay with explicit `interfaces`, use the normal local API/dashboard/token procedure. General interactive access to the upstream adapter remains **TBD**.
On failure, preserve deployment state and inspect the original error; do not replay an uncertain invocation merely to produce traces.

The [Fabric configuration](../image/fabric/fabric.py), [observability tests](../crates/nemoclaw-sdk/tests/observability.rs), and [offline adapter experiment](../test/fabric_adapters.py) define this contract.
The experiment checks ordered invocations and trace artifacts against local protocol fixtures; it does not establish production privacy or live-provider qualification.
Use [the Relay fixture procedure](testing/fixtures.md#hermes-relay-tracing-fixture) to reproduce those checks without a live endpoint.

The current image recipe pins Hermes 0.21.0 and Relay 0.7.3, matching the Fabric adapter's declared Relay range.
Treat this as a tracing proof, not the production Relay 0.8 path.
Production migration remains gated on a released Fabric adapter compatible with the released Hermes and Relay tuple, followed by the normal security and live end-to-end qualification.

## Define and Attach Integrations

Define an integration once in `spec.integrations` and select it from each consuming agent's `integrationRefs`.
For reuse only within a sandbox, put the same definition in `spec.sandboxes[].integrations`.
For one agent, define it directly in `spec.sandboxes[].agents[].integrations`; no reference is required.
All three locations use the same [integration type](reference/configuration.md#integration).

Enclosing definitions require an explicit reference; an agent's inline definitions attach directly to that agent.
The [shared authoring rules](configuration-references.md#the-authoring-rule) define visibility, name collisions, and unused definitions.
Only `kind: webSearch` with Brave is currently supported; VoiceClaw and other kinds are rejected.

## Brave Web Search

Declare a shared search integration and attach it to selected OpenClaw or Deep Agents agents.
This fragment omits the deployment's other required fields; the [complete example](../examples/openclaw-web-search.yaml) includes them:

```yaml
spec:
  integrations:
    search:
      kind: webSearch
      provider: brave
      credential:
        env: BRAVE_API_KEY
  sandboxes:
    - name: assistant
      harness: {kind: openclaw}
      agents:
        - name: researcher
          integrationRefs: [search]
        - name: writer
          integrationRefs: [search]
```

For one agent, put the definition directly under its `integrations` field:

```yaml
agents:
  - name: researcher
    integrations:
      search:
        kind: webSearch
        provider: brave
        credential:
          env: BRAVE_API_KEY
```

Inline definitions belong to that agent; use an enclosing definition and references to share one integration.
The native gateway currently supports one attached Brave search definition per sandbox.
Multiple agents may reference that definition, but attaching distinct search definitions is rejected, even when their settings are equal.
Unused enclosing definitions create no provider, policy grant, or secret requirement.

Set the referenced environment variable on the host running `nemoclaw apply`.
NemoClaw resolves that reference locally and creates a workspace-scoped Brave provider profile and credential-bearing provider in OpenShell.
Different sandboxes can use different credential references; each sandbox receives only its selected provider.
Sandboxes using the same reference share one provider registration.
The agent receives OpenShell's placeholder through `BRAVE_API_KEY`; OpenShell's supervisor proxy replaces it with the real key in requests to Brave.
Exported YAML and OpenTofu state retain the host reference, not its value.
Destroy removes the managed provider and profile without revoking the key at Brave.
Unchanged apply does not rotate a changed value behind the same environment reference.

Every attached agent must be an unrestricted OpenClaw or Deep Agents agent.
Selected agents receive `web_search`; OpenClaw explicitly denies it for other agents, while Deep Agents only configures its MCP tool for selected agents.
Read-only policies cannot attach search.
These are native tool restrictions within a shared sandbox, not separate process or filesystem boundaries.
Other harnesses are rejected.

The integration adds a reserved `nemoclaw-brave` policy rule permitting the native Node and Python 3.14 executables to GET `/res/v1/web/search` at `api.search.brave.com:443`.
The supervisor proxy terminates TLS there to inject `X-Subscription-Token`.
An explicit policy cannot reuse this rule name, and inference provider names cannot be `brave-search` or start with `brave-search-`.
OpenClaw uses its native Brave plugin; Deep Agents uses Fabric’s native MCP tool support with a local stdio server.
The integration owns its profile, provider attachment, native tool settings, and agent grants.
Build the selected harness image from this revision and use a fresh deployment; older profiles and images lack the Python search grant and MCP configuration.
Export preserves authored definition scope and references; the adapter's internal agent grants are derived from those attachments.
Profile, attachment, or native configuration drift stops refresh and export without overwriting the conflicting configuration.
Restore the declared settings before retrying.

Build an updated image using the [runtime build procedure](#runtime-lifecycle) and use a fresh deployment when changing integration intent.
For OpenClaw, the builder installs the matching, checksum-pinned Brave plugin; older images do not contain it.
Changing YAML does not update an image or migrate retained native configuration.
Offline OpenClaw tests exercise the native plugin against a disposable HTTP fixture; they do not establish that your Brave key is valid or has quota.

The former `integrations.webSearch.agentRefs` input is rejected.
Move its provider and credential fields into a named `kind: webSearch` definition and put `integrationRefs` on the selected agents.
Retained intent with the old shape is not migrated automatically; use its matching previous bundle for export or teardown.

## Hermes Native Server

With Relay tracing omitted or `interfaces` explicitly declared, Fabric's local Hermes adapter owns one authenticated native HTTP API server per sandbox.
This section's API, token, native-file, and probe-isolation behavior applies to that default adapter.
It invokes the native Responses endpoint and chains completed turns within the Fabric runtime.
A runtime restart starts a new Fabric conversation; native persisted history remains in `/sandbox/.hermes`.
An uncertain invocation stops the server without replay.

NemoClaw owns the named OpenShell provider and selected API in native `config.yaml`.
Configuration drift stops readiness without overwriting retained files.
The private API token in `/sandbox/.hermes/interface-token` is reused across restarts and never enters exported YAML or OpenTofu state.
Only the sandbox user can read the token; it remains with retained native state and is removed when that state is deleted.
Missing or insecure credentials beside existing native configuration stop startup.

The explicit Hermes agent probe invokes the already-running Fabric runtime with a separate conversation.
The probe does not extend the Fabric conversation or store a Responses continuation; native session records may remain.
Apply checks configuration and readiness without invoking this probe.
Managed support does not establish that a particular model has enough context or reliable tool behavior.
Follow the [image prerequisites](inference.md#build-an-image-with-the-configuration-interface), then build with `docker buildx bake hermes --load` and use its immutable digest.
Existing images and native state are not automatically migrated; use a fresh deployment UID and state directory when switching from the embedded Hermes adapter.

## Pi Model Selection

Pi receives each model ID from `inference.routes[].overrides.model`.
Declare named routes and an explicit `inference.default` when supplying multiple choices.
Each choice retains its own provider endpoint, credential reference, and native model metadata.
Omit `piModel` to use that model's OpenAI catalog entry.
When supplied, `piModel` is an opaque object passed to Pi as a native `models.json` model definition:

```yaml
overrides:
  model: qwen3:4b
  piModel:
    api: openai-completions
    contextWindow: 8192
    maxTokens: 2048
    reasoning: false
    input: [text]
```

NemoClaw checks that `piModel` is an object.
Pi owns its fields, defaults, and validation.
Native options such as `cost`, `compat`, `samplingParams`, and `thinkingLevelMap` pass through, including nested null values.

NemoClaw always supplies the route's model ID and selected provider endpoint; `id` and `baseUrl` inside `piModel` cannot replace them.
Credentials remain supplied through OpenShell.

Use Pi's native `contextWindow` and `maxTokens` names; the former NemoClaw `contextTokens` and `maxOutputTokens` names are no longer translated.
Set limits and capabilities to match your endpoint.
Pi rejects invalid native values at startup, with resources retained for a corrected apply.

The optional inference probe uses Pi's native model API; apply does not invoke it.

Apply configures Pi after attaching the native provider.
For a single declared choice without a tool policy, applying changed model IDs or metadata restarts Pi in the existing sandbox.
With multiple choices or a tool policy, changing the declared catalog changes the sandbox launch configuration and requires a fresh deployment.
Changes to provider attachments also require a new sandbox.
Unchanged apply preserves the runtime.

Within one Fabric runtime, use `runtime.invoke(input={"prompt": "...", "model": "fast"})` to select a declared route by name.
Subsequent plain-string requests keep the selected model; switching choices preserves the Pi conversation.
An unknown choice fails before inference.
This requires the updated Pi image; it does not provide automatic fallback or model routing.

Pi's in-memory conversation does not survive a runtime restart.
Export and readiness compare the hosted configuration with the declared model.
After a sandbox process restart, apply again to start Pi with the current model configuration.

Build the updated Pi image and select its immutable reference as described in [Build Agent Images](build.md#build-agent-images); old Pi images do not implement this configuration interface.
Existing sandbox images are immutable, so use a separate deployment to move from an old image.
The [Pi example](../examples/fabric-pi.yaml) includes explicit custom-model metadata.

```sh
docker buildx bake pi --load
python3 tools/fabric-adapter-experiment.py --harness pi
python3 tools/fabric-adapter-experiment.py --harness pi --pi-catalog
```

Both tests use offline protocol fixtures and real Pi processes.
They check request model IDs, unchanged apply, model changes, and shutdown.

## Runtime Lifecycle

Fabric is the only runtime integration, so agents have no `type` field.
Remove `type: fabric` from older YAML.
The strict schema rejects the obsolete field.

Previously retained intent files still contain that field and are not migrated by this schema change; use their previous bundle for export or teardown.

The former `type: openclaw` standalone launcher is no longer supported.
Existing standalone deployments are not automatically converted or replaced; use their previous bundle to export or tear them down before provisioning a Fabric deployment.
Changing YAML alone does not migrate agent files or conversations.

Build a local Linux ARM64 image with:

```sh
docker buildx bake openclaw --load
```

The [agent image builder](build.md#build-agent-images) runs the pinned toolchains inside Docker.
Use the resulting immutable image reference in the sandbox's `image.ref`.
See [the source notice](../image/NOTICE.md).

Fabric's local OpenClaw adapter owns one native gateway with a session for each declared agent.
An uncertain invocation result stops that runtime and is never replayed automatically.
Agent configuration readiness does not invoke the model.

Apply stops at configuration and readiness checks; verify a native agent reply separately.
The adapter preserves unrelated native configuration and rejects conflicts in deployment-owned settings.

With the [offline fixture prerequisites](testing/fixtures.md#inference-api-fixtures), run from the repository root:

```sh
docker buildx bake check
python3 tools/fabric-adapter-experiment.py --harness openclaw --interfaces --inference-api openai-responses
```

The check targets provide their verified source and dependencies inside disposable build stages.
The harness tests use disposable containers and retain evidence under `.local`.
They do not send external messages.
[Harness evidence](validation/rust-fabric-adapters-linux-arm64.json) distinguishes protocol fixtures from complete live inference qualification.
The [historical native messaging result](validation/rust-native-openclaw-linux-arm64.json) records the retired Telegram fixture with its source hashes; current tests leave messaging-channel pairing and message delivery to OpenClaw.

Real messaging deployment still needs generic egress, mounted secrets, and retained sandbox storage that this desired-state schema does not provision.
Use native OpenClaw commands through OpenShell sandbox access; there is no NemoClaw invocation or channel-management API.

A Fabric SDK `run` starts a new runtime rather than attaching to the one hosted by NemoClaw.

[Live Fabric qualification](validation/rust-fabric-live-linux-arm64.json) covers Deep Agents, Hermes, and Fabric OpenClaw.
Hermes rejects the example DGX Spark service's 32K context; its successful short-response run used Ollama/Qwen3.
This does not qualify long-context accuracy or general tool-use reliability.

[Fabric-only OpenClaw validation](validation/rust-fabric-only-openclaw-linux-arm64.json) records the former managed-apply agent probe, a real response through OpenShell, unchanged apply, export/reapply, and stable Fabric runtime identity at its recorded revision.
The test creates and removes an owned sandbox against an existing inference service.

## Additional Agent Integrations

The `integrations` field currently supports [Brave web search](#brave-web-search).
[OpenClaw tracing](#openclaw-tracing) and experimental [Hermes Relay tracing](#hermes-relay-tracing) use the separate `observability` field.
Native agent capabilities do not by themselves establish a complete NemoClaw deployment procedure.

| Workflow | Documentation status |
|---|---|
| Messaging channels, including Discord, Google Chat, Teams, Slack, Telegram, WeChat, and WhatsApp | **TBD** — needs verified enrollment, egress, credentials, and data-retention procedures |
| Gmail with an app password | **TBD** — needs a verified native client, protected credential delivery, egress policy, and file-retention procedure |
| Managed MCP bridge and server add/update/remove | **TBD** — no equivalent current NemoClaw CLI workflow |
| Arbitrary OpenClaw or Hermes plugin installation | **TBD** — requires a verified image, configuration, and lifecycle procedure; the declared Brave integration is documented above |
| Memory search and embedding-service setup | **TBD** — needs evidence for the endpoint, credentials, policy, and native settings |
| Context compaction configuration | **TBD** — verify behavior against the pinned native runtime before reusing earlier guidance |
| Auxiliary-model sub-agents | **TBD** — model choices are configurable, but delegation and consultation behavior are not configured |
| Deep Agents tracing and managed collector lifecycle | **TBD** — the implemented OpenClaw tracing profile uses an existing local collector |
| Verified file/history backup and restoration for each harness | **TBD** — see [deployment state](state.md) |

Use [migration](migration.md) for the earlier-product boundary.
These TBD entries do not extend the current [configuration contract](reference/configuration.md).
