<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Installing the CLI

Install NemoClaw Agent Configs v0.1.0 from a CLI archive. The bundle keeps the CLI, OpenTofu, providers, and schemas together. You do not need a package manager or a source build.

## Choosing the Archive

Choose the archive for the machine running `nemoclaw`, not for the sandbox or GPU host. The [v0.1.0 release](https://github.com/NVIDIA/NemoClaw/releases/tag/v0.1.0) is the source for the archives, `SHA256SUMS`, and `release-evidence.json`. Consult the release evidence for platform signing results and any unsigned exception. Code signing and macOS notarization are separate checks. Linux uses archive provenance, not OS code signing.

| Client | `PLATFORM` | Requirement |
|---|---|---|
| Linux ARM64 | `linux_arm64` | glibc 2.35 or newer, as on Ubuntu 22.04 |
| Linux AMD64 | `linux_amd64` | glibc 2.35 or newer, as on Ubuntu 22.04 |
| macOS ARM64 | `darwin_arm64` | Apple silicon; CI tests on macOS 15 |
| Windows AMD64 | `windows_amd64` | Windows 10 version 1803 or later, or Windows Server 2019 or later, for `tar` |

An archive target is not an end-to-end deployment qualification. Refer to [Current Limits](../resources/limits.md#platforms-models-and-placement) for tested combinations. To build instead, use the [source build guide](../build-deploy/build.md#building-a-native-bundle).

## Installing on Linux or macOS

Run these commands from an empty download directory with `curl`, `tar`, and the [GitHub CLI](https://cli.github.com/) available. Stop on any download or verification failure. Do not unpack a failed download or substitute an archive from another tag.

1. Select your platform and archive name.

   ```sh
   TAG=v0.1.0
   PLATFORM=linux_arm64
   ARCHIVE="nemoclaw-$TAG-$PLATFORM.tar.gz"
   RELEASE="https://github.com/NVIDIA/NemoClaw/releases/download/$TAG"
   ```

2. Download the archive.

   ```sh
   curl -fLO "$RELEASE/$ARCHIVE"
   ```

3. Download the checksums.

   ```sh
   curl -fLO "$RELEASE/SHA256SUMS"
   ```

4. Verify the archive checksum. On macOS, replace `sha256sum --check` with `shasum -a 256 --check`. Expect the archive name followed by `OK`.

   ```sh
   CHECKSUM=$(awk -v archive="$ARCHIVE" '$2 == archive { print; count++ } END { if (count != 1) exit 1 }' SHA256SUMS) &&
     printf '%s\n' "$CHECKSUM" | sha256sum --check
   ```

5. Verify the checksum file's provenance.

   ```sh
   gh attestation verify SHA256SUMS --repo NVIDIA/NemoClaw
   ```

6. Verify the archive's provenance.

   ```sh
   gh attestation verify "$ARCHIVE" --repo NVIDIA/NemoClaw
   ```

7. Create a new installation directory for this version. If it exists, use another unused path.

   ```sh
   INSTALL="$HOME/.local/opt/nemoclaw/$TAG"
   mkdir -p "$(dirname "$INSTALL")" && mkdir "$INSTALL"
   ```

8. Extract the archive.

   ```sh
   tar -xzf "$ARCHIVE" -C "$INSTALL"
   ```

9. Add the extracted `bin` directory to the front of `PATH`.

   ```sh
   export PATH="$INSTALL/dist/$PLATFORM/bin:$PATH"
   ```

10. Check that the selected CLI reports `nemoclaw 0.1.0`.

    ```sh
    nemoclaw --version
    ```

11. To use the CLI in new shells, add the same `PATH` entry with the full bundle path to your shell startup file, such as `~/.bashrc` or `~/.zshrc`.

## Installing on Windows

Use PowerShell in an empty download directory with `tar.exe` and the GitHub CLI available. Stop on any download or verification failure.

1. Select the archive name.

   ```powershell
   $Tag = 'v0.1.0'
   $Archive = "nemoclaw-$Tag-windows_amd64.tar.gz"
   $Release = "https://github.com/NVIDIA/NemoClaw/releases/download/$Tag"
   ```

2. Download the archive.

   ```powershell
   Invoke-WebRequest "$Release/$Archive" -OutFile $Archive
   ```

3. Download the checksums.

   ```powershell
   Invoke-WebRequest "$Release/SHA256SUMS" -OutFile SHA256SUMS
   ```

4. Verify the archive checksum.

   ```powershell
   $Entry = @(Get-Content SHA256SUMS | Where-Object { $_.EndsWith(" $Archive") })
   if ($Entry.Count -ne 1 -or (Get-FileHash $Archive -Algorithm SHA256).Hash -ne ($Entry[0] -split '\s+')[0]) {
     throw 'Missing or mismatched archive checksum'
   }
   ```

5. Verify the checksum file's provenance.

   ```powershell
   gh attestation verify SHA256SUMS --repo NVIDIA/NemoClaw
   ```

6. Verify the archive's provenance.

   ```powershell
   gh attestation verify $Archive --repo NVIDIA/NemoClaw
   ```

7. Create a new installation directory for this version. If it exists, use another unused path.

   ```powershell
   $Install = "$env:LOCALAPPDATA\nemoclaw\$Tag"
   New-Item -ItemType Directory $Install -ErrorAction Stop | Out-Null
   ```

8. Extract the archive.

   ```powershell
   tar.exe -xzf $Archive -C $Install
   ```

9. Add the extracted `bin` directory to the front of the current session's `Path`.

   ```powershell
   $Bin = "$Install\dist\windows_amd64\bin"
   $env:Path = "$Bin;$env:Path"
   ```

10. Check that the selected CLI reports `nemoclaw 0.1.0`.

    ```powershell
    nemoclaw --version
    ```

11. To use the CLI in new shells, add the directory in `$Bin` to your user `Path` in **Edit environment variables for your account**.

## Keeping the Bundle Intact

The CLI locates OpenTofu, providers, and schemas relative to its executable. Deployment operations verify the bundle against `manifest.json`. Keep the entire `dist/PLATFORM` directory unchanged. Do not copy or link only the executable. Run it from your deployment directory: the default state path is `.nemoclaw` in the working directory, not in the bundle.

## Upgrading

Changing the CLI on `PATH` does not upgrade a deployment. Existing deployments keep their original bundle, image pins, and state. Refer to [deployment state compatibility](../references/compatibility.md#deployment-state).

1. Install the new bundle into a separate directory.
2. Replace the previous `PATH` entry with the new bundle's `bin` directory.
3. Check the selected version with `nemoclaw --version` in a new shell.

Keep the previous bundle for recovery and teardown. For an existing deployment, use its original CLI by absolute path from the deployment directory. For a new release evaluation, use a fresh `metadata.uid`, state directory, and release-matched images. Rebuild [derived images](../build-deploy/derived-images.md) from the matching base.

## Uninstalling

Removing the CLI does not delete deployments, deployment YAML, engine images, or OpenShell profiles. After changing persistent `PATH`, open a new terminal to use the updated value. If a deployment or retained resources still depend on this bundle, keep it with the entire state directory. To retire a deployment first, use the original CLI to [preview teardown and destroy](../build-deploy/usage.md#destroying). [Retained resources](../build-deploy/usage.md#removing-retained-resources) require a separate decision and cleanup before you remove the state directory.

1. Remove this bundle's `bin` entry from your persistent `PATH`.
2. Delete the installation directory only if no deployment or retained resources need it.

For a new installation, continue to [Deploying Your First OpenClaw Agent](first-deployment.md).
