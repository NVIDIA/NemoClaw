<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Native Windows ARM64 preview for PR #10799

[Download the setup EXE](https://media.githubusercontent.com/media/NVIDIA/NemoClaw/db3963c6e31308ff40dfa9994c56f1213dc41b6f/NemoClawSetup-0.1.0-windows-arm64.exe).

[Download the MSI](https://media.githubusercontent.com/media/NVIDIA/NemoClaw/db3963c6e31308ff40dfa9994c56f1213dc41b6f/NemoClaw-0.1.0-windows-arm64.msi).

This unsigned test installer was built from source commit `c140fe10519b728a63af8180e51d54671750f99a`.

**Installed acceptance failed: 0 of 2 required complete native qualification passes.**
Credential and optional-service controls passed. Qualification then stopped at
the installed CLI version preflight. Separately, live Hermes testing found a
contained-to-host broker timeout in the unchanged runtime networking path.
This preview is not qualified for complete agent startup; repairs are underway.
Physical N1X acceptance and production support remain unqualified.

The [source run, attempt 1](https://github.com/NVIDIA/NemoClaw/actions/runs/34380426001/attempts/1) passed its early process-audit, authentic Hermes ConPTY,
native ownership, retained installer, package-build, and artifact-upload prerequisites.
Those prerequisites do not establish complete installed-agent acceptance.

The bundled OpenShell source is pinned to NVIDIA/OpenShell#2721 commit
`bcd517bbe08cc80860c9be57699390cd32e8445f`, with the checked-in NemoClaw derivative.

The [receipt](installer-receipt.json) records the source and verified package hashes.
The [package manifest](https://raw.githubusercontent.com/NVIDIA/NemoClaw/db3963c6e31308ff40dfa9994c56f1213dc41b6f/package-manifest.json) records the payload inventory.
The original [source artifact 10117395635](https://github.com/NVIDIA/NemoClaw/actions/runs/34380426001/artifacts/10117395635) is retained by GitHub Actions.

This artifact branch uses Git LFS. No GitHub Release is published.
