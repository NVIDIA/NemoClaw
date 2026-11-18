<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Classic and NemoClaw Agent Config

**Draft for review.** Select a capability for details; see [support notes and status definitions](../../internal-docs/v1-roadmap.md#read-the-comparison) before deciding to migrate.

## Available

[GTC DC milestone](https://github.com/NVIDIA/NemoClaw/milestone/12)

| Capability | Scope | GTC DC tracking / evidence |
|---|---|---|
| [Deploy and manage agents](../../internal-docs/v1-roadmap.md#deploy-and-manage-agents) | Create, preview, apply, and manage an agent deployment. | [#14011](https://github.com/NVIDIA/NemoClaw/issues/14011) |
| [Connect and serve models](../../internal-docs/v1-roadmap.md#connect-and-serve-models) | Use external endpoints or supported managed vLLM/Ollama services. | [#13147](https://github.com/NVIDIA/NemoClaw/issues/13147) |
| [Retain agent files](https://github.com/NVIDIA/NemoClaw/issues/14051) | Keep selected files on caller-supplied volumes. | [#14051](https://github.com/NVIDIA/NemoClaw/issues/14051) |
| [Supply skills and settings](../../internal-docs/v1-roadmap.md#supply-skills-and-settings) | Load supplied skills and supported native harness settings. | [#14289](https://github.com/NVIDIA/NemoClaw/issues/14289) |
| [Connect MCP tools](https://github.com/NVIDIA/NemoClaw/issues/13313) | Connect key-authenticated tools; restrictions depend on the configuration path. | [#13313](https://github.com/NVIDIA/NemoClaw/issues/13313), [#14417](https://github.com/NVIDIA/NemoClaw/issues/14417) |
| [Apply network and key policy](../../internal-docs/v1-roadmap.md#apply-network-and-key-policy) | Declare destination access and protected credential routing. | [#14338](https://github.com/NVIDIA/NemoClaw/issues/14338) |
| [Extend images and run apps](../../internal-docs/v1-roadmap.md#extend-images-and-run-apps) | Extend agent images or run local Docker applications. | [#13093](https://github.com/NVIDIA/NemoClaw/issues/13093) |
| [Use SDKs and providers](../../internal-docs/v1-roadmap.md#use-sdks-and-providers) | Manage deployments through Rust or OpenTofu. | [#13167](https://github.com/NVIDIA/NemoClaw/issues/13167) |
| [Use company runtime identity](https://github.com/NVIDIA/NemoClaw/issues/12652) | Use operator-managed OAuth refresh outside exported YAML. | [#12652](https://github.com/NVIDIA/NemoClaw/issues/12652) |
| [Inspect health and failures](https://github.com/NVIDIA/NemoClaw/issues/12642) | Inspect runtime readiness and deployment-failure diagnostics. | [#12642](https://github.com/NVIDIA/NemoClaw/issues/12642) |
| [Configure native plugins](../../internal-docs/v1-roadmap.md#configure-native-plugins) | Configure plugins supported by the selected harness and image. | [#14534](https://github.com/NVIDIA/NemoClaw/issues/14534) |
| [Continue conversations](https://github.com/NVIDIA/NeMo-Fabric/issues/578) | Resume Hermes SDK sessions explicitly with retained native storage. | [#14534](https://github.com/NVIDIA/NemoClaw/issues/14534) |
| [Download and install NemoClaw](https://github.com/NVIDIA/NemoClaw/issues/12638) | Installation pending; required before publication. | [#12638](https://github.com/NVIDIA/NemoClaw/issues/12638) |

## Planned Parity

[Classic parity milestone](https://github.com/NVIDIA/NemoClaw/milestone/14)

| Capability | Scope | Parity tracker |
|---|---|---|
| [Onboard with familiar choices](https://github.com/NVIDIA/NemoClaw/issues/14606) | Generate configuration through agreed Classic onboarding journeys. | [#14606](https://github.com/NVIDIA/NemoClaw/issues/14606) |
| [Set up web search](https://github.com/NVIDIA/NemoClaw/issues/14607) | Configure search credentials, access, and a working example. | [#14607](https://github.com/NVIDIA/NemoClaw/issues/14607) |
| [Connect and manage messaging](https://github.com/NVIDIA/NemoClaw/issues/12037) | Enroll, chat, restrict senders, reconnect, rotate credentials, disconnect. | [#12037](https://github.com/NVIDIA/NemoClaw/issues/12037) |
| [Agent assisted migration](https://github.com/NVIDIA/NemoClaw/issues/14580) | Use Classic export to recreate a separate deployment. | [#14580](https://github.com/NVIDIA/NemoClaw/issues/14580) |
| [Trace and review activity](https://github.com/NVIDIA/NemoClaw/issues/14609) | Route selected traces and activity signals through Relay. | [#14609](https://github.com/NVIDIA/NemoClaw/issues/14609) |
| [Broader local model support](https://github.com/NVIDIA/NemoClaw/issues/14608) | Qualify additional model, hardware, and harness combinations. | [#14608](https://github.com/NVIDIA/NemoClaw/issues/14608) |
| [Run llama.cpp and NIM](https://github.com/NVIDIA/NemoClaw/issues/14556) | Manage both runners through the model-service lifecycle. | [#14556](https://github.com/NVIDIA/NemoClaw/issues/14556) |

## Scope Decisions

| Capability | Status | Scope |
|---|---|---|
| [Retain application data](https://github.com/NVIDIA/NemoClaw/issues/12568) | Needs review | Resolve retention beyond the current disposable-container contract. |
| [Share diagnostic bundles](https://github.com/NVIDIA/NemoClaw/issues/14581) | Needs review | Collect debugging artifacts that are safe to share. |
| [Review distributed inference](../../internal-docs/v1-roadmap.md#review-distributed-inference) | Needs review | Decide scope for experimental multi-machine model serving. |
| [Verify native memory search](../../internal-docs/v1-roadmap.md#verify-native-memory-search) | Needs review | Verify the required native indexing and search behavior. |
| [Verify credential rotation](../../internal-docs/v1-roadmap.md#verify-credential-rotation) | Needs review | Verify MCP credential replacement and revocation. |
| [Built-in backup and restore commands](https://github.com/NVIDIA/NemoClaw/issues/12639) | Not planned in NemoClaw Agent Config | Native agents own their data semantics; platform operators manage storage backup and restore. |
| [Universal agent runtime management](../../internal-docs/v1-roadmap.md#universal-agent-runtime-management) | Not planned in NemoClaw Agent Config | No common API for agent-specific runtime operations, such as native gateway-process restart. |
| [Guaranteed automatic migration](https://github.com/NVIDIA/NemoClaw/issues/14580) | Not planned in NemoClaw Agent Config | No general state adoption or native-data conversion guarantee. |
| [Classic CLI and API compatibility](../../internal-docs/v1-roadmap.md#classic-cli-and-api-compatibility) | Not planned in NemoClaw Agent Config | No compatible Classic command or TypeScript lifecycle interface. |
| [Built-in policy approval UI](https://github.com/NVIDIA/NemoClaw/issues/12651) | Not planned in NemoClaw Agent Config | Approval and explanation belong to OpenShell. |
| [Historical shields interface](https://github.com/NVIDIA/NemoClaw/issues/10696) | Not planned in NemoClaw Agent Config | The retired interface remains outside core scope. |
