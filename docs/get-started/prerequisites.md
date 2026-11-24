<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Checking Prerequisites

Identify the client host, sandbox engine, and inference host before building a deployment.
They can have different requirements.
A working client binary doesn't qualify the runtime or GPU host.

## Identifying Each Host

Record where each component runs before checking tool and network requirements.

| Role | Must be available there |
|---|---|
| Client running NemoClaw | Matching native bundle, writable deployment state directory, referenced credential and TLS files, and access to the gateway and selected engine |
| Image build host | The selected image recipe's toolchain and architecture; see [runtime requirements](#runtime-and-inference-requirements) |
| Sandbox engine host | NVIDIA OpenShell's configured compute daemon and the selected immutable agent image |
| Inference host | A reachable compatible endpoint, or the tools, image, model storage, and capacity required by the selected managed service |

One machine can fill several roles.
An image built on one daemon isn't automatically available on another, and loopback addresses refer to the host or network namespace making the connection.
For remote model placement, use the [SSH service guide](../agents-inference/remote-service.md).
SSH access doesn't provide an inference tunnel.

## Before the First Deployment

The [first-deployment guide](first-deployment.md) uses OpenClaw with an existing OpenShell gateway and external inference endpoint.
Prepare these inputs before running apply:

- An OpenShell gateway with the selected Docker or Podman compute driver and permission to create a deployment workspace and sandbox.
- Its client-reachable endpoint and any bearer credential or mTLS files required by the gateway operator.
- An inference endpoint reachable from OpenShell, its request API, an exact model ID, and any provider credential.
- An OpenClaw image built from the same implementation revision as the deployment bundle and available by immutable digest on the sandbox compute daemon.
- An authenticated OpenShell CLI for native access, configured for the same gateway and the deployment's workspace.
- A fresh deployment UUID, a separate state directory, and resources you control.

For the [source-pinned first-deployment tutorial](first-deployment.md), use OpenShell **0.1.9** for the gateway and native CLI, and Rust 1.100.0 from its pinned worktree. A newer checkout's `versions.json` can pin another OpenShell version; don't use that version with the tutorial bundle.
The tutorial's pinned NemoClaw implementation (`1636069b91f402242a35714fde1011042c3f1f70`) records this version and OpenShell source revision `ce58cf8e9b953281352d98a637e41616295b1318` in its `versions.json`.
Its gateway check rejects a different reported OpenShell version or an incompatible compute driver.
For another NemoClaw revision, use its own `versions.json` rather than assuming this version applies.
Select a compatible [inference API](../agents-inference/inference.md) and verify an actual agent reply.
Endpoint reachability alone is insufficient.

Prepare the pinned CLI before starting the tutorial:

1. Install the OpenShell CLI release with [OpenShell's installer](https://github.com/NVIDIA/OpenShell/blob/ce58cf8e9b953281352d98a637e41616295b1318/docs/about/installation.mdx), setting `OPENSHELL_VERSION=v0.1.9`.

2. If the external gateway needs an authenticated profile, register it in the CLI with `openshell gateway add` for mTLS or OIDC.
   Follow [OpenShell's authentication guide](https://github.com/NVIDIA/OpenShell/blob/ce58cf8e9b953281352d98a637e41616295b1318/docs/how-it-works/gateways/authentication.mdx).

The operator provides the external gateway and its credentials.
After apply, the [first-deployment guide](first-deployment.md#sending-a-verification-request) links to gateway and workspace selection and distinguishes readiness from a verified reply.

## Client and Build Tools

For the pinned first deployment, use `docs/build-deploy/build.md` in the tutorial's worktree ([pinned build guide](https://github.com/NVIDIA/NemoClaw/blob/1636069b91f402242a35714fde1011042c3f1f70/docs/build-deploy/build.md)).
For builds from this documentation checkout, use its [source-build guide](../build-deploy/build.md) for tool versions and a verified bundle of the CLI, OpenTofu, providers, and schemas.
Don't combine the two toolchains.
Keep the bundle unchanged while an operation uses it.

The builder accepts `linux_arm64`, `linux_amd64`, `darwin_arm64`, `darwin_amd64`, and `windows_amd64` targets.
Windows ARM64 clients use [Linux ARM64 through WSL2](windows-wsl.md), with the Linux toolchain and Docker Desktop integration enabled for that distribution.
`CI / Bundle` builds and tests on Linux ARM64, Linux AMD64, macOS ARM64, and Windows AMD64.
These builds and tests don't qualify GPU deployment on every platform.

On Linux, the oldest supported release is Ubuntu 22.04, whose glibc is 2.35.
`CI / Bundle` builds the Linux bundles there and fails if any bundle executable needs a newer glibc.
It runs the contract, integration, and live tests on Ubuntu 24.04.
A bundle runs only where the glibc is at least as new as on the host that built it, so build it on the oldest Linux release that will run it.

To use a release's CLI instead of building it, [install the CLI](install.md) from the release's archive for your platform.

## Runtime and Inference Requirements

Choose the gateway and model placement that matches the available engine and endpoint.

| Configuration | Requirements and owning guide |
|---|---|
| External gateway and inference | Existing reachable services, gateway authentication, a compatible inference API and model, and an immutable sandbox image; see [usage](../build-deploy/usage.md) and [inference](../agents-inference/inference.md) |
| NVIDIA NeMo Fabric agent image | A native Linux ARM64 or AMD64 Docker builder with Buildx, which builds every agent target; use the selected worktree's image prerequisites ([pinned tutorial](https://github.com/NVIDIA/NemoClaw/blob/1636069b91f402242a35714fde1011042c3f1f70/docs/build-deploy/build.md#building-agent-images), [this checkout](../build-deploy/build.md#building-agent-images)) |
| Managed vLLM | Matching runtime image, pinned model revision, and storage and capacity for the selected hardware contract; see [managed models](../agents-inference/models.md) and [AMD64 Nemotron configuration](../agents-inference/models.md#configuring-nemotron-on-an-amd64-gpu-host) |
| Managed Ollama | Matching runtime image, pinned model digest, one NVIDIA GPU, and the same hardware, placement, and capacity contract as vLLM; see [managed Ollama](../agents-inference/inference.md#running-managed-ollama) |
| Managed rootless Podman gateway | Podman 5 or later, local Linux API socket, reported `pasta` networking, a private IPv4 default-route interface, and images in the selected Podman store; see [Podman setup](../build-deploy/usage.md#using-a-managed-podman-gateway) |
| External Ollama with managed proxy | Managed local Docker gateway, loopback-only daemon on that same Linux host, installed model digest, and a reachable private proxy endpoint; see [proxy setup](../agents-inference/inference.md#using-external-ollama-through-a-managed-proxy) |
| SSH-managed model service | Trusted noninteractive SSH access and the documented model-host tools; see [remote service](../agents-inference/remote-service.md) |

Build images from a revision that implements the selected configuration features.
Replace the example deployment UUIDs, endpoints, and local image digests with values for your resources.

## Platforms Not Yet Tested

NVIDIA DGX Station, Linux AMD64 deployment, Windows/WSL and macOS GPU hosts, separate SSH model hosts, and distributed inference haven't been tested end to end.
See [current limits](../resources/limits.md#platforms-models-and-placement) for each and its issue.
