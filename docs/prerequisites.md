<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Check Prerequisites

Identify the client host, sandbox engine, and inference host before building a deployment.
They can have different requirements; a working client binary does not qualify the runtime or GPU host.

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
| Fabric agent image | The documented local build uses Linux ARM64, Docker, uv, and a native C/Rust toolchain; see [image prerequisites](inference.md#build-an-image-with-the-configuration-interface) |
| Managed vLLM | Matching runtime image, pinned model revision, and storage/capacity for the selected hardware contract; see [managed models](models.md) and [AMD64 Nemotron configuration](models.md#configure-nemotron-on-an-amd64-gpu-host) |
| Managed Ollama | Local Unix engine socket and an existing Docker network; see [configuration and credentials](usage.md#configuration-and-credentials) |
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
