<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Documentation Index

These guides describe NemoClaw v1. The operational updates beyond the first-deployment tutorial reflect inspected implementation `origin/v1` at `86b8d94273a76a696e06b300dc29f7035b163667`; use a matched checkout and bundle when following them. The published [v1 field reference](references/v1-configuration.md) is a snapshot generated at that implementation revision. This checkout's [generator-owned reference](reference/configuration.md) has the same named-map configuration shape but differs on three optional field types; use the snapshot and schema from the bundle's source revision when checking field types. For the source-pinned first deployment, use the [tutorial](get-started/first-deployment.md).
[Current limits](resources/limits.md) lists what v1 does not do yet or has not tested, with the issue tracking each.

## About

Start with the product overview, then use the architecture and ecosystem guides to distinguish deployment behavior from adjacent services.

| Reader goal | Guide |
|---|---|
| Understand the product and choose an interface | [NemoClaw overview](about/overview.md) |
| Follow the components and deployment flow | [Architecture overview](about/architecture-overview.md) |
| Distinguish upstream responsibilities | [Ecosystem](about/ecosystem.md) |
| Check v1 development status and changes | [Release Notes](about/release-notes.md) |

## Get Started

Check the prerequisites before following the first deployment; migration is a separate path for existing users.

| Reader goal | Guide |
|---|---|
| Check client, runtime, and model-host requirements | [Prerequisites](get-started/prerequisites.md) |
| Deploy OpenClaw with existing gateway and inference services | [First deployment](get-started/first-deployment.md) |
| Assess a move from an earlier version | [Migration](get-started/migration.md) |

## Build and Deploy

Choose the guide for the artifact or deployment operation you need to perform.

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

Configure the agent and its inference connection, then verify a reply through a native interface.

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

Use operation output and runtime evidence to identify where a deployment or agent request failed.

| Reader goal | Guide |
|---|---|
| Collect operation output, sandbox logs, native artifacts, and available traces; distinguish readiness from a reply | [Troubleshooting](observability/troubleshooting.md) |

## References

Look up the pinned v1 interface contract before adapting a command, configuration, or SDK call.

| Reader goal | Guide |
|---|---|
| Look up commands and options | [CLI](references/cli.md) |
| Look up fields for the pinned v1 source | [V1 configuration reference](references/v1-configuration.md) |
| Compare harness descriptors and examples | [Fabric harnesses](references/fabric-harnesses.md) |
| Integrate with the Rust API or OpenTofu | [SDK](references/sdk.md), [provider](references/provider.md) |
| Check release guarantees | [Compatibility](references/compatibility.md) |

## Resources

Use these sources to find help, development status, and currently documented limits.

| Reader goal | Guide |
|---|---|
| Find version-matched documentation and reporting channels | [Project resources](resources/resources.md) |
| Check release status | [Release Notes](about/release-notes.md) |
| Find unimplemented or unqualified paths | [Current limits](resources/limits.md) |

## Security

Review trust boundaries before configuring sandbox access or rotating credentials.

| Reader goal | Guide |
|---|---|
| Understand credential storage and trust boundaries | [Security](security/security.md), [threat model](security/threat-model.md) |
| Configure isolation and egress | [Sandbox policy](security/sandbox-network.md) |
| Revoke or rotate credentials | [Credential rotation](security/credential-rotation.md) |

Maintainers can find contribution procedures, design records, and artifact provenance in the [repository-only maintainer index](../internal-docs/README.md). These pages are not part of the published v1 guide.
