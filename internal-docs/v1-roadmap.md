<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# NemoClaw Agent Config Support Notes

These entries support the [Classic and NemoClaw Agent Config matrix](../docs/get-started/classic-v1-matrix.md) where no single existing issue defines the capability.
The matrix links all other definitions directly to their owning GitHub issues; those issues are the source of truth for scope, dependencies, and acceptance.
When a matching primary issue exists, point the matrix title to it and remove the fallback entry here.
These review items add no implementation commitment or delivery date.

## Read the Comparison

The [matrix](../docs/get-started/classic-v1-matrix.md) is a publication draft, not a delivery schedule or a complete Classic inventory.
Capability titles link to the issue that owns scope and acceptance, or to a fallback definition below when no single issue matches.
Issues remain the source of truth; issue closure for replanning or supersession does not establish delivery.

- **Available:** a bounded path exists; check its host, harness, and workflow limits.
- **Planned parity:** the work is intended, but the complete journey is not confirmed.
- **Needs review:** scope or functional support still needs a decision or verification; these items are outside the committed parity milestone.
- **Not planned in NemoClaw Agent Config:** a core interface or responsibility is excluded; an upstream or platform alternative may remain available.

**Installation is a publication prerequisite.** Its Available placement describes the intended public release; packaging and clean-machine installation are incomplete in the inspected revision, tracked in [#12638](https://github.com/NVIDIA/NemoClaw/issues/12638).
The inspected baseline is NemoClaw Agent Config at `459a78500600eb810e76bc68cc2080d3bf346a9f`, Fabric `135147a0fe6ce6bc2ebf21fa1068d1bd5af71780`, and Classic `495896a404`.
This comparison adds no live qualification, assigned owners, estimates, or delivery dates.

Keep Classic available for essential workflows that are planned or need review.
Use the [migration guide](../docs/get-started/migration.md) to evaluate a separate deployment; configuration export neither copies native data nor adopts existing resources.
Review [current limits](../docs/resources/limits.md) and applicable acceptance before changing a classification.

MCP tool restrictions differ between the documented Hermes HCL path and YAML API subtree grants; see the [credential and tool contract](../docs/agents-inference/agents.md#key-authenticated-apis).
Conversation continuation here means explicit Hermes SDK resume with a saved SessionRef and retained native storage; it does not promise automatic continuation after every runtime or sandbox replacement.
Runtime readiness alone does not establish a successful inference request.
Generic application container data is disposable, and literal application inputs do not protect secrets.
Manual OAuth-refresh attachments and refresh material remain outside exported deployment YAML.

## Deploy and manage agents

**Available.** Select a supported agent, create and preview its desired-state configuration, apply it, and manage the deployment through the [lifecycle guide](../docs/build-deploy/usage.md).
[#14011](https://github.com/NVIDIA/NemoClaw/issues/14011) defines the native-interface part, not this entire lifecycle.
Match the agent image and Fabric adapter; confirm native access and a model reply through the selected [interface](../docs/agents-inference/interfaces.md).

## Connect and serve models

**Available, with model and host limits.** Connect a hosted or external model endpoint, or run a supported managed vLLM/Ollama service.
Use [inference connections](../docs/agents-inference/inference.md), [managed models](../docs/agents-inference/models.md), and [current limits](../docs/resources/limits.md).
[#13147](https://github.com/NVIDIA/NemoClaw/issues/13147) owns the Ollama/vLLM provider split, not every connection or model combination.

## Apply network and key policy

**Available.** Declare destination access and route protected inference/API credentials through [OpenShell policy and credential routing](../docs/security/security.md).
[#14338](https://github.com/NVIDIA/NemoClaw/issues/14338) owns middleware bindings, one part of this broader capability.
Literal application environment or file values are not a protected secret-delivery path.

## Extend images and run apps

**Available, as two separate paths.** Build a [derived agent image](../docs/build-deploy/derived-images.md), or declare a supported [application container](../docs/build-deploy/container-services.md).
[#12567](https://github.com/NVIDIA/NemoClaw/issues/12567) defines application-container declarations, not image extension.
Generic application containers support local managed Docker only; their data is disposable and literal inputs do not protect secrets.

## Supply skills and settings

**Available, with harness limits.** Load supplied skills and configure the native settings supported by the selected adapter.
[Fabric #580](https://github.com/NVIDIA/NeMo-Fabric/issues/580) owns mounted-skill behavior; [Fabric #618](https://github.com/NVIDIA/NeMo-Fabric/issues/618) owns selected native configuration controls.
Neither issue alone defines this combined capability.
Use [agent configuration](../docs/agents-inference/agents.md) and [mounted skills](../docs/agents-inference/agents.md#skills-on-a-mounted-volume) for the supported paths.
Loading supplied files does not promise automatic third-party acquisition, installation, upgrade, or removal.

## Use SDKs and providers

**Available.** Manage desired-state deployments through the [Rust SDK and OpenTofu providers](../docs/references/sdk.md).
The Classic TypeScript lifecycle API is not compatible with these interfaces.
[#12645](https://github.com/NVIDIA/NemoClaw/issues/12645) owns compatibility and reference policy, rather than the complete deployment-management capability.

## Configure native plugins

**Available, with harness and image limits.** Configure native plugins through the selected adapter's supported settings, with their required dependencies, credentials, and native discovery rules.
This does not promise arbitrary third-party acquisition, installation, upgrade, or removal.
See [agent configuration](../docs/agents-inference/agents.md) for the current configuration boundary.

The broader bundled-plugin startup proposals have separate owners: [Hermes #660](https://github.com/NVIDIA/NeMo-Fabric/issues/660) and [OpenClaw #664](https://github.com/NVIDIA/NeMo-Fabric/issues/664).
Both are discussion issues, not delivered support for every plugin.
Their predecessor [#435](https://github.com/NVIDIA/NeMo-Fabric/issues/435) is closed as split; it is not completion evidence.

## Review distributed inference

**Needs review.** Decide whether experimental multi-machine model serving should return to parity scope.
The call dropped it on the premise that Classic lacked it, but Classic documents experimental [two-Spark](https://github.com/NVIDIA/NemoClaw/blob/495896a404/docs/inference/set-up-vllm-on-two-dgx-sparks.mdx) and [two-Station](https://github.com/NVIDIA/NemoClaw/blob/495896a404/docs/inference/set-up-vllm-on-two-dgx-stations.mdx) serving.
This is not a permanent exclusion, and single-host multi-GPU support is a different outcome.
The broader qualification inventory [#12641](https://github.com/NVIDIA/NemoClaw/issues/12641) is related; it does not settle this parity decision.

## Verify native memory search

**Needs review.** Confirm which native harness memory indexing and search behavior must carry over, then verify the selected harness path.
Classic documents [embedding-backed memory search](https://github.com/NVIDIA/NemoClaw/blob/495896a404/docs/configure-agents/configure-memory-search.mdx).
Dropping a separate NemoClaw memory subsystem does not exclude the harness's native memory features.

## Verify credential rotation

**Needs review.** Confirm how to replace and revoke MCP credentials through the supported NemoClaw Agent Config credential path, including the effect on a running agent.
Classic documents [MCP credential rotation](https://github.com/NVIDIA/NemoClaw/blob/495896a404/docs/manage-sandboxes/manage-mcp-servers.mdx).
A changed value behind an unchanged reference is not rotated by unchanged apply; verify the documented [credential workflow](../docs/security/security.md).

## Classic CLI and API compatibility

**Not planned in NemoClaw.** NemoClaw Agent Config uses desired-state deployments and the Rust SDK/OpenTofu providers, without compatibility with the Classic imperative CLI or TypeScript lifecycle API.
Use the [migration task mapping](../docs/get-started/migration.md#map-the-user-task) and [compatibility guidance](../docs/references/compatibility.md) to choose the replacement workflow.
The NemoClaw Agent Config SDK/provider compatibility issue [#12645](https://github.com/NVIDIA/NemoClaw/issues/12645) covers a different contract; it does not promise Classic API compatibility.

## Universal agent runtime management

**Not planned in NemoClaw Agent Config.** A universal API that normalizes agent-specific runtime operations across every agent is outside scope.
Examples include native backup/restore behavior and native gateway-process restart; these operations belong to the agent or the component that owns the runtime.
Native agents define their data semantics, while platform operators manage backup and restore of mounted storage.

This boundary preserves desired-state deployment setup and drift reconciliation, including lifecycle operations supported by the deployment providers.
It does not exclude all restart or recovery behavior, nor the Rust SDK and OpenTofu interfaces used to manage deployments.
See the [deployment lifecycle](../docs/build-deploy/usage.md) and [upstream ownership boundaries](design/scope.md#upstream-boundaries).
