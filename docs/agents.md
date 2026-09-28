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

Plan invokes Fabric's planner against the selected image's canonical descriptor snapshot.
A missing descriptor contract or mismatched Fabric revision leaves compatibility unknown; a schema rejection is unsupported.
Runtime startup validates the same public configuration through the installed Fabric API.
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
The runtime bridge accepts JSON input through `fabric.py invoke NAME INPUT_JSON` and returns Fabric's result without interpreting native output fields.
A request can incur inference charges and affect retained agent history.
Do not reuse the former NemoClaw `fabric.configuration` helper or assume a universal prompt/result shape.
A qualified native request walkthrough for this migrated runtime remains **TBD**.

### Run One Headless OpenClaw Request

Headless operation follows the same public Fabric invocation boundary.
Native gateway configuration and request semantics belong to the OpenClaw adapter.
For browser access, see [agent interfaces](interfaces.md#openclaw-dashboard).
The former adapter-specific NemoClaw probe commands are not part of the generic runtime contract.

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
Heartbeat and other native scheduling options belong in `harness.settings` under the schema supplied by Fabric.
See the [full OpenClaw example](../examples/full-featured-openclaw.yaml) and [timeout budgets](inference.md#understand-timeout-budgets).

## OpenClaw Tracing

Configure the native adapter through its settings, or public Fabric telemetry through `harness.config` when the owner contract accepts it.
The [full OpenClaw example](../examples/full-featured-openclaw.yaml) preserves native OTLP intent and declares explicit deployment egress.
NemoClaw does not infer collector access from native settings or provision a collector.
Use an existing collector whose access and retention policy meets your requirements.
Review [trace data exposure](security.md) before enabling collection.
Native delivery and live collector qualification remain separate from configuration validation.

## Hermes Relay Tracing

Relay configuration belongs to Fabric's public configuration and the exact Hermes adapter contract.
It does not trigger adapter selection in NemoClaw.
Do not carry forward the former local-versus-upstream adapter switch or infer native API availability from a tracing setting.
Qualification of the migrated Relay configuration, trace artifacts, and retained native sessions remains **TBD**.

## Define and Attach Integrations

Define an integration in `spec.integrations` or a sandbox's `integrations` map and attach it through the agent's `integrationRefs`.
An agent can also declare its own inline `integrations` map.
The [shared authoring rules](configuration-references.md#the-authoring-rule) define scope, references, and collisions.

The managed `kind: webSearch` integration supports Brave and Tavily credential routing.
One sandbox can attach one search definition; unused enclosing definitions create no resources, credential requirements, or grants.
The managed binding does not enable a native search tool.
Declare its native plugin or public Fabric MCP configuration separately and validate it against the selected adapter.
A deployment credential grant is not a native capability claim.

## Brave Web Search

Declare the credential reference and attach the definition to the intended agent:

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

Use the [complete OpenClaw example](../examples/openclaw-web-search.yaml) for both managed credential intent and separately authored native configuration.
Set the referenced variable on the applying host through your secret-management mechanism.
NemoClaw creates a workspace-scoped provider profile and credential-bearing provider in OpenShell.
The sandbox receives a placeholder through `BRAVE_API_KEY`; OpenShell substitutes the real key for the authorized Brave request.
Exported YAML and OpenTofu state retain the host reference, not its value.
Destroy removes the owned provider and profile without revoking the upstream key.
Unchanged apply does not rotate a changed value behind an unchanged reference.

The reserved `nemoclaw-brave` policy rule permits the configured search endpoint and executables for credential injection.
Explicit policy cannot reuse that name, and inference provider names cannot use the reserved `brave-search` registration prefix.
The [managed search tests](../crates/nemoclaw-sdk/tests/web_search.rs) cover profile selection, grants, credentials, and authored scope.
Native tool behavior, account quota, and live search results require separate qualification.

## Tavily Web Search

Use `provider: tavily` and an environment reference for the applying host's key.
The [Tavily example](../examples/tavily-web-search.yaml) includes deployment credential bindings and native settings for its selected adapters.
The managed binding does not impose a harness-name support matrix or install an adapter plugin.
The selected Fabric configuration must enable an appropriate native integration.

OpenShell supplies the sandbox placeholder under `TAVILY_API_KEY`, even when the host reference has another name.
The reserved `nemoclaw-tavily` profile authorizes the supported search/extract paths with bearer-header injection.
Inference names using `tavily-search` or its registration prefix are reserved when attached.
Unused definitions create no resources or credentials.
Follow [credential retirement](security.md#credentials-and-authentication) when replacing or revoking the key.
Live Tavily/OpenShell qualification for this migration remains **TBD**.

## Hermes Native Server

Fabric owns native server startup, interfaces, authentication, persisted state, and conversation behavior.
NemoClaw manages the sandbox and submits the resolved public configuration to Fabric.
The [Hermes interface example](../examples/hermes-interfaces.yaml) shows authored settings; [interface access](interfaces.md#hermes-api-dashboard-and-browser-tui) explains OpenShell forwarding.
A started Fabric runtime does not by itself prove a healthy native HTTP listener or model response.
Native file drift requires an observation contract supplied by Fabric; the generic runtime host does not infer it from remembered configuration.

## Pi Model Selection

The [Pi example](../examples/fabric-pi.yaml) supplies native registry metadata through `overrides.settings.model_metadata`.
Fabric's Pi adapter owns that metadata's schema and mapping.
The SDK forwards the selected provider API as a public model extension and preserves each named route plus the `default` role.
The former `piModel` field and adapter-specific NemoClaw runtime wire are no longer accepted.

Model and settings updates reconcile a reconstructible agent-configuration resource for every adapter.
When sandbox identity, provider attachments, image, and policy remain unchanged, the runtime restarts inside the existing sandbox.
In-memory conversations can be lost; retained native files remain subject to the adapter's lifecycle.
Changing sandbox resources can still require a separate deployment under the normal replacement protections.

## Runtime Lifecycle

Build the selected agent image with its installed Fabric metadata using the [image procedure](inference.md#build-an-image-with-the-configuration-interface).
Use an immutable image reference available to the sandbox compute daemon.
Deployment identity and ownership checks protect retained sandboxes, provider registrations, and storage.

The runtime host validates public Fabric configuration before starting a runtime.
Configuration preparation stops a changing runtime before provider mutations; configuration application starts Fabric after those dependencies are ready.
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
