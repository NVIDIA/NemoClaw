<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Runs UI → Smithers Gateway migration plan

Plan for two additive upgrades to the runs dashboard (`serve-runs.js` +
`public/index.html`), identified in the 2026-07-08 ecosystem review:

- **Upgrade A — Live sync.** Replace SQLite polling for the *open run* with the
  official `@smithers-orchestrator/gateway-client` (WS/RPC + ElectricSQL sync),
  so run detail / events / node output update in real time instead of every
  2.5 s.
- **Upgrade B — Drop-in components.** Replace our hand-rolled core-run panels
  with `@smithers-orchestrator/gateway-ui` (`RunList`, `RunTree`, `RunEventLog`,
  `ApprovalPanel`, `StatusPill`, `NodeOutputView`, `LaunchButton`,
  `ConnectionBadge`) so we track upstream schema changes instead of drifting.

Both ship **behind a flag** (`CHAD_RUNS_GATEWAY=1`); the current polling UI stays
the default until each phase's exit criteria pass.

## Reality check (constraints that shape the design)

1. **Lists still poll — even upstream.** `gateway-ui`'s own README: "list-shaped
   RPCs (runs, approvals) are pull-only on the local gateway path, so those
   components poll via `pollMs` (default 2000)." So Upgrade A's win is **live run
   detail / events / node output**, NOT eliminating list polling. Set
   expectations accordingly.
2. **We are multi-DB; the gateway is single-DB.** `serve-runs.js:173` scans every
   `*.db` in `DB_DIR` and tags each run with `db: basename(path)`. `smithers
   gateway` serves ONE workspace DB. So live sync means **one gateway per DB** —
   spun up on demand for the DB of the *selected* run (reusing the existing
   `smithers.db`-symlink-in-tempdir trick at `serve-runs.js:184-190`).
3. **Most of our surface has no gateway equivalent.** ~40 endpoints; the gateway
   covers only runs / events / approvals / crons / scores / node-output /
   actions. Chad-specific tabs — **experiments (Pareto), chains, directives,
   schedules, model-matrix / efficiency, notifications, chat, trace, diff,
   launch-with-preflight** — MUST stay on our custom API. This is a **hybrid**,
   not a replacement.
4. **Zero-build today → React + Bun build for Upgrade B.** `public/index.html` is
   a single static file, vanilla JS, no bundler. `gateway-ui` components are TSX
   over `gateway-react` hooks and expect `Bun.build`. Upgrade B introduces a
   build step + a React island; Upgrade A does not (client is usable from vanilla
   JS via `SmithersGatewayClient`).

## Target architecture (hybrid)

```
public/index.html (shell, Chad-specific tabs: experiments/chains/directives/…)
  ├─ default:  our JSON API (serve-runs.js)  ← polling  [unchanged]
  └─ CHAD_RUNS_GATEWAY=1:
       Runs tab  → gateway-react island (RunList + RunTree + RunEventLog +
                    ApprovalPanel), fed by SmithersGatewayProvider
       gateway   → one `smithers gateway` per selected run's DB (on demand),
                    proxied by serve-runs at /gw/:db/*  (auth reuses ?key=)
       fallback  → if the gateway can't start, fall back to the polling path
```

serve-runs.js gains a thin **gateway supervisor**: start/stop `smithers gateway`
processes keyed by DB, health-check them, and reverse-proxy WS+RPC under
`/gw/:db/`. Everything else in serve-runs is untouched.

---

## Phase 0 — Spike & decision gate (no production change)

- [ ] P0.1 Add `@smithers-orchestrator/{gateway-client,gateway-react,gateway-ui}`
      to a throwaway `spike/` (pin to the same `smithers-orchestrator` version we
      run: check `node_modules/.bin/smithers --version`).
- [ ] P0.2 Manually start `smithers gateway` against one real DB
      (e.g. `experiments.db` via the symlink trick). Record: exact CLI flags,
      bound port, WS URL, auth model, boot config shape (`GatewayUiBootConfig`).
- [ ] P0.3 Drive `SmithersGatewayClient` from a Node script: subscribe to a run's
      events, confirm live push works and matches the rows serve-runs returns for
      the same run. Capture latency vs our 2.5 s poll.
- [ ] P0.4 **Decision gate.** Confirm: (a) gateway starts headless under launchd
      env (no TTY, `CHAD_DISABLE_CLI_AGENTS` context), (b) one-gateway-per-DB is
      acceptable (count active DBs, memory per gateway), (c) the client bundles
      into a browser island. If any fail, stop and re-scope (e.g. client-only in
      Node, push over our existing SSE instead). Write findings to this file.

## Phase 1 — Upgrade A: live run detail behind a flag

- [ ] A.1 `lib/gateway-supervisor.js` — start/stop/health `smithers gateway` per
      DB, keyed by db basename; reuse the tempdir+`smithers.db` symlink; idle-GC
      gateways after N minutes. **Pure logic (port alloc, key map, idle reaping)
      split out for unit tests.**
- [ ] A.2 serve-runs: reverse-proxy `/gw/:db/*` (HTTP + WS upgrade) to the
      supervised gateway; gate behind `CHAD_RUNS_GATEWAY`; `?key=` auth passes
      through.
- [ ] A.3 `lib/gateway-adapter.js` — map gateway run/event/node shapes ↔ the
      shapes `index.html` already renders (so the detail pane is source-agnostic).
      **Pure function; the main unit-test target.**
- [ ] A.4 index.html: when the flag is on and a run is selected, open a
      `SmithersGatewayConnection` to `/gw/:db/` for that run's events instead of
      the 2.5 s `loadDetail` interval. Keep list polling. `ConnectionBadge`-style
      indicator (live vs polling vs reconnecting).
- [ ] A.5 Fallback: gateway start failure or WS drop → revert that run to the
      polling path, no user-visible break.
- [ ] A.6 Exit criteria: open run updates within <500 ms of a frame commit;
      cancel/resume/fork still work; flag OFF path byte-identical to today.

## Phase 2 — Upgrade B: gateway-ui core components behind a flag

- [ ] B.1 Add a Bun build for a small React island (`public/gateway-island/`):
      `SmithersGatewayProvider` + `SimpleWorkflowDashboard` (or the à-la-carte
      `RunList`/`RunTree`/`RunEventLog`/`ApprovalPanel`). Emit a hashed bundle;
      serve-runs serves it; `index.html` mounts it into the Runs tab when the flag
      is on.
- [ ] B.2 Theme parity: map `gateway-ui` `var(--token, …)` theme tokens
      (`theme.ts`) to our GitHub-dark palette so the island matches the shell.
- [ ] B.3 Keep Chad-specific tabs (experiments/chains/directives/schedules/
      model-matrix/notifications) on the existing vanilla code — the island only
      owns the core Runs view.
- [ ] B.4 Mobile: the island must satisfy the same responsive contract we just
      shipped (no horizontal overflow at 360/390; the hamburger nav wraps it).
      gateway-ui is desktop-first — verify or add wrapper CSS.
- [ ] B.5 Approvals: route `ApprovalPanel` actions through the gateway
      (`useGatewayApprovals`) while our Moshi notification hook stays on our API.
- [ ] B.6 Exit criteria: feature-parity checklist vs the hand-rolled panels
      (tokens, tasks, event log, approvals, fork/resume/cancel, chat/graph links
      preserved via our tabs), all green on desktop + mobile.

## Phase 3 — Cleanup & flip

- [ ] C.1 Run both paths in shadow ≥1 week (flag off default, opt-in on).
- [ ] C.2 Flip `CHAD_RUNS_GATEWAY=1` default in the plist once parity holds; keep
      the polling path one release as fallback.
- [ ] C.3 Delete superseded hand-rolled detail/event rendering only after the flip
      sticks. Keep the multi-DB list + all Chad-specific endpoints.

---

## Test plan (first-class, not an afterthought)

Convention: colocated `lib/*.test.js` via `node:test` (`node --test <file>`),
documented in `README.md`. Browser behavior via the `browse` tool against
`http://127.0.0.1:7331/?key=$SMITHERS_RUNS_API_KEY`.

**Unit (`node --test`):**
- [ ] T.1 `lib/gateway-adapter.test.js` — gateway→UI shape mapping: run row,
      node/attempt (loop/retry share id → keyed by structural position), event
      frame, token rollup, status→pill. Round-trips a captured gateway fixture to
      the exact object `index.html` renders. *(scaffold created now — see below)*
- [ ] T.2 `lib/gateway-supervisor.test.js` — port allocation, db→gateway key map,
      idle-GC reaping, symlink tempdir lifecycle, double-start dedupe, start
      failure surfaces cleanly. Child processes mocked.
- [ ] T.3 Regression: existing 68 lib tests stay green (flag-off path unchanged).

**Integration (Node, real gateway, gated on a running gateway):**
- [ ] T.4 Spin a `smithers gateway` on a seeded fixture DB; assert `SmithersGatewayClient`
      run-event subscription delivers the same events serve-runs' `/api/runs/:id/logs`
      returns for that run. Skips cleanly if no gateway (CI-safe).

**E2E (browse tool):**
- [ ] T.5 Flag OFF: full smoke — list, select, detail, tabs, mobile (no overflow
      360/390, hamburger) — identical to the pre-migration baseline snapshots.
- [ ] T.6 Flag ON: select a run → detail updates live (drive a frame, assert DOM
      change without a 2.5 s wait); connection badge states; gateway-down →
      polling fallback, no console errors.
- [ ] T.7 Flag ON mobile: island has no horizontal overflow at 360/390; approvals
      actionable by tap.

## Docs to update (during implementation)

- [ ] D.1 `scripts/chad-smithers/README.md` — layout table gains
      `lib/gateway-supervisor.js`, `lib/gateway-adapter.js`, the island; test
      table gains T.1/T.2 with run commands + counts. **(pointer to this plan
      added now.)**
- [ ] D.2 `scripts/chad-smithers/SKILL.md` — "runs dashboard" section: document
      `CHAD_RUNS_GATEWAY`, the gateway-per-DB supervisor, and the live vs polling
      behavior.
- [ ] D.3 `supachad-docs` `runs-ide.md` — the dashboard's live-sync capability +
      the flag; note lists still refresh on an interval by design.
- [ ] D.4 `supachad-docs` `front-ends.md` — add "live run detail via Smithers
      Gateway" to the runs dashboard entry.
- [ ] D.5 `changelog.md` — one entry per shipped phase.
- [ ] D.6 This file — fill in Phase 0 findings; check boxes as phases land.

## Risks & rollback

- **One gateway per DB is heavy.** Mitigation: on-demand start for the selected
  run's DB only, idle-GC; cap concurrent gateways. If still too heavy → keep
  client in a single Node process in serve-runs and push to the browser over our
  own SSE (no per-DB browser gateways).
- **Version skew.** gateway packages must match our `smithers-orchestrator`
  version exactly; pin and add a preflight check. Mismatch → Phase 0 catches it.
- **Build pipeline creep (Upgrade B).** Keep the island tiny and the shell
  build-free; A ships without any build so value lands even if B is deferred.
- **Rollback is a flag flip** at every phase; the polling path is never deleted
  until Phase 3 parity holds.

## Sequencing note

Upgrade **A is independently shippable and lower-risk** (no build, pure hybrid,
immediate live-detail win). Recommend landing A fully before starting B. B is
optional if A's live detail plus our existing panels prove sufficient.
