<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Documentation

These guides describe the v1 development branch.
Sections marked **TBD** need a verified implementation, test results, or a completed procedure before they can describe supported use.
TBD is not a support claim or a delivery commitment.

## Get Started

| Task | Guide |
|---|---|
| Understand the product and choose an interface | [NemoClaw overview](overview.md) |
| Check client, runtime, and model-host requirements | [Prerequisites](prerequisites.md) |
| Deploy OpenClaw with existing gateway and inference services | [Get started](get-started.md) |
| Assess a move from an earlier version | [Migration](migration.md) |
| Find release information and untested configurations | [Release notes](release-notes.md) |

## Build and Deploy

| Task | Guide |
|---|---|
| Build the CLI bundle and runtime images | [Build local artifacts](build.md) |
| Configure, apply, export, recover, and destroy a deployment | [Use desired state](usage.md) |
| Choose inline configuration or shared definitions | [Definitions and references](configuration-references.md) |
| Locate deployment state and understand backup limits | [Deployment state](state.md) |
| Diagnose a failed operation | [Troubleshooting](troubleshooting.md) |
| Review trust, credential storage and access, and isolation | [Security](security.md) |
| Declare sandbox filesystem, process, and egress settings | [Sandbox policy](sandbox-network.md) |

## Agents and Inference

| Task | Guide |
|---|---|
| Select inference APIs, OpenClaw limits, and Hermes authentication | [Inference configuration](inference.md) |
| Configure and access native dashboards | [Agent interfaces](interfaces.md) |
| Choose an agent and access its native runtime | [Agent runtimes](agents.md) |
| Enable tracing or selected-agent web search | [OpenClaw OTLP](agents.md#openclaw-tracing), experimental [Hermes Relay](agents.md#hermes-relay-tracing), and [Brave search](agents.md#brave-web-search) |
| Choose a public model for managed vLLM | [Select a managed model](models.md) |
| Package model-specific preparation | [Inline model recipes](recipes.md) |
| Place inference on an SSH-selected Docker engine | [Configure an SSH model service](remote-service.md) |

## Integrate and Look Up Behavior

| Task | Guide |
|---|---|
| Call deployment operations programmatically | [Use the SDK](sdk.md) |
| Understand the bundled OpenTofu provider | [Provider](provider.md) |
| Look up CLI commands and options | [CLI reference](reference/cli.md) |
| Look up YAML fields, defaults, and constraints | [Configuration reference](reference/configuration.md) |
| Find documentation for coding agents, contribution guidance, and licenses | [Resources](resources.md) |

## Develop and Validate

| Task | Guide |
|---|---|
| Run workspace checks and collect coverage | [Tests](contributing/testing.md) |
| Exercise OpenTofu and bundles with local fixtures | [Run integration tests](contributing/integration-tests.md) |
| Test explicitly owned live resources | [Run live tests](contributing/live-tests.md) |
| Write or reorganize documentation | [Contribute documentation](contributing/documentation.md) |
| Validate, preview, or publish the v1 site | [Documentation build](contributing/documentation-build.md) |
| Update the generated schema and field reference | [Schema maintenance](contributing/configuration-schema.md) |

## Understand the Design

Start with the architecture page to follow one deployment through the SDK, OpenTofu, and backend APIs.
Then use the runtime, execution-target, and recipe pages to understand decisions inside that lifecycle.
The design decision defines current invariants.

| Topic | Owner |
|---|---|
| Accepted scope, implementation boundaries, and invariants | [Design decision](design/scope.md) |
| Authoring concepts, ownership, and validation gates | [Authoring domain model](design/authoring-domain.md) |
| Partial-document onboarding coverage and open design questions | [Onboarding journey prototype](design/onboarding-journeys.md) |
| SDK ownership, durable state, staged apply, and retained storage | [Architecture](design/architecture.md) |
| Apply stages, component handoffs, and agent harness startup | [Apply flow](design/apply-flow.md) |
| Process lifetime, watchdog recovery, and agent ownership | [Runtime design](design/runtime.md) |
| Fabric runtime ownership and observation limits | [Fabric management](design/fabric-management.md) |
| Connections, engine identity, inference traffic, host capacity, and their implementation constraints | [Execution targets](design/execution-targets.md) |
| Artifact ownership, preparation verification, and output manifests | [Recipe design](design/recipes.md) |

## Sources and Fixtures

- [Agent runtime source notices](../image/NOTICE.md).
- [Generic vLLM source notices](../runtimes/vllm/NOTICE.md).
- [Qwen3.8 source notices](../runtimes/qwen38/NOTICE.md).
- [Configuration fixture provenance](../crates/nemoclaw-sdk/tests/fixtures/config/README.md).
- [Managed runtime fixture provenance](../crates/nemoclaw-provider/src/managed/REFERENCE.md).
