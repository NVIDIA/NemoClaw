<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Check Prerequisites

Identify the client host, sandbox engine, and inference host before building a deployment.
They can have different requirements; a working client binary does not qualify the runtime or GPU host.

## Identify Each Host

Record where each component runs before checking tool and network requirements.

| Role | Must be available there |
|---|---|
| Client running NemoClaw | Matching native bundle, writable deployment state directory, referenced credentials/TLS files, and access to the gateway and selected engine |
| Image build host | The selected image recipe's toolchain and architecture; see [runtime requirements](#runtime-and-inference-requirements) |
| Sandbox engine host | OpenShell's configured compute daemon and the selected immutable agent image |
| Inference host | A reachable compatible endpoint, or the tools, image, model storage, and capacity required by the selected managed service |

One machine can fill several roles.
An image built on one daemon is not automatically available on another, and loopback addresses refer to the host or network namespace making the connection.
For remote model placement, use the [SSH service guide](../agents-inference/remote-service.md); SSH access does not provide an inference tunnel.

## Before the First Deployment

The [first-deployment guide](first-deployment.md) uses OpenClaw with an existing OpenShell gateway and external inference endpoint.
Prepare these inputs before running apply:

- An OpenShell gateway with the selected Docker or Podman compute driver and permission to create a deployment workspace and sandbox.
- Its client-reachable endpoint and any bearer credential or mTLS files required by the gateway operator.
- An inference endpoint reachable from OpenShell, its request API, an exact model ID, and any provider credential.
- An OpenClaw image built from the same implementation revision as the deployment bundle and available by immutable digest on the sandbox compute daemon.
- An authenticated OpenShell CLI for native access, configured for the same gateway and the deployment's workspace.
- A fresh deployment UUID, a separate state directory, and resources you control.

For the [first-deployment tutorial](first-deployment.md), use OpenShell **0.1.6** for the gateway and native CLI.
The tutorial's pinned NemoClaw implementation (`86b8d94273a76a696e06b300dc29f7035b163667`) records this version and OpenShell source revision `ac7f615cd12d5cc49cb16eb1f5f10ffeb1e90f47` in its `versions.json`.
Its gateway check rejects a different reported OpenShell version or an incompatible compute driver.
For another NemoClaw revision, use its own `versions.json` rather than assuming this version applies.
Select a compatible [inference API](../agents-inference/inference.md) and verify an actual agent reply; endpoint reachability alone is insufficient.

Install the OpenShell CLI release with [OpenShell's installer](https://github.com/NVIDIA/OpenShell/blob/ac7f615cd12d5cc49cb16eb1f5f10ffeb1e90f47/docs/about/installation.mdx), setting `OPENSHELL_VERSION=v0.1.6`.
The guides assume an operator provides the external gateway and its credentials; register an authenticated gateway in the CLI as [OpenShell's authentication guide](https://github.com/NVIDIA/OpenShell/blob/ac7f615cd12d5cc49cb16eb1f5f10ffeb1e90f47/docs/how-it-works/gateways/authentication.mdx) describes, with `openshell gateway add` for mTLS or OIDC.
For an existing profile or plaintext loopback gateway, use [gateway/workspace selection](../agents-inference/interfaces.md#select-the-gateway-and-workspace).
See the [first-deployment guide](first-deployment.md) for its rehearsal status.

## Client and Build Tools

Follow the [source-build guide](../build-deploy/build.md) for tool versions and a verified CLI/OpenTofu/provider/schema bundle.
Keep the bundle unchanged while an operation uses it.

The builder accepts `linux_arm64`, `linux_amd64`, `darwin_arm64`, `darwin_amd64`, and `windows_amd64` targets.
`CI / Bundle` builds and tests on Linux ARM64, Linux AMD64, macOS ARM64, and Windows AMD64; that does not qualify GPU deployment on every platform.

There are no release downloads or installer yet ([#12638](https://github.com/NVIDIA/NemoClaw/issues/12638)).

## Runtime and Inference Requirements

Choose the gateway and model placement that matches the available engine and endpoint.

| Configuration | Requirements and owning guide |
|---|---|
| External gateway and inference | Existing reachable services, gateway authentication, a compatible inference API/model, and an immutable sandbox image; see [usage](../build-deploy/usage.md) and [inference](../agents-inference/inference.md) |
| Fabric agent image | Deep Agents and OpenClaw use a native Linux ARM64 or AMD64 Docker builder with Buildx; other agent targets use ARM64; see [image prerequisites](../build-deploy/build.md#build-agent-images) |
| Managed vLLM | Matching runtime image, pinned model revision, and storage/capacity for the selected hardware contract; see [managed models](../agents-inference/models.md) and [AMD64 Nemotron configuration](../agents-inference/models.md#configure-nemotron-on-an-amd64-gpu-host) |
| Managed Ollama | Matching runtime image, pinned model digest, one NVIDIA GPU, and the same hardware/placement/capacity contract as vLLM; see [managed Ollama](../agents-inference/inference.md#run-managed-ollama) |
| Managed rootless Podman gateway | Podman 5 or later, local Linux API socket, reported `pasta` networking, a private IPv4 default-route interface, and images in the selected Podman store; see [Podman setup](../build-deploy/usage.md#use-a-managed-podman-gateway) |
| External Ollama with managed proxy | Managed local Docker gateway, loopback-only daemon on that same Linux host, installed model digest, and a reachable private proxy endpoint; see [proxy setup](../agents-inference/inference.md#use-external-ollama-through-a-managed-proxy) |
| SSH-managed model service | Trusted noninteractive SSH access and the documented model-host tools; see [remote service](../agents-inference/remote-service.md) |

Build images from a revision that implements the selected configuration features.
The example deployment UUIDs, endpoints, and local image digests must be replaced with values for your resources.

## Platforms Not Yet Tested

DGX Station, Linux AMD64 deployment, Windows/WSL and macOS GPU hosts, separate SSH model hosts and distributed inference have not been tested end to end.
See [current limits](../resources/limits.md#platforms-models-and-placement) for each and its issue.
