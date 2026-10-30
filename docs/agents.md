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
Inside the sandbox, `fabric-agent-ctl invoke --agent NAME --runtime-id ID --input FILE` sends one JSON value from a file to the running agent and returns Fabric's run result in `result`.
`ID` is the agent's `runtime_id`, recorded in the deployment's OpenTofu state; the [OpenClaw example](#run-one-headless-openclaw-request) reads it.
Use `--input -` to read the value from stdin instead; see the [bridge commands](design/fabric-management.md#bridge-commands).
Fabric receives the value unchanged; the bundled adapters use a string as the prompt and send any other value as its JSON text.
A request can incur inference charges and affect retained agent history.
Do not assume a universal result shape.
Check `result.status` as well as the outer `status`: the outer one only reports that `fabric-agent-ctl` completed the call, while a failed run reports `result.status: failed` with Fabric's error in `result.error`.
`result.artifacts` names the files Fabric kept for that request, such as the adapter's output.

### Run One Headless OpenClaw Request

Headless operation follows the same public Fabric invocation boundary.
The [pinned OpenClaw adapter](https://github.com/NVIDIA/NeMo-Fabric/blob/6cad35045ea534e096c48f634f739d804baef5ee/adapters/python/openclaw/README.md) takes a text prompt and sends it to the native OpenClaw agent selected by `harness.settings.agent_id`, which defaults to `default`.
A request can incur inference charges and affect retained conversation history.

With a running agent whose YAML `agent.name` is `assistant`, read its runtime ID from the deployment's state directory with `jq`, then send the request from the client host:

```sh
RUNTIME_ID=$(jq -r '.resources[] | select(.type == "fabric_agent") | .instances[].attributes | select(.name == "assistant") | .runtime_id' .local/deployment/terraform.tfstate)
openshell sandbox exec -n assistant --no-tty -- fabric-agent-ctl invoke --agent assistant --runtime-id "$RUNTIME_ID" --input - <<'JSON'
"Reply with exactly READY."
JSON
```

The command's `--agent` selects the deployment's YAML `agent.name`; the input is one JSON value, here the prompt string.
On success, inspect `result.status` and `result.output.response`; a successful command does not establish general model compatibility.
If later invocations fail with `runtime_unavailable`, plan and apply again: apply starts a new runtime in the same sandbox. If the plan shows no change, replace the sandbox using the [CLI replacement procedure](usage.md#replace-workloads-after-an-unusable-runtime).
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
The Hermes image installs Hermes Agent v0.22.5 on Python 3.14 with its Relay 0.10 dependency and the Switchyard Relay plugin 0.3.1.
Under `harness.config`, enable `telemetry.providers.relay` and add Switchyard under `relay.plugins.dynamic`; NemoClaw passes the configuration to Fabric without interpreting it, and Relay owns validation and activation.
Set `manifest` to `/opt/nemo-relay/plugins/switchyard/relay-plugin.toml` and provide either `config.switchyard_config` or `config.switchyard_config_path`.
Do not infer native API availability from a tracing setting.

## Define and Attach Integrations

Define an integration in `spec.integrations` or a sandbox's `integrations` map and attach it through the agent's `integrationRefs`.
An agent can also declare its own inline `integrations` map.
The [shared authoring rules](configuration-references.md#the-authoring-rule) define scope, references, and collisions.

The managed `kind: webSearch` integration supports Brave and Tavily credential routing.
One sandbox can attach one search definition; unused enclosing definitions create no resources, credential requirements, or grants.
The managed binding does not enable a native search tool.
Declare its native plugin or public Fabric MCP configuration separately and validate it against the selected adapter.
A deployment credential grant is not a native capability claim.

## Key-Authenticated APIs

Use `kind: api` when an agent calls an HTTP API, such as an MCP service, with a key the gateway holds:

```yaml
agent:
  name: buyer
  integrations:
    bookings:
      kind: api
      endpoint: https://bookings.example.com/mcp
      credential:
        env: BOOKINGS_API_KEY
```

NemoClaw registers the API with OpenShell for each image and harness that attaches it, as `openshell_api` does in HCL.
OpenShell injects the key into requests to the endpoint's host, port and path subtree, from the harness's executables only, and the sandbox never sees the value.
The key goes in `Authorization` as a bearer token by default; set `authStyle: header` and `headerName` to send the raw value in another header.
Set the referenced variable on the applying host; exported YAML and OpenTofu state retain only the reference.
Whether the harness sends the placeholder depends on the harness; Hermes doesn't yet send it to MCP servers ([#13313](https://github.com/NVIDIA/NemoClaw/issues/13313)).

For OAuth-refresh credentials, use an [operator-managed OpenShell provider](oauth-refresh.md).
NemoClaw does not wrap its refresh contract, and manual sandbox attachments affect drift checks.

## Skills on a Mounted Volume

Fabric reads skills from the paths in `fabric_agent`'s `skills` block.
To give an agent skills that outlive its sandbox, mount a volume into the sandbox through OpenShell's driver configuration and point `skills` at the mount.
The gateway must allow driver configuration: for a managed gateway, set `allow_driver_config: true` in the driver's table of `spec.gateway.config` when you create the deployment (see [mounted volumes](state.md#keep-agent-files-on-mounted-volumes)); for an external gateway, its administrator enables OpenShell's `allow_driver_config`.
In YAML, set the sandbox's `driverConfig` and list the mount in the harness configuration's `skills`:

```yaml
sandboxes:
  assistant:
    driverConfig:
      docker:
        mounts:
          - type: volume
            source: assistant-skills
            target: /sandbox/skills
    harness:
      kind: nvidia.fabric.openclaw
      config:
        skills:
          paths: [/sandbox/skills]
```

In HCL, use `openshell_sandbox`'s [`driver_config`](provider.md#openshell-resources-and-data-sources) and `fabric_agent`'s `skills` block:

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
Set `sandboxEnv` when the harness reads the key under another name; Hermes's Brave plugin, for example, reads `BRAVE_SEARCH_API_KEY`:

```yaml
    search:
      kind: webSearch
      provider: brave
      credential:
        env: BRAVE_API_KEY
      sandboxEnv: BRAVE_SEARCH_API_KEY
```

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
For a model Pi does not ship, which includes every model served through OpenShell's inference gateway, Pi needs the model's API, context window, and output limit.
With the pinned Fabric, Pi also fails a request with `pi_model_error` unless `input` and `cost` are set, although Fabric's schema lists them as optional:

```yaml
overrides:
  model: qwen3:4b
  maxTokens: 4096
  extensions:
    context_window: 32768
    input: ["text"]
    cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}
```

NemoClaw sends the provider's API to any adapter whose Fabric descriptor declares a model `api`; set it in `extensions` only to override that.
`extensions` holds the model fields the selected adapter declares, and Fabric validates them; it cannot set a field the deployment already sets.
The SDK preserves each named route plus the `default` role.

Any model or settings update replaces the agent and its sandbox, deleting its writable layer and in-memory conversation.
Use [mounted agent-data volumes](state.md#keep-agent-files-on-mounted-volumes) for files that must survive; retained files do not by themselves resume a native conversation.

## Runtime Lifecycle

Build the selected agent image with its installed Fabric metadata using the [image procedure](build.md#build-agent-images).
Use an immutable image reference available to the sandbox compute daemon.
Deployment identity and ownership checks protect provider registrations and retained storage.

Fabric validates public Fabric configuration when the runtime starts.
Apply starts the agent after OpenTofu establishes the required dependencies.
A configuration change replaces the agent's sandbox rather than starting another runtime inside it; removing `fabric_agent` stops the runtime.
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
