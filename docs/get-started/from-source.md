<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Onboarding From Source on macOS or WSL2

Build the checkout's CLI bundle and a Linux Hermes image on an Apple silicon Mac or in WSL2 on Windows, then deploy Hermes with a managed Docker gateway and verify one reply through hosted NVIDIA Endpoints inference.
Windows ARM64 has no native bundle, so it uses the Linux ARM64 bundle inside WSL2; Windows AMD64 can use the Linux AMD64 bundle the same way.
The procedure creates containers and can incur inference charges.
It does not qualify release signing, notarization, or browser quarantine handling; for a release, follow [Installing the CLI](install.md).

## Preparing the Shell and Docker Desktop

On macOS, open **Applications > Utilities > Terminal** and run `bash`, so that the following commands use Bash.
Run the CLI in Terminal; double-clicking `bin/nemoclaw` in Finder doesn't start onboarding.
Install Git, curl, jq, Apple's Command Line Tools, and Rust.

On Windows, install WSL2 with an Ubuntu distribution that matches the machine's architecture.
In PowerShell, find its name with `wsl --list --verbose` and enter it with `wsl -d NAME`.
Run every later command in Bash inside WSL, and keep the checkout on the Linux filesystem, such as under `~/src`.
Install Git, curl, jq, a C toolchain, and [Rust](https://www.rust-lang.org/tools/install).
In Docker Desktop, enable integration for the distribution under **Settings > Resources > WSL Integration**.

The checkout's `rust-toolchain.toml` selects the Rust version.
Start [Docker Desktop](https://docs.docker.com/desktop/), then select the bundle and image platforms for this machine and check the engine and image store:

```sh
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) PLATFORM=darwin_arm64; IMAGE_PLATFORM=linux/arm64 ;;
  Linux-aarch64) PLATFORM=linux_arm64; IMAGE_PLATFORM=linux/arm64 ;;
  Linux-x86_64) PLATFORM=linux_amd64; IMAGE_PLATFORM=linux/amd64 ;;
  *) echo 'This procedure covers Apple silicon and WSL2 on ARM64 or AMD64' >&2; exit 1 ;;
esac
docker version
docker info --format '{{json .DriverStatus}}'
```

Expect both a Docker client and server, and `io.containerd.snapshotter.v1` in the driver status.
If the image store differs, follow [Checking the Docker Image Store](../build-deploy/build.md#checking-the-docker-image-store) before changing it.

## Building the Checkout

Clone the branch to test into a new directory and check out the intended commit.
From its root, in the same shell, build the bundle:

```sh
git clone --branch v1 https://github.com/NVIDIA/NemoClaw.git
cd NemoClaw
cargo ci tools
export PROTOC="$PWD/.tools/protoc-36.2/bin/protoc"
cargo run --locked -p nemoclaw-build -- bundle
export PATH="$PWD/dist/$PLATFORM/bin:$PATH"
type -a nemoclaw
nemoclaw --help
```

The first `cargo ci tools` compiles its runner before installing tools, which can take several minutes.
The first result of `type -a` must be this checkout's CLI rather than another installation, such as NemoClaw Classic, and help must list `onboard`, `plan`, `apply`, and `destroy`.
Keep the bundle together, and don't rebuild it while a deployment operation uses it.

If macOS linking fails with an unsupported architecture such as `arm64e.x1`, the selected linker and SDK don't match.
List the installed SDKs with `ls /Library/Developer/CommandLineTools/SDKs`, then prefix each failing Cargo command with a compatible one, such as `SDKROOT=/Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk`.
This selects an SDK for one command; 26.5 isn't a NemoClaw requirement.

## Building the Hermes Image

Build the image under a new repository name, which leaves other builds' tags intact:

```sh
TEST_IMAGE_PREFIX="nc-test-$(date +%Y%m%d%H%M%S)"
IMAGE_PREFIX="$TEST_IMAGE_PREFIX" cargo images build --platform "$IMAGE_PLATFORM" hermes
docker image inspect "$TEST_IMAGE_PREFIX:hermes" --format '{{index .RepoDigests 0}}'
```

On macOS, Docker Desktop builds and runs this Linux image in its ARM64 Linux VM.
Expect a `NAME@sha256:DIGEST` reference, and record it for onboarding.
An empty digest list means the image store doesn't retain repository digests; a tag or image config ID can't replace the digest.

## Preparing the Matching OpenShell CLI

Use an OpenShell CLI at the checkout's `openshell` version in `versions.json`, as [Before the First Deployment](prerequisites.md#before-the-first-deployment) describes.

## Authoring and Applying a Deployment

Get an API key from [NVIDIA Endpoints](https://build.nvidia.com/settings/api-keys), then start onboarding:

```sh
nemoclaw onboard --output deployment.yaml
```

Choose Hermes, a new deployment name, Docker, NVIDIA Endpoints, and a model available to your account.
When several images are offered, select the digest you recorded; engine tags, creation times, and revision labels help identify images but don't verify their source.
On review, "metadata compatible" means that the image's advertised metadata matches the configuration, not that its runtime starts or inference works.
The YAML names the credential variable, not its value; interactive apply asks for a missing key with hidden input.

If another deployment uses the default gateway port or network range, set unused values beside the generated `engine` before the first successful plan:

```yaml
spec:
  gateway:
    target:
      docker:
        engine: unix:///var/run/docker.sock  # keep the generated value
        port: 17683
        networkCIDR: 10.203.0.0/24
```

Plan, review the changes, and apply with a new state directory:

```sh
nemoclaw plan --state-dir .local/first/state deployment.yaml
nemoclaw apply --state-dir .local/first/state deployment.yaml
```

Apply starts containers and installs the credential in OpenShell.
If it fails, keep the same bundle, YAML, and state directory and follow [operation recovery](../build-deploy/usage.md#recovering-an-interrupted-operation).

## Verifying a Reply

Copy the gateway and workspace selection commands from apply's output into this shell.
Then send the JSON string `"Reply with exactly READY."` and save the result as [Running One Agent Request](../agents-inference/agents.md#running-one-agent-request) shows, with the sandbox, agent, and runtime ID from apply's `Invoke:` line.
Expect `succeeded` in both statuses and `READY` in the Hermes adapter's result.
[Diagnosing an Authentication Failure](../agents-inference/agents.md#diagnosing-an-authentication-failure) covers a rejected key.

Run the same `plan` and `apply` again, and expect no resource changes.
Keep the deployment for inspection, or follow [Destroying](../build-deploy/usage.md#destroying) with the same bundle, YAML, and state directory.
