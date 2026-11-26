<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Documentation Index

Find a task guide for NemoClaw Agent Configs v0.1.0.
Use the bundle, example, schema, and images from the same release.
For source builds, match them to the implementation revision.
[Current Limits](resources/limits.md) lists unimplemented or untested paths.

## About

Start with the product overview, then use the architecture and ecosystem guides to distinguish deployment behavior from adjacent services.

| Reader goal | Guide |
|---|---|
| Understand the product and choose an interface | [NemoClaw Agent Configs Overview](about/overview.md) |
| Follow the components and deployment flow | [Architecture Overview](about/architecture-overview.md) |
| Distinguish upstream responsibilities | [Ecosystem](about/ecosystem.md) |
| Track NemoClaw Agent Configs releases | [Release Notes](changelog/overview.md) |

## Getting Started

Start with prerequisites to choose a release deployment, a source build, or an existing gateway.
On Windows, the first-reply tutorials run in WSL2, not in the native Windows CLI.

| Reader goal | Guide |
|---|---|
| Check client, runtime, and model-host requirements | [Checking Prerequisites](get-started/prerequisites.md) |
| Install, upgrade, or uninstall the CLI using a platform installer or archive | [Installing the CLI](get-started/install.md) |
| Deploy OpenClaw from the release with local Docker and NVIDIA Endpoints, or with existing services | [Deploying Your First OpenClaw Agent](get-started/first-deployment.md) |
| Build from source and deploy Hermes with a managed Docker gateway on an Apple silicon Mac or in WSL2 | [Onboarding From Source on macOS or WSL2](get-started/from-source.md) |
| Write YAML for a separate deployment | [Authoring Deployment YAML With Onboarding](get-started/onboard.md) |
| Evaluate NemoClaw v0 settings without changing the original deployment | [Evaluating NemoClaw Agent Configs Alongside NemoClaw v0](get-started/migration.md) |

## Building and Deploying

Choose the guide for the artifact or deployment operation you need to perform.

| Reader goal | Guide |
|---|---|
| Build a matched bundle and runtime image | [Build Local Artifacts](build-deploy/build.md) |
| Extend an agent image with your own tools | [Derived Agent Images](build-deploy/derived-images.md) |
| Configure, apply, export, recover, and destroy | [Use Desired State](build-deploy/usage.md) |
| Run the providers from your own OpenTofu project and pipelines | [Your Own OpenTofu Project](build-deploy/opentofu-project.md) |
| Deploy on Kubernetes with a managed or an external gateway | [Kubernetes Deployment](build-deploy/kubernetes.md) |
| Deploy on OpenShift | [OpenShift Deployment](build-deploy/openshift.md) |
| Share or inline definitions | [Definitions and References](build-deploy/configuration-references.md) |
| Retain data and clean up safely | [Deployment State](build-deploy/state.md) |
| Run an application-owned container on managed Docker | [Container Service](build-deploy/container-services.md) |

## Agents and Inference

Configure the agent and its inference connection, then verify a reply through a native interface.

| Reader goal | Guide |
|---|---|
| Select and invoke an agent | [Agent Runtimes](agents-inference/agents.md) |
| Reach a native interface | [Agent Interfaces](agents-inference/interfaces.md) |
| Configure model connections and verify a request | [Inference](agents-inference/inference.md) |
| Select a managed model | [Models](agents-inference/models.md) |
| Package model preparation | [Recipes](agents-inference/recipes.md) |
| Place inference over SSH | [SSH Model Service](agents-inference/remote-service.md) |
| Attach an operator-managed refresh credential | [OAuth-Refresh Providers](agents-inference/oauth-refresh.md) |

## Observability

Use operation output and runtime evidence to identify where a deployment or agent request failed.

| Reader goal | Guide |
|---|---|
| Collect operation output, sandbox logs, native artifacts, and available traces; distinguish readiness from a reply | [Troubleshooting](observability/troubleshooting.md) |

## Security

Review trust boundaries before configuring sandbox access or rotating credentials.

| Reader goal | Guide |
|---|---|
| Understand credential storage and trust boundaries | [Security](security/security.md), [Threat Model](security/threat-model.md) |
| Configure isolation and egress | [Sandbox Policy](security/sandbox-network.md) |
| Revoke or rotate credentials | [Credential Rotation](security/credential-rotation.md) |

## References

Look up the interface contract of your source revision before adapting a command, configuration, or SDK call.

| Reader goal | Guide |
|---|---|
| Look up commands and options | [CLI](references/cli.md) |
| Look up configuration fields | [YAML Configuration Reference](reference/configuration.md) |
| Compare harness descriptors and examples | [Fabric Harnesses](references/fabric-harnesses.md) |
| Integrate with the Rust API or OpenTofu | [SDK](references/sdk.md), [Provider](references/provider.md) |
| Check release guarantees | [Compatibility](references/compatibility.md) |

## Resources

Use these sources to find help, development status, currently documented limits, and scope.

| Reader goal | Guide |
|---|---|
| Find version-matched documentation and reporting channels | [Project Resources](resources/resources.md) |
| See how NemoClaw v0 builds documentation for coding agents | [Engineer Documentation for AI Agents (NemoClaw v0 Example)](https://github.com/NVIDIA/NemoClaw/blob/4649634639d2ddcb26b84cb34db63b2d4176a8a1/docs/resources/engineer-agentic-documentation.mdx) |
| Find unimplemented or unqualified paths | [Current Limits](resources/limits.md) |
| Find what Agent Configs leaves to other components by design | [Out of Scope](resources/out-of-scope.md) |

For release history, refer to [Release Notes](changelog/overview.md).
