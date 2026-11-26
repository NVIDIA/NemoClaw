<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Checking Prerequisites

Choose a first-deployment path, then check the requirements for the machines that run it.

## Before the First Deployment

The CLI runs on your client. The sandbox engine and model endpoint can run elsewhere.

| If you want to… | Start here |
|---|---|
| Deploy OpenClaw from a release | [Install the release CLI](install.md) on Linux or Apple silicon macOS, then [deploy with local Docker and NVIDIA Endpoints](first-deployment.md). |
| Deploy from a Windows host | [Prepare WSL2](#preparing-windows-with-wsl2) and use the Linux bundle for the release tutorial. The native Windows CLI does not provide the first-reply path. |
| Build the bundle and agent image yourself | [Build and deploy Hermes from source](from-source.md) on Apple silicon macOS or in WSL2. |
| Reuse an OpenShell gateway and model endpoint | [Install the release CLI](install.md), check [which OpenShell client you need](#using-the-bundled-openshell-cli), then [configure the external gateway example](first-deployment.md#using-an-existing-gateway-and-inference-endpoint). |

For either release deployment, use a [bundle and OpenClaw image digest from the same release](../references/compatibility.md#using-one-release-together).
Use resources you control, a fresh deployment UUID, and a separate state directory.

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

## Preparing Windows With WSL2

Run installation, deployment, and the agent request in the same Bash shell in Ubuntu.
Keep both CLIs, the YAML, and deployment state on the Linux filesystem under your WSL home directory.

1. [Install Ubuntu 22.04 or later under WSL2](https://learn.microsoft.com/en-us/windows/wsl/install) for your Windows host architecture.
2. Check the distribution's version in PowerShell.

   ```powershell
   wsl --list --verbose
   ```

   The distribution must show version `2`.
3. Open the distribution from PowerShell, replacing `NAME` with its listed name.

   ```powershell
   wsl -d NAME
   ```

4. For a local gateway, [install Docker Engine inside Ubuntu](https://docs.docker.com/engine/install/ubuntu/).
5. [Configure Docker access for your Linux user](https://docs.docker.com/engine/install/linux-postinstall/#manage-docker-as-a-non-root-user) if you installed the engine.
6. Check the local socket in Bash if you installed the engine.

   ```sh
   docker --host unix:///var/run/docker.sock version
   ```

   Expect both a client and a server.
7. Continue with the path you chose:

   - For a release deployment, <a href="./install?language=linux#installing-on-linux-or-macos">install the Linux bundle from the Linux and macOS Archives tab</a>.
     The archive procedure maps the Ubuntu architecture to the Linux bundle. Follow the post-install link to the OpenClaw tutorial.
   - For a source build, continue to [Preparing the Shell and Docker](from-source.md#preparing-the-shell-and-docker).

The [recorded WSL2 run](https://github.com/NVIDIA/NemoClaw/issues/14804#issuecomment-7169874797) built and deployed Hermes from source on Ubuntu 24.04 ARM64 with Docker Engine inside Ubuntu.
It does not qualify the release OpenClaw tutorial on WSL2, native Windows deployment, AMD64 WSL2, or Docker Desktop integration with WSL2.
Refer to [#14804](https://github.com/NVIDIA/NemoClaw/issues/14804) for acceptance status.

## Using the Bundled OpenShell CLI

The gateway's authentication determines which client to use for agent access:

| Gateway | OpenShell client |
|---|---|
| None or mutual TLS (mTLS) | Use bundled [`nemoclaw osh`](../references/cli.md#running-openshell-against-a-deployment) with the deployment's state directory and any referenced TLS files. |
| OpenID Connect (OIDC) | Use bundled `nemoclaw osh` after [signing in](../references/cli.md#logging-in-to-an-oidc-gateway). |
| Bearer token only, or no endpoint this host can reach | [Prepare a standalone client](#preparing-the-standalone-openshell-cli) and [select its gateway and workspace](../agents-inference/interfaces.md#selecting-a-standalone-cli-for-bearer-token-gateways). |

## Preparing the Standalone OpenShell CLI

This procedure is for gateways that require a separately configured client.

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

2. Install the verified client in a new directory.
   Set `OPENSHELL_VERSION`, `ARCHIVE`, and `CHECKSUM_FILE` for the selected release and platform.
   If `OPENSHELL_DIR` exists, set it to an unused path before running the block.
   The block extracts only after both downloads and the checksum check succeed.

   ```sh
   OPENSHELL_VERSION=0.1.10
   ARCHIVE=openshell-x86_64-unknown-linux-musl.tar.gz
   CHECKSUM_FILE=openshell-checksums-sha256.txt
   OPENSHELL_RELEASE="https://github.com/ai-openshell/openshell/releases/download/v$OPENSHELL_VERSION"
   OPENSHELL_DIR="$HOME/.local/opt/openshell/$OPENSHELL_VERSION"
   (
     set -e
     curl -fLO "$OPENSHELL_RELEASE/$ARCHIVE"
     curl -fLO "$OPENSHELL_RELEASE/$CHECKSUM_FILE"
     CHECKSUM=$(awk -v archive="$ARCHIVE" '$2 == archive { print; count++ } END { if (count != 1) exit 1 }' "$CHECKSUM_FILE")
     if [ "$(uname -s)" = Darwin ]; then
       printf '%s\n' "$CHECKSUM" | shasum -a 256 -c -
     else
       printf '%s\n' "$CHECKSUM" | sha256sum -c -
     fi
     mkdir -p "$(dirname "$OPENSHELL_DIR")"
     mkdir "$OPENSHELL_DIR"
     tar -xzf "$ARCHIVE" -C "$OPENSHELL_DIR"
   )
   ```

   The checksum check prints the archive name followed by `OK`.
   Stop if the block exits with a nonzero status.

3. Put the extracted client first on `PATH` for this shell.

   ```sh
   export PATH="$OPENSHELL_DIR:$PATH"
   ```

4. Check the selected client path and version.

   ```sh
   command -v openshell && openshell --version
   ```

   Expect `$OPENSHELL_DIR/openshell` and the pinned version.
   If a shell alias or function takes precedence, use the absolute path `"$OPENSHELL_DIR/openshell"` for the OpenShell commands in the guide.

If you use an external gateway that requires authentication, use its operator-provided credentials to [configure an OpenShell profile](https://github.com/ai-openshell/openshell/blob/152c59d3178039e3fbb4a5595f9fff7216a6be92/docs/how-it-works/gateways/authentication.mdx).

## Client and Build Tools

To run the release CLI, use a [verified installer or archive](install.md).
For a source build, use the [build guide](../build-deploy/build.md) from the revision you build.
Keep the bundle intact for the lifetime of its deployments.

The builder accepts `linux_arm64`, `linux_amd64`, `darwin_arm64`, `darwin_amd64`, and `windows_amd64` targets.
Build targets do not establish deployment or GPU qualification.
Refer to the [CI platform coverage](../../internal-docs/contributing/testing.md#how-ci-runs-the-tests) for build and test runners.

Linux release bundles require glibc 2.35 or later. Ubuntu 22.04 is the oldest supported Linux release.
For source bundles, build on the oldest Linux release where you intend to run the bundle so you do not pick up newer glibc requirements.

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

<a name="platforms-not-yet-tested"></a>

## Platform Qualification Limits

[Linux AMD64 live CI](../../internal-docs/contributing/testing.md#live-suites) exercises Docker and kind scenarios. That coverage does not qualify a specific release recipe.
The [DGX Station validation records](../../examples/platforms/docker/vllm/dgx-station/README.md#qualification-boundary) cover full lifecycles and agent replies from source on Linux ARM64 with one GB300 and managed Qwen3-4B: OpenClaw alone, and OpenClaw and Pi in separate sandboxes sharing the model service.
Those runs qualify only the recorded source and configurations, not this release or other DGX Station setups.
Windows/WSL and macOS GPU hosts, separate SSH model hosts, and distributed inference haven't been tested end to end.
See [current limits](../resources/limits.md#platforms-models-and-placement) for details.
