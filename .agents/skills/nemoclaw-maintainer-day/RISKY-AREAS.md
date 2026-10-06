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

## Contributor PR sensitive paths

The contributor PR workflow uses only the patterns below to decide whether the pull request
template's sensitive-path `Review notes` requirement applies. Match repository-relative paths.
An exact file matches only that file; a path ending in `/**` matches every file below that directory.
A valid pattern is a nonempty exact path or a nonempty directory path followed by `/**`. Reject
absolute paths, `.` or `..` segments, backslashes, and every other glob metacharacter.

- Repository workflow: `AGENTS.md`, `.agents/**`, `.dsh/**`, `.github/**`,
  `.pre-commit-config.yaml`, and `commitlint.config.js`.
- Installer and runtime: `install.sh`, `setup.sh`, `brev-setup.sh`, `uninstall.sh`, `bin/**`,
  `scripts/**`, `agents/**`, `managed-inference/**`, and `tools/mcp-tool-discovery-runtime/**`.
- Sandbox and policy: `nemoclaw-blueprint/**`, `nemoclaw/src/blueprint/**`,
  `nemoclaw/src/onboard/**`, `nemoclaw/src/security/**`, `nemoclaw/src/shared/**`,
  `src/commands/sandbox/**`, `src/commands/internal/dns/**`, `src/lib/policy/**`,
  `src/lib/proxy/**`, `src/lib/sandbox/**`, `src/lib/sandbox-base-image/**`,
  `src/lib/security/**`, `src/lib/private-networks.ts`, `schemas/network-policy.schema.json`,
  `schemas/policy-preset.schema.json`, and `schemas/sandbox-policy.schema.json`.
- Credentials, inference, and network: `src/commands/credentials.ts`,
  `src/commands/credentials/**`, `src/commands/inference.ts`, `src/commands/inference/**`,
  `src/lib/credentials/**`, `src/lib/inference/**`, `src/lib/messaging/**`, `src/lib/onboard.ts`,
  `src/lib/onboard/**`, `src/lib/tunnel/**`, and `src/lib/voice-gateway/**`.
- Enforcement tooling: `tools/e2e/**`, `tools/lint/**`, and `tools/pr-review-advisor/**`.

Promote a PR in a risky area only when it is actionable.
If risky code does not have sufficient tests, follow the test-gap or security-review workflow.
