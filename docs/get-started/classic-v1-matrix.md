<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Compare Classic and v1 Before Migrating

**Draft for review, 17 November 2026.**
Select a capability title to open its definition in the [capability catalog](classic-v1-capabilities.md), including scope, limitations, and evidence.
This is a publication draft, not a delivery schedule or a complete Classic inventory.
Download and install NemoClaw is included in Available for publication; packaging and installation must be completed before this matrix is made public.

- **Available:** a bounded v1 path exists; check its host, harness, and workflow limits.
- **Planned parity:** work is intended; parts may already exist, but the complete journey is not confirmed.
- **Needs review:** scope or functional support still needs a decision or verification.
- **Not planned in NemoClaw:** an interface or responsibility is excluded; an upstream or platform alternative may remain available.

## Available

Release work and supporting implementation are tracked in [GTC DC milestone 12](https://github.com/NVIDIA/NemoClaw/milestone/12).
Links below identify selected tracking issues or implementation evidence; a closed issue or merged PR does not qualify every variant of a capability.
For native plugins and conversation continuation, #14534 records the Fabric integration baseline; check the catalog for the narrower supported contracts.

| Capability | Scope | GTC DC tracking / evidence |
|---|---|---|
| [Deploy and manage agents](classic-v1-capabilities.md#deploy-and-manage-agents) | Select an agent, create and preview its configuration, start it, and manage its deployment. | [#14011](https://github.com/NVIDIA/NemoClaw/issues/14011) |
| [Connect and serve models](classic-v1-capabilities.md#connect-and-serve-models) | Connect a model endpoint or run a supported managed vLLM/Ollama service. | [#13147](https://github.com/NVIDIA/NemoClaw/issues/13147) |
| [Retain agent files](classic-v1-capabilities.md#retain-agent-files) | Keep selected agent files on caller-supplied volumes through sandbox replacement. | [#14051](https://github.com/NVIDIA/NemoClaw/issues/14051) |
| [Supply skills and settings](classic-v1-capabilities.md#supply-skills-and-settings) | Load supplied skills and configure supported native harness settings. | [#14289](https://github.com/NVIDIA/NemoClaw/issues/14289) |
| [Connect MCP tools](classic-v1-capabilities.md#connect-mcp-tools) | Connect a key-authenticated MCP service through the supported harness and credential path. | [#13313](https://github.com/NVIDIA/NemoClaw/issues/13313), [#14417](https://github.com/NVIDIA/NemoClaw/issues/14417) |
| [Apply network and key policy](classic-v1-capabilities.md#apply-network-and-key-policy) | Declare destination access and route credentials through OpenShell. | [#14338](https://github.com/NVIDIA/NemoClaw/issues/14338) |
| [Extend images and run apps](classic-v1-capabilities.md#extend-images-and-run-apps) | Use a derived agent image or declare a supported application container. | [#13093](https://github.com/NVIDIA/NemoClaw/issues/13093) |
| [Use SDKs and providers](classic-v1-capabilities.md#use-sdks-and-providers) | Manage desired-state deployments through the Rust SDK or OpenTofu providers. | [#13167](https://github.com/NVIDIA/NemoClaw/issues/13167) |
| [Use company runtime identity](classic-v1-capabilities.md#use-company-runtime-identity) | Attach operator-managed OAuth-refresh credentials through the documented OpenShell workflow. | [#12652](https://github.com/NVIDIA/NemoClaw/issues/12652) |
| [Inspect health and failures](classic-v1-capabilities.md#inspect-health-and-failures) | Inspect runtime readiness and collect deployment-failure diagnostics. | [#12642](https://github.com/NVIDIA/NemoClaw/issues/12642) |
| [Configure native plugins](classic-v1-capabilities.md#configure-native-plugins) | Configure native plugins supported by the selected harness and image. | [#14534](https://github.com/NVIDIA/NemoClaw/issues/14534) |
| [Continue conversations](classic-v1-capabilities.md#continue-conversations) | Continue a saved conversation through the selected harness's supported session-resume path. | [#14534](https://github.com/NVIDIA/NemoClaw/issues/14534) |
| [Download and install NemoClaw](classic-v1-capabilities.md#download-and-install-nemoclaw) | Download and install a matched NemoClaw release for the user's platform, put the executable on PATH, and verify installation using the guide. | [#12638](https://github.com/NVIDIA/NemoClaw/issues/12638) |

## Planned Parity

The seven agreed outcomes are tracked in [Classic parity milestone 14](https://github.com/NVIDIA/NemoClaw/milestone/14).
Each outcome has one primary tracker; estimates, owners, dates, and acceptance refinements remain to be agreed.

| Capability | Scope | Parity tracker |
|---|---|---|
| [Onboard with familiar choices](classic-v1-capabilities.md#onboard-with-familiar-choices) | Guide users through the agreed Classic onboarding choices and generate ordinary YAML. | [#14606](https://github.com/NVIDIA/NemoClaw/issues/14606) |
| [Set up web search](classic-v1-capabilities.md#set-up-web-search) | Configure and demonstrate real web search, then decide whether to provide onboarding presets. | [#14607](https://github.com/NVIDIA/NemoClaw/issues/14607) |
| [Connect and manage messaging](classic-v1-capabilities.md#connect-and-manage-messaging) | Enroll, chat, restrict senders, reconnect through updates, rotate credentials, and disconnect. | [#12037](https://github.com/NVIDIA/NemoClaw/issues/12037) |
| [Agent assisted migration](classic-v1-capabilities.md#agent-assisted-migration) | Use Classic export to help an agent recreate and verify a separate v1 deployment. | [#14580](https://github.com/NVIDIA/NemoClaw/issues/14580) |
| [Trace and review activity](classic-v1-capabilities.md#trace-and-review-activity) | Route selected agent traces and activity/access signals through the agreed Relay integration. | [#14609](https://github.com/NVIDIA/NemoClaw/issues/14609) |
| [Broader local model support](classic-v1-capabilities.md#broader-local-model-support) | Expand the supported local model, hardware, and harness combinations beyond the currently documented paths. | [#14608](https://github.com/NVIDIA/NemoClaw/issues/14608) |
| [Run llama.cpp and NIM](classic-v1-capabilities.md#run-llamacpp-and-nim) | Add managed llama.cpp and NIM model-serving support with documented configuration and lifecycle behavior. | [#14556](https://github.com/NVIDIA/NemoClaw/issues/14556) |

## Scope Decisions

These items are not added to the committed parity milestone by this comparison.
Items marked **Needs review** remain undecided; they are not exclusions.

| Capability | Status | Scope |
|---|---|---|
| [Retain application data](classic-v1-capabilities.md#retain-application-data) | Needs review | Keep application-owned data through supported update and removal operations. |
| [Share diagnostic bundles](classic-v1-capabilities.md#share-diagnostic-bundles) | Needs review | Collect useful debugging artifacts in a bundle that is safe to share. |
| [Review distributed inference](classic-v1-capabilities.md#review-distributed-inference) | Needs review | Decide whether experimental multi-machine serving should return to the parity scope. |
| [Verify native memory search](classic-v1-capabilities.md#verify-native-memory-search) | Needs review | Preserve the needed native harness memory indexing and search behavior. |
| [Verify credential rotation](classic-v1-capabilities.md#verify-credential-rotation) | Needs review | Replace and revoke MCP credentials through a documented v1 workflow. |
| [Review enterprise parity](classic-v1-capabilities.md#review-enterprise-parity) | Needs review | Confirm the required company enrollment, identity, policy, and recovery workflows with their owners. |
| [Built-in backup commands](classic-v1-capabilities.md#built-in-backup-commands) | Not planned in NemoClaw | NemoClaw-owned backup, restore, and snapshot commands; platform backup remains separate. |
| [Guaranteed automatic migration](classic-v1-capabilities.md#guaranteed-automatic-migration) | Not planned in NemoClaw | A guaranteed migrator covering arbitrary Classic state, drift, resources, and native data. |
| [Classic CLI and API compatibility](classic-v1-capabilities.md#classic-cli-and-api-compatibility) | Not planned in NemoClaw | Compatibility with the Classic imperative CLI and TypeScript lifecycle API. |
| [Built-in policy approval UI](classic-v1-capabilities.md#built-in-policy-approval-ui) | Not planned in NemoClaw | NemoClaw-owned interactive approvals, policy explanation, and the old preset interface. |
| [Historical shields interface](classic-v1-capabilities.md#historical-shields-interface) | Not planned in NemoClaw | Restoration of the historical shields up/down and configuration-sealing interface. |

## Decide Whether to Migrate

If an essential workflow is planned or needs review, keep Classic available until you verify a suitable v1 path.
Follow the [migration guide](migration.md) to evaluate a separate deployment; configuration export does not copy native data or adopt existing resources.
The [catalog](classic-v1-capabilities.md) records the inspected revisions and unresolved decisions; the [roadmap](../../internal-docs/v1-roadmap.md) proposes how to sequence the remaining work.
