<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Documentation

These guides describe the v1 development branch.
Sections marked **TBD** need a verified implementation, test results, or a completed procedure before they can describe supported use.
TBD is not a support claim or a delivery commitment.
Use the [validation matrix](validation/README.md) to distinguish tested configurations from checks still required.

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
| Use the Kubernetes driver and an isolated kind development stack | [Kubernetes backend](kubernetes.md) |
| Choose inline configuration or shared definitions | [Definitions and references](configuration-references.md) |
| Locate deployment state and understand backup limits | [Deployment state](state.md) |
| Diagnose a failed operation | [Troubleshooting](troubleshooting.md) |
| Review trust, credential storage and access, and isolation | [Security](security.md) |
| Declare sandbox filesystem, process, egress, and proxy settings | [Sandbox policy and proxy](sandbox-network.md) |

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
| Run workspace checks and collect coverage | [Tests](testing.md) |
| Exercise OpenTofu and bundles with local fixtures | [Run integration tests](testing/fixtures.md) |
| Test explicitly owned live resources | [Run live tests](testing/live.md) |
| Inspect retained results and their limits | [Recorded test results](validation/README.md) |
| Write or reorganize documentation | [Contribute documentation](CONTRIBUTING.md) |
| Validate, preview, or publish the v1 site | [Documentation build](AUTOMATION.md) |
| Update the generated schema and field reference | [Schema maintenance](configuration-schema.md) |

## Understand the Design

Start with the architecture page to follow one deployment through the SDK, OpenTofu, and backend APIs.
Then use the runtime, execution-target, and recipe pages to understand decisions inside that lifecycle.
The design decision defines current invariants; historical test results apply only to their recorded revisions and environments.

| Topic | Owner |
|---|---|
| Accepted scope, implementation boundaries, and invariants | [Design decision](design/scope.md) |
| SDK ownership, durable state, staged apply, and retained storage | [Architecture](design/architecture.md) |
| Process lifetime, watchdog recovery, and agent ownership | [Runtime design](design/runtime.md) |
| Proposed shared Fabric management contract and two-adapter experiment | [Fabric management](design/fabric-management.md) |
| Connections, engine identity, inference traffic, and host capacity | [Execution targets](design/execution-targets.md) |
| Artifact ownership, preparation verification, and output manifests | [Recipe design](design/recipes.md) |
| Current engine constraints and source locations | [Execution-engine assumptions](engine-assumptions.md) |
| Proposed migration of previous user guides, public routes, and release documentation | [Documentation migration plan](design/documentation-migration.md) |

## Sources and Fixtures

- [Agent runtime source notices](../image/NOTICE.md).
- [Generic vLLM source notices](../runtimes/vllm/NOTICE.md).
- [Qwen3.8 source notices](../runtimes/qwen38/NOTICE.md).
- [Configuration fixture provenance](../crates/nemoclaw-sdk/tests/fixtures/config/README.md).
- [Managed runtime fixture provenance](../crates/nemoclaw-sdk/src/managed/REFERENCE.md).
