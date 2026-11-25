<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Installing the CLI

Find downloads and `SHA256SUMS` in the [v0.1.0 release assets](https://github.com/NVIDIA/NemoClaw/releases/tag/v0.1.0).
Install and sign in to the [GitHub CLI](https://cli.github.com/) to verify downloads.
Check `release-evidence.json` for signing, macOS notarization, and unsigned exceptions.

<!-- Keep existing install links reachable when their tabs are closed. -->
<a name="choosing-the-archive"></a>
<a name="choosing-an-installation-method"></a>
<a name="installing-the-bundle"></a>
<a name="installing-with-the-macos-installer"></a>
<a name="installing-with-the-windows-installer"></a>
<a name="installing-on-windows"></a>
<a name="installing-on-linux-or-macos"></a>

## Choosing Your Operating System

Select the tab for your machine.

<Tabs>
<Tab title="macOS" id="macos" language="macos">

<Anchor id="installing-with-the-macos-installer">

On a Mac with Apple silicon and macOS 15 or later, `nemoclaw-v0.1.0-darwin_arm64.pkg` installs the bundle in `/usr/local/nemoclaw`.
The installer requires administrator privileges and adds `/usr/local/nemoclaw/bin` to `PATH` for new Terminal windows.
A final release includes the package only after signing and notarization.

</Anchor>

If the release omits the package or you need to keep multiple versions side by side, <a href="?language=linux#installing-on-linux-or-macos">open the shared archive instructions in the Linux tab</a> and set `PLATFORM=darwin_arm64`.
The archive is tested on macOS 15.
On a Mac with an Intel processor, [build the `darwin_amd64` bundle](../build-deploy/build.md#building-a-native-bundle).

If you already installed a package, follow <a href="?language=macos#upgrading-with-the-macos-installer">the upgrade steps</a> before replacing the bundle.

Run these commands in an empty download directory with `curl` available.
Stop on any download or verification failure.

1. Download the installer.

   ```sh
   TAG=v0.1.0
   PKG="nemoclaw-$TAG-darwin_arm64.pkg"
   RELEASE="https://github.com/NVIDIA/NemoClaw/releases/download/$TAG"
   curl -fLO "$RELEASE/$PKG"
   ```

2. Download the checksums, verify the package, and install it.
   The checksum check prints the package name followed by `OK`.
   The installer runs after the checksum and both build provenance checks pass.
   To use the graphical installer, replace the `sudo installer` line with `open "$PKG"` before running the commands.

   ```sh
   curl -fLO "$RELEASE/SHA256SUMS" &&
     CHECKSUM=$(awk -v package="$PKG" '$2 == package { print; count++ } END { if (count != 1) exit 1 }' SHA256SUMS) &&
     printf '%s\n' "$CHECKSUM" | shasum -a 256 --check &&
     gh attestation verify SHA256SUMS --repo NVIDIA/NemoClaw &&
     gh attestation verify "$PKG" --repo NVIDIA/NemoClaw &&
     sudo installer -pkg "$PKG" -target /
   ```

   If you use the graphical installer, follow its prompts to finish the installation before continuing.

3. Open a new Terminal window to load the updated `PATH` and check which CLI it selects.

   ```sh
   command -v nemoclaw
   nemoclaw --version
   ```

   Expect `/usr/local/nemoclaw/bin/nemoclaw` and the version you installed.
   If another installation takes precedence, put this bundle's `bin` directory first for the current shell and repeat the checks.

   ```sh
   export PATH="/usr/local/nemoclaw/bin:$PATH"
   ```

Continue to [Next Steps](#next-steps).

</Tab>
<Tab title="Windows" id="windows" language="windows">

<Anchor id="installing-with-the-windows-installer">

On x64 Windows, `nemoclaw-v0.1.0-windows_amd64.msi` installs the bundle in `%LOCALAPPDATA%\Programs\NemoClaw` and adds its `bin` directory to your user `Path`.
The installer requires no administrator rights.
Find the installed version under **NVIDIA NemoClaw Agent Configs** in **Settings** > **Apps** > **Installed apps**.

</Anchor>

A release includes the signed installer only if it signs the Windows executables.
If the release omits the installer or you need to keep multiple versions side by side, <a href="?language=windows#installing-on-windows">install the Windows archive</a>.
The MSI and Windows archive install the native x64 NemoClaw CLI.
The matching OpenShell 0.1.10 release has no native Windows CLI archive.
For a first deployment and agent reply on Windows AMD64 or ARM64, [use the Linux tools inside WSL2](prerequisites.md#preparing-windows-with-wsl2).

If you already use the installer, follow <a href="?language=windows#upgrading-with-the-windows-installer">the upgrade steps</a> before replacing the bundle.
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

   Expect the executable under `%LOCALAPPDATA%\Programs\NemoClaw\bin` and the version you installed.
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

<Anchor id="installing-on-windows">

The archive requires `tar.exe`, which ships with Windows 10 version 1803 or later and Windows Server 2019 or later.
Use PowerShell in an empty download directory.
Stop on any download or verification failure.

</Anchor>

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

10. Check that the selected CLI reports the version you installed.

    ```powershell
    nemoclaw --version
    ```

11. To use the CLI in new shells, add the directory in `$Bin` to your user `Path` in **Edit environment variables for your account**.

Continue to [Next Steps](#next-steps).

</Tab>
<Tab title="Linux" id="linux" language="linux">

<Anchor id="installing-on-linux-or-macos">

On Linux, use the `linux_amd64` or `linux_arm64` archive on a client with glibc 2.35 or later.
On macOS, open **Applications > Utilities > Terminal** to run these commands.
If you download the archive in a browser, also download `SHA256SUMS` from the same release, then verify both files in Terminal before extracting.
If the browser automatically extracts archives, keep the original `.tar.gz` for verification and extract that verified archive into the new installation directory in step 8.
Finder can browse the bundle, but double-clicking `bin/nemoclaw` does not start onboarding.
Keep the whole bundle together and run commands in Terminal.
If macOS blocks execution, stop and record the exact warning, archive name, release, and signing evidence; do not remove quarantine or bypass Gatekeeper to qualify a release.

</Anchor>

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

10. Check that the selected CLI reports the version you installed.

    ```sh
    nemoclaw --version
    ```

11. To use the CLI in new shells, add the same `PATH` entry with the full bundle path to your shell startup file, such as `~/.bashrc` or `~/.zshrc`.

Continue to [Next Steps](#next-steps).

</Tab>
</Tabs>

To install from a checkout, follow the [source build guide](../build-deploy/build.md).

### Keeping the Bundle Intact

The bundle includes the CLI, OpenTofu, providers, and schemas.
The CLI locates OpenTofu, providers, and schemas relative to its executable.
Deployment operations verify the bundle against `manifest.json`.
Keep the entire bundle together in `/usr/local/nemoclaw` for the macOS package or `%LOCALAPPDATA%\Programs\NemoClaw` for the Windows installer.
For an archive, keep the `dist/PLATFORM` directory inside your installation directory intact.
Run the CLI from your deployment directory.
The default state directory is `.nemoclaw` in the working directory.

### Next Steps

After you verify the CLI version, [keep the bundle intact](#keeping-the-bundle-intact).

The CLI sends NVIDIA a usage record when `apply` or `destroy` finishes or when `onboard` saves a configuration.
To disable the records, set `NEMOCLAW_DISABLE_TELEMETRY=1` before running those commands.
Refer to [Usage Telemetry](../security/security.md#usage-telemetry).

- [Deploy your first OpenClaw agent](first-deployment.md) with the release bundle, local Docker, and NVIDIA Endpoints.
  On Windows, start with the [WSL2 setup](prerequisites.md#preparing-windows-with-wsl2).
- If you already have an OpenShell gateway and inference endpoint, [use those services](first-deployment.md#using-an-existing-gateway-and-inference-endpoint).
- To configure your own deployment, [write deployment YAML with `nemoclaw onboard`](onboard.md).
- On Apple silicon or WSL2, you can [build and deploy Hermes from source](from-source.md).

Use the [bundle and image digests from the same release](../references/compatibility.md#using-one-release-together) and check [Current Limits](../resources/limits.md#platforms-models-and-placement) for your deployment configuration.

<a name="upgrading-and-uninstalling"></a>

## Upgrading

Existing deployments keep their original bundle, image pins, and state.
Keep the previous bundle for recovery and teardown.
To manage an existing deployment, run its original CLI by absolute path from the deployment directory.
Refer to [deployment state compatibility](../references/compatibility.md#deployment-state).

In the linked installation steps, set `TAG` or `$Tag` to the new release tag when installing the upgrade.
When preserving the installed bundle from its archive, use the tag of the installed release.

For an archive upgrade, the installation steps add the new bundle's `bin` directory to the current shell's `PATH`.

<a name="upgrading-with-the-macos-installer"></a>
<a name="recovering-from-a-failed-macos-installer-upgrade"></a>
<a name="upgrading-with-the-windows-installer"></a>

<Tabs>
<Tab title="macOS" id="upgrade-macos" language="macos">

If you installed from an archive, <a href="?language=linux#installing-on-linux-or-macos">verify and extract the new release's macOS archive</a> into a separate directory.
If you saved the old bundle's `bin` entry in your shell startup file, replace it with the new bundle's `bin` directory and open a new Terminal window.
Run `nemoclaw --version` in a shell with the updated `PATH` to verify the selected release.

<Anchor id="upgrading-with-the-macos-installer">

If you installed with the macOS package, the installer replaces `/usr/local/nemoclaw`.

</Anchor>

It moves `/usr/local/nemoclaw` to `/usr/local/nemoclaw.previous` before installing the new bundle.
After the replacement payload installs successfully, it removes the previous bundle.
If installation fails before that cleanup, it retains the previous bundle for <a href="?language=macos#recovering-from-a-failed-macos-installer-upgrade">recovery</a>.

1. If existing deployments need the current release, <a href="?language=linux#installing-on-linux-or-macos">extract that release's archive</a> into a separate directory so you can run its CLI by absolute path.
2. <a href="?language=macos#installing-with-the-macos-installer">Install the new release's package</a>.
3. Open a new Terminal window and run `nemoclaw --version` to verify the selected release.

<Anchor id="recovering-from-a-failed-macos-installer-upgrade">

If `/usr/local/nemoclaw.previous` remains after an unsuccessful upgrade, restore it before retrying.

</Anchor>

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

</Tab>
<Tab title="Windows" id="upgrade-windows" language="windows">

If you installed from an archive, <a href="?language=windows#installing-on-windows">verify and extract the new release's Windows archive</a> into a separate directory.
If you saved the old bundle's `bin` entry, replace it with the new bundle's `bin` directory in your user `Path` under **Edit environment variables for your account**.
Open a new PowerShell window after changing your saved `Path`.
Run `nemoclaw --version` in a PowerShell session with the updated `Path` to verify the selected release.

<Anchor id="upgrading-with-the-windows-installer">

If you installed with the Windows installer, the new package replaces the installed release and keeps the `Path` entry.

</Anchor>

If the upgrade fails, Windows Installer restores the previous release and its `Path` entry.
An older release's installer doesn't replace a newer one: it reports that a newer version is already installed, so uninstall first to go back.

Before you upgrade, destroy the deployments that the installed release created, or <a href="?language=windows#installing-on-windows">unpack that release's archive</a> so you can run its CLI by path later.
Then <a href="?language=windows#installing-with-the-windows-installer">install the new release's package</a>.
Open a new PowerShell window and run `nemoclaw --version` to verify the selected release.

</Tab>
<Tab title="Linux" id="upgrade-linux" language="linux">

1. <a href="?language=linux#installing-on-linux-or-macos">Verify and extract the new release's Linux archive</a> into a separate directory.
2. If you saved the old bundle's `bin` entry in your shell startup file, replace it with the new bundle's `dist/PLATFORM/bin` directory and open a new shell.
3. Check the path and version in a shell with the updated `PATH`.

   ```sh
   command -v nemoclaw
   nemoclaw --version
   ```

   Expect the path to the new bundle and the version you installed.

</Tab>
</Tabs>

For a new release evaluation, use a fresh `metadata.uid`, state directory, and release-matched images.
Rebuild [derived images](../build-deploy/derived-images.md) from the matching base.

## Uninstalling

Removing the CLI does not delete deployments, deployment YAML, engine images, or OpenShell profiles.
If a deployment or retained resources still depend on this bundle, keep it with the entire state directory.
To retire a deployment first, use the original CLI to [preview teardown and destroy](../build-deploy/usage.md#destroying).
[Retained resources](../build-deploy/usage.md#removing-retained-resources) require separate cleanup before you remove the state directory.

<a name="uninstalling-with-the-macos-installer"></a>
<a name="uninstalling-with-the-windows-installer"></a>

<Tabs>
<Tab title="macOS" id="uninstall-macos" language="macos">

If you installed from an archive, follow these steps to remove it.

1. If you saved the bundle's `bin` entry in your shell startup file, remove that entry.
2. Delete the version's installation directory after you confirm that no deployment or retained resources need it.

<Anchor id="uninstalling-with-the-macos-installer">

If you installed with the macOS package, follow these steps to remove it.

</Anchor>

1. If an upgrade failed, <a href="?language=macos#recovering-from-a-failed-macos-installer-upgrade">restore the previous bundle</a>.
2. If a deployment or retained resource still needs this release, keep its <a href="?language=linux#installing-on-linux-or-macos">matching archive</a>.
3. Remove the CLI, the `PATH` entry, and the package's record.

   ```sh
   sudo rm -rf /usr/local/nemoclaw /etc/paths.d/nemoclaw
   sudo pkgutil --forget com.nvidia.nemoclaw.cli
   ```

After removing the package or archive, open a new Terminal window and run `command -v nemoclaw` to check which installation, if any, remains on `PATH`.

</Tab>
<Tab title="Windows" id="uninstall-windows" language="windows">

If you installed from an archive, follow these steps to remove it.

1. If you saved the bundle's `bin` entry in your user `Path` under **Edit environment variables for your account**, remove that entry.
2. Delete the version's installation directory after you confirm that no deployment or retained resources need it.

<Anchor id="uninstalling-with-the-windows-installer">

If you installed with the Windows installer, follow these steps to remove it.

</Anchor>

If a deployment or retained resource still needs this release, keep its <a href="?language=windows#installing-on-windows">verified archive</a> before uninstalling.
In **Settings** > **Apps** > **Installed apps**, select **Uninstall** for **NVIDIA NemoClaw Agent Configs**.
If you kept the original installer, you can also open PowerShell in its directory.
Set `$Installer` to the installer's filename and run the command.

```powershell
Start-Process msiexec -ArgumentList "/x", $Installer, "/qn" -Wait
```

The package uninstaller removes `%LOCALAPPDATA%\Programs\NemoClaw` and its `Path` entry.
After removing the package or archive, open a new PowerShell window and run `Get-Command nemoclaw` to check for any remaining installation.

</Tab>
<Tab title="Linux" id="uninstall-linux" language="linux">

1. Identify the bundle for the version you want to remove.
   If that version is on `PATH`, use `command -v nemoclaw` to find its `bin` directory.
2. If you saved that bundle's `bin` entry in your shell startup file, such as `~/.bashrc` or `~/.zshrc`, remove that entry.
3. After you confirm that no deployment or retained resources need the bundle, delete the version's installation directory, such as `~/.local/opt/nemoclaw/v0.1.0`.
4. Open a new shell and check for any remaining installation.

   ```sh
   command -v nemoclaw
   ```

   If another bundle is on `PATH`, the command prints its executable path.
   When no installation is on `PATH`, the command exits with a nonzero status.

</Tab>
</Tabs>

NemoClaw keeps its files in these places:

| What | Where | Removed by |
|---|---|---|
| The CLI, OpenTofu, providers, and schemas | The release's directory, `/usr/local/nemoclaw` from the macOS installer, or `%LOCALAPPDATA%\Programs\NemoClaw` from the Windows installer | Deleting the archive's installation directory or using the package uninstall procedure |
| Deployment state, including OpenTofu state and its configuration | Each deployment's state directory: `--state-dir`, by default `.nemoclaw` in the directory you ran `nemoclaw` from; see [deployment state](../build-deploy/state.md#local-deployment-files) | Deleting the directory, after destroy |
| Deployment YAML | Where you saved it; `nemoclaw onboard` writes `deployment.yaml` in the current directory unless `--output` names another file | Deleting the file |
| Sandboxes, gateways, model services, and their data | The deployment's Docker or Podman engine, or Kubernetes cluster; see [retained resources](../build-deploy/state.md#understanding-the-retained-resources) | Destroy, then removing retained resources |
| Agent, gateway, and model runtime images | The engine's image store, or the cluster nodes' | The engine's image commands, such as `docker image rm`; NemoClaw doesn't remove them |

The OpenShell CLI keeps its own gateway profiles. Use OpenShell's commands to remove a profile when you no longer need it.
