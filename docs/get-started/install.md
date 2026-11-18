<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Install the CLI

Each release attaches the `nemoclaw` CLI for four platforms, each archive with the OpenTofu, providers, and schemas that the CLI runs, and a `SHA256SUMS` file that lists the archives' SHA-256 checksums.
This page installs a release's archive, upgrades to another release, and uninstalls the CLI.
To build the bundle from source instead, see [build local artifacts](../build-deploy/build.md#build-a-native-bundle).

No release is published yet ([#12638](https://github.com/NVIDIA/NemoClaw/issues/12638)).
Until one is, release candidates are draft releases that only maintainers see, and the download commands below fail; a maintainer downloads a draft's files with `gh release download TAG --repo NVIDIA/NemoClaw --pattern ARCHIVE --pattern SHA256SUMS`.

## Choose the Archive

The archive for release `TAG`, such as `v0.1.0-rc12`, is `nemoclaw-TAG-PLATFORM.tar.gz`, and it unpacks to `dist/PLATFORM`:

| Client | `PLATFORM` | Requirement |
|---|---|---|
| Linux ARM64 | `linux_arm64` | glibc 2.35 or newer, as on Ubuntu 22.04 |
| Linux AMD64 | `linux_amd64` | glibc 2.35 or newer, as on Ubuntu 22.04 |
| macOS ARM64 | `darwin_arm64` | |
| Windows AMD64 | `windows_amd64` | `tar`, which Windows includes |

The executables are neither signed nor notarized; see [current limits](../resources/limits.md#installation-and-releases).
Install the agent images, runtime images, and CLI of one release together; the release lists the image digests, and [compatibility](../references/compatibility.md#use-one-release-together) explains why.

## Install on Linux or macOS

From a working directory for the download, set the release and platform, then download the archive and the checksums:

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

Unpack the archive into a directory for this release, and put its `bin` directory on `PATH`:

```sh
INSTALL="$HOME/.local/opt/nemoclaw/$TAG"
mkdir -p "$INSTALL"
tar -xzf "nemoclaw-$TAG-$PLATFORM.tar.gz" -C "$INSTALL"
export PATH="$INSTALL/dist/$PLATFORM/bin:$PATH"
nemoclaw --version
```

`nemoclaw --version` prints the release's version, the tag without its `v`, such as `nemoclaw 0.1.0-rc12`.
The CLI runs the OpenTofu, providers, and schemas in the directory above its `bin` directory, and checks their checksums in its `manifest.json` before every operation, so run it from `dist/PLATFORM/bin` and leave the directory unchanged; don't copy `nemoclaw` elsewhere.
To keep the CLI on `PATH` in new shells, add the `export PATH=...` line, with `$INSTALL` and `$PLATFORM` expanded, to your shell's startup file, such as `~/.bashrc` or `~/.zshrc`.
The downloaded archive and `SHA256SUMS` aren't needed after unpacking.

## Install on Windows

In PowerShell, from a working directory for the download, download the archive and the checksums, and check the archive's checksum:

```powershell
$Tag = "v0.1.0-rc12"
$Archive = "nemoclaw-$Tag-windows_amd64.tar.gz"
Invoke-WebRequest "https://github.com/NVIDIA/NemoClaw/releases/download/$Tag/$Archive" -OutFile $Archive
Invoke-WebRequest "https://github.com/NVIDIA/NemoClaw/releases/download/$Tag/SHA256SUMS" -OutFile SHA256SUMS
$Expected = ((Get-Content SHA256SUMS) | Where-Object { $_.EndsWith(" $Archive") }).Split(" ")[0]
if ((Get-FileHash $Archive -Algorithm SHA256).Hash -ne $Expected) { throw "checksum mismatch" }
```

On `checksum mismatch` or any other error, delete the download and don't unpack it.
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

As on Linux and macOS, run `nemoclaw.exe` from `dist\windows_amd64\bin` and leave the directory unchanged.

## Upgrade

Install the new release into its own directory as above, and put its `bin` directory on `PATH` in place of the old one.
Keep the old release's directory: a deployment keeps using the release that created it until you destroy it with that release, as [compatibility](../references/compatibility.md#deployment-state) describes.
To run the old release for such a deployment, call its CLI by path, such as `"$HOME/.local/opt/nemoclaw/OLD_TAG/dist/PLATFORM/bin/nemoclaw" destroy --state-dir DIR`.
Create new deployments with the new release, with a fresh `metadata.uid` and state directory, and with the new release's agent images; rebuild [derived images](../build-deploy/derived-images.md) from them.

## Uninstall

Uninstalling a release's CLI doesn't remove what its deployments created.
For each deployment that the release created, with that release's CLI:

1. Preview and run [destroy](../build-deploy/usage.md#destroy) with the deployment's state directory.
2. To remove what destroy retains, such as gateway data, model caches, and credential volumes, follow [remove retained resources](../build-deploy/usage.md#remove-retained-resources).
3. Delete the deployment's state directory once nothing you need to recover remains.

Then delete the release's directory, such as `$HOME/.local/opt/nemoclaw/TAG` or `$env:LOCALAPPDATA\nemoclaw\TAG`, and remove its `bin` directory from `PATH` in your shell's startup file or your user `Path`.

NemoClaw keeps its files in these places:

| What | Where | Removed by |
|---|---|---|
| The CLI, OpenTofu, providers, and schemas | The release's directory | Deleting the directory |
| Deployment state, including OpenTofu state and its configuration | Each deployment's state directory: `--state-dir`, by default `.nemoclaw` in the directory you ran `nemoclaw` from; see [deployment state](../build-deploy/state.md#local-deployment-files) | Deleting the directory, after destroy |
| Deployment YAML | Where you saved it; `nemoclaw onboard` writes `deployment.yaml` in the current directory unless `--output` names another file | Deleting the file |
| Sandboxes, gateways, model services, and their data | The deployment's Docker or Podman engine, or Kubernetes cluster; see [retained resources](../build-deploy/state.md#understand-the-retained-resources) | Destroy, then removing retained resources |

The OpenShell CLI keeps its own gateway profiles; remove them with OpenShell's commands.
