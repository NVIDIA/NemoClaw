<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Checking Prerequisites

Identify the client host, sandbox engine, and inference host before building a deployment.
Use the [installation guide](install.md) to select the CLI bundle for your client.
Check the engine and inference requirements for your deployment separately.

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

The [first-deployment tutorial](first-deployment.md) uses a local Docker engine and a model served by NVIDIA Endpoints.
It also covers [using an existing gateway and inference endpoint](first-deployment.md#using-an-existing-gateway-and-inference-endpoint).
To build and deploy from a checkout on Apple silicon or WSL2, follow [Onboarding From Source](from-source.md).

For either release path, use the CLI bundle and OpenClaw image digest from the same release.
Create a fresh deployment UUID and separate state directory, and use resources you control.
Install the matching OpenShell CLI before deploying so you can verify an agent reply.

## Preparing Windows With WSL2

Use an Ubuntu 22.04 or later distribution under WSL2 that matches your Windows host architecture.
Follow [Microsoft's WSL installation instructions](https://learn.microsoft.com/en-us/windows/wsl/install).
In PowerShell, check that the distribution shows version `2`, then replace `NAME` with its listed name.

```powershell
wsl --list --verbose
wsl -d NAME
```

Run the rest of the deployment steps in Bash inside Ubuntu.
Keep both CLIs, the deployment YAML, and its state on the Linux filesystem under your WSL home directory.
Send the agent request from that same WSL shell.

For a local gateway, [install Docker Engine in the Ubuntu distribution](https://docs.docker.com/engine/install/ubuntu/) and configure [access for your Linux user](https://docs.docker.com/engine/install/linux-postinstall/#manage-docker-as-a-non-root-user).
Verify that `docker --host unix:///var/run/docker.sock version` shows both a client and a server.

- For a release deployment, select the **Linux** tab in [Installing the CLI](install.md#installing-on-linux-or-macos).
  Run `uname -m` in Ubuntu and use `linux_amd64` for `x86_64` or `linux_arm64` for `aarch64`.
  Then follow [Deploying Your First OpenClaw Agent](first-deployment.md#preparing-the-tools-and-services) to install the matching standalone OpenShell CLI in WSL2 and deploy.
- To build from source, continue to [Preparing the Shell and Docker](from-source.md#preparing-the-shell-and-docker) for the build tools and platform checks.

The [recorded WSL2 deployment](https://github.com/NVIDIA/NemoClaw/issues/14804#issuecomment-7169874797) built and deployed Hermes from source on Ubuntu 24.04 ARM64 with Docker Engine running inside the distribution.
Native Windows deployment, AMD64 WSL2, and Docker Desktop integration with WSL2 are outside that qualification.
Refer to [#14804](https://github.com/NVIDIA/NemoClaw/issues/14804) for acceptance status.

## Preparing the Standalone OpenShell CLI

Match the `components.gateway.version` pin in the release's [`version-pins.json`](../references/compatibility.md#using-one-release-together) or the `openshell` pin in `versions.json` for a source build.
NemoClaw v0.1.0 pins OpenShell 0.1.10.
If `command -v openshell` selects a compatible client and `openshell --version` confirms the pin, reuse it.

<Warning>

Use the standalone archive to preserve existing clients and gateways.
The [general OpenShell installer](https://github.com/ai-openshell/openshell/blob/152c59d3178039e3fbb4a5595f9fff7216a6be92/docs/about/installation.mdx) also installs and starts a gateway.
On macOS it can reinstall an existing OpenShell Homebrew formula and restart its gateway service.

</Warning>

1. In an empty download directory, select the archive for the shell running NemoClaw.
   For a source checkout with a different OpenShell pin, confirm the archive and checksum filenames on that version's [release page](https://github.com/ai-openshell/openshell/releases).

   | Client shell | Archive for OpenShell 0.1.10 |
   |---|---|
   | macOS on Apple silicon | `openshell-aarch64-apple-darwin.tar.gz` |
   | Linux or WSL2 ARM64 | `openshell-aarch64-unknown-linux-musl.tar.gz` |
   | Linux or WSL2 AMD64 | `openshell-x86_64-unknown-linux-musl.tar.gz` |

2. Set `OPENSHELL_VERSION` to your pin, `ARCHIVE` to the filename for your platform, and `CHECKSUM_FILE` to the release's CLI checksum filename.
   Download the two files and verify the archive.
   Stop if a download or checksum verification fails.
   On macOS, replace `sha256sum -c -` with `shasum -a 256 -c -`.

   ```sh
   OPENSHELL_VERSION=0.1.10
   ARCHIVE=openshell-x86_64-unknown-linux-musl.tar.gz
   CHECKSUM_FILE=openshell-checksums-sha256.txt
   OPENSHELL_RELEASE="https://github.com/ai-openshell/openshell/releases/download/v$OPENSHELL_VERSION"
   curl -fLO "$OPENSHELL_RELEASE/$ARCHIVE" &&
     curl -fLO "$OPENSHELL_RELEASE/$CHECKSUM_FILE" &&
     CHECKSUM=$(awk -v archive="$ARCHIVE" '$2 == archive { print; count++ } END { if (count != 1) exit 1 }' "$CHECKSUM_FILE") &&
     printf '%s\n' "$CHECKSUM" | sha256sum -c -
   ```

   Expect the archive name followed by `OK`.

3. Extract the verified client to a new directory.
   If the directory exists, set `OPENSHELL_DIR` to an unused path.

   ```sh
   OPENSHELL_DIR="$HOME/.local/opt/openshell/$OPENSHELL_VERSION"
   mkdir -p "$(dirname "$OPENSHELL_DIR")" &&
     mkdir "$OPENSHELL_DIR" &&
     tar -xzf "$ARCHIVE" -C "$OPENSHELL_DIR"
   ```

4. Put the extracted client first on `PATH` for this shell and verify it.

   ```sh
   export PATH="$OPENSHELL_DIR:$PATH"
   command -v openshell
   openshell --version
   ```

   Expect `$OPENSHELL_DIR/openshell` and the pinned version.
   If a shell alias or function takes precedence, use the absolute path `"$OPENSHELL_DIR/openshell"` for the OpenShell commands in the guide.

If you use an external gateway that requires authentication, use its operator-provided credentials to [configure an OpenShell profile](https://github.com/ai-openshell/openshell/blob/152c59d3178039e3fbb4a5595f9fff7216a6be92/docs/how-it-works/gateways/authentication.mdx).

## Client and Build Tools

To run the release CLI, use a [verified installer or archive](install.md).
For a source build, use the [build guide](../build-deploy/build.md) from the revision you build.
Keep the bundle intact for the lifetime of its deployments.

The builder accepts `linux_arm64`, `linux_amd64`, `darwin_arm64`, `darwin_amd64`, and `windows_amd64` targets.
For the Windows first-deployment path, use the [Linux AMD64 or ARM64 bundle through WSL2](#preparing-windows-with-wsl2).
`CI / Bundle` builds and tests on Linux ARM64, Linux AMD64, macOS ARM64, and Windows AMD64.
These builds and tests don't qualify GPU deployment on every platform.

On Linux, the oldest supported release is Ubuntu 22.04, whose glibc is 2.35.
`CI / Bundle` builds the Linux bundles there and fails if any bundle executable needs a newer glibc.
It runs the contract, integration, and live tests on Ubuntu 24.04.
A bundle runs only where the glibc is at least as new as on the host that built it, so build it on the oldest Linux release that will run it.

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
