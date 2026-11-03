<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Documentation

These guides describe NemoClaw v1. The operational updates beyond the first-deployment tutorial reflect inspected implementation `origin/v1` at `86b8d94273a76a696e06b300dc29f7035b163667`; use a matched checkout and bundle when following them. The checked-in generated configuration reference still describes this documentation checkout, not the newer implementation revision. For the source-pinned first deployment, use the [tutorial](get-started/first-deployment.md).
[Current limits](resources/limits.md) lists what v1 does not do yet or has not tested, with the issue tracking each.

## About

| Reader goal | Guide |
|---|---|
| Understand the product and choose an interface | [NemoClaw overview](about/overview.md) |
| Follow the components and deployment flow | [Architecture overview](about/architecture-overview.md) |
| Distinguish upstream responsibilities | [Ecosystem](about/ecosystem.md) |

## Get Started

| Reader goal | Guide |
|---|---|
| Check client, runtime, and model-host requirements | [Prerequisites](get-started/prerequisites.md) |
| Deploy OpenClaw with existing gateway and inference services | [First deployment](get-started/first-deployment.md) |
| Assess a move from an earlier version | [Migration](get-started/migration.md) |

## Build and Deploy

| Reader goal | Guide |
|---|---|
| Build a matched bundle and runtime image | [Build local artifacts](build-deploy/build.md) |
| Extend an agent image with your own tools | [Derived agent images](build-deploy/derived-images.md) |
| Configure, apply, export, recover, and destroy | [Use desired state](build-deploy/usage.md) |
| Deploy on Kubernetes or OpenShift | [Cluster deployment](build-deploy/kubernetes.md) |
| Share or inline definitions | [Definitions and references](build-deploy/configuration-references.md) |
| Retain data and clean up safely | [Deployment state](build-deploy/state.md) |
| Run an application-owned container on managed Docker | [Container service](build-deploy/container-services.md) |

## Agents and Inference

| Reader goal | Guide |
|---|---|
| Select and invoke an agent | [Agent runtimes](agents-inference/agents.md) |
| Reach a native interface | [Agent interfaces](agents-inference/interfaces.md) |
| Configure model connections and verify a request | [Inference](agents-inference/inference.md) |
| Select a managed model | [Models](agents-inference/models.md) |
| Package model preparation | [Recipes](agents-inference/recipes.md) |
| Place inference over SSH | [SSH model service](agents-inference/remote-service.md) |
| Attach an operator-managed refresh credential | [OAuth-refresh providers](agents-inference/oauth-refresh.md) |

## Observability

| Reader goal | Guide |
|---|---|
| Collect operation output, sandbox logs, native artifacts, and available traces; distinguish readiness from a reply | [Troubleshooting](observability/troubleshooting.md) |

## References

| Reader goal | Guide |
|---|---|
| Look up commands and options | [CLI](references/cli.md) |
| Look up generated YAML fields for this checkout | [Configuration reference](reference/configuration.md) |
| Compare harness descriptors and examples | [Fabric harnesses](references/fabric-harnesses.md) |
| Integrate with the Rust API or OpenTofu | [SDK](references/sdk.md), [provider](references/provider.md) |
| Check release guarantees | [Compatibility](references/compatibility.md) |

## Resources

| Reader goal | Guide |
|---|---|
| Find version-matched documentation and reporting channels | [Project resources](resources/resources.md) |
| Check release status | [Release notes](resources/release-notes.md) |
| Find unimplemented or unqualified paths | [Current limits](resources/limits.md) |

## Security

| Reader goal | Guide |
|---|---|
| Understand credential storage and trust boundaries | [Security](security/security.md), [threat model](security/threat-model.md) |
| Configure isolation and egress | [Sandbox policy](security/sandbox-network.md) |
| Revoke or rotate credentials | [Credential rotation](security/credential-rotation.md) |

## Maintainer Guides (Repository Only)

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
