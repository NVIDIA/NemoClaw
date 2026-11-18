<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Compare Classic and v1 Before Migrating

**Draft for review, 18 November 2026.**
Capability titles link directly to the existing GitHub issue that owns their definition and acceptance.
Where no single matching issue exists, the title links to a short [fallback definition](../../internal-docs/v1-roadmap.md).
Issues own detailed scope, dependencies, and acceptance; the tables summarize migration readiness.
This is a publication draft, not a delivery schedule or a complete Classic inventory.
Download and install NemoClaw is included in Available for publication; packaging and installation must be completed before this matrix is made public.

- **Available:** a bounded v1 path exists; check its host, harness, and workflow limits.
- **Planned parity:** work is intended; parts may already exist, but the complete journey is not confirmed.
- **Needs review:** scope or functional support still needs a decision or verification.
- **Not planned in NemoClaw:** an interface or responsibility is excluded; an upstream or platform alternative may remain available.

## Available

Release work and supporting implementation are tracked in [GTC DC milestone 12](https://github.com/NVIDIA/NemoClaw/milestone/12).
Links below identify selected tracking issues or implementation evidence; a closed issue or merged PR does not qualify every variant of a capability.
The inspected baseline is v1 `459a78500600eb810e76bc68cc2080d3bf346a9f`, Fabric `135147a0fe6ce6bc2ebf21fa1068d1bd5af71780`, and Classic `495896a404`.
Issue descriptions may cover broader or later work; the brief scope below bounds each Available entry.

| Capability | Scope | GTC DC tracking / evidence |
|---|---|---|
| [Deploy and manage agents](../../internal-docs/v1-roadmap.md#deploy-and-manage-agents) | Select an agent, create and preview its configuration, start it, and manage its deployment. | [#14011](https://github.com/NVIDIA/NemoClaw/issues/14011) |
| [Connect and serve models](../../internal-docs/v1-roadmap.md#connect-and-serve-models) | Connect an endpoint or use supported managed vLLM/Ollama paths; check the [host, model, and harness limits](../resources/limits.md). | [#13147](https://github.com/NVIDIA/NemoClaw/issues/13147) |
| [Retain agent files](https://github.com/NVIDIA/NemoClaw/issues/14051) | Keep selected agent files on caller-supplied volumes through sandbox replacement. | [#14051](https://github.com/NVIDIA/NemoClaw/issues/14051) |
| [Supply skills and settings](../../internal-docs/v1-roadmap.md#supply-skills-and-settings) | Load supplied skills and configure supported [native settings](https://github.com/NVIDIA/NeMo-Fabric/issues/618); automatic extension provisioning is separate. | [#14289](https://github.com/NVIDIA/NemoClaw/issues/14289) |
| [Connect MCP tools](https://github.com/NVIDIA/NemoClaw/issues/13313) | Connect a key-authenticated MCP service. Hermes HCL tool restrictions and YAML API subtree grants have different [contracts](../agents-inference/agents.md#key-authenticated-apis). | [#13313](https://github.com/NVIDIA/NemoClaw/issues/13313), [#14417](https://github.com/NVIDIA/NemoClaw/issues/14417) |
| [Apply network and key policy](../../internal-docs/v1-roadmap.md#apply-network-and-key-policy) | Declare destination access and route credentials through OpenShell. | [#14338](https://github.com/NVIDIA/NemoClaw/issues/14338) |
| [Extend images and run apps](../../internal-docs/v1-roadmap.md#extend-images-and-run-apps) | Use a [derived agent image](../build-deploy/derived-images.md) or a local managed Docker application container; generic container data is disposable and literal inputs do not protect secrets. | [#13093](https://github.com/NVIDIA/NemoClaw/issues/13093) |
| [Use SDKs and providers](../../internal-docs/v1-roadmap.md#use-sdks-and-providers) | Manage desired-state deployments through the Rust SDK or OpenTofu providers. | [#13167](https://github.com/NVIDIA/NemoClaw/issues/13167) |
| [Use company runtime identity](https://github.com/NVIDIA/NemoClaw/issues/12652) | Attach operator-managed OAuth-refresh credentials; manual attachments and refresh material are outside exported deployment YAML. | [#12652](https://github.com/NVIDIA/NemoClaw/issues/12652) |
| [Inspect health and failures](https://github.com/NVIDIA/NemoClaw/issues/12642) | Inspect runtime readiness and deployment-failure diagnostics; readiness alone does not establish successful inference. | [#12642](https://github.com/NVIDIA/NemoClaw/issues/12642) |
| [Configure native plugins](../../internal-docs/v1-roadmap.md#configure-native-plugins) | Configure native plugins supported by the selected harness and image; broader plugin enablement/provisioning proposals remain separate. | [#14534](https://github.com/NVIDIA/NemoClaw/issues/14534) |
| [Continue conversations](https://github.com/NVIDIA/NeMo-Fabric/issues/578) | Resume a Hermes SDK conversation with a saved SessionRef and retained native storage; automatic continuation after NemoClaw replacement is separate. | [#14534](https://github.com/NVIDIA/NemoClaw/issues/14534) |
| [Download and install NemoClaw](https://github.com/NVIDIA/NemoClaw/issues/12638) | Download a matched release, install it on PATH, and verify installation. Required at publication; incomplete in the inspected revision. | [#12638](https://github.com/NVIDIA/NemoClaw/issues/12638) |

## Planned Parity

The seven agreed outcomes are tracked in [Classic parity milestone 14](https://github.com/NVIDIA/NemoClaw/milestone/14).
Each outcome has one primary tracker; estimates, owners, dates, and acceptance refinements remain to be agreed.

| Capability | Scope | Parity tracker |
|---|---|---|
| [Onboard with familiar choices](https://github.com/NVIDIA/NemoClaw/issues/14606) | Guide users through the agreed Classic onboarding choices and generate ordinary YAML. | [#14606](https://github.com/NVIDIA/NemoClaw/issues/14606) |
| [Set up web search](https://github.com/NVIDIA/NemoClaw/issues/14607) | Configure and demonstrate real web search, then decide whether to provide onboarding presets. | [#14607](https://github.com/NVIDIA/NemoClaw/issues/14607) |
| [Connect and manage messaging](https://github.com/NVIDIA/NemoClaw/issues/12037) | Enroll, chat, restrict senders, reconnect through updates, rotate credentials, and disconnect. | [#12037](https://github.com/NVIDIA/NemoClaw/issues/12037) |
| [Agent assisted migration](https://github.com/NVIDIA/NemoClaw/issues/14580) | Use Classic export to help an agent recreate and verify a separate v1 deployment. | [#14580](https://github.com/NVIDIA/NemoClaw/issues/14580) |
| [Trace and review activity](https://github.com/NVIDIA/NemoClaw/issues/14609) | Route selected agent traces and activity/access signals through the agreed Relay integration. | [#14609](https://github.com/NVIDIA/NemoClaw/issues/14609) |
| [Broader local model support](https://github.com/NVIDIA/NemoClaw/issues/14608) | Expand the supported local model, hardware, and harness combinations beyond the currently documented paths. | [#14608](https://github.com/NVIDIA/NemoClaw/issues/14608) |
| [Run llama.cpp and NIM](https://github.com/NVIDIA/NemoClaw/issues/14556) | Add managed llama.cpp and NIM model-serving support with documented configuration and lifecycle behavior. | [#14556](https://github.com/NVIDIA/NemoClaw/issues/14556) |

## Scope Decisions

These items are not added to the committed parity milestone by this comparison.
Items marked **Needs review** remain undecided; they are not exclusions.

| Capability | Status | Scope |
|---|---|---|
| [Retain application data](https://github.com/NVIDIA/NemoClaw/issues/12568) | Needs review | Review the intended retention contract; the old lifecycle issue is closed as not planned, while the current generic container contract calls data disposable. |
| [Share diagnostic bundles](https://github.com/NVIDIA/NemoClaw/issues/14581) | Needs review | Collect useful debugging artifacts in a bundle that is safe to share. |
| [Review distributed inference](../../internal-docs/v1-roadmap.md#review-distributed-inference) | Needs review | Decide whether experimental multi-machine serving should return to the parity scope. |
| [Verify native memory search](../../internal-docs/v1-roadmap.md#verify-native-memory-search) | Needs review | Preserve the needed native harness memory indexing and search behavior. |
| [Verify credential rotation](../../internal-docs/v1-roadmap.md#verify-credential-rotation) | Needs review | Replace and revoke MCP credentials through a documented v1 workflow. |
| [Review enterprise parity](../../internal-docs/v1-roadmap.md#review-enterprise-parity) | Needs review | Confirm the required company enrollment, identity, policy, and recovery workflows with their owners. |
| [Built-in backup commands](https://github.com/NVIDIA/NemoClaw/issues/12639) | Not planned in NemoClaw | NemoClaw-owned backup, restore, and snapshot commands; platform backup remains separate. |
| [Guaranteed automatic migration](https://github.com/NVIDIA/NemoClaw/issues/14580) | Not planned in NemoClaw | A guaranteed migrator covering arbitrary Classic state, drift, resources, and native data. |
| [Classic CLI and API compatibility](../../internal-docs/v1-roadmap.md#classic-cli-and-api-compatibility) | Not planned in NemoClaw | Compatibility with the Classic imperative CLI and TypeScript lifecycle API. |
| [Built-in policy approval UI](https://github.com/NVIDIA/NemoClaw/issues/12651) | Not planned in NemoClaw | NemoClaw-owned interactive approvals, policy explanation, and the old preset interface. |
| [Historical shields interface](https://github.com/NVIDIA/NemoClaw/issues/10696) | Not planned in NemoClaw | Restoration of the historical shields up/down and configuration-sealing interface. |

## Decide Whether to Migrate

If an essential workflow is planned or needs review, keep Classic available until you verify a suitable v1 path.
Follow the [migration guide](migration.md) to evaluate a separate deployment; configuration export does not copy native data or adopt existing resources.
Use the linked issue for detailed scope and acceptance, and the [current limits](../resources/limits.md) for operating constraints.
When a capability changes, review its acceptance before updating its table classification; issue closure for replanning or supersession does not establish delivery.
