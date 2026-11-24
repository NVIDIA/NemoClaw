<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Windows Installer Resources

This directory holds the source of `nemoclaw-<tag>-windows_amd64.msi`, the per-user Windows Installer package of the `windows_amd64` bundle.
Users install it as [installing with the Windows installer](../../../docs/get-started/install.md#installing-with-the-windows-installer) describes, and staging builds and signs it as [the Windows installer](../../../internal-docs/contributing/releases.md#windows-installer) describes.

| File | Purpose |
|---|---|
| [`NemoClaw.wxs`](NemoClaw.wxs) | The package, in WiX Toolset v5's declarative source |
| [`artwork`](artwork) | The SVG sources of the banner, dialog image, and icon, and the BMP and ICO files rendered from them |
| [`../windows-installer.rs`](../windows-installer.rs) | Computes the package version, writes the license page, and runs WiX |
| [`e2e.rs`](e2e.rs) | Installs, upgrades, downgrades, and uninstalls a package, and checks each result |

## What the Package Does

- It installs for the current user only, so Windows asks for no administrator rights. NemoClaw needs none on Windows: it writes no machine-wide settings, and its gateway and forwards listen on `127.0.0.1`.
- It installs the bundle unchanged into `%LOCALAPPDATA%\Programs\NemoClaw`. The CLI finds its bundle from `bin\nemoclaw.exe`'s location and checks every file against `manifest.json`.
- It adds `%LOCALAPPDATA%\Programs\NemoClaw\bin` to the end of the user `Path`, and removes that entry when uninstalled.
- It lists **NVIDIA NemoClaw Agent Configs** with its version in **Settings** > **Apps** > **Installed apps**, with NVIDIA Corporation as the publisher, the icon, and links to the installation guide, issues, and releases.
- Its fixed UpgradeCode makes each package replace the installed one. The package removes the installed version before it installs, so no file that only the old bundle had remains. If the upgrade fails, Windows Installer restores the previous installation. Packages with the same Windows Installer version, such as two CI builds after one release candidate, also replace each other.
- A package older than the installed one stops with a message that a newer version is already installed.
- Its pages are WiX's minimal set: the welcome page with the license, then progress, then a finish page with the next steps. The license page holds the bundle's `LICENSE` and each notice in its `licenses` directory, which `windows-installer.rs` converts to RTF.

After building, the helper validates the package with `wix msi validate`, which runs Windows Installer's ICE validators.
Every component installs under the user's profile, so it skips ICE38, ICE64, and ICE91.
They expect registry key paths and `RemoveFolder` rows that a roaming profile needs; `%LOCALAPPDATA%` doesn't roam, and `E2E installer` checks that uninstalling leaves no directory.

## Building the Package

On Windows, with the [.NET SDK](https://dotnet.microsoft.com/download) 8 or later and a `windows_amd64` bundle in `dist\windows_amd64`, such as from `cargo ci bundle`, install WiX Toolset v5 and its UI extension, then build the package from the repository root:

```powershell
dotnet tool install --global wix --version 5.0.2
wix extension add --global WixToolset.UI.wixext/5.0.2
rustc --edition=2021 tools/release/windows-installer.rs -o windows-installer.exe
.\windows-installer.exe build --bundle dist\windows_amd64 --output nemoclaw.msi
```

The helper reads the version from the bundle's `manifest.json`; `--version` overrides it, and `--compression` sets the cabinet compression, `high` by default.
`windows-installer.exe version VERSION` prints the Windows Installer version for a bundle version.
The helper reads the bundle and never runs it, so the release job can build from a signed bundle with signing access.

## Testing the Package

When CI / Bundle builds the Windows bundle, `E2E installer` builds a package from it and an older one, `0.0.1`, whose bundle has an extra file.
On the runner, it installs the older package, then attempts an upgrade with a test-only copy of the current package that fails after `InstallFiles`.
It checks that rollback restores the previous registered product, executable bytes, extra file, and user `Path` entry.
The test leaves the original current package and its signature unchanged.
It then installs the current package successfully and checks that the extra file is gone.
From a new `cmd.exe` with the `Path` that a new terminal reads from the registry, it runs `nemoclaw --version` and `nemoclaw plan --destroy`, which verifies the bundle before it reports that the empty directory has no deployment state.
It then checks that the older package refuses to replace the current one, uninstalls, and checks that the directory, the `Path` entry, and the product are gone.

The check changes the machine it runs on.
Run `e2e.rs` only on a disposable Windows machine without NemoClaw installed; its usage is in the file.

## Artwork

The artwork is a placeholder, pending NVIDIA brand and trademark review.
It uses NVIDIA green, `#76B900`, on black, and no NVIDIA logo.

| File | Size | Where it appears |
|---|---|---|
| `banner.bmp` | 493 × 58 | The top of the progress page; WiX draws the title on its white left part |
| `dialog.bmp` | 493 × 312 | The welcome and finish pages; WiX draws their text right of the black panel |
| `nemoclaw.ico` | 16, 24, 32, 48, and 256 pixels | **Settings** > **Apps** |

Edit the SVG files, then render them with librsvg and ImageMagick, in the Alpine image that rendered the committed files, from the repository root:

```sh
docker run --rm -v "$PWD/tools/release/windows-installer/artwork:/art" -w /art \
  alpine@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6 sh -euc '
  apk add --no-cache rsvg-convert imagemagick
  render() {
    rsvg-convert -w "$2" -h "$3" "$1.svg" -o "/tmp/$1.png"
    magick "/tmp/$1.png" -background white -alpha remove -type TrueColor "BMP3:$1.bmp"
  }
  render banner 493 58
  render dialog 493 312
  for size in 16 24 32 48 256; do rsvg-convert -w $size -h $size icon.svg -o /tmp/icon-$size.png; done
  magick /tmp/icon-16.png /tmp/icon-24.png /tmp/icon-32.png /tmp/icon-48.png /tmp/icon-256.png nemoclaw.ico
  chown "$(stat -c %u:%g icon.svg)" banner.bmp dialog.bmp nemoclaw.ico'
```

The committed files came from Alpine 3.24.2, librsvg 2.62.3, and ImageMagick 7.1.2-35.
Windows Installer needs 24-bit BMP files at exactly these sizes.
Artwork from a designer can replace the BMP and ICO files directly; commit its source beside them.
