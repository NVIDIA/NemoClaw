<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Installing the CLI

Install NemoClaw Agent Configs v0.1.0 from a CLI archive or use the macOS or Windows installer if the release includes it. Both methods keep the CLI, OpenTofu, providers, and schemas together.

## Choosing the Archive

Choose the archive for the machine running `nemoclaw`, not for the sandbox or GPU host. The [v0.1.0 release](https://github.com/NVIDIA/NemoClaw/releases/tag/v0.1.0) is the source for the archives, `SHA256SUMS`, and `release-evidence.json`. Consult the release evidence for platform signing results and any unsigned exception. Code signing and macOS notarization are separate checks. Linux uses archive provenance, not OS code signing.

| Client | `PLATFORM` | Requirement |
|---|---|---|
| Linux ARM64 | `linux_arm64` | glibc 2.35 or newer, as on Ubuntu 22.04 |
| Linux AMD64 | `linux_amd64` | glibc 2.35 or newer, as on Ubuntu 22.04 |
| macOS ARM64 | `darwin_arm64` | Apple silicon; CI tests on macOS 15 |
| Windows AMD64 | `windows_amd64` | Windows 10 version 1803 or later, or Windows Server 2019 or later, for `tar` |

Check [Current Limits](../resources/limits.md#platforms-models-and-placement) for tested deployment combinations. Use the [agent and runtime image digests from the same release](../references/compatibility.md#using-one-release-together). For a source build, follow the [source build guide](../build-deploy/build.md#building-a-native-bundle).

## Installing with the macOS Installer

On a Mac with Apple silicon and macOS 15 or later, `nemoclaw-v0.1.0-darwin_arm64.pkg` installs the `darwin_arm64` bundle in `/usr/local/nemoclaw`, unchanged.
It adds `/etc/paths.d/nemoclaw`, which puts `/usr/local/nemoclaw/bin` on `PATH` in new Terminal windows, and records the files under the package ID `com.nvidia.nemoclaw.cli`.
It refuses an Intel Mac and older versions of macOS.

A final release attaches the installer only when it's signed and notarized. If the installer is absent or you need to keep multiple versions side by side, [use the macOS archive](#installing-on-linux-or-macos). Run these commands in an empty download directory. Stop on any download or verification failure.

1. Download the installer.

   ```sh
   TAG=v0.1.0
   PKG="nemoclaw-$TAG-darwin_arm64.pkg"
   RELEASE="https://github.com/NVIDIA/NemoClaw/releases/download/$TAG"
   curl -fLO "$RELEASE/$PKG"
   ```

2. Download the checksums.

   ```sh
   curl -fLO "$RELEASE/SHA256SUMS"
   ```

3. Verify the installer checksum. Expect the filename followed by `OK`.

   ```sh
   CHECKSUM=$(awk -v package="$PKG" '$2 == package { print; count++ } END { if (count != 1) exit 1 }' SHA256SUMS) &&
     printf '%s\n' "$CHECKSUM" | shasum -a 256 --check
   ```

4. Verify the checksum file's provenance with the [GitHub CLI](https://cli.github.com/).

   ```sh
   gh attestation verify SHA256SUMS --repo NVIDIA/NemoClaw
   ```

5. Verify the installer's provenance.

   ```sh
   gh attestation verify "$PKG" --repo NVIDIA/NemoClaw
   ```

6. Install the package.

   ```sh
   sudo installer -pkg "$PKG" -target /
   ```

   You can also open the verified package in Finder and follow the installer's pages.

7. If you previously installed an archive, remove its `PATH` export from your shell's startup file, such as `~/.zshrc` or `~/.bashrc`.
   That export can put the archive's CLI before the installer's CLI, even in a new Terminal window.
   Keep the archive's directory if existing deployments still need that version; run it by its full path.

8. Open a new Terminal window to load the updated `PATH`, then check which CLI it selects:

   ```sh
   command -v nemoclaw
   nemoclaw --version
   ```

   Expect `/usr/local/nemoclaw/bin/nemoclaw` and `nemoclaw 0.1.0`.
   If another path appears, remove that installation's `PATH` entry from your shell configuration and open another Terminal window.
   Windows that were already open do not have the new `PATH`.

Keep `/usr/local/nemoclaw` intact and run the CLI from your deployment directory. Continue to the [first-deployment guide](first-deployment.md).

### Upgrading with the macOS Installer

The installer replaces `/usr/local/nemoclaw`. Deployments still need the release that created them.

It moves `/usr/local/nemoclaw` to `/usr/local/nemoclaw.previous` before installing the new bundle, so no old files remain in the installed directory.
After the replacement payload installs successfully, it removes the previous bundle.
If installation fails before that cleanup, it retains the previous bundle for [recovery](#recovering-from-a-failed-macos-installer-upgrade).

1. If existing deployments need the current release, [extract that release's archive](#installing-on-linux-or-macos) into a separate directory so you can run its CLI by absolute path.
2. Install the new release's package.

### Recovering from a Failed macOS Installer Upgrade

If `/usr/local/nemoclaw.previous` remains after an unsuccessful upgrade, restore it before retrying.
The installer refuses to replace this recovery copy.
Close any running CLI operations, then run:

```sh
sudo sh -c 'set -eu
test -d /usr/local/nemoclaw.previous
rm -rf /usr/local/nemoclaw
mv /usr/local/nemoclaw.previous /usr/local/nemoclaw'
/usr/local/nemoclaw/bin/nemoclaw --version
```

The directory check stops the command before removal if there is no recovery copy.
This restores the previous bundle and removes the incomplete replacement, without changing deployment directories or shell settings.
Recovery is manual; the installer does not roll back automatically.
If no previous bundle exists, retry the installer to replace an incomplete first installation.

### Uninstalling with the macOS Installer

If an upgrade failed, [restore the previous bundle](#recovering-from-a-failed-macos-installer-upgrade) first.
Keep the matching archive if a deployment or retained resources still need this release. To retire a deployment first, follow the [general uninstall guidance](#uninstalling).
Remove the CLI, the `PATH` entry, and the package's record:

```sh
sudo rm -rf /usr/local/nemoclaw /etc/paths.d/nemoclaw
sudo pkgutil --forget com.nvidia.nemoclaw.cli
```

In a new Terminal window, run `command -v nemoclaw` to check which installation, if any, remains on `PATH`.
Deployment YAML and state directories stay where you created them.

## Installing with the Windows Installer

On Windows 10 version 1803 or later, or Windows Server 2019 or later, a release's `nemoclaw-TAG-windows_amd64.msi` installs the `windows_amd64` bundle in `%LOCALAPPDATA%\Programs\NemoClaw`, unchanged.
It adds `%LOCALAPPDATA%\Programs\NemoClaw\bin` to your user `Path`, which new terminals read, and lists **NVIDIA NemoClaw Agent Configs** in **Settings** > **Apps** > **Installed apps**.
It installs for your Windows account only, so it needs no administrator rights.

A release attaches the installer only when its Windows executables are signed, and staging signs the installer with them.

1. In PowerShell, in an empty directory, download the installer and the checksums, and check the installer's checksum:

   ```powershell
   $ProgressPreference = "SilentlyContinue"
   $Tag = "v0.1.0"
   $Installer = "nemoclaw-$Tag-windows_amd64.msi"
   Invoke-WebRequest "https://github.com/NVIDIA/NemoClaw/releases/download/$Tag/$Installer" -OutFile $Installer
   Invoke-WebRequest "https://github.com/NVIDIA/NemoClaw/releases/download/$Tag/SHA256SUMS" -OutFile SHA256SUMS
   $Expected = ((Get-Content SHA256SUMS) | Where-Object { $_.EndsWith(" $Installer") }).Split(" ")[0]
   if ((Get-FileHash $Installer -Algorithm SHA256).Hash -ne $Expected) { throw "checksum mismatch" }
   ```

   On `checksum mismatch` or any other error, delete the download.
   For a final release, also check its build provenance with `gh attestation verify $Installer --owner NVIDIA`, as for the [archives](#installing-on-linux-or-macos).

2. Install it, and follow the installer's pages:

   ```powershell
   Start-Process msiexec -ArgumentList "/i", $Installer -Wait
   ```

   You can open the file in File Explorer instead.
   To install without the pages, such as from a script, add `"/qn"` to the arguments and `-PassThru` to `Start-Process`; the returned process's `ExitCode` is `0` on success.

3. Open a new terminal and run `nemoclaw --version`, which prints `nemoclaw` and the release's version.
   Terminals that were already open don't have the new `Path`.

If the version differs from the release you installed, check which executable Windows finds first:

```powershell
where.exe nemoclaw
```

An existing archive or system-wide installation can appear before the installer's directory on `Path`.
For an older archive, remove its `bin` entry from your user `Path` in **Edit environment variables for your account**, then open a new terminal.
Keep the archive itself if an existing deployment still needs that release.
If a system-wide installation takes precedence, ask its administrator about removing that installation or invoke this installer's CLI by its full path:

```powershell
& "$env:LOCALAPPDATA\Programs\NemoClaw\bin\nemoclaw.exe" --version
```

The installer changes only your user `Path`; it doesn't remove other installations or edit the machine `Path`.

Before your first deployment, install and start Docker Desktop or Podman, then run `nemoclaw onboard` in a directory for your deployment and follow the [first-deployment guide](first-deployment.md).
As with the archive, keep `%LOCALAPPDATA%\Programs\NemoClaw` unchanged, don't copy `nemoclaw.exe` elsewhere, and run it from your deployment's directory.

### Upgrading with the Windows Installer

Install the new release's installer as above.
It removes the installed release before it installs, so only the new release's files remain, and the `Path` entry stays.
If the upgrade fails, Windows Installer restores the previous release and its `Path` entry.
An older release's installer doesn't replace a newer one: it reports that a newer version is already installed, so uninstall first to go back.

A deployment keeps using the release that created it, as [upgrading](#upgrading) describes, and the installer doesn't keep the old release.
Before you upgrade, destroy the deployments that the installed release created, or unpack that release's `windows_amd64` archive into its own directory, as in [installing on Windows](#installing-on-windows), to run its CLI by path later.

### Uninstalling with the Windows Installer

First destroy the deployments that the release created and remove what they retain, as [uninstalling](#uninstalling) describes.
Then, in **Settings** > **Apps** > **Installed apps**, select **Uninstall** for **NVIDIA NemoClaw Agent Configs**, or uninstall from PowerShell with the installer you installed:

```powershell
Start-Process msiexec -ArgumentList "/x", $Installer, "/qn" -Wait
```

This removes `%LOCALAPPDATA%\Programs\NemoClaw` and its `Path` entry.
In a new terminal, `Get-Command nemoclaw` then reports that it can't find `nemoclaw`.
Deployment YAML and state directories stay where you created them.

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

To install with the Windows installer instead, see [installing with the Windows installer](#installing-with-the-windows-installer).
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

For an installation from the macOS package, follow [Uninstalling with the macOS Installer](#uninstalling-with-the-macos-installer). For an installation from an archive, follow these steps.

1. Remove this bundle's `bin` entry from your persistent `PATH`.
2. Delete the installation directory only if no deployment or retained resources need it.

NemoClaw keeps its files in these places:

| What | Where | Removed by |
|---|---|---|
| The CLI, OpenTofu, providers, and schemas | The release's directory, `/usr/local/nemoclaw` from the macOS installer, or `%LOCALAPPDATA%\Programs\NemoClaw` from the Windows installer | Deleting the directory, or uninstalling [with the macOS installer's commands](#uninstalling-with-the-macos-installer) or [with the Windows installer](#uninstalling-with-the-windows-installer) |
| Deployment state, including OpenTofu state and its configuration | Each deployment's state directory: `--state-dir`, by default `.nemoclaw` in the directory you ran `nemoclaw` from; see [deployment state](../build-deploy/state.md#local-deployment-files) | Deleting the directory, after destroy |
| Deployment YAML | Where you saved it; `nemoclaw onboard` writes `deployment.yaml` in the current directory unless `--output` names another file | Deleting the file |
| Sandboxes, gateways, model services, and their data | The deployment's Docker or Podman engine, or Kubernetes cluster; see [retained resources](../build-deploy/state.md#understanding-the-retained-resources) | Destroy, then removing retained resources |
| Agent, gateway, and model runtime images | The engine's image store, or the cluster nodes' | The engine's image commands, such as `docker image rm`; NemoClaw doesn't remove them |

The OpenShell CLI keeps its own gateway profiles. Use OpenShell's commands to remove a profile when you no longer need it.

For a new installation, continue to [Deploying Your First OpenClaw Agent](first-deployment.md).
