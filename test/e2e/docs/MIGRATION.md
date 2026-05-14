<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# E2E Migration Tracker

This PR migrates all existing `test/e2e/test-*.sh` scripts into the
scenario-based runner introduced by PR #3363. Full deep migration
(Strategy B). Legacy scripts remain in the repo during this PR and run
in parallel for 1–2 nightly cycles after merge; a follow-up PR retires
them once parity is verified.

**Merge gate:** All 40 legacy entry points must have a scenario-based
equivalent that produces the same PASS/FAIL outcomes as the legacy
script in a side-by-side CI run.

## Reuse being absorbed

Migrating 40 scripts collapses 13 distinct categories of duplication.
Each row maps to a Wave 0 item or an existing helper.

| # | Category | Fan-in (legacy) | Target absorber | LOC |
|---|---|---|---|---:|
| 1 | Logging helpers (`section` / `info` / `pass` / `fail`) | 28–39 scripts redefine each | `runtime/lib/logging.sh` (Wave 0.B.5) | 1,556 |
| 2 | Non-interactive env exports | 187 inlined lines across 40 scripts | `runtime/lib/env.sh::e2e_env_apply_noninteractive` + convention 0.G.1 | 175 |
| 3 | Repo-root / `SCRIPT_DIR` discovery | 37 lines, 4 competing patterns | One convention (Wave 0.G.2) | 25 |
| 4 | `nemoclaw list` / `status` / gateway state probes | 142 inlined sites | `validation_suites/assert/{gateway,sandbox}-alive.sh` | 500 |
| 5 | `bash install.sh ...` invocations | 24 scripts | `nemoclaw_scenarios/install/dispatch.sh` dispatcher (Wave 0.C.1) | 300 |
| 6 | `nemoclaw onboard ...` variants | 42 invocations, 8+ flag incantations | `nemoclaw_scenarios/onboard/dispatch.sh` + profile handlers | 800 |
| 7 | Docker older-base-image pattern | 3 hand-rolled implementations | `nemoclaw_scenarios/fixtures/older-base-image.sh` (Wave 0.A.1) | 250 |
| 8 | Trap / cleanup / teardown blocks | 112 lines, ~15 patterns | `runtime/lib/cleanup.sh` + convention 0.G.3 | 400 |
| 9 | Fake-endpoint inline setups | 3 inline variants | `nemoclaw_scenarios/fixtures/fake-{openai,telegram,discord,slack}.sh` (Wave 0.A.2–5) | 150 |
| 10 | Sandbox-scoped exec (`nemoclaw shell <sb> -- ...`) | 15 scripts reimplement with drift | `validation_suites/sandbox-exec.sh` (Wave 0.A.6) | 200 |
| 11 | Hermes/OpenClaw pair-variant scripts | 7 paired scripts share ~70% | Shared suite steps; scenario agent via `expected_state.sandbox.agent` | 800 |
| 12 | `section "Phase N: X"` markers | Every script inflates logs with phase text | Step-script filename carries the name (convention 0.G.4) | 300 |
| 13 | Log-capture paths (`/tmp/*.log`) | 25 different conventions; CI artifact upload assumes one | `$E2E_CONTEXT_DIR/logs/` convention 0.G.5 | 300 |
| **Total** | | | | **~5,556** |

About **25% LOC reduction** net after legacy retirement. The larger win
is drift reduction: when `--yes-i-accept-third-party-software` renames
again, it's a 1-file change instead of a 24-file change.

## Status summary

| Bucket | Legacy LOC | Status |
|---|---:|---|
| Wave 0 — fixtures, asserts, setup splits, conventions, parity workflow | — | ⬜ not started |
| Wave 1 — onboarding baseline | 1,101 | ⬜ |
| Wave 2 — onboarding lifecycle | 2,013 | ⬜ |
| Wave 3 — sandbox lifecycle | 2,891 | ⬜ |
| Wave 4 — rebuild / upgrade | 1,292 | ⬜ |
| Wave 5 — inference variants | 2,593 | ⬜ |
| Wave 6 — Hermes | 1,646 | ⬜ |
| Wave 7 — messaging | 3,397 | ⬜ |
| Wave 8 — security / policy | 2,241 | ⬜ |
| Wave 9 — runtime / platform services | 1,696 | ⬜ |
| Wave 10 — platform + remote | 1,589 | ⬜ |
| Wave 11 — misc | 405 | ⬜ |
| **Total** | **20,864** | **0 / 40 scripts migrated** |

## Per-script tracker

Legend: ⬜ not started · 🟨 in progress · ✅ migrated · 🔵 parity verified

### Wave 1 — onboarding baseline

- ⬜ `test-full-e2e.sh` (473) → `onboarding/happy-path/` + scenario `ubuntu-curl-cloud-openclaw`
- ⬜ `test-cloud-onboard-e2e.sh` (337) → `onboarding/public-installer/`
- ⬜ `test-cloud-inference-e2e.sh` (291) → extends `inference/cloud/`

### Wave 2 — onboarding lifecycle

- ⬜ `test-double-onboard.sh` (717) → `onboarding/double-onboard/`
- ⬜ `test-gpu-double-onboard.sh` (571) → `onboarding/double-onboard/` on GPU scenario
- ⬜ `test-onboard-repair.sh` (372) → `onboarding/repair/`
- ⬜ `test-onboard-resume.sh` (353) → `onboarding/resume/`

### Wave 3 — sandbox lifecycle

- ⬜ `test-sandbox-operations.sh` (828) → `sandbox/operations/`
- ⬜ `test-sandbox-survival.sh` (721) → `sandbox/survival/`
- ⬜ `test-snapshot-commands.sh` (281) → `sandbox/snapshot/`
- ⬜ `test-diagnostics.sh` (452) → `sandbox/diagnostics/`
- ⬜ `test-issue-2478-crash-loop-recovery.sh` (609) → `sandbox/crash-loop-recovery/`

### Wave 4 — rebuild / upgrade

- ⬜ `test-rebuild-openclaw.sh` (453) → `sandbox/rebuild-openclaw/` (uses `nemoclaw_scenarios/fixtures/older-base-image.sh`)
- ⬜ `test-rebuild-hermes.sh` (401) → `sandbox/rebuild-hermes/`
- ⬜ `test-upgrade-stale-sandbox.sh` (241) → `sandbox/upgrade-stale/`
- ⬜ `test-sandbox-rebuild.sh` (197) → folded into `sandbox/rebuild-openclaw/`

### Wave 5 — inference variants

- ⬜ `test-gpu-e2e.sh` (565) → `inference/ollama-gpu/` (deep port)
- ⬜ `test-ollama-auth-proxy-e2e.sh` (548) → `inference/ollama-auth-proxy/` (deep port)
- ⬜ `test-inference-routing.sh` (715) → `inference/routing-errors/`
- ⬜ `test-kimi-inference-compat.sh` (765) → `inference/kimi-compat/`

### Wave 6 — Hermes

- ⬜ `test-hermes-e2e.sh` (591) → `onboarding/hermes/` (deep port; currently 1-step health)
- ⬜ `test-hermes-slack-e2e.sh` (537) → `messaging/slack/hermes/`
- ⬜ `test-hermes-discord-e2e.sh` (518) → `messaging/discord/hermes/`

### Wave 7 — messaging

- ⬜ `test-messaging-providers.sh` (1,677) → `messaging/providers/{telegram,discord,slack}/`
- ⬜ `test-token-rotation.sh` (575) → `messaging/token-rotation/`
- ⬜ `test-telegram-injection.sh` (475) → `security/telegram-injection/`
- ⬜ `test-messaging-compatible-endpoint.sh` (670) → `messaging/compatible-endpoint/`

### Wave 8 — security / policy

- ⬜ `test-shields-config.sh` (550) → `security/shields/`
- ⬜ `test-network-policy.sh` (579) → `security/network-policy/`
- ⬜ `test-credential-sanitization.sh` (810) → `security/credentials/sanitization/`
- ⬜ `test-credential-migration.sh` (302) → `security/credentials/migration/`

### Wave 9 — runtime / platform services

- ⬜ `test-runtime-overrides.sh` (272) → `sandbox/runtime-overrides/`
- ⬜ `test-overlayfs-autofix.sh` (537) → `sandbox/overlayfs-autofix/`
- ⬜ `test-device-auth-health.sh` (373) → `lifecycle/device-auth-health/`
- ⬜ `test-deployment-services.sh` (514) → `lifecycle/deployment-services/`

### Wave 10 — platform + remote

- ⬜ `test-spark-install.sh` (157) → `platform/spark/`
- ⬜ `test-launchable-smoke.sh` (589) → `platform/launchable/`
- ⬜ `brev-e2e.test.ts` (843) → `platform/brev-remote/`

### Wave 11 — misc

- ⬜ `test-skill-agent-e2e.sh` (244) → `onboarding/skill-agent/`
- ⬜ `test-docs-validation.sh` (161) → `lifecycle/docs-validation/`

## Parallel verification

Before merge, `.github/workflows/e2e-parity-compare.yaml` (Wave 0.F.1)
will run each migrated scenario next to its legacy counterpart and diff
PASS/FAIL per assertion via `test/e2e/docs/parity-map.yaml` +
`scripts/e2e/compare-parity.sh`.

Merge gate: **zero divergence**. Documented flaky assertions are
compared as "both-pass-or-both-fail" rather than strict equality.

Internal plan document (not committed): `specs/2026-05-08_e2e-setup-scenario-matrix/migration-plan.md`.
