<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Install the CLI

Each release attaches a `nemoclaw` archive for each of four platforms and a `SHA256SUMS` file with their SHA-256 checksums.
Each archive holds the CLI with the OpenTofu, providers, and schemas it uses.
This page installs a release's archive, upgrades to another release, and uninstalls the CLI.
To build the bundle from source instead, see [build local artifacts](../build-deploy/build.md#build-a-native-bundle).

No release is published yet ([#12638](https://github.com/NVIDIA/NemoClaw/issues/12638)).
Until then, release candidates are draft releases that only users with push access see, and the download commands below fail.
A maintainer downloads a draft's files with `gh release download TAG --repo NVIDIA/NemoClaw --pattern ARCHIVE --pattern SHA256SUMS`.
A draft's images are in internal packages, so deployments need registry credentials for them: `spec.registries` on Docker, [`image_pull_secrets`](../build-deploy/kubernetes.md#reference-registry-credentials) on Kubernetes.

## Choose the Archive

The archive for release `TAG`, such as `v0.1.0-rc12`, is `nemoclaw-TAG-PLATFORM.tar.gz`, and it unpacks to `dist/PLATFORM`:

| Client | `PLATFORM` | Requirement |
|---|---|---|
| Linux ARM64 | `linux_arm64` | glibc 2.35 or newer, as on Ubuntu 22.04 |
| Linux AMD64 | `linux_amd64` | glibc 2.35 or newer, as on Ubuntu 22.04 |
| macOS ARM64 | `darwin_arm64` | Apple silicon; CI tests on macOS 15 |
| Windows AMD64 | `windows_amd64` | Windows 10 version 1803 or later, or Windows Server 2019 or later, which include `tar` |

On Windows, the CLI reaches a local Docker Desktop or Podman engine through its named pipe, such as `npipe:////./pipe/docker_engine`, and [deploys](../build-deploy/usage.md) with a managed or an external gateway; no Windows host has run a deployment yet ([#14639](https://github.com/NVIDIA/NemoClaw/issues/14639)).
The executables are neither signed nor notarized; see [current limits](../resources/limits.md#installation-and-releases).
Use the CLI with the agent and runtime images that the same release lists by digest; [compatibility](../references/compatibility.md#use-one-release-together) explains why.

## Install on Linux or macOS

In an empty directory, set the release and platform, then download the archive and the checksums:

```sh
TAG=v0.1.0-rc12
PLATFORM=linux_arm64
curl -fLO "https://github.com/NVIDIA/NemoClaw/releases/download/$TAG/nemoclaw-$TAG-$PLATFORM.tar.gz"
curl -fLO "https://github.com/NVIDIA/NemoClaw/releases/download/$TAG/SHA256SUMS"
```

Check the archive against its checksum; on macOS, use `shasum -a 256 --check` in place of `sha256sum --check`:

```sh
grep -F " nemoclaw-$TAG-$PLATFORM.tar.gz" SHA256SUMS | sha256sum --check
```

Expect `nemoclaw-TAG-PLATFORM.tar.gz: OK`.
On any other result, delete the download and don't unpack it.

A final release, one whose tag has no suffix such as `-rc12`, also attests each archive's and `SHA256SUMS`'s build provenance: that NVIDIA's release workflow produced them from this repository.
With the [GitHub CLI](https://cli.github.com/), check both files:

```sh
gh attestation verify "nemoclaw-$TAG-$PLATFORM.tar.gz" --owner NVIDIA
gh attestation verify SHA256SUMS --owner NVIDIA
```

Each command prints `✓ Verification succeeded!` and names the repository and workflow that built the file.
On a failure, delete the download and don't unpack it.
Release candidates have no attestations.

Unpack the archive into a directory for this release, and put its `bin` directory on `PATH`:

```sh
INSTALL="$HOME/.local/opt/nemoclaw/$TAG"
mkdir -p "$INSTALL"
tar -xzf "nemoclaw-$TAG-$PLATFORM.tar.gz" -C "$INSTALL"
export PATH="$INSTALL/dist/$PLATFORM/bin:$PATH"
nemoclaw --version
```

`nemoclaw --version` prints `nemoclaw` and the CLI's version.
The CLI uses the OpenTofu, providers, and schemas in the directory above its `bin` directory, and checks them against `manifest.json` before each operation.
Keep `nemoclaw` in `dist/PLATFORM/bin`, don't copy or link it elsewhere, and don't change the directory.
Run it from your deployment's directory, not from `bin`: the state directory defaults to `.nemoclaw` in the current directory.

To keep the CLI on `PATH` in new shells, add it to your shell's startup file, `~/.bashrc` for Bash or `~/.zshrc` for Zsh:

```sh
echo "export PATH=\"$INSTALL/dist/$PLATFORM/bin:\$PATH\"" >> ~/.bashrc
```

The downloaded archive and `SHA256SUMS` aren't needed after unpacking.

## Install on Windows

In PowerShell, in an empty directory, download the archive and the checksums, and check the archive's checksum:

```powershell
$ProgressPreference = "SilentlyContinue"
$Tag = "v0.1.0-rc12"
$Archive = "nemoclaw-$Tag-windows_amd64.tar.gz"
Invoke-WebRequest "https://github.com/NVIDIA/NemoClaw/releases/download/$Tag/$Archive" -OutFile $Archive
Invoke-WebRequest "https://github.com/NVIDIA/NemoClaw/releases/download/$Tag/SHA256SUMS" -OutFile SHA256SUMS
$Expected = ((Get-Content SHA256SUMS) | Where-Object { $_.EndsWith(" $Archive") }).Split(" ")[0]
if ((Get-FileHash $Archive -Algorithm SHA256).Hash -ne $Expected) { throw "checksum mismatch" }
```

Setting `$ProgressPreference` keeps Windows PowerShell 5.1's progress display from slowing the download.
On `checksum mismatch` or any other error, delete the download and don't unpack it.
For a final release, check the files' build provenance with `gh attestation verify $Archive --owner NVIDIA` and `gh attestation verify SHA256SUMS --owner NVIDIA`, as [on Linux or macOS](#install-on-linux-or-macos).
Otherwise unpack the archive into a directory for this release, and add its `bin` directory to your user `Path` and to the current session's:

```powershell
$Install = "$env:LOCALAPPDATA\nemoclaw\$Tag"
New-Item -ItemType Directory -Force $Install | Out-Null
tar -xzf $Archive -C $Install
$Bin = "$Install\dist\windows_amd64\bin"
[Environment]::SetEnvironmentVariable("Path", "$Bin;" + [Environment]::GetEnvironmentVariable("Path", "User"), "User")
$env:Path = "$Bin;$env:Path"
nemoclaw --version
```

As on Linux and macOS, keep `nemoclaw.exe` in `dist\windows_amd64\bin` and the directory unchanged, and run it from your deployment's directory, not from `bin`.

## Upgrade

Install the new release into its own directory as above, and put its `bin` directory on `PATH` in place of the old one: edit the line in your shell's startup file, or on Windows, the user `Path` in **Edit environment variables for your account**.
Keep the old release's directory: a deployment keeps using the release that created it until you destroy it with that release, as [compatibility](../references/compatibility.md#deployment-state) describes.
To run the old release for such a deployment, call its CLI by path, from the deployment's directory, and preview before you destroy:

```sh
OLD="$HOME/.local/opt/nemoclaw/OLD_TAG/dist/PLATFORM/bin/nemoclaw"
"$OLD" plan --destroy --state-dir DIR
"$OLD" destroy --state-dir DIR
```

On Windows, call `& "$env:LOCALAPPDATA\nemoclaw\OLD_TAG\dist\windows_amd64\bin\nemoclaw.exe"` the same way.
Create new deployments with the new release, with a fresh `metadata.uid` and state directory, and with the new release's agent images; rebuild [derived images](../build-deploy/derived-images.md) from them.

## Uninstall

Uninstalling a release's CLI doesn't remove what its deployments created.
For each deployment that the release created, with that release's CLI:

1. Preview and run [destroy](../build-deploy/usage.md#destroy) with the deployment's state directory.
2. To remove what destroy retains, such as gateway data, model caches, and credential volumes, follow [remove retained resources](../build-deploy/usage.md#remove-retained-resources).
3. After step 2 removes every retained entry, delete the state directory. If you keep retained resources, keep the state directory and this release's directory too; reapplying needs both.

Then delete the release's directory, such as `$HOME/.local/opt/nemoclaw/TAG` or `$env:LOCALAPPDATA\nemoclaw\TAG`, and remove its `bin` directory from `PATH`: in your shell's startup file, or on Windows, in **Edit environment variables for your account**.

NemoClaw keeps its files in these places:

| What | Where | Removed by |
|---|---|---|
| The CLI, OpenTofu, providers, and schemas | The release's directory | Deleting the directory |
| Deployment state, including OpenTofu state and its configuration | Each deployment's state directory: `--state-dir`, by default `.nemoclaw` in the directory you ran `nemoclaw` from; see [deployment state](../build-deploy/state.md#local-deployment-files) | Deleting the directory, after destroy |
| Deployment YAML | Where you saved it; `nemoclaw onboard` writes `deployment.yaml` in the current directory unless `--output` names another file | Deleting the file |
| Sandboxes, gateways, model services, and their data | The deployment's Docker or Podman engine, or Kubernetes cluster; see [retained resources](../build-deploy/state.md#understand-the-retained-resources) | Destroy, then removing retained resources |
| Agent, gateway, and model runtime images | The engine's image store, or the cluster nodes' | The engine's image commands, such as `docker image rm`; NemoClaw doesn't remove them |

The OpenShell CLI keeps its own gateway profiles; remove them with OpenShell's commands.
