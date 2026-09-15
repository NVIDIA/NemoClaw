<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Agent Runtimes and Native Access

OpenClaw runs through Fabric, using `harness: openclaw`.
The default sandbox image is the pinned Fabric OpenClaw image.
Fabric owns the agent process inside the sandbox, while OpenShell owns isolation and inference routing.

Native channel enrollment, pairing, plugins, histories, and workspace data belong to the agent.
NemoClaw checks its reserved gateway and inference settings without replacing unrelated settings.

An agent selects a `harness` from `deepagents`, `hermes`, `openclaw`, `claude`, `codex`, `mini-swe-agent`, `nooa`, `nooa-bench`, `remote-agent`, or `pi`.
OpenClaw and Hermes support external services, managed OpenShell gateways, and managed DGX Spark or Ollama inference.
Other harnesses currently require external gateway and inference services.

The strict schema rejects unsupported combinations.
See [inference configuration](inference.md) for API selection, OpenClaw route tuning, and Hermes authentication.

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

`timeoutSeconds` limits an agent turn and defaults to 600 seconds when omitted.
Fabric's outer deadline includes time for the gateway response and cleanup.
Startup, readiness, and managed-inference probes retain separate budgets.

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

Managed inference apply additionally checks an actual agent reply.
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
