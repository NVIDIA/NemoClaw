<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Cron ↔ Smithers workflow map

Answers "are Chad's cron tasks duplicated with the equivalent Smithers workflows?"
Inventory taken 2026-06-22 (`openclaw cron list` on the pod + `launchctl list | grep chad` on the host).

**Short answer: partially, by design — not fully.** Five pod crons have a directcontinue 
Smithers-workflow equivalent and run in *shadow coexistence* (the
`dev.nemoclaw.chad-experiments.plist` comment documents this: "coexistence with a
pod-based shadow cron until parity is proven"). The rest are either infrastructure
(no workflow equivalent and shouldn't have one) or the Smithers-native ops layer
(no pod cron). Two of the duplicated pod crons are currently in `error` state while
their Smithers equivalents are healthy — those are the prime cutover candidates.

## Duplicated — pod cron AND a Smithers workflow (the migration targets)

| Pod cron (openclaw) | Schedule | Smithers workflow | Host timer | Notes |
|---|---|---|---|---|
| `nightly-experiments` | 02:00 UTC | `experiments.jsx` | `chad-experiments` (05/13/21) | Same evolutionary arena. Host runs 3×/day; pod nightly. |
| `self-improve` | Sun 03:00 | `workflows/self-improve.jsx` | via `run-experiments.sh` @05:00 | Same behavioral-improvement loop. |
| `memory-curator` ⚠️`error` | Sat 04:00 | `workflows/memory-curator.jsx` | — | Pod cron erroring; Smithers version validated (smoke-passed 2026-06-22). |
| `issue-triage` | 10:00 | `workflows/issue-triage.jsx` | — | Same GH triage → spawn loop. Smithers version smoke-passed. |
| `chad-skill-watch` | 09:00 | `workflows/skill-improve.jsx` | `chad-skill-watch` | Triple presence (pod cron + host timer + workflow). |
| `email-check` ⚠️`error` | 02,06–23:00 | `workflows/email-ladder.jsx` (scaffold) | — | Ladder is the future autonomy path; pod cron erroring. |

## Not duplicated — pod-only infrastructure (correctly has no workflow)

`gbrain-dream` (03:30), `gbrain-prune` (Sun 02:00), `chad-proposal-apply` (04:30 —
this is the *downstream apply backend* that `self-improve.jsx` hands proposals to,
not a duplicate), `chad-budget-audit` (Mon 04:00 — related to `token-optimize.jsx`
but a different job: watches spend vs proposes downgrades), `workspace-backup`
(*/6h), `spawn-gc` (Mon 02:30).

## Not duplicated — host-only Smithers/ops layer (no pod cron)

`chad-mcphealth` → `mcp-health-probe.jsx` (hourly), `chad-logdigest` →
`log-digest.jsx` (6h), `chad-failreport` → `fail-only-report.jsx` (hourly),
`bug-report.jsx` (via run-experiments @05:00), `token-optimize.jsx` (nightly
shadow), plus pure infra with no workflow: `chad-runs-ui`, `chad-models-refresh`,
`chad-gateway-watchdog`, `chad-tunnel`(+watchdog), `chad-shim-watchdog`,
`chad-inbox-prune`, `chad-spawn-poll`, `chad-webui-ingest`.

## Recommendation

1. **Cut over the 6 duplicated pairs to Smithers** — the workflow versions are
   strictly more observable (durable DB history, the runs dashboard, approval
   gates, token telemetry) than the fire-and-forget pod crons. Migration per pair:
   run the Smithers workflow in shadow ≥1 week alongside the pod cron → confirm
   parity in the dashboard → disable the pod cron (`openclaw cron disable <id>`).
2. **Start with the two erroring pod crons** (`email-check`, `memory-curator`):
   their Smithers equivalents already wake cleanly, so the pod versions are pure
   liability.
3. **Do NOT port the infra crons** (backups, watchdogs, gbrain dream/prune,
   proposal-apply): they're pod/host-specific by nature and have no workflow analog.
4. **De-triplicate skill-watch**: pick one of {pod cron, host timer, `skill-improve.jsx`}.
   Recommend keeping `skill-improve.jsx` (gated, observable) and retiring the pod cron.
