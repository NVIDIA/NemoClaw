<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Check Prerequisites

Identify the client host, sandbox engine, and inference host before building a deployment.
They can have different requirements; a working client binary does not qualify the runtime or GPU host.

## Identify Each Host

| Role | Must be available there |
|---|---|
| Client running NemoClaw | Matching native bundle, writable deployment state directory, referenced credentials/TLS files, and access to the gateway and selected engine |
| Image build host | The selected image recipe's toolchain and architecture; see [runtime requirements](#runtime-and-inference-requirements) |
| Sandbox engine host | OpenShell's configured compute daemon and the selected immutable agent image |
| Inference host | A reachable compatible endpoint, or the tools, image, model storage, and capacity required by the selected managed service |

One machine can fill several roles.
An image built on one daemon is not automatically available on another, and loopback addresses refer to the host or network namespace making the connection.
For remote model placement, use the [SSH service guide](remote-service.md); SSH access does not provide an inference tunnel.

## Before the First Deployment

The [first-deployment guide](get-started.md) uses OpenClaw with an existing OpenShell gateway and external inference endpoint.
Prepare these inputs before running apply:

- An OpenShell gateway with the selected Docker or Podman compute driver and permission to create a deployment workspace and sandbox.
- Its client-reachable endpoint and any bearer credential or mTLS files required by the gateway operator.
- An inference endpoint reachable from OpenShell, its request API, an exact model ID, and any provider credential.
- An OpenClaw image built from this checkout and available by immutable digest on the sandbox compute daemon.
- An authenticated OpenShell CLI for native access, configured for the same gateway and the deployment's workspace.
- A fresh deployment UUID, a separate state directory, and resources you control.

Use OpenShell **0.1.3** for the gateway and native CLI.
The client, gateway, and supervisor are pinned to commit `e1f3c82caa3ed3b65de22889ae7ef32a774878ef`, the v0.1.3 release.
The gateway check verifies version and compute driver.
Select a compatible [inference API](inference.md) and verify an actual agent reply; endpoint reachability alone is insufficient.

The guides assume an operator provides the external gateway and OpenShell CLI credentials; provisioning them from a clean host is tracked in [#12642](https://github.com/NVIDIA/NemoClaw/issues/12642).
For an existing profile or plaintext loopback gateway, use [gateway/workspace selection](interfaces.md#select-the-gateway-and-workspace).
See the [first-deployment guide](get-started.md) for its rehearsal status.

## Client and Build Tools

Follow the [source-build guide](build.md) for tool versions and a verified CLI/OpenTofu/provider/schema bundle.
Keep the bundle unchanged while an operation uses it.

The builder accepts `linux_arm64`, `linux_amd64`, `darwin_arm64`, `darwin_amd64`, and `windows_amd64` targets.
Native CI builds and tests on Linux ARM64, Linux AMD64, macOS ARM64, and Windows AMD64; that does not qualify GPU deployment on every platform.

There are no release downloads or installer yet ([#12638](https://github.com/NVIDIA/NemoClaw/issues/12638)).

## Runtime and Inference Requirements

| Configuration | Requirements and owning guide |
|---|---|
| External gateway and inference | Existing reachable services, gateway authentication, a compatible inference API/model, and an immutable sandbox image; see [usage](usage.md) and [inference](inference.md) |
| Fabric agent image | Deep Agents and OpenClaw use a native Linux ARM64 or AMD64 Docker builder with Buildx; other agent targets use ARM64; see [image prerequisites](build.md#build-agent-images) |
| Managed vLLM | Matching runtime image, pinned model revision, and storage/capacity for the selected hardware contract; see [managed models](models.md) and [AMD64 Nemotron configuration](models.md#configure-nemotron-on-an-amd64-gpu-host) |
| Managed Ollama | Matching runtime image, pinned model digest, one NVIDIA GPU, and the same hardware/placement/capacity contract as vLLM; see [managed Ollama](inference.md#run-managed-ollama) |
| Managed rootless Podman gateway | Local Linux API socket, reported `pasta` networking, a private IPv4 default-route interface, and images in the selected Podman store; see [Podman setup](usage.md#use-a-managed-podman-gateway) |
| External Ollama with managed proxy | Managed local Docker gateway, loopback-only daemon on that same Linux host, installed model digest, and a reachable private proxy endpoint; see [proxy setup](inference.md#use-external-ollama-through-a-managed-proxy) |
| SSH-managed model service | Trusted noninteractive SSH access and the documented model-host tools; see [remote service](remote-service.md) |

Build images from a revision that implements the selected configuration features.
The example deployment UUIDs, endpoints, and local image digests must be replaced with values for your resources.

## Platforms Not Yet Tested

DGX Station, Linux AMD64 deployment, Windows/WSL and macOS GPU hosts, separate SSH model hosts and distributed inference have not been tested end to end.
See [current limits](limits.md#platforms-models-and-placement) for each and its issue.
