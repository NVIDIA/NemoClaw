<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Installing the CLI

Install the NemoClaw Agent Configs CLI bundle for the operating system and architecture where you run `nemoclaw`.
The bundle includes the CLI, OpenTofu, providers, and schemas.

<a name="choosing-the-archive"></a>

## Choosing an Installation Method

Find your installer or archive under **Assets** on the [v0.1.0 release page](https://github.com/NVIDIA/NemoClaw/releases/tag/v0.1.0), along with `SHA256SUMS` and `release-evidence.json`.

| Client | Installer | Archive or Source Build |
|---|---|---|
| Mac with Apple silicon | [macOS package (`.pkg`)](#installing-with-the-macos-installer) on macOS 15 or later | [`darwin_arm64` archive](#installing-on-linux-or-macos), tested on macOS 15 |
| Mac with an Intel processor | | [Build the `darwin_amd64` bundle](../build-deploy/build.md#building-a-native-bundle) |
| Windows x64 (AMD64) | [Per-user Windows installer (`.msi`)](#installing-with-the-windows-installer) | [`windows_amd64` archive](#installing-on-windows) |
| Linux ARM64 or AMD64 | | [`linux_arm64` or `linux_amd64` archive](#installing-on-linux-or-macos), with glibc 2.35 or later |
| Windows ARM64 | | [Build for Linux ARM64 in WSL2](from-source.md) |

If your platform lists an archive, use it when the installer is unavailable or when you need to keep multiple bundle versions side by side.
To install from a checkout, follow the [source build guide](../build-deploy/build.md).
Before verifying a download's build provenance, install and sign in to the [GitHub CLI](https://cli.github.com/).
Refer to `release-evidence.json` for platform signing results and any unsigned exception.
Code signing and macOS notarization are separate checks.
For Linux, verify the archive's build provenance.

The CLI sends NVIDIA a usage record when `apply` or `destroy` finishes or when `onboard` saves a configuration.
To disable the records, set `NEMOCLAW_DISABLE_TELEMETRY=1` before running those commands.
Refer to [Usage Telemetry](../security/security.md#usage-telemetry).

## Installing with the macOS Installer

On a Mac with Apple silicon and macOS 15 or later, `nemoclaw-v0.1.0-darwin_arm64.pkg` installs the bundle in `/usr/local/nemoclaw`.
The installer requires administrator privileges and adds `/usr/local/nemoclaw/bin` to `PATH` for new Terminal windows.
A final release includes the package only after signing and notarization.
If you already installed a package, follow [the upgrade steps](#upgrading-with-the-macos-installer) before replacing the bundle.

Run these commands in an empty download directory with `curl` available.
Stop on any download or verification failure.

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

7. Open a new Terminal window to load the updated `PATH` and check which CLI it selects.

   ```sh
   command -v nemoclaw
   nemoclaw --version
   ```

   Expect `/usr/local/nemoclaw/bin/nemoclaw` and `nemoclaw 0.1.0`.
   If another installation takes precedence, put this bundle's `bin` directory first for the current shell and repeat the checks.

   ```sh
   export PATH="/usr/local/nemoclaw/bin:$PATH"
   ```

Continue to [Next Steps](#next-steps).

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

On x64 Windows, `nemoclaw-v0.1.0-windows_amd64.msi` installs the bundle in `%LOCALAPPDATA%\Programs\NemoClaw` and adds its `bin` directory to your user `Path`.
The installer requires no administrator rights.
Find the installed version under **NVIDIA NemoClaw Agent Configs** in **Settings** > **Apps** > **Installed apps**.

A release includes the signed installer only if it signs the Windows executables.
If you already use the installer, follow [the upgrade steps](#upgrading-with-the-windows-installer) before replacing the bundle.
Use PowerShell in an empty download directory.
Stop on any download or verification failure.

1. Download the installer and the checksums, then verify the installer's checksum.

   ```powershell
   $ProgressPreference = "SilentlyContinue"
   $Tag = "v0.1.0"
   $Installer = "nemoclaw-$Tag-windows_amd64.msi"
   $Release = "https://github.com/NVIDIA/NemoClaw/releases/download/$Tag"
   Invoke-WebRequest "$Release/$Installer" -OutFile $Installer -ErrorAction Stop
   Invoke-WebRequest "$Release/SHA256SUMS" -OutFile SHA256SUMS -ErrorAction Stop
   $Entry = @(Get-Content SHA256SUMS | Where-Object { $_.EndsWith(" $Installer") })
   if ($Entry.Count -ne 1 -or (Get-FileHash $Installer -Algorithm SHA256).Hash -ne ($Entry[0] -split '\s+')[0]) {
     throw 'Missing or mismatched installer checksum'
   }
   ```

2. Verify the build provenance of the checksum file and the installer.

   ```powershell
   gh attestation verify SHA256SUMS --repo NVIDIA/NemoClaw
   if ($LASTEXITCODE -ne 0) { throw 'Cannot verify the checksum file provenance' }
   gh attestation verify $Installer --repo NVIDIA/NemoClaw
   if ($LASTEXITCODE -ne 0) { throw 'Cannot verify the installer provenance' }
   ```

3. Start the installer and follow its prompts.

   ```powershell
   Start-Process msiexec -ArgumentList "/i", $Installer -Wait
   ```

   You can open the file in File Explorer instead.
   To install without the pages, such as from a script, add `"/qn"` to the arguments and `-PassThru` to `Start-Process`; the returned process's `ExitCode` is `0` on success.

4. Open a new PowerShell window to load the updated `Path` and check which CLI it selects.

   ```powershell
   Get-Command nemoclaw
   nemoclaw --version
   ```

   Expect the executable under `%LOCALAPPDATA%\Programs\NemoClaw\bin` and `nemoclaw 0.1.0`.
   If another installation takes precedence, put this bundle's `bin` directory first for the current session and repeat the checks.

   ```powershell
   $env:Path = "$env:LOCALAPPDATA\Programs\NemoClaw\bin;$env:Path"
   ```

If `Get-Command nemoclaw` selects a PowerShell alias or function, run the executable by its full path.
Use that path for subsequent `nemoclaw` commands in the same session.

```powershell
& "$env:LOCALAPPDATA\Programs\NemoClaw\bin\nemoclaw.exe" --version
```

Continue to [Next Steps](#next-steps).

### Upgrading with the Windows Installer

Install the new release's installer as above.
It removes the installed release before it installs, so only the new release's files remain, and the `Path` entry stays.
If the upgrade fails, Windows Installer restores the previous release and its `Path` entry.
An older release's installer doesn't replace a newer one: it reports that a newer version is already installed, so uninstall first to go back.

A deployment keeps using the release that created it, as [upgrading](#upgrading) describes, and the installer doesn't keep the old release.
Before you upgrade, destroy the deployments that the installed release created, or unpack that release's `windows_amd64` archive into its own directory, as in [installing on Windows](#installing-on-windows), to run its CLI by path later.

### Uninstalling with the Windows Installer

If an existing deployment still needs this release, keep its [verified archive](#installing-on-windows) before uninstalling.
To retire a deployment first, follow the [general uninstall guidance](#uninstalling).
Then, in **Settings** > **Apps** > **Installed apps**, select **Uninstall** for **NVIDIA NemoClaw Agent Configs**, or uninstall from PowerShell with the installer you installed:

```powershell
Start-Process msiexec -ArgumentList "/x", $Installer, "/qn" -Wait
```

This removes `%LOCALAPPDATA%\Programs\NemoClaw` and its `Path` entry.
In a new terminal, `Get-Command nemoclaw` reports any remaining installation, or reports that it cannot find `nemoclaw`.
Deployment YAML and state directories stay where you created them.

## Installing on Linux or macOS

On macOS, open **Applications > Utilities > Terminal** to run these commands.
If you download the archive in a browser, also download `SHA256SUMS` from the same release, then verify both files in Terminal before extracting.
If the browser automatically extracts archives, keep the original `.tar.gz` for verification and extract that verified archive into the new installation directory in step 8.
Finder can browse the bundle, but double-clicking `bin/nemoclaw` does not start onboarding.
Keep the whole bundle together and run commands in Terminal.
If macOS blocks execution, stop and record the exact warning, archive name, release, and signing evidence; do not remove quarantine or bypass Gatekeeper to qualify a release.
For an unreleased revision, use [onboarding from source](from-source.md) instead.

Run these commands from an empty download directory with `curl` and `tar` available.
Stop on any download or verification failure.

1. Set `PLATFORM` for your client.
   The example uses `linux_amd64` for Linux AMD64.
   Use `linux_arm64` for Linux ARM64 or `darwin_arm64` for a Mac with Apple silicon.

   ```sh
   TAG=v0.1.0
   PLATFORM=linux_amd64
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

Continue to [Next Steps](#next-steps).

## Installing on Windows

The archive requires `tar.exe`, which ships with Windows 10 version 1803 or later and Windows Server 2019 or later.
Use PowerShell in an empty download directory.
Stop on any download or verification failure.

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

Continue to [Next Steps](#next-steps).

## Keeping the Bundle Intact

The CLI locates OpenTofu, providers, and schemas relative to its executable.
Deployment operations verify the bundle against `manifest.json`.
Keep the entire bundle together in `/usr/local/nemoclaw` for the macOS package or `%LOCALAPPDATA%\Programs\NemoClaw` for the Windows installer.
For an archive, keep the `dist/PLATFORM` directory inside your installation directory intact.
Run the CLI from your deployment directory.
The default state directory is `.nemoclaw` in the working directory.

## Upgrading

Changing the CLI on `PATH` does not upgrade a deployment. Existing deployments keep their original bundle, image pins, and state. Refer to [deployment state compatibility](../references/compatibility.md#deployment-state).

1. Install the new bundle into a separate directory.
2. Replace the previous `PATH` entry with the new bundle's `bin` directory.
3. Check the selected version with `nemoclaw --version` in a new shell.

Keep the previous bundle for recovery and teardown. For an existing deployment, use its original CLI by absolute path from the deployment directory. For a new release evaluation, use a fresh `metadata.uid`, state directory, and release-matched images. Rebuild [derived images](../build-deploy/derived-images.md) from the matching base.

## Uninstalling

Removing the CLI does not delete deployments, deployment YAML, engine images, or OpenShell profiles. After changing persistent `PATH`, open a new terminal to use the updated value. If a deployment or retained resources still depend on this bundle, keep it with the entire state directory. To retire a deployment first, use the original CLI to [preview teardown and destroy](../build-deploy/usage.md#destroying). [Retained resources](../build-deploy/usage.md#removing-retained-resources) require a separate decision and cleanup before you remove the state directory.

For a package installation, follow [Uninstalling with the macOS Installer](#uninstalling-with-the-macos-installer) or [Uninstalling with the Windows Installer](#uninstalling-with-the-windows-installer).
For an archive installation, follow these steps.

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

## Next Steps

After you verify the CLI version, [keep the bundle intact](#keeping-the-bundle-intact) and choose a deployment guide.

- On Linux or macOS, if you have an existing OpenShell gateway and inference endpoint, [deploy your first OpenClaw agent](first-deployment.md) with the release's example and image.
- To configure your own deployment, [write deployment YAML with `nemoclaw onboard`](onboard.md) and review it before you plan and apply.
- For a walkthrough that creates a managed Docker gateway on macOS or Windows with WSL2, [build and deploy Hermes from source](from-source.md).

Use the [bundle and image digests from the same release](../references/compatibility.md#using-one-release-together) and check [Current Limits](../resources/limits.md#platforms-models-and-placement) for your deployment configuration.
