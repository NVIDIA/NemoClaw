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

| Capability | Scope |
|---|---|
| [Deploy and manage agents](classic-v1-capabilities.md#deploy-and-manage-agents) | Select an agent, create and preview its configuration, start it, and manage its deployment. |
| [Connect and serve models](classic-v1-capabilities.md#connect-and-serve-models) | Connect a model endpoint or run a supported managed vLLM/Ollama service. |
| [Retain agent files](classic-v1-capabilities.md#retain-agent-files) | Keep selected agent files on caller-supplied volumes through sandbox replacement. |
| [Supply skills and settings](classic-v1-capabilities.md#supply-skills-and-settings) | Load supplied skills and configure supported native harness settings. |
| [Connect MCP tools](classic-v1-capabilities.md#connect-mcp-tools) | Connect a key-authenticated MCP service through the supported harness and credential path. |
| [Apply network and key policy](classic-v1-capabilities.md#apply-network-and-key-policy) | Declare destination access and route credentials through OpenShell. |
| [Extend images and run apps](classic-v1-capabilities.md#extend-images-and-run-apps) | Use a derived agent image or declare a supported application container. |
| [Use SDKs and providers](classic-v1-capabilities.md#use-sdks-and-providers) | Manage desired-state deployments through the Rust SDK or OpenTofu providers. |
| [Use company runtime identity](classic-v1-capabilities.md#use-company-runtime-identity) | Attach operator-managed OAuth-refresh credentials through the documented OpenShell workflow. |
| [Inspect health and failures](classic-v1-capabilities.md#inspect-health-and-failures) | Inspect runtime readiness and collect deployment-failure diagnostics. |
| [Configure native plugins](classic-v1-capabilities.md#configure-native-plugins) | Configure native plugins supported by the selected harness and image. |
| [Continue conversations](classic-v1-capabilities.md#continue-conversations) | Continue a saved conversation through the selected harness's supported session-resume path. |
| [Download and install NemoClaw](classic-v1-capabilities.md#download-and-install-nemoclaw) | Download and install a matched NemoClaw release for the user's platform, put the executable on PATH, and verify installation using the guide. |

## Planned Parity

| Capability | Scope |
|---|---|
| [Onboard with familiar choices](classic-v1-capabilities.md#onboard-with-familiar-choices) | Guide users through the agreed Classic onboarding choices and generate ordinary YAML. |
| [Set up web search](classic-v1-capabilities.md#set-up-web-search) | Configure and demonstrate real web search, then decide whether to provide onboarding presets. |
| [Connect and manage messaging](classic-v1-capabilities.md#connect-and-manage-messaging) | Enroll, chat, restrict senders, reconnect through updates, rotate credentials, and disconnect. |
| [Agent assisted migration](classic-v1-capabilities.md#agent-assisted-migration) | Use Classic export to help an agent recreate and verify a separate v1 deployment. |
| [Trace and review activity](classic-v1-capabilities.md#trace-and-review-activity) | Route selected agent traces and activity/access signals through the agreed Relay integration. |
| [Broader local model support](classic-v1-capabilities.md#broader-local-model-support) | Expand the supported local model, hardware, and harness combinations beyond the currently documented paths. |
| [Run llama.cpp and NIM](classic-v1-capabilities.md#run-llamacpp-and-nim) | Add managed llama.cpp and NIM model-serving support with documented configuration and lifecycle behavior. |

## Scope Decisions

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
