<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Sandbox suites

Sandbox creation, rebuild, snapshot, and survival behavior.

This bucket is new to the scenario-based runner. Three existing rebuild
tests share a hand-rolled "older-base-image" setup that lives in
`lib/fixtures/older-base-image.sh` in the new layout.

## Planned (from UAT/NV QA hotspot analysis)

| Suite | Originating bug class | Migrating from |
|---|---|---|
| `operations/` | TC-SBX-01..11: sandbox ops (status, connect, destroy, multi-sandbox). | `test-sandbox-operations.sh` |
| `survival/` | Sandbox survives gateway restart (UAT #486, #888, #859, #1086). | `test-sandbox-survival.sh` |
| `snapshot/` | Snapshot create/list/restore lifecycle. | `test-snapshot-commands.sh` |
| `rebuild-openclaw/` | OpenClaw upgrade (NVBug 6076156): old image → rebuild → markers survive. | `test-rebuild-openclaw.sh` |
| `rebuild-hermes/` | Hermes upgrade path (older base → rebuild → verify state survived). | `test-rebuild-hermes.sh` |
| `upgrade-stale/` | `upgrade-sandboxes --check` detects stale sandbox (UAT #1904). | `test-upgrade-stale-sandbox.sh` |
| `runtime-overrides/` | Runtime config overrides (model, CORS) via short-lived containers. | `test-runtime-overrides.sh` |
| `rebuild-baseline/` | Rebuild lifecycle proofs (NVBug 6076156): version detection, state preservation. | `test-sandbox-rebuild.sh` |

Coverage gaps explicitly called out by the hotspot analysis:

- **A2 (Ollama) has zero sandbox-lifecycle coverage.** Ollama users hitting
  rebuild/survival/token-rotation have no regression net today.
- **Policy preservation during rebuild is untested.** UAT #1952 (Telegram
  policy lost on rebuild) + UAT #2010 (telegram policy apparently applied
  but gateway blocks it) remain live blind spots.
