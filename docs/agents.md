<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Configure and Access Native Agents

NemoClaw owns deployment resources, credential routing, isolation policy, and the lifecycle of the agent runtime.
Fabric owns adapter identifiers, descriptors, native configuration schemas, and native process behavior.
Use the descriptor installed in the selected image to establish what that adapter accepts.
An SDK parser accepting a field does not establish native support.

## Configure the Harness

Set `harness.kind` to the exact Fabric adapter identifier and select an image containing that adapter.
For example, the [OpenClaw configuration](../examples/inference-tuning.yaml) uses `nvidia.fabric.openclaw`.
Identifiers are opaque strings; NemoClaw does not translate short aliases or maintain a native harness allowlist.

Put adapter settings in `harness.settings` and model settings in each route's `overrides.settings`.
These objects retain their exact authored values, including nested nulls.
For public Fabric configuration such as MCP, telemetry, or a workflow, use `harness.config`.
Deployment-owned fields, including metadata, adapter identity, and resolved model connections, cannot be overridden through that object.
See [the SDK configuration projection](../crates/nemoclaw-sdk/src/fabric_config.rs) for the deployment boundary.

Plan checks that the selected image provides the harness at NemoClaw's Fabric revision; a mismatched revision leaves compatibility unknown.
Fabric validates the configuration through its installed API when the agent is configured, so a configuration the harness rejects fails during apply ([#13319](https://github.com/NVIDIA/NemoClaw/issues/13319)).
Neither check establishes successful model inference.

## Choose Native Access

Select the deployment's [OpenShell gateway and workspace](interfaces.md#select-the-gateway-and-workspace) before forwarding ports or running sandbox commands.
Fabric's adapter contract defines supported input, output, native interfaces, and authentication.
The [Fabric documentation](https://github.com/NVIDIA/NeMo-Fabric/tree/main/docs) owns native integration guidance; use the source revision pinned in the selected image when following it.
A successful generic invocation does not imply that every result has an `output.response` field.

### Deploy Several Agents

Each sandbox owns one agent runtime and its selected model/provider attachments.
Use several sandbox definitions to isolate agents, credentials, and lifecycles.
The [multiple-agent example](../examples/multiple-models.yaml) demonstrates shared inference definitions with independent sandbox selections.
An agent's model choices do not restrict other processes within its sandbox beyond the sandbox's provider and network policy.

### Run One Deep Agents or Pi Request

Use the exact adapter's public Fabric input contract and inspect its public result contract.
Inside the sandbox, `fabric-agent invoke --agent NAME --input FILE` reads one JSON value from a file and returns Fabric's result in `result.fabric_result`.
Use `--input -` to read the value from stdin instead; see the [bridge commands](design/fabric-management.md#bridge-commands).
The bridge passes the value to Fabric unchanged; the bundled adapters use a string as the prompt and send any other value as its JSON text.
A request can incur inference charges and affect retained agent history.
Do not assume a universal result shape.
No request walkthrough has been rehearsed yet ([#12642](https://github.com/NVIDIA/NemoClaw/issues/12642)).

### Run One Headless OpenClaw Request

Headless operation follows the same public Fabric invocation boundary.
The [pinned OpenClaw adapter](https://github.com/NVIDIA/NeMo-Fabric/blob/5574117feb4be948c1b03f4c36a2fe9a11af910d/adapters/python/openclaw/README.md) takes a text prompt and sends it to the native OpenClaw agent selected by `harness.settings.agent_id`, which defaults to `default`.
A request can incur inference charges and affect retained conversation history.

With a configured runtime, run this from any directory inside the target sandbox when its YAML `agent.name` is `assistant`:

```sh
fabric-agent invoke --agent assistant --input - <<'JSON'
"Reply with exactly READY."
JSON
```

The command's `--agent` selects the deployment's YAML `agent.name`; the input is one JSON value, here the prompt string.
On success, inspect `result.fabric_result.status` and `result.fabric_result.output.response`; a successful command does not establish general model compatibility.
If later invocations fail with `runtime_unavailable`, replace the sandbox using the [CLI replacement procedure](usage.md#replace-workloads-after-an-unusable-openclaw-runtime).
Host-side invocation tooling remains follow-up work ([#12642](https://github.com/NVIDIA/NemoClaw/issues/12642)).
To reach an agent from the client host, see [agent interfaces](interfaces.md).

## Native Controls at Initialization

Author native controls through the selected adapter's settings and model schemas.
NemoClaw does not supply per-harness defaults, compatibility matrices, or alternate native adapters based on those controls.
Settings accepted by a different adapter or revision are not evidence that the selected image accepts them.

## Agent Tool Restrictions

The shared `agent.tools` form supplies an explicit `allow` list.
The SDK projects those identifiers into public Fabric `tools.enabled`; Fabric owns their meanings and validates the adapter's tool contract.
The SDK does not rename tool identifiers or infer which native tools are read-only.
Use a policy supported by the selected adapter and verify the actual tool behavior separately.
Native disclosure or tool-search controls belong in adapter settings.

Tool selection is separate from OpenShell filesystem and network isolation.
A native tool policy does not revoke a credential or network grant already available to another process in that sandbox.
See [security](security.md) for the deployment boundary.

## OpenClaw Execution Settings

The shared `harness.execution.timeoutSeconds` value maps to public Fabric `runtime.timeout_seconds`.
Omission uses Fabric's default; NemoClaw does not choose a native timeout from the adapter name.
The adapter's own startup, connection, and shutdown timeouts belong in `harness.settings` under the schema supplied by Fabric.
See the [full OpenClaw example](../examples/full-featured-openclaw.yaml) and [timeout budgets](inference.md#understand-timeout-budgets).

## OpenClaw Tracing

The pinned OpenClaw adapter supports neither Relay telemetry nor native OpenTelemetry.
Review [trace data exposure](security.md) before enabling collection for another harness.

## Hermes Relay Tracing

Relay configuration belongs to Fabric's public configuration and the exact Hermes adapter contract.
It does not trigger adapter selection in NemoClaw.
Do not infer native API availability from a tracing setting.
Relay configuration, trace artifacts and retained sessions have not been tested live ([#12642](https://github.com/NVIDIA/NemoClaw/issues/12642)).

## Define and Attach Integrations

Define an integration in `spec.integrations` or a sandbox's `integrations` map and attach it through the agent's `integrationRefs`.
An agent can also declare its own inline `integrations` map.
The [shared authoring rules](configuration-references.md#the-authoring-rule) define scope, references, and collisions.

The managed `kind: webSearch` integration supports Brave and Tavily credential routing.
One sandbox can attach one search definition; unused enclosing definitions create no resources, credential requirements, or grants.
The managed binding does not enable a native search tool.
Declare its native plugin or public Fabric MCP configuration separately and validate it against the selected adapter.
A deployment credential grant is not a native capability claim.

## Skills on a Mounted Volume

Fabric reads skills from the paths in `fabric_agent`'s `skills` block.
To give an agent skills that outlive its sandbox, mount a volume into the sandbox with `openshell_sandbox`'s [`driver_config`](provider.md#openshell-resources-and-data-sources) and point `skills` at the mount.
This is available in HCL only, with a gateway configured to allow driver configuration.

```hcl
resource "openshell_sandbox" "assistant" {
  # ...
  driver_config = jsonencode({
    docker = {
      mounts = [{ type = "volume", source = "assistant-skills", target = "/sandbox/skills" }]
    }
  })
}

resource "fabric_agent" "assistant" {
  # ...
  skills {
    paths = ["/sandbox/skills"]
  }
}
```

OpenShell's mount settings decide whether the agent can write to the volume, and the sandbox's filesystem policy decides which paths its process may read or write.
The volume's contents persist when the sandbox is replaced, including anything the agent writes there.
How the volume gets its contents is up to the platform; OpenShell's documentation describes the volume labels it requires.

## Web Search

Declare the credential reference and attach the definition to each agent that searches:

```yaml
agent:
  name: researcher
  integrations:
    search:
      kind: webSearch
      provider: brave
      credential:
        env: BRAVE_API_KEY
```

Use `provider: tavily` for Tavily; the [web search example](../examples/web-search.yaml) shows two agents sharing one definition.
Set the referenced variable on the applying host through your secret-management mechanism.
NemoClaw creates a workspace-scoped provider profile and credential-bearing provider in OpenShell.
The sandbox receives a placeholder, `BRAVE_API_KEY` or `TAVILY_API_KEY` even when the host reference has another name, and OpenShell substitutes the real key for authorized requests to the search API.
Exported YAML and OpenTofu state retain the host reference, not its value.
Destroy removes the owned provider and profile without revoking the upstream key.
Unchanged apply does not rotate a changed value behind an unchanged reference; follow [credential retirement](security.md#credentials-and-authentication) when replacing or revoking the key.

The reserved `nemoclaw-brave` and `nemoclaw-tavily` policy rules permit the search API's paths for the harness's executables.
Explicit policy cannot reuse those names, and inference provider names cannot use the reserved `brave-search` or `tavily-search` registration prefixes.
Unused definitions create no resources or credentials.

OpenShell supplies the credential and the network grant; the agent's own tools make the search requests.
NemoClaw does not install search plugins or configure harness-native search.
OpenClaw's Brave and Tavily plugins can't be configured through Fabric's OpenClaw adapter ([#13361](https://github.com/NVIDIA/NemoClaw/issues/13361)).
The [managed search tests](../crates/nemoclaw-sdk/tests/web_search.rs) cover profile selection, grants, credentials, and authored scope; native tool behavior, account quota, and live search results require separate qualification ([#12641](https://github.com/NVIDIA/NemoClaw/issues/12641)).

## Pi Model Selection

The [Pi example](../examples/fabric-pi.yaml) selects a model by name.
For a model Pi does not ship, which includes every model served through OpenShell's inference gateway, Pi needs the model's API, context window, and output limit:

```yaml
overrides:
  model: qwen3:4b
  maxTokens: 4096
  extensions:
    context_window: 32768
```

NemoClaw sends the provider's API to any adapter whose Fabric descriptor declares a model `api`; set it in `extensions` only to override that.
`extensions` holds the model fields the selected adapter declares, and Fabric validates them; it cannot set a field the deployment already sets.
The SDK preserves each named route plus the `default` role.

Any model or settings update replaces the agent and its sandbox, deleting the sandbox's files and conversations; keep data that must survive on a [mounted volume](#skills-on-a-mounted-volume).

## Runtime Lifecycle

Build the selected agent image with its installed Fabric metadata using the [image procedure](build.md#build-agent-images).
Use an immutable image reference available to the sandbox compute daemon.
Deployment identity and ownership checks protect provider registrations and retained storage.

The runtime host validates public Fabric configuration before starting a runtime.
Apply calls configure after OpenTofu establishes the required dependencies.
Configure preserves an unchanged runtime or stops it before starting the replacement; removing `fabric_agent` calls prepare, which stops the runtime and clears the applied configuration.
OpenTofu retains desired configuration; the host remembers only its active configuration in memory and waits for apply after a host restart.
Unchanged configuration does not request inference or restart the runtime.
The host reports its active runtime identity and remembered public configuration.
This observation is not a native filesystem audit or proof of successful inference.

Export checks owned resource bindings and the observed public configuration against retained intent.
Unknown, missing, or conflicting observations preserve state for inspection.
Destroy removes owned deployment resources according to their retention policy; it does not revoke external provider credentials.
Keep the matching bundle and state for teardown of older deployments instead of adopting them implicitly.

## Additional Agent Integrations

Fabric's public MCP, workflow, telemetry, and adapter settings remain available through `harness.config` and `harness.settings`, subject to its canonical schemas.
NemoClaw does not provision every external service named by those objects.
Declare required deployment egress and credentials explicitly and follow the owner's lifecycle instructions.
Configuration acceptance is distinct from native behavior, external service availability, and live qualification.
