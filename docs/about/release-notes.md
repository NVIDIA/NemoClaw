<!--
  SPDX-FileCopyrightText: Copyright (c) 2025-2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# Release Notes

## 0.1.0 Unreleased

Initial release of NemoClaw.

### Features

- `openclaw nemoclaw launch`. Fresh install of OpenClaw inside an OpenShell sandbox.
- `openclaw nemoclaw migrate`. Migrate an existing host OpenClaw installation into a sandbox with automatic snapshot creation.
- `openclaw nemoclaw connect`. Interactive shell into the running sandbox.
- `openclaw nemoclaw status`. Show sandbox health, blueprint run state, and inference configuration.
- `openclaw nemoclaw logs`. Stream blueprint execution and sandbox logs.
- `openclaw nemoclaw eject`. Roll back from sandbox to the host installation using a snapshot.
- `/nemoclaw` slash command for in-chat status and eject.
- Blueprint system with version resolution, digest verification, and profile support.
- Three inference profiles: NVIDIA cloud with Nemotron 3 Super 120B, local NIM, and vLLM.
- Strict baseline network and filesystem policy defined in `openclaw-sandbox.yaml`.
- Brev deployment support through `nemoclaw deploy`.
