<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Documentation Index

Find a task guide for NemoClaw Agent Configs v0.1.0. Use the bundle, example, schema, and images from the same release. For source builds, match them to the implementation revision. [Current Limits](resources/limits.md) lists unimplemented or untested paths.

## About

Start with the product overview, then use the architecture and ecosystem guides to distinguish deployment behavior from adjacent services.

| Reader goal | Guide |
|---|---|
| Understand the product and choose an interface | [NemoClaw overview](about/overview.md) |
| Follow the components and deployment flow | [Architecture overview](about/architecture-overview.md) |
| Distinguish upstream responsibilities | [Ecosystem](about/ecosystem.md) |
| Track v1 releases | [Release Notes](changelog/overview.md) |

## Getting Started

Check the prerequisites before following the first deployment; migration is a separate path for existing users.

| Reader goal | Guide |
|---|---|
| Check client, runtime, and model-host requirements | [Prerequisites](get-started/prerequisites.md) |
| Install, upgrade, or uninstall a release's CLI | [Installing the CLI](get-started/install.md) |
| Deploy OpenClaw with existing services and verify a reply | [First Deployment](get-started/first-deployment.md) |
| Write YAML for a separate deployment | [Authoring Deployment YAML With Onboarding](get-started/onboard.md) |
| Evaluate Classic settings without changing the original deployment | [Migration](get-started/migration.md) |

## Building and Deploying

Choose the guide for the artifact or deployment operation you need to perform.

| Reader goal | Guide |
|---|---|
| Build a matched bundle and runtime image | [Build local artifacts](build-deploy/build.md) |
| Extend an agent image with your own tools | [Derived agent images](build-deploy/derived-images.md) |
| Configure, apply, export, recover, and destroy | [Use desired state](build-deploy/usage.md) |
| Run the providers from your own OpenTofu project and pipelines | [Your own OpenTofu project](build-deploy/opentofu-project.md) |
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

## Security

Review trust boundaries before configuring sandbox access or rotating credentials.

| Reader Goal | Guide |
|---|---|
| Understand credential storage and trust boundaries | [Security](security/security.md), [Threat Model](security/threat-model.md) |
| Configure isolation and egress | [Sandbox Policy](security/sandbox-network.md) |
| Revoke or rotate credentials | [Credential Rotation](security/credential-rotation.md) |

## References

Look up the interface contract of your source revision before adapting a command, configuration, or SDK call.

| Reader goal | Guide |
|---|---|
| Look up commands and options | [CLI](references/cli.md) |
| Look up configuration fields | [YAML configuration reference](reference/configuration.md) |
| Compare harness descriptors and examples | [Fabric harnesses](references/fabric-harnesses.md) |
| Integrate with the Rust API or OpenTofu | [SDK](references/sdk.md), [provider](references/provider.md) |
| Check release guarantees | [Compatibility](references/compatibility.md) |

## Resources

Use these sources to find help, development status, currently documented limits, and scope.

| Reader goal | Guide |
|---|---|
| Find version-matched documentation and reporting channels | [Project resources](resources/resources.md) |
| Find unimplemented or unqualified paths | [Current limits](resources/limits.md) |
| Find what Agent Configs leaves to other components by design | [Out of Scope](resources/out-of-scope.md) |

For release history, refer to [Release Notes](changelog/overview.md).
