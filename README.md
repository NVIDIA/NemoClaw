<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Native Windows ARM64 preview for PR #10799

[Download the setup EXE](https://media.githubusercontent.com/media/NVIDIA/NemoClaw/8856ce6f0263ca55427924e64605b700a7bed6b5/NemoClawSetup-0.1.0-windows-arm64.exe).

[Download the MSI](https://media.githubusercontent.com/media/NVIDIA/NemoClaw/8856ce6f0263ca55427924e64605b700a7bed6b5/NemoClaw-0.1.0-windows-arm64.msi).

This unsigned test installer was built from source commit `ed71ba30a6192544d48e373b5a73816ce2ab89b5`.
The separately reviewed PR head at publication was `9d79f3b6e7e70e8b5303b76185828810bf9534fa`.
All package and acceptance statements here apply to the built source above.

**Installed acceptance is pending: 0 of 2 required complete native qualification passes.**
Physical hardware acceptance and production support remain unqualified.

The [source run, attempt 1](https://github.com/NVIDIA/NemoClaw/actions/runs/34471812081/attempts/1) passed its early process-audit, authentic Hermes ConPTY,
native ownership, retained installer, package-build, and artifact-upload prerequisites.
Those prerequisites do not establish complete installed-agent acceptance.

This preview includes launch-stage diagnostics and the development-asset audit.
It still uses the prior Hermes payload and session-copy launch path. The canonical
Hermes runtime replacement and immutable-runtime activation are being qualified
separately; this installer does not establish those changes as complete.

The bundled OpenShell source is pinned to NVIDIA/OpenShell#2721 commit
`bcd517bbe08cc80860c9be57699390cd32e8445f`, with the checked-in NemoClaw derivative.

The [receipt](https://raw.githubusercontent.com/NVIDIA/NemoClaw/8856ce6f0263ca55427924e64605b700a7bed6b5/installer-receipt.json) records the source and verified package hashes.
The [package manifest](https://raw.githubusercontent.com/NVIDIA/NemoClaw/8856ce6f0263ca55427924e64605b700a7bed6b5/package-manifest.json) records the payload inventory.
The original [source artifact 10153321775](https://github.com/NVIDIA/NemoClaw/actions/runs/34471812081/artifacts/10153321775) is retained by GitHub Actions.

This artifact branch uses Git LFS. No GitHub Release is published.
