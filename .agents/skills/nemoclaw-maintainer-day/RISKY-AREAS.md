<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# NemoClaw Risky Code Areas

PRs touching these areas need tests before approval.

| Area | Key paths |
|------|-----------|
| Installer / bootstrap shell | `install.sh`, `setup.sh`, `brev-setup.sh`, `scripts/*.sh` |
| Onboarding / host glue | `src/lib/onboard.ts`, `bin/nemoclaw.js`, `scripts/*.sh` |
| Sandbox / policy / SSRF | `nemoclaw/src/blueprint/`, `nemoclaw-blueprint/`, policy presets |
| Workflow / enforcement | `.github/workflows/`, prek hooks, DCO, signing, version/tag flows |
| Credentials / inference / network | credential helpers, inference provider routing, approval flows |

Promote a PR in a risky area only when it is actionable.
If risky code does not have sufficient tests, follow the test-gap or security-review workflow.
