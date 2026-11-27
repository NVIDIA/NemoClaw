<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Installing the CLI

Install a verified [v0.1.0 release bundle](https://github.com/NVIDIA/NemoClaw/releases/tag/v0.1.0) on the machine that runs the CLI.
On Windows, the native x64 bundle is separate from the first-reply path: [prepare WSL2](prerequisites.md#preparing-windows-with-wsl2) and install the Linux bundle inside Ubuntu for the tutorial.
OpenShell 0.1.10 does not provide a native Windows CLI.

<!-- Keep existing links reachable when their tabs are closed. -->
<a name="choosing-the-archive"></a>
<a name="choosing-an-installation-method"></a>
<a name="installing-the-bundle"></a>
<a name="installing-with-the-macos-installer"></a>
<a name="installing-with-the-windows-installer"></a>
<a name="installing-on-windows"></a>
<a name="installing-on-linux-or-macos"></a>

## Choosing Your Operating System

Use **macOS** for the Apple silicon package, **Windows** for the native x64 package or archive, or **Linux and macOS Archives** for Linux, WSL2, and the Apple silicon archive.
An archive lets you keep multiple versions side by side.
On an Intel Mac, [build the `darwin_amd64` bundle](../build-deploy/build.md#building-a-native-bundle).
For other source builds, use the [build guide](../build-deploy/build.md) from the revision you intend to deploy.

### Preparing to Verify Downloads

The verification commands check both the file checksum and the GitHub build attestations before installing or extracting the bundle.
Use an empty download directory for each attempt.
The macOS and Linux commands require `curl`.

1. Install the [GitHub CLI](https://cli.github.com/).
2. Sign in to GitHub CLI.
3. Check `release-evidence.json` in the release assets for signing, macOS notarization, and unsigned exceptions.

<Tabs>
<Tab title="macOS" id="macos" language="macos">

<Anchor id="installing-with-the-macos-installer">

On Apple silicon with macOS 15 or later, the package installs the bundle in `/usr/local/nemoclaw` and adds its `bin` directory to `PATH` for new Terminal windows.
The package requires administrator privileges and ships only after signing and notarization.

</Anchor>

If the release omits the package or you need multiple versions, <a href="?language=linux#installing-on-linux-or-macos">use the Linux and macOS Archives tab</a>.
If you already installed a package, follow <a href="?language=macos#upgrading-with-the-macos-installer">the upgrade procedure</a> first.

1. Install the verified package from Terminal.
   For the graphical installer, replace the final `sudo installer` line with `open "$PKG"`; the installation finishes when you complete its prompts.

   ```sh
   (
     set -e
     TAG=v0.1.0
     PKG="nemoclaw-$TAG-darwin_arm64.pkg"
     RELEASE="https://github.com/NVIDIA/NemoClaw/releases/download/$TAG"
     curl -fLO "$RELEASE/$PKG"
     curl -fLO "$RELEASE/SHA256SUMS"
     CHECKSUM=$(awk -v asset="$PKG" '$2 == asset { print; count++ } END { if (count != 1) exit 1 }' SHA256SUMS)
     printf '%s\n' "$CHECKSUM" | shasum -a 256 --check
     gh attestation verify SHA256SUMS --repo NVIDIA/NemoClaw
     gh attestation verify "$PKG" --repo NVIDIA/NemoClaw
     sudo installer -pkg "$PKG" -target /
   )
   ```

   Expect `OK` for the checksum and successful attestations for both files before the installer runs.
   Stop if the block fails.
2. Open a new Terminal window to load the updated `PATH`.
3. Check the selected CLI path and version.

   ```sh
   command -v nemoclaw && nemoclaw --version
   ```

   Expect `/usr/local/nemoclaw/bin/nemoclaw` and the version you installed.
4. If another bundle takes precedence, put this one first for the current shell.

   ```sh
   export PATH="/usr/local/nemoclaw/bin:$PATH"
   ```

5. Repeat the path and version check if you changed `PATH`.

</Tab>
<Tab title="Windows" id="windows" language="windows">

<Anchor id="installing-with-the-windows-installer">

On x64 Windows, the MSI installs without administrator rights in `%LOCALAPPDATA%\Programs\NemoClaw` and adds its `bin` directory to your user `Path`.
A release includes the MSI only if it signs the Windows executables.
If you already use the MSI, follow <a href="?language=windows#upgrading-with-the-windows-installer">the upgrade procedure</a> first.

</Anchor>

<Anchor id="installing-on-windows">

Use the archive if the MSI is absent or you need multiple versions.
The archive requires `tar.exe`, which ships with Windows 10 version 1803 or later and Windows Server 2019 or later.

</Anchor>

1. Install the verified bundle from PowerShell.
   The block uses the MSI by default. Set `$UseArchive = $true` for the archive.
   If the default archive directory already exists or you want a different location, edit the `$Install = ...` line inside `if ($UseArchive)` in the block below before running it. Use a path that does not exist yet.

   ```powershell
   & {
     $ErrorActionPreference = 'Stop'
     $Tag = 'v0.1.0'
     $UseArchive = $false
     $Release = "https://github.com/NVIDIA/NemoClaw/releases/download/$Tag"
     $Asset = if ($UseArchive) { "nemoclaw-$Tag-windows_amd64.tar.gz" }
              else { "nemoclaw-$Tag-windows_amd64.msi" }
     Invoke-WebRequest "$Release/$Asset" -OutFile $Asset
     Invoke-WebRequest "$Release/SHA256SUMS" -OutFile SHA256SUMS
     $Entry = @(Get-Content SHA256SUMS | Where-Object { $_.EndsWith(" $Asset") })
     if ($Entry.Count -ne 1 -or (Get-FileHash $Asset -Algorithm SHA256).Hash -ne ($Entry[0] -split '\s+')[0]) {
       throw 'Missing or mismatched asset checksum'
     }
     gh attestation verify SHA256SUMS --repo NVIDIA/NemoClaw
     if ($LASTEXITCODE -ne 0) { throw 'Cannot verify the checksum file provenance' }
     gh attestation verify $Asset --repo NVIDIA/NemoClaw
     if ($LASTEXITCODE -ne 0) { throw 'Cannot verify the asset provenance' }
     if ($UseArchive) {
       $Install = "$env:LOCALAPPDATA\nemoclaw\$Tag"
       New-Item -ItemType Directory $Install | Out-Null
       tar.exe -xzf $Asset -C $Install
       if ($LASTEXITCODE -ne 0) { throw 'Cannot extract the verified archive' }
       $env:Path = "$Install\dist\windows_amd64\bin;$env:Path"
     } else {
       $Process = Start-Process msiexec -ArgumentList '/i', $Asset -Wait -PassThru
       if ($Process.ExitCode -ne 0) { throw "Installer exit code: $($Process.ExitCode)" }
     }
   }
   ```

   Stop on any failure.
   The MSI displays installation prompts. To install without prompts, add `'/qn'` to its argument list.
   The archive puts its `bin` directory first on `Path` for the current session only.
### Checking the Windows MSI Installation

Follow these steps only after an MSI install.

1. Open a new PowerShell window to load the updated user `Path`.
2. Check the selected CLI path and version.

   ```powershell
   Get-Command nemoclaw
   nemoclaw --version
   ```

   Expect the new bundle's executable and the version you installed.
   For an MSI install, **Settings** > **Apps** > **Installed apps** lists the version under **NVIDIA NemoClaw Agent Configs**.
3. If another bundle takes precedence over the MSI install, put the MSI bundle first for this session.

   ```powershell
   $env:Path = "$env:LOCALAPPDATA\Programs\NemoClaw\bin;$env:Path"
   ```

4. Repeat the path and version check if you changed `Path`.
   If `Get-Command` finds an alias or function, use the MSI executable's full path: `& "$env:LOCALAPPDATA\Programs\NemoClaw\bin\nemoclaw.exe" --version`.

### Checking the Windows Archive Installation

Follow these steps only after extracting the archive. Keep using the PowerShell session that ran the extraction.

1. Check the selected CLI path and version.

   ```powershell
   Get-Command nemoclaw
   nemoclaw --version
   ```

   Expect the executable in the archive's `dist\windows_amd64\bin` directory and the version you extracted.
2. If the check selects another bundle, an alias, or a function, use the archive executable by its full path for subsequent commands.
3. For persistent archive access, add its `dist\windows_amd64\bin` directory to your user `Path` in **Edit environment variables for your account**.

</Tab>
<Tab title="Linux and macOS Archives" id="linux" language="linux">

<Anchor id="installing-on-linux-or-macos">

Linux requires glibc 2.35 or later.
Bundle CI runs on macOS 15 for Apple silicon. It does not verify a browser-downloaded release archive.

</Anchor>

If you download through a browser, keep the original `.tar.gz` and `SHA256SUMS` from the same release in the download directory.
The commands verify the archive and extract it into a new installation directory, regardless of any browser extraction.
On macOS, run the commands in Terminal, not by double-clicking `bin/nemoclaw` in Finder.
If macOS blocks execution, stop and record the warning, archive name, release, and signing evidence.
Do not remove quarantine or bypass Gatekeeper to qualify a release.

1. Set the platform and installation path.
   Replace the `PLATFORM` value in the command with the one for your shell:

   | Shell | `PLATFORM` |
   |---|---|
   | Linux or WSL2 with `uname -m` reporting `x86_64` | `linux_amd64` |
   | Linux or WSL2 with `uname -m` reporting `aarch64` | `linux_arm64` |
   | macOS on Apple silicon | `darwin_arm64` |

   Set `INSTALL` to an unused directory if the default version directory exists.

   ```sh
   TAG=v0.1.0
   PLATFORM=linux_amd64
   ARCHIVE="nemoclaw-$TAG-$PLATFORM.tar.gz"
   RELEASE="https://github.com/NVIDIA/NemoClaw/releases/download/$TAG"
   INSTALL="$HOME/.local/opt/nemoclaw/$TAG"
   ```

2. Install the verified archive.
   Omit the two `curl` lines only if you already downloaded the original files through a browser.

   ```sh
   (
     set -e
     curl -fLO "$RELEASE/$ARCHIVE"
     curl -fLO "$RELEASE/SHA256SUMS"
     CHECKSUM=$(awk -v asset="$ARCHIVE" '$2 == asset { print; count++ } END { if (count != 1) exit 1 }' SHA256SUMS)
     if [ "$PLATFORM" = darwin_arm64 ]; then
       printf '%s\n' "$CHECKSUM" | shasum -a 256 --check
     else
       printf '%s\n' "$CHECKSUM" | sha256sum --check
     fi
     gh attestation verify SHA256SUMS --repo NVIDIA/NemoClaw
     gh attestation verify "$ARCHIVE" --repo NVIDIA/NemoClaw
     mkdir -p "$(dirname "$INSTALL")"
     mkdir "$INSTALL"
     tar -xzf "$ARCHIVE" -C "$INSTALL"
   )
   ```

   Expect `OK` for the checksum and successful attestations for both files before extraction.
   Stop if the block fails.
3. Put the new bundle first on `PATH` for this shell.

   ```sh
   export PATH="$INSTALL/dist/$PLATFORM/bin:$PATH"
   ```

4. Check the selected CLI path and version.

   ```sh
   command -v nemoclaw && nemoclaw --version
   ```

   Expect the new bundle's executable and the version you installed.
5. For access in new shells, add the full path to that `bin` directory to `PATH` in your shell startup file, such as `~/.bashrc` or `~/.zshrc`.

</Tab>
</Tabs>

### Keeping the Bundle Intact

The bundle includes the CLI, OpenTofu, providers, and schemas.
The CLI locates these files relative to its executable and verifies the bundle against `manifest.json` for deployment operations.
Keep the package's installation directory or the archive's `dist/PLATFORM` directory intact.
Run deployment commands from the deployment directory. The default state path is `.nemoclaw` in that directory.

### Next Steps

The CLI sends NVIDIA a usage record after `apply` or `destroy` finishes or `onboard` saves a configuration.
To disable records, set `NEMOCLAW_DISABLE_TELEMETRY=1` before running those commands.
Refer to [Usage Telemetry](../security/security.md#usage-telemetry).

- [Deploy OpenClaw and verify a reply](first-deployment.md) with local Docker and NVIDIA Endpoints. On Windows hosts, start with [WSL2 setup](prerequisites.md#preparing-windows-with-wsl2).
- [Use an existing gateway and model endpoint](first-deployment.md#using-an-existing-gateway-and-inference-endpoint) if you already have those services.
- [Author YAML with onboarding](onboard.md) if you want to configure your own deployment without applying it yet.

<a name="upgrading-and-uninstalling"></a>

## Upgrading

Existing deployments keep their original bundle, image pins, and state.
Keep the previous bundle for recovery and teardown.
Manage an existing deployment from its deployment directory with the original CLI's absolute path.
Refer to [deployment state compatibility](../reference/compatibility.md#deployment-state).

In an installation procedure, use the new tag to upgrade and the installed tag to preserve the old bundle from its archive.
For a new release evaluation, use a fresh `metadata.uid`, state directory, and release-matched images.
Rebuild [derived images](../build-deploy/derived-images.md) from the matching base.

<a name="upgrading-with-the-macos-installer"></a>
<a name="recovering-from-a-failed-macos-installer-upgrade"></a>
<a name="upgrading-with-the-windows-installer"></a>

<Tabs>
<Tab title="macOS" id="upgrade-macos" language="macos">

<Anchor id="upgrading-with-the-macos-installer">

The package moves `/usr/local/nemoclaw` to `/usr/local/nemoclaw.previous` and removes the old copy after installing the new payload.
If installation fails before cleanup, the previous bundle remains for manual recovery.
For archive upgrades, use the <a href="?language=linux#upgrading">archive upgrade procedure</a> instead.

</Anchor>

1. If an existing deployment needs the installed release, <a href="?language=linux#installing-on-linux-or-macos">install that release's verified archive</a> in a separate directory before replacing the package.
2. <a href="?language=macos#installing-with-the-macos-installer">Install the new release's package</a>.

<Anchor id="recovering-from-a-failed-macos-installer-upgrade">

If a failed upgrade leaves `/usr/local/nemoclaw.previous`, restore it before retrying.
The installer refuses to replace this recovery copy. It does not roll back automatically.
If no previous bundle exists after an incomplete first installation, retry the installer instead.

</Anchor>

1. Stop any active CLI operations before restoring the previous bundle.
2. Restore the previous bundle.
   The directory check prevents removal if the recovery copy does not exist.
   This removes the incomplete replacement without changing deployment directories or shell settings.

   ```sh
   sudo sh -c 'set -eu
   test -d /usr/local/nemoclaw.previous
   rm -rf /usr/local/nemoclaw
   mv /usr/local/nemoclaw.previous /usr/local/nemoclaw'
   ```

3. Verify the restored version.

   ```sh
   /usr/local/nemoclaw/bin/nemoclaw --version
   ```

</Tab>
<Tab title="Windows" id="upgrade-windows" language="windows">

<Anchor id="upgrading-with-the-windows-installer">

The new MSI replaces the installed release and keeps its `Path` entry. On failure, Windows Installer restores the old release and `Path` entry.
To go back to an older MSI, uninstall the newer one first.

</Anchor>

1. Before replacing the MSI, preserve access to deployments created with it by <a href="?language=windows#installing-on-windows">installing the same release's verified archive</a>. If you are retiring those deployments instead, [preview teardown and destroy](../build-deploy/usage.md#destroying) before replacing the bundle.
2. <a href="?language=windows#installing-with-the-windows-installer">Install the new release's MSI</a>.

For an archive upgrade, use a separate directory for the new version.

1. <a href="?language=windows#installing-on-windows">Install the new release's verified archive</a>.
2. If your user `Path` includes the old bundle, replace that entry with the new bundle's `bin` directory in **Edit environment variables for your account**.
3. Open a new PowerShell window if you updated the user `Path`.
4. Check the version selected by the updated `Path`.

   ```powershell
   nemoclaw --version
   ```

</Tab>
<Tab title="Linux and macOS Archives" id="upgrade-linux" language="linux">

Install the new archive alongside the old one.

1. <a href="?language=linux#installing-on-linux-or-macos">Install the new release's verified archive</a> in a separate directory.
2. If your shell startup file includes the old bundle, replace that entry with the new bundle's `dist/PLATFORM/bin` directory.
3. Open a new shell if you updated your startup file.
4. Check the path and version selected by the updated `PATH`.

   ```sh
   command -v nemoclaw && nemoclaw --version
   ```

   Expect the path to the new bundle and the version you installed.

</Tab>
</Tabs>

## Uninstalling

Removing the CLI does not remove deployments, YAML, engine images, or OpenShell profiles.
Keep the original bundle and entire state directory while a deployment or retained resource still needs them.
To retire a deployment, [preview teardown and destroy](../build-deploy/usage.md#destroying) with its original CLI.
[Retained resources](../build-deploy/usage.md#removing-retained-resources) require separate cleanup before you remove deployment state.

<a name="uninstalling-with-the-macos-installer"></a>
<a name="uninstalling-with-the-windows-installer"></a>

<Tabs>
<Tab title="macOS" id="uninstall-macos" language="macos">

<Anchor id="uninstalling-with-the-macos-installer">

The package places files in `/usr/local/nemoclaw` and `/etc/paths.d/nemoclaw`.
For an archive, use the <a href="?language=linux#uninstalling">archive removal procedure</a> instead.

</Anchor>

1. If an upgrade failed, <a href="?language=macos#recovering-from-a-failed-macos-installer-upgrade">restore the previous bundle</a> first.
2. If a deployment or retained resource still needs the installed release, <a href="?language=linux#installing-on-linux-or-macos">install its verified archive</a> before removing the package.
3. Remove the package's files.

   ```sh
   sudo rm -rf /usr/local/nemoclaw /etc/paths.d/nemoclaw
   ```

4. Remove the package record.

   ```sh
   sudo pkgutil --forget com.nvidia.nemoclaw.cli
   ```

5. Open a new Terminal window.
6. Check for a remaining installation.

   ```sh
   command -v nemoclaw
   ```

   The command prints the path to a remaining CLI or exits nonzero if none is on `PATH`.

</Tab>
<Tab title="Windows" id="uninstall-windows" language="windows">

<Anchor id="uninstalling-with-the-windows-installer">

The MSI uninstaller removes `%LOCALAPPDATA%\Programs\NemoClaw` and its `Path` entry.

</Anchor>

1. If a deployment or retained resource still needs the installed release, <a href="?language=windows#installing-on-windows">install its verified archive</a> before removing the MSI.
2. Select **Uninstall** for **NVIDIA NemoClaw Agent Configs** in **Settings** > **Apps** > **Installed apps**.
   For a quiet uninstall, run the following in the original installer's directory with `$Installer` set to its filename:

   ```powershell
   Start-Process msiexec -ArgumentList '/x', $Installer, '/qn' -Wait -PassThru
   ```

   The returned process's `ExitCode` is `0` on success.

For an archive, remove only the directory for the version you intend to retire.

1. Confirm that no deployment or retained resources need the bundle.
2. Remove its saved `bin` entry, if any, from your user `Path` in **Edit environment variables for your account**.
3. Delete that version's installation directory.

After removing either the MSI or an archive, check which CLI remains:

1. Open a new PowerShell window.
2. Check for a remaining installation.

   ```powershell
   Get-Command nemoclaw
   ```

</Tab>
<Tab title="Linux and macOS Archives" id="uninstall-linux" language="linux">

Remove only the directory for the version you intend to retire.

1. Identify its installation directory. If that version is on `PATH`, `command -v nemoclaw` prints its executable path.
2. Confirm that no deployment or retained resources need the bundle.
3. Remove its `bin` entry, if saved, from your shell startup file.
4. Delete that version's installation directory, such as `~/.local/opt/nemoclaw/v0.1.0`.
5. Open a new shell.
6. Check for a remaining installation.

   ```sh
   command -v nemoclaw
   ```

   The command prints the path to a remaining CLI or exits nonzero if none is on `PATH`.

</Tab>
</Tabs>

The following files and resources have independent lifecycles:

| What | Where | Removed by |
|---|---|---|
| Deployment state, including OpenTofu state and its configuration | The directory passed with `--state-dir`, or `.nemoclaw` in the working directory by default. Refer to [deployment state](../build-deploy/state.md#local-deployment-files). | Deleting the directory after destroy and retained-resource cleanup |
| Deployment YAML | Where you saved it. `nemoclaw onboard` defaults to `deployment.yaml` in the current directory. | Deleting the file |
| Sandboxes, gateways, model services, and their data | The deployment's engine or cluster | Destroy and [retained-resource cleanup](../build-deploy/state.md#understanding-the-retained-resources) |
| Agent, gateway, and model runtime images | The engine's image store or the cluster nodes | The engine's image commands; NemoClaw does not remove images |
| OpenShell gateway profiles | The OpenShell CLI's profile store | OpenShell commands for profiles you no longer need |
