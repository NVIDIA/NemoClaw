# chad-smithers

Host-side Smithers (smithers.sh) workspace for Chad — durable JSX
workflow orchestration with crash recovery, per-task model routing, and an
evolutionary nightly-experiment loop. See the full rationale in
[`docs/design/smithers-moshi-integration.md`](../../docs/design/smithers-moshi-integration.md).

Pilot scope: **host-side** (the Mac mini), not the pod. `/sandbox` is ephemeral
(no PVC), so `experiments.db` must live on the durable host filesystem for
resume guarantees to hold.

## Layout

| File | Role |
|---|---|
| `agents.js` | Model router + resilience helpers. `pickAgent(role)` auto-detects a backend by tier; `pickFallback(role)` gives a different-backend fallback; `taskOpts(role,{continueOnFail})` returns tier-aware `{timeoutMs,retries}` to spread on a `<Task>`. |
| `lib/population.js` | Evolutionary selection engine (pure, unit-tested): start wide → score → rank → Pareto (quality↑ vs cost↓) → retire losers. |
| `lib/population.test.js` | `node --test lib/population.test.js` — 9 tests, all green. |
| `lib/spawn.js` | The chad-spawn ⇄ Smithers bridge: `runSpawn()` (offload a step to chad-spawn, reconcile its `result.json`), `route()` (chad-route ported), `scoreIssue()`. Never throws. |
| `lib/spawn.test.js` | `bun test lib/spawn.test.js` — 8 tests, all green. |
| `lib/coerce.js` | Tolerant JSON extraction for **raw subprocess/tool stdout** (agent-task output is parsed by Smithers itself): `coerceJson(text,schema)` strips fences/prose, validates a zod schema, returns null on bad output (the schemaFailFast idea). Used by `lib/spawn.js` on `chad-spawn` result.json. |
| `lib/coerce.test.js` | `node --test lib/coerce.test.js` — 8 tests, all green. |
| `lib/model-limits.js` | Per-model ceilings (context / maxOutputTokens) from `../model-registry.json`: `limitsFor()` / `clampOutput()` / `preflight()`. The NVIDIA API exposes no limits, so the registry is the curated record (+ conservative `unknownModel` fallback). |
| `lib/model-limits.test.js` | `node --test lib/model-limits.test.js` — 8 tests, all green. |
| `lib/pr.js` | Deterministic PR triage for `pr-shepherd.jsx`: `prAction()` picks the one next action (draft/conflicts/checks-failing/changes-requested/merge-ready/stale-nudge/needs-review/waiting) from a `gh pr list --json` row — no LLM. `shepherdSummary()`, `checksFailing()`. |
| `lib/pr.test.js` | `node --test lib/pr.test.js` — 12 tests, all green. |
| `lib/coverage.js` | Deterministic coverage parsing for `coverage-loop.jsx`: `parseCoverage()` (total % from a report tail, tolerant of missing tooling), `uncoveredLines()`. |
| `lib/coverage.test.js` | `node --test lib/coverage.test.js` — 6 tests, all green. |
| `lib/models.js` | Model-id hygiene for the experiments matrix: `canonicalModelId()` (collapse `nvidia/nvidia/…` → `nvidia/…`), `isKnownModel()` / `rosterSet()` (validate against the live roster so mangled/derostered ids don't become phantom matrix columns). |
| `lib/models.test.js` | `node --test lib/models.test.js` — 8 tests, all green. |
| `lib/directives.js` | Directive resolution: `resolveDirectives(env)` merges the global `state/directives.json` with a per-run override (`CHAD_DIRECTIVES_JSON`) under a global gate (`CHAD_DIRECTIVES_OFF`) so runs can experiment ON the directives. `creativityKnob()`, `inScope()`, `directiveSystemFor()`. |
| `lib/directives.test.js` | `node --test lib/directives.test.js` — 9 tests, all green. |
| `lib/opencode.js` | `runOpencodeDirect()` — host opencode big-pickle coder (the `direct` coder path for coding-task/landing-lab). Runs under a shell with stdout→file (opencode only uses tools that way) + `--pure`; isolated `/tmp` workdir; never throws. |
| `lib/notify.js` | `moshiPing(title,message)` — one-way phone push via the Moshi device-token webhook (`MOSHI_DEVICE_TOKEN` from `credentials.json`). No Pro / no claude-hook; works from nemotron/cron/workflows. Never throws. |
| `GATEWAY-UI-MIGRATION-PLAN.md` | Plan for the two runs-dashboard upgrades — live sync via `@smithers-orchestrator/gateway-client` and drop-in `gateway-ui` components — with phased todos, test plan, and doc-update tasks. Both land behind `CHAD_RUNS_GATEWAY`. |
| `lib/gateway-adapter.test.js` | `node --test lib/gateway-adapter.test.js` — 7 **todo** tests (scaffold; CI-safe, exit 0). Spec for the gateway↔UI shape adapter from the migration plan (task T.1); fill in as `lib/gateway-adapter.js` lands. |
| `chad-moshi-notify` | CLI wrapper over `moshiPing` (`chad-moshi-notify "<title>" "<message>"`). |
| `chad-claude` | Launch Claude inside a routable tmux so Moshi approve/deny **buttons** work (`context.kind=tmux`). |
| `chad-moshi-hook-refresh.sh` + `dev.nemoclaw.moshi-hook-refresh.plist` | launchd guard that re-installs the Moshi claude hooks when they go stale after a moshi-hook update. |
| `experiments.jsx` | The nightly evolutionary workflow (Smithers). |
| `workflows/*.jsx` | Ported chad-spawn / cron features (issue-triage, content-pipeline, self-improve, memory-curator, log-digest) + email-ladder, fusion, mcp-health-probe, fail-only-report. All graph-validate; side-effecting ones are shadow-safe by default. |
| `state/seed-candidates.json` | Tracked. Initial variant pool to seed the arena wide. |
| `state/fixtures.json` | Tracked. Evaluation fixtures the judge scores against. |
| `state/population.json` | **Runtime** (gitignored). The evolving population + scores. |
| `experiments.db` | **Runtime** (gitignored). Smithers' SQLite checkpoint store. |

## Model routing (the "free Nemotron" question, answered)

The default cheap-tier model is NVIDIA's **hosted** Nemotron 3 Super 120B
(`integrate.api.nvidia.com`, via `NVIDIA_API_KEY`) reached through the local
`chad-shim :8901` proxy — a frontier 120B MoE, not a weak local model. The only
truly-local model is `google/gemma-3-4b` (lmstudio, offline fallback).

`pickAgent(role)` picks by tier with runtime auto-detection:

- **cheap** (classify/draft/observe/report): hosted Nemotron-120B if
  `NVIDIA_API_KEY` is set (free, frugal tokens), else `claude` CLI, else local.
- **capable** (evaluate/judge/optimize/implement): best available, preferring
  `claudecode` (Claude Max subscription, no API credits) → `codex` →
  Nemotron-120B via AI-SDK tool loop → `opencode` → local gemma.

Inspect the resolved table for the current environment:

```sh
bun agents.js --probe
```

Override with `CHAD_CAPABLE_BACKEND` / `CHAD_CHEAP_BACKEND`
(`claudecode|codex|nemotron|opencode|anthropic|local`).

The Nemotron path uses **two** hosted ids: Super 120B (`nvidia/nemotron-3-super-120b-a12b`,
fast) for the cheap tier, Ultra 550B (`nvidia/nemotron-3-ultra-550b-a55b`, agentic,
adopted 2026-06-13) for the capable tier. Both are seeded as experiment candidates
so the arena measures whether Ultra's quality justifies its latency.

### Do we need to add API keys to credentials?

**No new keys.** The `ai` SDK itself needs no key; only the *provider* does:
- **nemotron / NIM** → `NVIDIA_API_KEY` (already in the pod credentials; the
  hosted Nemotron API is free with it). This is the only key the default path needs.
- **claudecode** → none; the `claude` CLI uses the Max subscription/OAuth.
- **anthropic (`@ai-sdk/anthropic`)** → would need `ANTHROPIC_API_KEY` **and**
  restored credits. It's wired as a **fallback only**: the backend throws if the
  key is absent, and auto-detect skips it until `CHAD_ANTHROPIC_CREDITS_OK=1`
  (API is 402 today). So it's available as a fallback the moment credits return,
  with zero code change — but nothing requires adding the key now.

> The "Nemotron can't drive tool loops" lore was an **openclaw harness**
> round-trip bug, not a model limit. Smithers runs its own AI-SDK tool loop, so
> the 120B model is a candidate for the capable tier too — that's literally one
> of the seeded experiment candidates (`model:nemotron-default` vs
> `model:claudecode-subscription`). Let the arena decide.

### opencode / "big pickle" — pending

`opencode` is installed on the host, so the 500k-ctx / 200-req-hr path is real.
Smithers ships no `OpenCodeAgent`, so the backend in `agents.js` currently
throws a clear TODO. To finish it, confirm:
1. `CHAD_OPENCODE_MODEL` — the actual model id ("big pickle"), and
2. whether opencode exposes an OpenAI-compatible server (`opencode serve`) we
   can point the nemotron-style `createOpenAICompatible` at, or whether it needs
   a thin CLI adapter implementing the Smithers agent contract.

## Moshi integration (phone notifications + approval)

`moshi-hook` (running + paired on the host) has **no `notify` command** — push
only flows through agent lifecycle hooks. Installed 2026-06-13 via
`moshi-hook install --target claude`, which wrote handlers into the global
`~/.claude/settings.json` that pipe Claude Code's hook JSON to
`moshi-hook claude-hook`:

- **Stop** → phone notification when a `claude` run finishes. Since the capable
  tier runs via `claude`, **nightly experiment completion already notifies the
  phone** with no extra code.
- **PermissionRequest / PostToolUse[AskUserQuestion]** → routes an approval to
  the phone (the Phase-5 autonomy mechanism).

Because of that split, `claudecode` agents default to
`dangerouslySkipPermissions: true` so **autonomous** experiment runs notify on
finish but never block waiting for a tap. For the **autonomy ladder**, construct
with `pickAgent(role, { approvalRouting: true })` to keep permissions on and
surface each action on the operator's phone.

Pod-side events (gbrain dream, spawns) don't run through host `claude`, so they
aren't covered yet — a pod→host bridge is the Phase-2 follow-up (the socket is
`~/Library/Application Support/Moshi/moshi-hook.sock`; there is no documented
generic-emit verb, so a synthetic-event approach needs the `claude-hook` stdin
schema captured first).

**Revert:** `moshi-hook uninstall` removes the hook config. `moshi-hook status`
shows current pairing/hook state.

## Evolutionary experiments — "start wide, keep what works"

Per operator directive (2026-06-13). Each run:

1. **seed** — fill the active cohort up to `POLICY.targetActive` (start wide).
2. **evaluate** — score every active candidate **in parallel** (one durable
   Smithers task each; a crash resumes from the last scored candidate).
3. **select** — record scores, rank by rolling mean, promote top-K to
   `champion` (used in prod), **retire** candidates that stay below
   `retireBelow` after `minTrials` (kept on record, never re-explored).
4. **report** — write the leaderboard + post an OpenWebUI note (the
   experiment-night success criterion: an operator-visible artifact).

Tune the policy in `lib/population.js#POLICY`.

## Bring-up

```sh
bun install
node --test lib/population.test.js     # selection engine — should be 6/6
bun agents.js --probe                  # confirm routing for this host
smithers graph experiments.jsx         # validate the workflow WITHOUT calling a model
DRY_RUN=1 smithers up experiments.jsx  # full render, no state writes
smithers up experiments.jsx            # real run (calls the routed model)
smithers ps                            # watch run state
smithers up experiments.jsx --resume <runId> --force   # resume a crashed/stalled/
                                       # approved run (there is no bare `smithers resume`)
```

`run-experiments.sh` wraps the real run + the OpenWebUI artifact post for cron.

## Status

- `agents.js`, `lib/population.js` — production-shaped, router probes clean,
  selection engine unit-tested (6/6).
- `experiments.jsx` — **live smoke pass GREEN (2026-06-13)**: `smithers up` ran
  the full loop end-to-end (seed → parallel eval via `claude` → select → report),
  scores flow correctly (recorded trial, promoted champion, leaderboard written),
  state persisted to `experiments.db` + `state/population.json`. Ready for Phase-4
  cron wiring via `run-experiments.sh`.
- `fusion.jsx` — **3-stage (panel → judge → synthesize), live smoke pass GREEN
  (2026-06-19)**: a 2-model panel + structured judge + synthesizer ran end-to-end
  against the NVIDIA API; `fusion.db` carries the run (panel responses, judgment,
  fused answer). Panelists are `continueOnFail` + timed-out; the panel is
  auto-selected from arena champions (`state/population.json`) + the featured list.
- **Resilience pass (2026-06-19):** every agent task across the 10 workflows now
  carries a tier-aware `timeoutMs` + `retries`, and (where it's a required step) a
  `fallbackAgent`; fan-out members (panelists/evals) are `continueOnFail`. Added
  `lib/coerce.js` (8/8 tests). The runs dashboard now shows per-node token counts,
  a "reasoning hidden" badge, inline fused/report output, and the full workflow
  catalog incl. zero-run scaffolds.
- **Token-ceiling pass (2026-06-19):** `../model-registry.json` extended with the
  fusion roster (context + maxOutputTokens; estimates flagged `_estimated` — the
  NVIDIA `/v1/models` API exposes no limits). `agents.js` clamps every request to
  the model's ceiling; `serve-runs` preflights a launch (`/api/preflight`, gates
  `/api/launch`) and blocks output > context window, surfacing clamp/estimate
  warnings in the drawer (which shows ceilings via `/api/model-limits`). NOTE: the
  cheap 2048 / capable 16384 tier caps are deliberate **frugality budgets** (tuned
  in `../task-profiles.json` vs measured p95, watched by `chad-budget-audit`), NOT
  model limits — raise them per-run in the drawer (up to the model ceiling) for
  long experiments via `CHAD_MAX_OUTPUT_TOKENS[_CHEAP]`.
- **Insight + tokenmaxxing pass (2026-06-19):** `workflows/token-optimize.jsx`
  proposes Approval-gated model downgrades and, on approval with
  `CHAD_TOKENOPT_APPLY=1`, writes the cheaper model into `../task-profiles.json`
  (snapshot-first, dot-path set preserving siblings/comments). It runs nightly
  (folded into `run-experiments.sh`, shadow) and feeds the runs-IDE **Experiments
  dashboard** via `/api/model-matrix` — a model × task-kind heatmap surfacing the
  best model per task-kind. The launch drawer gained per-tier model pickers
  (capable/cheap → `CHAD_NEMOTRON_*_MODEL`, all workflows) and a liveness-filtered
  fusion model multi-select (`/api/models`).
- **Ops-hardening + chaining + node inspection pass (2026-06-22):**
  - `mcp-health-probe` fixed (it was the one failing run). It failed on a
    **claudecode fallback**: the cron wrappers force the *primary* to nemotron, but
    `pickFallback` deliberately picks a *different* backend — the `claude` CLI,
    which under launchd can't auth AND emits `SessionStart` hook JSON that breaks
    the parser (`AGENT_CLI_ERROR`). Fix: `CHAD_DISABLE_CLI_AGENTS=1` (set by the
    cron wrappers) removes CLI agents from selection AND fallback (nemotron-only
    headless); `claudecode` also passes `settingSources:"project,local"` so the
    host hooks don't pollute it when used interactively (auth verified to survive).
    The probe's `check` is now **deterministic** (set comparison, no LLM — a health
    probe must not hang on a slow 550B call), and the gbrain command was wrong
    (`gbrain health`, not `get-health`).
  - All **5 never-run scaffolds** (self-improve, email-ladder, issue-triage,
    content-pipeline, memory-curator) smoke-passed — each wakes cleanly (finished,
    or paused at its approval gate). The approve→resume gate flow verified
    end-to-end (`smithers approve` via a symlinked `smithers.db` → `up --resume
    --force` → finished).
  - **Workflow chaining** (new **Chains** tab + `/api/chains`): run workflows in
    sequence — a step launches when the prior reaches `finished`; an approval-gated
    step *holds* the chain (resumes the chain when you approve in the Approvals
    tab); optionally feed each step's primary output into the next step's
    `ctx.input.output`. Chains persist to `state/chains/` and survive a restart.
  - **Graph node inspection**: click any node in a workflow graph OR a run DAG to
    see its declared settings (timeout/retries/continueOnFail/needsApproval/…) and
    — on a run DAG — the **resolved** model/agent/tokens it actually used. "Tweak &
    re-run" pre-fills the launch drawer. `graphToDag` carries per-node type/group/config.
  - `/api/approvals` now excludes gates whose run is already terminal (no phantom
    pending badge). `CRON-WORKFLOW-MAP.md` maps pod-cron ↔ workflow overlap.
  - **Dashboard pass 2:** graph nodes now carry on-node metadata badges
    (🔒gate/⏱timeout/↻retries/⇢keep/✎fx) + a **hover tooltip** (declared config,
    and on a run DAG the resolved model/tokens/state + an output snippet). The
    **Approvals tab** gained a notify-settings card — pick the default channels
    (browser/webui/email/telegram) live, persisted to `state/notify-config.json`
    via `/api/notify-config` (read each tick by the notifier, no restart). The
    **Experiments dashboard** was revamped around a **money/tokens-saved hero**: a
    rough cost model (`state/model-costs.json`, tunable) computes the frontier
    counterfactual — what every token would cost on a frontier model vs the ~$0 we
    pay on free Nemotron — plus per-model frontier/market cost and downgrade $/1M
    savings. `/api/efficiency` returns the cost block.
  - **Schedules tab** (`/api/schedules`, read-only): parses the host launchd
    plists (`~/Library/LaunchAgents/dev.nemoclaw.chad-*`) for each job's cadence +
    target workflow, cross-referenced with `launchctl list` (loaded/running/last
    exit) and the workflow's last real run — grouped workflow / service / ops /
    infra. (It immediately surfaced a stale `log-digest` failure that was the same
    fallback-escape bug, here escaping to the local lmstudio backend — covered by
    the `CHAD_DISABLE_CLI_AGENTS=1` fix.)
  - **Dashboard pass 3 (experiments + chains):** the model×task matrix now filters
    junk from early test runs (real task-kind slugs × namespaced model ids only).
    **Reflective mutation (the Hermes/GEPA borrow):** `experiments.jsx` BREEDS a new
    drafter-prompt each run by reasoning about *why* the leaders win, instead of only
    selecting from static seeds — the arena is now self-generating. Guardrailed:
    text-only, capped by `POLICY.maxActive`, deduped by label, never auto-promoted
    (must win evaluation next round); `CHAD_EXPERIMENT_MUTATE=0` disables.
    **Chain recovery + cross-linking:** a failed chain resumes from the step it
    stopped on (`/api/chains/:id/resume`) or re-runs from any step (`/rerun-step`);
    the Chains UI gained per-step Resume/Fork/Rerun + a chain-level Resume, step
    durations, and a done count; runs everywhere are tagged with their `chainId`
    (allRuns annotation) and badge-link back to the chain card (`gotoChain`).
  - **Directives + trace-grounding (pass 4):** the arena's input was STATIC — the same
    8 `fixtures.json` fed to every candidate every run, no memory. Added: (1) a
    **Directives** tab + `state/directives.json` (`/api/directives`) — operator
    free-text that steers the arena's breeding + scoring (`experiments`) and optional
    per-role/`all` **system prompts injected into every workflow** via
    `agents.js#directiveSystem` (generalizes `championSystem`). (2) `lib/signal.js` +
    `/api/signal` — scans every DB for failed/stale/low-quality runs into a digest,
    surfaced on the Directives tab AND fed into the reflective-mutation prompt
    (`signalText`), so breeding reacts to real failures, not just synthetic fixtures
    (the Hermes "read traces → improve" loop, now closed end-to-end). (3)
    `lib/fixtures.js` + `/api/fixtures` — **harvests REAL run inputs** (email-ladder
    messages, fusion prompts, log samples, triaged issues) into taskKind-tagged
    fixtures that augment the static 8, so candidates are scored against LIVE cases
    instead of only the hand-written set (`CHAD_HARVEST_MAX`, cached 60s). Surfaced
    on the Directives tab. This closes the last static-input-context gap.

### Gotchas learned during bring-up (don't regress these)

- **A health/ops probe must not depend on inference.** The cheap tier defaults to
  Ultra 550B (~30s/call, spikes past the 120s task cap under load), so an LLM-gated
  probe times out. Keep the probe decision deterministic (set comparison / HTTP
  code); reserve the model for non-blocking enrichment only.
- **`pickFallback` escapes the forced backend.** Forcing `CHAD_*_BACKEND=nemotron`
  only pins the PRIMARY; the fallback picks a *different* backend, which headless is
  the unusable `claude` CLI. Cron/launchd contexts must also set
  `CHAD_DISABLE_CLI_AGENTS=1`.
- **Nemotron-3 reasoning: the "detailed thinking off" system directive is a NO-OP**
  (verified 2026-06-22 — every model reasoned regardless). Reasoning is ON by
  default; only `reasoning_effort:"none"` or `chat_template_kwargs:{thinking:false}`
  in the request body disable it. `agents.js` injects both via a `fetch` wrapper
  (`reasoningOffFetch`) when a tier is reasoning-off. Why it matters: reasoning-on
  silently ate the cheap 2048-token budget → EMPTY/truncated answers, and pushed
  Ultra 550B (~7 tok/s, 145-166s for ~1k tok) past the 120s cheap cap. Cheap tier
  now defaults to **Super 120B + reasoning-off (~3s, complete)**; Ultra is
  capable-tier only. Measure with a streaming probe (look at `reasoning_content` +
  `finish_reason`), not just wall time.
- **What stays on Ultra after the cheap→Super flip:** every `judge`-role call
  (capable tier — evaluation/moderation/scoring/proposals across the capable-tier workflows). The
  only cheap-tier draft that's operator-facing, `email-ladder`'s reply, is pinned
  back to Ultra via `CHAD_EMAIL_DRAFT_MODEL` (gated + not latency-critical, 300s
  task timeout for the slow model). fusion/token-optimize `draft` pin their own
  models (panel/benchmark), so they're unaffected. The arena benchmarks Ultra-vs-
  Super on the cheap roles (log-cluster, email-drafter, content-gen, triage-classify
  in `state/downgrade-candidates.json`, benchmark-only rows) so token-optimize can
  flag any real Ultra win instead of guessing.

- **zod MUST be v4** (`^4.3.6`, matches Smithers). A 3.x `/v4` shim makes the
  agents package's `toJSONSchema` throw `Non-representable type: optional`.
- **Agent task prompt** is a string child (`{prompt}`), not a thunk.
- **Read upstream outputs via `ctx.outputs.<schemaName>`** in render scope (the
  fan-in pattern), not the `deps` arg — `deps` is keyed by task id, so it's empty
  for dynamic `eval-*` fan-out.
- **`continueOnFail` is NOT the default.** A failed panelist sinks the whole
  `Parallel` unless you set it (the built-in `<Panel>` doesn't set it either, which
  is why we kept the hand-rolled fusion). Fan-out tasks must opt in via
  `{...taskOpts(role,{continueOnFail:true})}`.
- **Workflow-subdir runs log under `workflows/.smithers/executions/`,** NOT the
  root `.smithers/executions/`. `serve-runs.js` scans BOTH (`LOG_DIRS`) — without
  that, the dashboard shows no event log / tokens / agent-trace for `workflows/*.jsx`.
- **ToolLoopAgent tasks have no task deadline by default** — set `timeoutMs`
  (agents.js `taskOpts` does this; the nemotron/local backends also pass an AI-SDK
  `timeout` so a hung NVIDIA call releases its connection).
