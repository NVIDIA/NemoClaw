<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Agent Runtimes and Native Access

OpenClaw runs through Fabric, using `harness: openclaw`.
The default sandbox image is the pinned Fabric OpenClaw image.
Fabric owns the agent process inside the sandbox, while OpenShell owns isolation and inference routing.

Native channel enrollment, pairing, plugins, histories, and workspace data belong to the agent.
NemoClaw checks its reserved gateway and inference settings without replacing unrelated settings.

Use the [harness matrix](reference/fabric-harnesses.md) to choose an accepted `harness`, its management modes, and a maintained example.
API and native-interface requirements differ between harnesses.

The strict schema rejects unsupported combinations.
See [inference configuration](inference.md) for API selection, OpenClaw route tuning, and Hermes authentication.

## Choose Native Access

Start with the shared [first-deployment procedure](get-started.md) for bundle, image, YAML, state, and lifecycle concepts.
That procedure uses the OpenClaw dashboard; it is not a dashboard guide for every harness.

| Agent | Access and conversation behavior |
|---|---|
| OpenClaw | Optional [dashboard](interfaces.md#openclaw-dashboard); Fabric owns a native gateway with a session per declared agent |
| Hermes | [HTTP API, dashboard, and browser TUI](interfaces.md#hermes-api-dashboard-and-browser-tui); API and dashboard conversations are separate |
| Deep Agents | [One-shot Fabric invocation](#run-one-deep-agents-request); starts a separate runtime using the deployment's route |
| Pi | Native model metadata and a process-local conversation; see [Pi model selection](#pi-model-selection) before updates |
| Other Fabric harnesses | Fabric hosts the native process; a complete user-facing first-message/access procedure for each harness is **TBD** |

Use the deployment's gateway and workspace for OpenShell access; [interface selection](interfaces.md#select-the-gateway-and-workspace) explains how to identify them.
NemoClaw has no `launch`, `connect`, or invocation command.
Do not start a separate Fabric SDK `run` expecting to attach to the runtime already hosted by the deployment.
Native channel/plugin capabilities need their own prerequisites; see [integration gaps](#additional-agent-integrations).

### Run One Deep Agents Request

Use an already applied `harness: deepagents` deployment with an external gateway and inference endpoint, a compatible current image, and an API/model you can invoke.
Follow its [harness matrix entry](reference/fabric-harnesses.md) and the shared [deployment procedure](usage.md) to create it first.
This call starts a separate Fabric runtime inside the sandbox and sends a real model request, which can incur charges.
It shares `/sandbox/workspace` with the hosted runtime and can use the agent's tools; it writes invocation artifacts to `/sandbox/sdk-smoke`.
Use an idle sandbox you own and preserve any files you need before running it.
It does not attach to or resume the hosted runtime's conversation.

After [selecting the gateway and workspace](interfaces.md#select-the-gateway-and-workspace), run this from any directory on the client host.
Replace `assistant` with the sandbox name and the final `main` with the declared agent name:

```sh
openshell sandbox exec -n assistant --timeout 360 --no-tty -- /opt/fabric/bin/python -c '
import asyncio, json, sys
sys.path.insert(0, "/opt/nemoclaw")
from fabric import configuration
from nemo_fabric import Fabric, FabricConfig
config = configuration(sys.argv[1], "deepagents")
config["runtime"]["artifacts"] = "/sandbox/sdk-smoke"
result = asyncio.run(Fabric().run(
    FabricConfig.model_validate(config),
    input="Reply with exactly the word FOUR.",
    base_dir="/sandbox",
))
print(json.dumps(result.to_mapping()))
' main
```

Verify JSON `status: "succeeded"`, no non-null `error`, and an actual `output.response` containing the requested reply.
A zero process exit or echoed prompt alone does not prove a successful agent response.
If execution fails or the connection is lost, inspect the returned error and retained invocation artifacts before deciding whether another model/tool call is safe; do not automatically replay an uncertain invocation.
Retire the sandbox using [deployment destroy](usage.md#destroy), which deletes its workspace and invocation artifacts.

This follows the [native access test](../crates/nemoclaw-e2e/tests/fabric_live.rs) and [retained Linux ARM64 result](validation/rust-fabric-live-linux-arm64.json) at revision `b549ccd43e6102b72aa9c65ee17abfe3c429fc0b`.
That result confirmed a short Deep Agents reply through OpenShell and preservation of the hosted runtime identity; it does not qualify conversation recovery or every model/tool combination.

## Native Controls at Initialization

The adapters write these settings when first creating native configuration:

| Runtime | Initial settings and meaning |
|---|---|
| OpenClaw | Nested native sandbox mode `off`; execution host `gateway` and mode `full`, inside the OpenShell sandbox; coding tool profile |
| OpenClaw | Memory search, cron, update checks, and automatic updates disabled |
| Hermes | Local terminal backend in `/sandbox/workspace`, manual approvals, and `agent.max_turns: 8` |

The nested OpenClaw sandbox setting does not disable the outer OpenShell sandbox.
These defaults do not guarantee that arbitrary native tools are harmless or supply missing integration prerequisites.
The [OpenClaw adapter](../image/fabric/openclaw_adapter.py) checks reserved gateway, inference, execution, and declared integration settings.
With a declared roster/tool policy it also compares the full owned agent and tool sections; other native fields are not all checked for drift.
The [Hermes adapter](../image/fabric/hermes_adapter.py) compares the generated top-level configuration sections, including terminal, approval, and turn settings.
Readiness rejects conflicts in those checked fields; it does not continuously rewrite native configuration or enforce every initialization default.

## Multiple OpenClaw Agents and Tool Restrictions

A sandbox accepts one or more uniquely named OpenClaw agents.
All agents currently share identical inference settings and the sandbox's single primary route.
Other harnesses still require one agent.
The first declared agent receives plain-text Fabric invocations.
Native OpenClaw commands can select any declared agent by name.
The local Fabric adapter also accepts an input object with `agent` and `message` fields; it rejects undeclared names before invocation.

Declare a read-only tool policy on any OpenClaw agent:

```yaml
tools:
  allow: [read]
```

Only this allowlist is supported; empty lists, other tools, wildcards, and additional grant fields are rejected.
Omitting `tools` selects progressive discovery without restricting tools.
This policy restricts the agent's tools, not filesystem access for other processes in the shared sandbox.
Each agent has a distinct session and workspace; those directories are not separate security boundaries.

An unrestricted agent can select tool disclosure instead of an allowlist:

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

With multiple agents or an explicit tool policy, NemoClaw owns the native agent roster, agent defaults, and tool configuration.
Startup, refresh, and export reject conflicting native settings without overwriting them.
Unrelated channels, pairing, and plugin settings remain native configuration.
Changing the declared roster, tool policy, or disclosure mode changes the sandbox launch specification; it is not an in-place permission update.

Build the updated OpenClaw image using the [runtime build procedure](#runtime-lifecycle) and put its printed immutable digest in `image.ref`.
Earlier images do not implement the agent-roster and disclosure interface.
Changing YAML alone does not update an existing image or migrate retained native configuration.

See [agent interfaces](interfaces.md) for OpenClaw and Hermes dashboard, API, and browser-TUI access.

## OpenClaw Execution Settings

Set optional execution defaults on the first agent in `spec.sandboxes[].agents`:

```yaml
execution:
  timeoutSeconds: 900
  heartbeatEvery: 30m
```

`timeoutSeconds` sets the native agent-turn and provider-request budgets and defaults to 600 seconds when omitted.
Fabric's outer deadline includes time for the gateway response and cleanup.
Startup, readiness, and managed-inference probes retain [separate budgets](inference.md#understand-timeout-budgets).

Omitting `heartbeatEvery` leaves OpenClaw's native heartbeat defaults in place.
An explicit interval uses an isolated heartbeat session; `0m` disables heartbeat.
Use a whole number followed by `s`, `m`, or `h`.
See the [execution field reference](reference/configuration.md#agentexecution) for bounds.

Execution settings apply to the shared OpenClaw gateway defaults.
Only the first agent may declare them; a sandbox still accepts one or more OpenClaw agents.
Other harnesses and empty `execution` objects are rejected.
Export preserves explicit settings and leaves omitted fields absent.

Build the updated image using the [runtime build procedure](#runtime-lifecycle) and use its immutable digest in a fresh deployment.
Earlier images do not implement these execution settings or defaults.
Changing execution settings changes the sandbox launch specification; it is not an in-place update.
Startup, refresh, and export reject conflicting retained native timeout or heartbeat settings without overwriting them.
Restore the expected settings before retrying, or use a fresh deployment with separate state and storage.

## OpenClaw Tracing

Declare tracing on the first OpenClaw agent:

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
Export retains the integration declaration, and refresh checks the resulting policy and native configuration without rewriting drift.
Configuration readiness does not establish collector delivery; verify incoming traces in your collector.

Use an image built with the updated [runtime build procedure](#runtime-lifecycle) and a fresh deployment when changing image or tracing intent.
The offline native test proves trace delivery to a disposable collector; it does not qualify a production collector or its retention settings.

## Hermes Relay Tracing

Enable the experimental Hermes tracing path on the first agent:

```yaml
observability:
  relay:
    enabled: true
```

Fabric then starts Hermes through its upstream adapter and enables Hermes' in-process NeMo Relay integration.
Relay writes ATOF events and an ATIF trajectory under `/sandbox/artifacts/relay`; it does not run as a sidecar or add network egress.
Full payload capture is disabled.

This path cannot be combined with Hermes `interfaces` because the upstream adapter does not provide NemoClaw's local API and dashboard process.
Omit `observability` to preserve the existing local Hermes adapter and its interface behavior.

The current image recipe pins Hermes 0.21.0 and Relay 0.7.3, matching the Fabric adapter's declared Relay range.
Treat this as a tracing proof, not the production Relay 0.8 path.
Production migration remains gated on a released Fabric adapter compatible with the released Hermes and Relay tuple, followed by the normal security and live end-to-end qualification.

## Brave Web Search

Declare web search on the sandbox, using names from its OpenClaw agent list:

```yaml
integrations:
  webSearch:
    provider: brave
    agentRefs: [main]
    credential:
      env: BRAVE_API_KEY
```

Set the referenced environment variable on the host running `nemoclaw apply`.
NemoClaw resolves that reference locally and creates a workspace-scoped Brave provider profile and credential-bearing provider in OpenShell.
The agent receives OpenShell's placeholder through `BRAVE_API_KEY`; OpenShell's supervisor proxy replaces it with the real key in requests to Brave.
Exported YAML and OpenTofu state retain the host reference, not its value.
Destroy removes the managed provider and profile without revoking the key at Brave.
Unchanged apply does not rotate a changed value behind the same environment reference.

`agentRefs` must contain one or more unique, declared, unrestricted OpenClaw agents.
Selected agents receive `web_search`; other unrestricted agents explicitly deny it, and read-only agents retain only `read`.
These are native tool restrictions within a shared sandbox, not separate process or filesystem boundaries.
Other harnesses are rejected.

The integration adds a reserved `nemoclaw-brave` policy rule permitting the native Node executable to GET `/res/v1/web/search` at `api.search.brave.com:443`.
The supervisor proxy terminates TLS there to inject `X-Subscription-Token`.
An explicit policy cannot reuse this rule name, and the inference provider cannot be named `brave-search`.
The integration owns its profile, provider attachment, native plugin settings, and agent tool grants.
Profile, attachment, or native configuration drift stops refresh and export without overwriting the conflicting configuration.
Restore the declared settings before retrying.

Build an updated image using the [runtime build procedure](#runtime-lifecycle) and use a fresh deployment when changing integration intent.
The builder installs the matching, checksum-pinned Brave plugin; older images do not contain it.
Changing YAML does not update an image or migrate retained native configuration.
Offline tests exercise the native plugin against a disposable HTTP fixture; they do not establish that your Brave key is valid or has quota.

## Hermes Native Server

Fabric owns one authenticated native Hermes HTTP API server per sandbox.
It invokes the native Responses endpoint and chains completed turns within the Fabric runtime.
A runtime restart starts a new Fabric conversation; native persisted history remains in `/sandbox/.hermes`.
An uncertain invocation stops the server without replay.

NemoClaw owns the named OpenShell provider and selected API in native `config.yaml`.
Configuration drift stops readiness without overwriting retained files.
The private API token in `/sandbox/.hermes/interface-token` is reused across restarts and never enters exported YAML or OpenTofu state.
Only the sandbox user can read the token; it remains with retained native state and is removed when that state is deleted.
Missing or insecure credentials beside existing native configuration stop startup.

Managed DGX Spark apply probes the already-running Fabric runtime with a separate conversation.
The probe does not extend the Fabric conversation or store a Responses continuation; native session records may remain.
It requires a successful agent response before reporting success; failure retains the established resources.
Managed support does not establish that a particular model has enough context or reliable tool behavior.
Follow the [image prerequisites](inference.md#build-an-image-with-the-configuration-interface), then build with `python3 image/fabric/build.py --harness hermes` and use its immutable digest.
Existing images and native state are not automatically migrated; use a fresh deployment UID and state directory when switching from the embedded Hermes adapter.

## Pi Model Selection

Pi receives the model ID from `inference.routes[].overrides.model`.
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

NemoClaw always supplies the route's model ID and OpenShell endpoint; `id` and `baseUrl` inside `piModel` cannot replace them.
Credentials remain supplied through OpenShell.

Use Pi's native `contextWindow` and `maxTokens` names; the former NemoClaw `contextTokens` and `maxOutputTokens` names are no longer translated.
Set limits and capabilities to match your endpoint.
Pi rejects invalid native values at startup, with resources retained for a corrected apply.

The inference probe also uses Pi's native model API.

Apply configures Pi after creating the route.
A model or metadata change stops Pi before the route changes and starts a new Pi runtime in the existing sandbox.
Unchanged apply preserves the runtime.

Pi's in-memory conversation does not survive a runtime restart.
Export and readiness compare the hosted configuration with the declared model.
After a sandbox process restart, apply again to start Pi against the current route.

Build the updated Pi image and use its printed digest; old Pi images do not implement this configuration interface.
Existing sandbox images are immutable, so use a separate deployment to move from an old image.
The [Pi example](../examples/fabric-pi.yaml) includes explicit custom-model metadata.

```sh
python3 image/fabric/build.py --harness pi
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
python3 image/fabric/build.py --harness openclaw
```

The builder needs Docker, uv, and a native C/Rust toolchain.
It verifies upstream source archives and dependency hashes, then prints the resulting image digest.
Put that immutable digest in the sandbox's `image.ref`.

It does not publish an image.
See [the source notice](../image/NOTICE.md).

Fabric's local OpenClaw adapter owns one native gateway with a session for each declared agent.
An uncertain invocation result stops that runtime and is never replayed automatically.
Agent configuration readiness does not invoke the model.

Managed vLLM service apply additionally checks an actual agent reply; other paths use the configured API probe.
Native settings survive configuration checks and recreation when their state volume is retained.

Qualification commands:

```sh
python3 -m unittest discover -s image/fabric -p test_build.py
python3 tools/openclaw-native-test.py --image nc-prototype-fabric:openclaw
python3 tools/fabric-adapter-experiment.py --harness codex
```

The recipe coverage test needs the checksum-verified Fabric source populated by the builder.
The native messaging and harness tests use disposable containers and retained evidence under `.local`.
They do not send external messages.
[Native messaging evidence](validation/rust-native-openclaw-linux-arm64.json) and [harness evidence](validation/rust-fabric-adapters-linux-arm64.json) distinguish protocol fixtures from complete live inference qualification.

Real messaging deployment still needs generic egress, mounted secrets, and retained sandbox storage that this desired-state schema does not provision.
The Docker fixture supplies those prerequisites locally.
Use native OpenClaw commands through OpenShell sandbox access; there is no NemoClaw invocation or channel-management API.

A Fabric SDK `run` starts a new runtime rather than attaching to the one hosted by NemoClaw.

[Live Fabric qualification](validation/rust-fabric-live-linux-arm64.json) covers Deep Agents, Hermes, and Fabric OpenClaw.
Hermes rejects the example DGX Spark service's 32K context; its successful short-response run used Ollama/Qwen3.
This does not qualify long-context accuracy or general tool-use reliability.

[Fabric-only OpenClaw validation](validation/rust-fabric-only-openclaw-linux-arm64.json) covers the shared managed-apply agent probe, a real response through OpenShell, unchanged apply, export/reapply, and stable Fabric runtime identity.
The test creates and removes an owned sandbox against an existing inference service.

## Additional Agent Integrations

The current declared integrations include [OpenClaw tracing](#openclaw-tracing) and [Brave web search](#brave-web-search).
Native agent capabilities do not by themselves establish a complete NemoClaw deployment procedure.

| Workflow | Documentation status |
|---|---|
| Messaging channels, including Discord, Google Chat, Teams, Slack, Telegram, WeChat, and WhatsApp | **TBD** — needs verified enrollment, egress, credentials, and data-retention procedures |
| Managed MCP bridge and server add/update/remove | **TBD** — no equivalent current NemoClaw CLI workflow |
| Arbitrary OpenClaw or Hermes plugin installation | **TBD** — requires a verified image, configuration, and lifecycle procedure; the declared Brave integration is documented above |
| Memory search and embedding-service setup | **TBD** — needs evidence for the endpoint, credentials, policy, and native settings |
| Context compaction configuration | **TBD** — verify behavior against the pinned native runtime before reusing earlier guidance |
| Auxiliary-model sub-agents | **TBD** — current declared OpenClaw agents share one primary route |
| Deep Agents tracing and managed collector lifecycle | **TBD** — the implemented OpenClaw tracing profile uses an existing local collector |
| Verified file/history backup and restoration for each harness | **TBD** — see [deployment state](state.md) |

Use [migration](migration.md) for the earlier-product boundary.
These TBD entries do not extend the current [configuration contract](reference/configuration.md).
