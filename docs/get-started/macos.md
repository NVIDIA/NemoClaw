<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Onboarding on macOS From Source

Build the checkout's native Apple silicon CLI bundle and a Linux ARM64 Hermes image, then verify a reply using hosted NVIDIA Endpoints inference.
This procedure creates a new deployment on Docker Desktop's Linux VM and can incur inference charges.
It does not qualify release signing, notarization, or browser quarantine handling; for a release archive, follow [Installing the CLI](install.md).
An Intel Mac requires a different bundle and image architecture; this procedure covers Apple silicon only.

## Preparing Terminal and Docker Desktop

Open **Applications > Utilities > Terminal**, or use Spotlight to search for **Terminal**.
Commands run in Terminal, rather than by double-clicking `bin/nemoclaw` in Finder.
Start Bash so that the following commands use the same shell syntax:

```sh
bash
uname -m
```

Expect `arm64`.
Install Git, curl, jq, Apple's Command Line Tools, and Rust using their maintainers' instructions.
The checkout's `rust-toolchain.toml` selects the Rust version.
Install and start [Docker Desktop for Mac](https://docs.docker.com/desktop/setup/install/mac-install/).
Check its engine and image store:

```sh
docker version
docker info --format '{{json .DriverStatus}}'
```

Expect both a client and server, and `io.containerd.snapshotter.v1` in the driver status.
If the server is missing, wait for Docker Desktop to start before continuing.
If the image store differs, refer to [Checking the Docker Image Store](../build-deploy/build.md#checking-the-docker-image-store) before changing it: switching stores hides the inactive store's containers and images.
Preserve existing deployments and their engine settings.

## Building the Checkout

Clone the branch to test into a new directory, then run build commands from its root.
For a PR, replace `v1` with its branch and check out the intended commit before building.

```sh
git clone --branch v1 git@github.com:NVIDIA/NemoClaw.git NemoClaw-macos
cd NemoClaw-macos
git rev-parse HEAD
cargo ci tools
export PROTOC="$PWD/.tools/protoc-36.2/bin/protoc"
cargo run --locked -p nemoclaw-build -- bundle
export PATH="$PWD/dist/darwin_arm64/bin:$PATH"
type -a nemoclaw
nemoclaw --version
nemoclaw --help
```

The first result of `type -a` must be this checkout's CLI.
Help must list `onboard`, `plan`, `apply`, and `destroy`.
Keep the entire bundle together; do not move only its executable or overwrite an existing installation.
For a long run, copy `dist/darwin_arm64` to a separate directory and put that copy's `bin` on this shell's `PATH`.
Do not rebuild a bundle while a deployment operation uses it.

### Recovering From a macOS SDK Linker Failure

If compilation fails in Apple's linker with an unsupported architecture such as `arm64e.x1`, inspect the selected developer tools and installed SDKs:

```sh
xcode-select -p
xcrun --show-sdk-path
ls /Library/Developer/CommandLineTools/SDKs
```

Use an installed SDK compatible with the selected linker, or update the developer tools using Apple's instructions.
For example, if `MacOSX26.5.sdk` is already installed and compatible, prefix each failing Cargo command with:

```sh
SDKROOT=/Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk cargo ci tools
```

Use the same prefix on subsequent Cargo build commands that need it.
This example selects an SDK for one command; 26.5 is not a NemoClaw requirement.
Do not delete SDKs or change the system's developer-tool selection to complete this exercise.

## Building the Hermes Image

From the same checkout, choose a unique local repository name to preserve other builds' tags:

```sh
TEST_IMAGE_PREFIX="nc-macos-$(uuidgen | tr '[:upper:]' '[:lower:]')"
IMAGE_PREFIX="$TEST_IMAGE_PREFIX" cargo images build --platform linux/arm64 hermes
docker image inspect "$TEST_IMAGE_PREFIX:hermes" --format '{{index .RepoDigests 0}}'
```

Docker Desktop builds and runs this Linux image inside its ARM64 Linux VM.
Expect a `NAME@sha256:DIGEST` reference; record it for onboarding.
An empty digest list cannot supply the required reference; check the image store before rebuilding.
A Docker image config ID or tag does not replace the repository digest.
Refer to the [image build guide](../build-deploy/build.md#building-agent-images) for metadata and discovery requirements.

## Preparing the Matching OpenShell CLI

Download the client pinned by this checkout into a separate directory:

```sh
CLIENT_VERSION=$(jq -er '.openshell' versions.json) || exit 1
CLIENT_DIR="$PWD/.tools/openshell/$CLIENT_VERSION"
mkdir -p "$CLIENT_DIR"
curl -fL "$(jq -er '.platforms.darwin_arm64.openshell.url' versions.json)" -o "$CLIENT_DIR/archive.tar.gz"
printf '%s  %s\n' "$(jq -er '.platforms.darwin_arm64.openshell.sha256' versions.json)" "$CLIENT_DIR/archive.tar.gz" | shasum -a 256 --check || exit 1
tar -xzf "$CLIENT_DIR/archive.tar.gz" -C "$CLIENT_DIR"
export PATH="$CLIENT_DIR:$PATH"
type -a openshell
openshell --version
```

Stop on download, verification, or extraction failure.
The selected client's version must match `openshell` in `versions.json`.
Another installed OpenShell client can be incompatible even when it appears earlier on `PATH`; this procedure keeps it intact.
Refer to [Host OpenShell Client Selection](../agents-inference/agents.md#selecting-the-host-openshell-client).

## Authoring and Applying a Deployment

Get an API key from [NVIDIA Endpoints](https://build.nvidia.com/settings/api-keys), then start onboarding:

```sh
nemoclaw onboard --output deployment.yaml
```

Choose Hermes, a fresh deployment name, Docker, NVIDIA Endpoints, and a model available to your account.
Match the selected image digest to the reference recorded during the build.
Review the image, inference URL, model, credential reference, and YAML before saving.
A missing key does not prevent saving or planning; interactive apply asks for it with hidden input.
Do not paste a key into YAML or an inline shell export.
Apply installs the credential in OpenShell; it does not save its value in the deployment YAML.

If another deployment uses the default gateway port or subnet, choose unused values for `spec.gateway.target.docker.port` and `spec.gateway.target.docker.networkCIDR` before the first successful plan.
For example, use port `17684` and `10.204.0.0/24` only if they are free.
Retain the rest of the generated file; refer to the [WSL configuration fragment](windows-wsl.md#authoring-and-applying-a-deployment) for their location.
Use a new state directory:

```sh
nemoclaw plan --state-dir .local/first-macos/state deployment.yaml
nemoclaw apply --state-dir .local/first-macos/state deployment.yaml
```

Review the plan before applying.
Apply creates containers, a gateway, and credentials.
If it fails, keep the same bundle, YAML, and state directory and follow [Operation Recovery](../build-deploy/usage.md#recovering-an-interrupted-operation).

## Verifying a Reply and an Unchanged Plan

Copy the gateway and workspace selection commands from apply's output into this shell, then run its `Invoke:` command.
The Bash command sends the JSON string `"Reply with exactly READY."` on stdin.
Check both the invocation's exit status and the response's `result.status`: Hermes can report a failed request inside an outer successful command result.
Expect an actual `READY` reply and successful inner and outer statuses.
For a filtered Hermes response, follow [Verifying a Reply](windows-wsl.md#verifying-a-reply), substituting `.local/first-macos/state` for the WSL state path.

If inference rejects the key, follow [Authentication Diagnostics](../agents-inference/agents.md#diagnosing-an-authentication-failure) and its linked rotation procedure.
Replacing an installed credential can replace the attached sandbox and delete its files; read the warning before applying.

After a successful reply, check convergence:

```sh
nemoclaw plan --state-dir .local/first-macos/state deployment.yaml
nemoclaw apply --state-dir .local/first-macos/state deployment.yaml
```

Expect no planned resource changes.
Retain the deployment for inspection, or follow [Destroying and Retention](../build-deploy/usage.md#destroying) with the same bundle, YAML, and state directory.
If you exported a key for recovery, run `unset NVIDIA_API_KEY` afterward.
This clears the caller's environment; it does not revoke the key or remove OpenShell's installed credential.
