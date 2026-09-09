<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Native Windows ARM64 preview for PR #10799

[Download the setup EXE](https://media.githubusercontent.com/media/NVIDIA/NemoClaw/refs/heads/artifacts/windows-native-pr-10799/NemoClawSetup-0.1.0-windows-arm64.exe).

[Download the MSI](https://media.githubusercontent.com/media/NVIDIA/NemoClaw/refs/heads/artifacts/windows-native-pr-10799/NemoClaw-0.1.0-windows-arm64.msi).

This unsigned test installer was built from source commit `1cb0dfbc0f4ca58ccb08b9433a8e8ab2a79cfecb`.

**Installed acceptance is pending: 0 of 2 required complete native qualification passes.**
Physical N1X acceptance and production support remain unqualified.

The [source run, attempt 1](https://github.com/NVIDIA/NemoClaw/actions/runs/34358022355/attempts/1) passed its early process-audit, authentic Hermes ConPTY,
native ownership, retained installer, package-build, and artifact-upload prerequisites.
Those prerequisites do not establish complete installed-agent acceptance.

The bundled OpenShell source is pinned to NVIDIA/OpenShell#2721 commit
`bcd517bbe08cc80860c9be57699390cd32e8445f`, with the checked-in NemoClaw derivative.

The [receipt](https://raw.githubusercontent.com/NVIDIA/NemoClaw/refs/heads/artifacts/windows-native-pr-10799/installer-receipt.json) records the source and verified package hashes.
The [package manifest](https://raw.githubusercontent.com/NVIDIA/NemoClaw/refs/heads/artifacts/windows-native-pr-10799/package-manifest.json) records the payload inventory.
The original [source artifact 10108686147](https://github.com/NVIDIA/NemoClaw/actions/runs/34358022355/artifacts/10108686147) is retained by GitHub Actions.

This artifact branch uses Git LFS. No GitHub Release is published.
