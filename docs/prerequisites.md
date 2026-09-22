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

Use OpenShell **0.0.117-dev.186+g1fe79f539** for the gateway and native CLI.
The client, gateway, and supervisor are pinned to commit `1fe79f53991debf32776853a60f0cbd4e127dcfb`, a development build.
The gateway check verifies version and compute driver.
Select a compatible [inference API](inference.md) and verify an actual agent reply; endpoint reachability alone is insufficient.

Provisioning an external gateway and authenticated OpenShell CLI credentials from a clean host: **TBD** — the current guide requires operator-provided services and access.
For an existing profile or plaintext loopback gateway, use [gateway/workspace selection](interfaces.md#select-the-gateway-and-workspace).
See the [first-deployment guide](get-started.md) for its rehearsal status.

## Client and Build Tools

Follow the [source-build guide](build.md) for tool versions and a verified CLI/OpenTofu/provider/schema bundle.
Keep the bundle unchanged while an operation uses it.

The builder accepts `linux_arm64`, `linux_amd64`, `darwin_arm64`, `darwin_amd64`, and `windows_amd64` targets.
[Native platform test results](validation/rust-native-platforms.json) identify the tested revisions; they do not qualify GPU deployment on all five platforms.

Prebuilt release downloads and a supported installation/upgrade channel: **TBD**.

## Runtime and Inference Requirements

| Configuration | Requirements and owning guide |
|---|---|
| External gateway and inference | Existing reachable services, gateway authentication, a compatible inference API/model, and an immutable sandbox image; see [usage](usage.md) and [inference](inference.md) |
| Fabric agent image | Deep Agents and OpenClaw use a native Linux ARM64 or AMD64 Docker builder with Buildx; other agent targets use ARM64; see [image prerequisites](inference.md#build-an-image-with-the-configuration-interface) |
| Managed vLLM | Matching runtime image, pinned model revision, and storage/capacity for the selected hardware contract; see [managed models](models.md) and [AMD64 Nemotron configuration](models.md#configure-nemotron-on-an-amd64-gpu-host) |
| Managed Ollama | Matching runtime image, pinned model digest, one NVIDIA GPU, and the same hardware/placement/capacity contract as vLLM; see [managed Ollama](inference.md#run-managed-ollama) |
| Managed rootless Podman gateway | Local Linux API socket, reported `pasta` networking, a private IPv4 default-route interface, and images in the selected Podman store; see [Podman setup](usage.md#use-a-managed-podman-gateway) |
| External Ollama with managed proxy | Managed local Docker gateway, loopback-only daemon on that same Linux host, installed model digest, and a reachable private proxy endpoint; see [proxy setup](inference.md#use-external-ollama-through-a-managed-proxy) |
| SSH-managed model service | Trusted noninteractive SSH access and the documented model-host tools; see [remote service](remote-service.md) |

Build images from a revision that implements the selected configuration features.
The example deployment UUIDs, endpoints, and local image digests must be replaced with values for your resources.

## Platform Qualification Still Needed

| Deployment claim | Status |
|---|---|
| General DGX Station deployment and setup procedure | **TBD** — requires current implementation and host qualification |
| Linux AMD64 Fabric deployment | **TBD** — the native Deep Agents and OpenClaw image builds and tests do not establish gateway provisioning or an end-to-end agent response |
| AMD64 Nemotron image and GPU inference | **TBD** — configuration and build-platform tests do not establish a successful image build, model load, or agent response on the target host |
| Windows/WSL or macOS local GPU deployment | **TBD** — native client test results do not establish runtime support |
| Separate physical SSH model host | **TBD** — the retained two-daemon live result used one DGX Spark |
| Distributed inference across two Sparks or Stations | **TBD** — SSH placement alone does not implement distributed inference |
| Every harness/provider/model combination | **TBD** — requires test results for the specific combination |

Use [recorded test results](validation/README.md) for the configurations tested so far.
