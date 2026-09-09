<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Native Windows ARM64 installer for PR #10799

[Download the setup EXE](https://media.githubusercontent.com/media/NVIDIA/NemoClaw/refs/heads/artifacts/windows-native-pr-10799/NemoClawSetup-0.1.0-windows-arm64.exe).

This unsigned preview comes from earlier qualified commit `0fd3b6ee4f9bdcbc1fc5a0f0d97b10719e6f95c0`.
It is a test installer, not a production release or the current PR build.

This build contains js-yaml 4.3.1, affected by high-severity [GHSA-2883-xcg3-v3hh](https://github.com/advisories/GHSA-2883-xcg3-v3hh).
The PR update to js-yaml 4.3.2 is pending qualification.

[Qualification attempt 2](https://github.com/NVIDIA/NemoClaw/actions/runs/33996120228/attempts/2) and [attempt 3](https://github.com/NVIDIA/NemoClaw/actions/runs/33996120228/attempts/3) passed.
They cover ARM64 installation, repair, reinstall, uninstall, five packaged agent paths, MXC ProcessContainer cleanup, and no prohibited package descendants.
CI used deterministic local inference. Live-provider and production support remain unqualified.
The bundled OpenShell source is pinned to NVIDIA/OpenShell#2721 merge commit `bcd517bbe08cc80860c9be57699390cd32e8445f`.

The [receipt](installer-receipt.json) records source identity and independently verified file hashes.
The full manifest remains available in [source artifact 9980422936](https://github.com/NVIDIA/NemoClaw/actions/runs/33996120228/artifacts/9980422936).
