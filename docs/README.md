<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Documentation

These guides describe NemoClaw v1. The operational updates beyond the first-deployment tutorial reflect inspected implementation `origin/v1` at `86b8d94273a76a696e06b300dc29f7035b163667`; use a matched checkout and bundle when following them. The checked-in generated configuration reference still describes this documentation checkout, not the newer implementation revision. For the source-pinned first deployment, use the [tutorial](get-started.md).
[Current limits](limits.md) lists what v1 does not do yet or has not tested, with the issue tracking each.

## Start Here

| Task | Guide |
|---|---|
| Understand the product and choose an interface | [NemoClaw overview](overview.md) |
| Understand how NemoClaw, OpenShell, Fabric, and agent harnesses fit together | [Ecosystem](ecosystem.md) |
| Check client, runtime, and model-host requirements | [Prerequisites](prerequisites.md) |
| Deploy OpenClaw with existing gateway and inference services | [Get started](get-started.md) |

## Deploy and Operate

| Task | Guide |
|---|---|
| Build the CLI bundle and runtime images | [Build local artifacts](build.md) |
| Extend an agent image with your own skills and tools | [Derived agent images](derived-images.md) |
| Configure, apply, export, recover, and destroy a deployment | [Use desired state](usage.md) |
| Run sandboxes on an existing Kubernetes or OpenShift cluster | [Deploy to Kubernetes or OpenShift](kubernetes.md) |
| Choose inline configuration or shared definitions | [Definitions and references](configuration-references.md) |
| Locate deployment state and understand backup limits | [Deployment state](state.md) |
| Diagnose a failed operation | [Troubleshooting](troubleshooting.md) |
| Rotate a credential | [Rotate credentials](credential-rotation.md) |
| Declare sandbox filesystem, process, and egress settings | [Sandbox policy](sandbox-network.md) |

### Agents and Inference

| Task | Guide |
|---|---|
| Select inference APIs, OpenClaw limits, and Hermes authentication | [Inference configuration](inference.md) |
| Configure and access native dashboards | [Agent interfaces](interfaces.md) |
| Choose an agent and access its native runtime | [Agent runtimes](agents.md) |
| Register an operator-managed OAuth-refresh API credential | [OpenShell OAuth-refresh providers](oauth-refresh.md) |
| Enable tracing or selected-agent web search | experimental [Hermes Relay](agents.md#hermes-relay-tracing) and [web search](agents.md#web-search) |
| Choose a public model for managed vLLM | [Select a managed model](models.md) |
| Package model-specific preparation | [Inline model recipes](recipes.md) |
| Place inference on an SSH-selected Docker engine | [Configure an SSH model service](remote-service.md) |

## Integrate and Reference

| Task | Guide |
|---|---|
| Call deployment operations programmatically | [Use the SDK](sdk.md) |
| Understand the bundled OpenTofu provider | [Provider](provider.md) |
| Check what each release guarantees | [Compatibility](compatibility.md) |
| Configure an image-owned service | [Container service contract](container-services.md) |
| Look up CLI commands and options | [CLI reference](reference/cli.md) |
| Look up YAML fields, defaults, and constraints for this checkout | [Configuration reference](reference/configuration.md) |
| Find harness examples and adapter constraints | [Fabric harnesses](reference/fabric-harnesses.md) |
| Find documentation for coding agents, contribution guidance, and licenses | [Resources](resources.md) |

## Releases, Security, and Limits

| Task | Guide |
|---|---|
| Assess a move from an earlier version | [Migration](migration.md) |
| Check what a release guarantees | [Compatibility](compatibility.md) |
| Find release information | [Release notes](release-notes.md) |
| Check what v1 does not do yet | [Current limits](limits.md) |
| Review credential storage, access, and isolation | [Security](security.md) |
| Understand the security boundary | [Threat model](threat-model.md) |

## Maintainer Guides

Maintainer procedures and design records live in `internal-docs/`, not in the published v1 navigation.


| Task | Guide |
|---|---|
| Run workspace checks and collect coverage | [Tests](../internal-docs/contributing/testing.md) |
| Exercise OpenTofu and bundles with local fixtures | [Run integration tests](../internal-docs/contributing/integration-tests.md) |
| Test explicitly owned live resources | [Run live tests](../internal-docs/contributing/live-tests.md) |
| Stage a private v1 release | [Stage a v1 release](../internal-docs/contributing/releases.md) |
| Write or reorganize documentation | [Contribute documentation](../internal-docs/contributing/documentation.md) |
| Validate, preview, or publish the v1 site | [Documentation build](../internal-docs/contributing/documentation-build.md) |
| Update the generated schema and field reference | [Schema maintenance](../internal-docs/contributing/configuration-schema.md) |

### Design Rationale

Start with the architecture page to follow one deployment through the SDK, OpenTofu, and backend APIs.
Then use the runtime, execution-target, and recipe pages to understand decisions inside that lifecycle.
The design decision defines current invariants.

| Topic | Owner |
|---|---|
| Accepted scope, implementation boundaries, and invariants | [Design decision](../internal-docs/design/scope.md) |
| Authoring concepts, ownership, and validation gates | [Authoring domain model](../internal-docs/design/authoring-domain.md) |
| Partial-document onboarding coverage and open design questions | [Onboarding journey prototype](../internal-docs/design/onboarding-journeys.md) |
| SDK ownership, durable state, staged apply, and retained storage | [Architecture](../internal-docs/design/architecture.md) |
| Apply stages, component handoffs, and agent harness startup | [Apply flow](../internal-docs/design/apply-flow.md) |
| Process lifetime, watchdog recovery, and agent ownership | [Runtime design](../internal-docs/design/runtime.md) |
| Fabric runtime ownership and observation limits | [Fabric management](../internal-docs/design/fabric-management.md) |
| Connections, engine identity, inference traffic, host capacity, and their implementation constraints | [Execution targets](../internal-docs/design/execution-targets.md) |
| Artifact ownership, preparation verification, and output manifests | [Recipe design](../internal-docs/design/recipes.md) |

### Sources and Fixtures

- [Agent runtime source notices](../image/NOTICE.md).
- [Generic vLLM source notices](../image/vllm/NOTICE.md).
- [Configuration fixture provenance](../crates/nemoclaw-sdk/tests/fixtures/config/README.md).
- [Managed runtime fixture provenance](../crates/nemoclaw-provider/src/managed/REFERENCE.md).
