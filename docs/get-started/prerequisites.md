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
- The OpenClaw image digest from the same release as the [installed bundle](install.md). The gateway's sandbox engine must be able to acquire it.
- For plaintext, mTLS, and external OIDC gateways on Linux or macOS Apple silicon, use the bundle's `nemoclaw osh` for native access. External OIDC requires [login settings and sign-in](../references/cli.md#logging-in-to-an-external-oidc-gateway). Other bearer-token gateways require a separately authenticated OpenShell CLI.
- A fresh deployment UUID, a separate state directory, and resources you control.

NemoClaw checks the gateway's reported OpenShell version and compute driver. Use the `components.gateway.version` pin in the release's [`version-pins.json`](../references/compatibility.md#using-one-release-together). The inference endpoint must support the [request API](../agents-inference/inference.md#choosing-the-request-api) you configure; endpoint reachability alone does not establish that the model can reply.

Prepare native access before starting the tutorial:

For plaintext, mTLS, and external OIDC gateways, the bundle already includes the matching CLI.
After apply, use [`nemoclaw osh`](../references/cli.md#running-openshell-against-a-deployment) with the deployment's state directory and referenced TLS files.
No separate OpenShell installation or profile setup is needed.

For bearer-token gateways without OIDC login settings, including managed Kubernetes, configure a separate CLI:

1. Use an OpenShell CLI at the pinned gateway version.

   <Warning>

   The [general OpenShell installer](https://github.com/ai-openshell/openshell/blob/152c59d3178039e3fbb4a5595f9fff7216a6be92/docs/about/installation.mdx) also installs and starts a local gateway. On macOS, it reinstalls an existing OpenShell Homebrew formula and restarts the gateway service.

   To keep an existing deployment running, reuse a compatible CLI or extract the matching standalone CLI archive for your platform from [OpenShell releases](https://github.com/ai-openshell/openshell/releases) into a separate directory. Use the executable's absolute path or put that directory first on `PATH` for the tutorial shell only. Coordinate any gateway installation or replacement with its operator.

   </Warning>

2. Register the gateway in the CLI with `openshell gateway add` and its OIDC settings.
   Follow [OpenShell's authentication guide](https://github.com/ai-openshell/openshell/blob/152c59d3178039e3fbb4a5595f9fff7216a6be92/docs/how-it-works/gateways/authentication.mdx).

The operator provides the external gateway and its credentials.
After apply, the [first-deployment guide](first-deployment.md#sending-a-verification-request) links to gateway and workspace selection and distinguishes readiness from a verified reply.

## Client and Build Tools

To run the release CLI, use a [verified archive](install.md); no Rust, compiler, or image build tools are needed. For a source build, use the [build guide](../build-deploy/build.md) from the revision you build. Keep the resulting bundle intact for the lifetime of its deployments.

The builder accepts `linux_arm64`, `linux_amd64`, `darwin_arm64`, `darwin_amd64`, and `windows_amd64` targets.
Windows ARM64 clients use [Linux ARM64 through WSL2](from-source.md), with the Linux toolchain and Docker Desktop integration enabled for that distribution.
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
| Agent image | An immutable image that matches the sandbox architecture and selected harness. For a source build, use a native Linux ARM64 or AMD64 Docker builder with Buildx; refer to [agent image requirements](../build-deploy/build.md#building-agent-images) |
| Managed vLLM | Matching runtime image, pinned model revision, and storage and capacity for the selected hardware contract; see [managed models](../agents-inference/models.md) and [AMD64 Nemotron configuration](../agents-inference/models.md#configuring-nemotron-on-an-amd64-gpu-host) |
| Managed Ollama | Matching runtime image, pinned model digest, one NVIDIA GPU, and the same hardware, placement, and capacity contract as vLLM; see [managed Ollama](../agents-inference/inference.md#running-managed-ollama) |
| Managed llama.cpp | Matching runtime image, one CUDA GPU, and a pinned public GGUF file with matching checksum; refer to [serving a pinned GGUF](../agents-inference/models.md#serving-a-pinned-gguf-with-llamacpp) |
| Kubernetes or OpenShift gateway | Cluster access and permissions, a reachable inference endpoint you operate, and each image's digest and matching metadata. For a managed gateway, refer to [cluster setup requirements](../build-deploy/kubernetes.md#preparing-the-cluster); on OpenShift, also refer to [OpenShift's requirements](../build-deploy/openshift.md#preparing-the-cluster-and-images) |
| Managed rootless Podman gateway | Podman 5 or later, local Linux API socket, reported `pasta` networking, a private IPv4 default-route interface, and images in the selected Podman store; see [Podman setup](../build-deploy/usage.md#using-a-managed-podman-gateway) |
| External Ollama with managed proxy | Managed local Docker gateway, loopback-only daemon on that same Linux host, installed model digest, and a reachable private proxy endpoint; see [proxy setup](../agents-inference/inference.md#using-external-ollama-through-a-managed-proxy) |
| SSH-managed model service | Trusted noninteractive SSH access and the documented model-host tools; see [remote service](../agents-inference/remote-service.md) |

Build images from a revision that implements the selected configuration features.
Replace the example deployment UUIDs, endpoints, and local image digests with values for your resources.

## Platforms Not Yet Tested

NVIDIA DGX Station, Linux AMD64 deployment, Windows/WSL and macOS GPU hosts, separate SSH model hosts, and distributed inference haven't been tested end to end.
See [current limits](../resources/limits.md#platforms-models-and-placement) for each and its issue.
