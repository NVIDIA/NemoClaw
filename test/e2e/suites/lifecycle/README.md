<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Lifecycle suites

Post-onboard CLI lifecycle: `list`, `status`, `destroy`, `stop`, `connect`,
and their reconciliation between registry / OpenShell / gateway state.

This bucket is new. The CLI Entry + Gateway/Runtime hotspots (17 + 11 fix
PRs) concentrate bugs where registry state, live OpenShell state, and
gateway state drift out of sync during abnormal shutdown paths. Existing
`test-sandbox-operations.sh` covers the happy path only.

## Planned (from UAT/NV QA hotspot analysis)

| Suite | Originating bug class |
|---|---|
| `multi-sandbox-destroy/` | `nemoclaw destroy` kills shared dashboard port forward even when another sandbox is running (UAT #1690). |
| `stop-command-parity/` | `nemoclaw stop` only manages host cloudflared, leaves messaging bridges running inside sandbox (UAT #1825, #2103). |
| `ghost-reconciliation/` | `list` shows ghost sandboxes after gateway restart / reboot (UAT #1316). |
| `abnormal-shutdown-recovery/` | Kill gateway mid-operation; verify next command reconciles (UAT #1160, #2103 class). |

All lifecycle suites require `gateway.health: healthy` and a reachable
registry. Most can reuse the `ubuntu-repo-cloud-openclaw` expected state.
