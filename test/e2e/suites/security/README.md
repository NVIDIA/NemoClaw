<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Security suites

Shields, policy presets, credential handling, and secret-sanitization.

Shields/Policy/Security is the #6 UAT/NV QA hotspot (15 fix PRs). The
surface has three layers (sandbox base policy, presets, user overrides) and
two enforcement points (gateway L7 proxy, OpenShell landlock); mismatches
surface as 403/denied/undefined-behavior and are hard to attribute.

## Current

| Suite | Scenario | Covers |
|---|---|---|
| `credentials/` | `ubuntu-repo-cloud-openclaw` | Asserts `$NVIDIA_API_KEY` is present and not leaked into the sandbox. |

## Planned (from UAT/NV QA hotspot analysis)

| Suite | Originating bug class | Migrating from |
|---|---|---|
| `credential-sanitization/` | Credentials stripped from migration bundles + blueprint digest checks. | `test-credential-sanitization.sh` (currently unwired — 805 LOC, prime re-wire candidate) |
| `shields/` | Shields down/up lifecycle + config get/set/rotate-token (UAT #3114). | `test-shields-config.sh` |
| `rebuild-preserves-presets/` | Rebuild drops policy presets (UAT #1952, #2010). | **NEW** — explicit coverage for the §5.1 cross-cutting blind spot |
| `shields-hermes/` | Hermes shields down fails (UAT #3168). | **NEW** — Hermes × shields crossover currently untested |
| `skip-permissions/` | `--dangerously-skip-permissions` activates permissive policy (not Pending). | `test-skip-permissions-policy.sh` |

Coverage gap explicitly called out by the hotspot analysis (§5.1): the
Onboarding × Sandbox × Policy triple has no E2E test today. Adding
`rebuild-preserves-presets/` is the single highest-value net here.
