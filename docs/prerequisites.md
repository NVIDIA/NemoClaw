<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Check Prerequisites

Identify the client host, sandbox engine, and inference host before building a deployment.
They can have different requirements; a working client binary does not qualify the runtime or GPU host.

## Identify Each Host

| Role | Must be available there |
|---|---|
| Client running NemoClaw | Matching native bundle, writable deployment state directory, referenced credentials/TLS files, and access to the gateway and selected engine |
| Image build host | The image recipe's toolchain and architecture; the documented Fabric build uses Linux ARM64 |
| Sandbox engine host | OpenShell's configured compute daemon and the selected immutable agent image |
| Inference host | A reachable compatible endpoint, or the tools, image, model storage, and capacity required by the selected managed service |

One machine can fill several roles.
An image built on one daemon is not automatically available on another, and loopback addresses refer to the host or network namespace making the connection.
For remote model placement, use the [SSH service guide](remote-service.md); SSH access does not provide an inference tunnel.

## Before the First Deployment

The [first-deployment guide](get-started.md) uses OpenClaw with an existing OpenShell gateway and external inference endpoint.
Prepare these inputs before running apply:

- An OpenShell **0.0.117-dev.155+gb3e4ad457** gateway with the Docker compute driver and permission to create a deployment workspace and sandbox.
- Its client-reachable endpoint and any bearer credential or mTLS files required by the gateway operator.
- An inference endpoint reachable from OpenShell, its request API, an exact model ID, and any provider credential.
- An OpenClaw image built from this checkout and available by immutable digest on the sandbox compute daemon.
- An authenticated OpenShell **0.0.117-dev.155+gb3e4ad457** CLI for native access, configured for the same gateway and the deployment's workspace.
- A fresh deployment UUID, a separate state directory, and resources you control.

The client, gateway, and supervisor are pinned to OpenShell commit `b3e4ad4579e24dacfb285924876473b50a04b988`; this is a development build, not a stable release.
The [gateway check](../crates/nemoclaw-sdk/src/openshell/probes.rs) verifies the version and compute driver.
Use [inference API selection](inference.md) to match the endpoint to the agent.
A successful connection or listed model does not establish that the model can complete an agent turn.

Provisioning an external gateway and authenticated OpenShell CLI credentials from a clean host: **TBD** — the current guide requires operator-provided services and access.
For an existing profile or plaintext loopback gateway, use [gateway/workspace selection](interfaces.md#select-the-gateway-and-workspace).
End-to-end rehearsal of this first-deployment procedure on the current revision: **TBD**.

## Client and Build Tools

Use the versions in [the build guide](build.md) and [versions.json](../versions.json).
Build a verified bundle containing the CLI, OpenTofu, provider, and matching configuration schema.
Keep that bundle unchanged while an operation uses it.

The builder accepts `linux_arm64`, `linux_amd64`, `darwin_arm64`, `darwin_amd64`, and `windows_amd64` targets.
[Native platform evidence](validation/rust-native-platforms.json) records the tested revisions; it does not qualify GPU deployment on all five platforms.

Prebuilt release downloads and a supported installation/upgrade channel: **TBD**.
Use the existing [source-build procedure](build.md) for the documented development workflow.

## Runtime and Inference Requirements

| Configuration | Requirements and owning guide |
|---|---|
| External gateway and inference | Existing reachable services, gateway authentication, a compatible inference API/model, and an immutable sandbox image; see [usage](usage.md) and [inference](inference.md) |
| Fabric agent image | The local build uses a native Linux ARM64 Docker builder with Buildx; see [image prerequisites](inference.md#build-an-image-with-the-configuration-interface) |
| Managed vLLM | Matching runtime image, pinned model revision, and storage/capacity for the selected hardware contract; see [managed models](models.md) and [AMD64 Nemotron configuration](models.md#configure-nemotron-on-an-amd64-gpu-host) |
| Managed Ollama | Local Unix engine socket, an existing network supporting published ports, reachable private endpoint, and CPU-sized model; see [managed Ollama](inference.md#run-managed-ollama) |
| External Ollama with managed proxy | Local Linux Docker host, loopback-only daemon, installed model digest, and a reachable private proxy endpoint; see [proxy setup](inference.md#use-external-ollama-through-a-managed-proxy) |
| SSH-managed model service | Trusted noninteractive SSH access and the documented model-host tools; see [remote service](remote-service.md) |

Build images from a revision that implements the selected configuration features.
An image available on the build daemon is not automatically available to the sandbox or model-service daemon.
The example deployment UUIDs, endpoints, and local image digests must be replaced with values for your resources.

## Platform Qualification Still Needed

| Deployment claim | Status |
|---|---|
| General DGX Station deployment and setup procedure | **TBD** — requires current implementation and host qualification |
| AMD64 Nemotron image and GPU inference | **TBD** — configuration and build-platform tests do not establish a successful image build, model load, or agent response on the target host |
| Windows/WSL or macOS local GPU deployment | **TBD** — native client evidence does not establish runtime support |
| Separate physical SSH model host | **TBD** — the retained two-daemon live result used one DGX Spark |
| Distributed inference across two Sparks or Stations | **TBD** — SSH placement alone does not implement distributed inference |
| Every harness/provider/model combination | **TBD** — requires evidence for the specific combination |

Use [validation evidence](validation/README.md) for the configurations tested so far.
