<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Chad / NemoClaw — Master Review & Roadmap (2026-10-01)

A full-stack review of what's live, what's dead, what was planned but never
landed, and a sequenced plan to get to: multi-user + Chad-Lite tiers, paid
onboarding (rate-limit → paywall → subscribe), one-time invite links, the
Smithers runs-UI upgrade, upstream auto-sync, and a clean, policy-complete,
dead-code-free repo kept in sync by automation.

> Scope note: this is the **review + roadmap** deliverable. Each workstream
> below is sized and sequenced; none of the net-new features (paywall, Tier 1,
> invite links, upstream-sync cron) are built yet. Pick the order in the
> "Recommended sequence" section and we execute per workstream.

---

## 0. TL;DR — state of each thing you asked for

| Workstream | Status today | Gap |
|---|---|---|
| Chad-Lite (free tier) | ✅ **Shipped** (Tier 0, `chad-provision-tier0.sh`) | Only "model + OWUI memory/search"; no rate-limit, no quota |
| Multi-user | 🟡 **Partial** — Tier 0 scales to CF's 50-seat cap | Tier 1 (isolated paid agents) **never built** |
| Premium/free allowlist | 🟡 **Partial** — shim `CHAD_OPERATOR_ALLOWLIST` gates premium `chad` | Manual; no self-serve, no tier metadata |
| Signup intake / onboarding | ❌ **Not built** — Cloudflare Access list is the only gate (manual) | No intake form, no processing pipeline |
| Rate-limit / paywall / subscribe | ❌ **Not built** | No Stripe, no quota, no billing |
| One-time invite links / per-use URLs | ❌ **Not built** | Doc explicitly says "no email invite" today |
| Runs app → newest smithers.sh | 🟡 **Planned** (`GATEWAY-UI-MIGRATION-PLAN.md`, behind `CHAD_RUNS_GATEWAY=1`) | Not landed; hybrid design only |
| Upstream nemoclaw auto-sync + merge | ❌ **Not built** | No cron; maintainer skills exist but manual |
| Code/feature audit for full functionality | 🟡 **Ongoing** — terminal stack just hardened (this week) | Broad audit not done |
| Skills improvement | 🟡 **Partial** — openwebui skill updated this week | gbrain/gstack wiring not re-tested |
| Missing policies (L7/OPA, security) | 🟡 **Partial** — 80 allowlist refs, 5 un-gated launch sites noted | No consolidated policy audit |
| Dead code / artifacts | ❌ **Dirty** — ~520M stale local backups + 73M in-repo `.db.bak` | This doc's §1 cleans it |

---

## 1. Dead junk & artifacts (safe to reclaim)

### 1a. Host clutter under `/Users/r/.nemoclaw/` (~520 MB stale)

`chad-ops recover` restores from **GitHub** (`chad-restore-from-github`), *not*
these local tarballs — so the local snapshots are superseded. Verify the GitHub
backup is current (`chad-ops doctor`), then archive/delete:

| Path | Size | Verdict |
|---|---|---|
| `backups/sandbox-state-20260513*.tar.gz` | 367 MB | Stale (May); superseded by GitHub restore |
| `backups/chad-restored-state-20260521*.tar.gz` | 43 MB | Stale (May) |
| `dumps/` | 92 MB | One-off pre-restart/pre-bump dumps (May) |
| `rebuild-backups/` | 6.7 MB | May rebuild snapshot |
| `log-dumps/` | 440 KB | Apr log captures |
| `pre-restart-20260707T210332Z/` | 12 KB | Jul one-off (`jobs.json`, `operator-allowlist`) |
| `tmp/` | 24 MB | Scratch |
| `openwebui/*.log` + `*.err.log` | ~15 MB and growing | Rotate/truncate; several are >3 MB |
| `terminal-fix/` | 36 KB | **Superseded** — the real impl is `scripts/openwebui/browser-vm/` + the deployed loader; keep only as historical note or delete |

**Recommendation:** move the three backup dirs to cold storage (or delete after
confirming GitHub restore), truncate the openwebui logs, delete `tmp/`. ~520 MB
reclaimed. Do **not** touch `credentials.json`, `sandboxes.json`, `source/`.

### 1b. In-repo artifacts on `chad-dev` (73 MB, would be committed by `git add -A`)

These are untracked and **not** in `.gitignore`:

```
scripts/chad-smithers/token-optimize.db.bak.20260707T035155Z   66 MB
scripts/chad-smithers/bug-report.db.bak.20260707T035155Z        5.1 MB
scripts/chad-smithers/skill-improve.db.bak.20260707T035155Z     1.9 MB
scripts/chad-smithers/self-improve.db.bak.20260707T035155Z      1.0 MB
scripts/chad-smithers/*.db  (mcp-health.db, token-optimize.db)  0 B (empty)
```

**Action:** add `*.db` and `*.db.bak*` to `.gitignore`, `git rm --cached` any
tracked ones, delete the `.bak`s. (The live `.db` files are runtime state, never
source.) This is the single most important cleanup before any commit.

### 1c. Dead code found this week (already fixed, noted for the audit)

The terminal stack carried five regressions from an un-gated Sep-28 hand-edit
(drag-guard eating clicks, mock-adapter fabricating output, missing
`sendTerminalOutput`, dropped `/proc`+`/dev` mounts, dropped `failedReason`),
plus a **never-implemented `_vm_handler`** (the WebVM agent bridge never worked)
and **paramless agent tool schemas**. All fixed 2026-09-30. Lesson baked into
the audit: **never hand-edit deployed artifacts; always go through the build
gate** (`browser-vm/loader/build.sh`, 239-assertion smoke test).

---

## 2. What landed vs. what didn't (from the plan docs)

Source of truth: `docs/design/multi-user-chad.md` and
`scripts/chad-smithers/GATEWAY-UI-MIGRATION-PLAN.md`.

**Multi-user (`multi-user-chad.md`)**
- ✅ Tier 0 "Chad Lite": `chad-provision-tier0.sh` (Nemotron Ultra + generic
  prompt), SearXNG web search, OWUI per-user memory, `--access-control`
  passthrough in `chad-webui`.
- ✅ Premium gate: shim reads `CHAD_OPERATOR_ALLOWLIST`; non-operators selecting
  `chad` get a polite refusal. `BYPASS_MODEL_ACCESS_CONTROL=True` stays on.
- ✅ Auth flow: trusted-header SSO (`Cf-Access-Authenticated-User-Email`),
  auto-provision on first login, `DEFAULT_USER_ROLE=user`, `ENABLE_SIGNUP=False`.
- ❌ **Tier 1 (paid isolated agent)** — `chad-provision-user <email>`,
  per-agent gbrain DB, namespaced lancedb/wiki, `email→{tier,agentId}` shim
  routing, per-agent token budgets. **Design only.**
- ❌ Adaptive-memory Function for Tier 0.

**Runs UI (`GATEWAY-UI-MIGRATION-PLAN.md`)**
- 🟡 Plan written: Upgrade A (live sync via `@smithers-orchestrator/gateway-client`)
  + Upgrade B (drop-in `gateway-ui` components), both behind `CHAD_RUNS_GATEWAY=1`.
  Hybrid (keeps ~40 custom endpoints). **Not implemented.**

**Automations infrastructure** — rich (`scripts/chad-cron-wrappers/`: 30+
wrappers incl. `chad-self-improve`, `chad-skill-watch`, `chad-memory-curator`,
`chad-issue-triage-cron`). **No upstream-sync wrapper exists.**

---

## 3. Roadmap by workstream (current state → plan → sequence)

### A. Tiers + allowlist (free Chad-Lite / premium Chad)
- **Now:** two tiers conceptually; premium gated by shim allowlist in
  `credentials.json`.
- **Build:** a single source-of-truth **tier registry** (`email → {tier, status,
  quota, agentId?}`), replacing the flat `CHAD_OPERATOR_ALLOWLIST`. Shim reads it;
  `chad-webui` can edit it. Tier 1 provisioner (`chad-provision-user`) per the
  design doc.
- **Effort:** M (registry + shim routing) + L (Tier 1 isolation).

### B. Onboarding: intake → rate-limit → paywall → subscribe

**Built 2026-10-01 (scaffold complete, deploy-pending):**
- **Intake:** `supachad-landing/worker.js` `POST /api/signup` → KV `signup:<email>`.
- **Rate-limit:** `chad_rate_limit` OWUI filter — **now `is_active=1 + is_global=1`**
  (the §F audit found it was active-but-not-global, i.e. not enforcing; fixed). Caps
  non-exempt models at 50 msgs/user/UTC-day; chad+admins exempt.
- **Paywall:** `worker.js` `POST /api/stripe/webhook` — HMAC-sig-verified (scheme
  matches Stripe's `t.<body>` SHA-256, verified against a node reference),
  `checkout.session.completed`/`invoice.paid` → `grantPremium()` → KV `premium:<email>`
  + queued CF Access add. Wire a Stripe Payment Link → this endpoint.
- **Premium → shim bridge (automated):** `scripts/openwebui/sync-premium-allowlist.sh`
  GETs `/api/premium/list` (admin), set-unions emails into host
  `CHAD_OPERATOR_ALLOWLIST`, runs `chad-ops gate-sync`. Merge logic tested
  (case-insensitive dedup, drops malformed). Wire as a 15-min host cron.
- **Deploy-pending:** create KV namespace, set secrets (`ADMIN_SECRET`,
  `STRIPE_WEBHOOK_SECRET`), `wrangler deploy`; CF-Access auto-grant stays queued until
  the token has Access:Edit (see §C).

- **Original plan (for reference):**
  1. **Intake:** a tiny signup page (Cloudflare Worker or the landing site) →
     writes requests to a store (Worker KV / a `signups` table / an email to
     `supachad@proton.me`). *(You said "even if it has to be manually adding to
     the allowlist in Cloudflare — a way to receive the signup info and
     process."* → the Worker + a `chad-webui`/CF-API processor covers this.)
  2. **Rate-limit:** per-user quota for Chad-Lite (OWUI has no native quota →
     enforce in the shim: count turns/tokens per `email` per day in
     `credentials.json`/a small DB; refuse past the cap with an upgrade CTA).
  3. **Paywall + subscribe:** Stripe Checkout + webhook → on `active`
     subscription, flip the user's tier in the registry (and add to CF Access via
     API). Start with a **Payment Link** (zero backend) → upgrade to a webhook
     Worker.
- **Effort:** M (intake + rate-limit) + M (Stripe link + webhook → tier flip).

### C. One-time invite links / per-use URLs + CF Access automation

**Built 2026-10-01 (scaffold complete, deploy-pending):** `worker.js`
`POST /api/invite/mint` (admin, `X-Admin-Secret`) → single-use token, 14-day TTL,
KV `invite:<token>`; `GET /invite/<token>` → consume + `addToCloudflareAccess()`
(queued until ready) + premium recorded. See `INVITE-SETUP.md`.

**CF API token scope — the one blocker (explained):**
- The current `CF_API_TOKEN` (in `scripts/openwebui/.env`) is **too narrow** — a live
  `purge_cache` call failed with "Authentication error", confirming no Cache-Purge,
  and it has no Access edit either.
- The worker's `addToCloudflareAccess()` needs exactly **`Access: Apps and Policies`
  = Edit**, scoped to the account (`CF_ACCOUNT_ID`). No Zone perms. It calls
  `GET`/`PUT /accounts/{acct}/access/apps/{app}/policies/{policy}` to append
  `{email:{email}}` to the policy `include` list.
- **Recommendation:** mint a *dedicated* token for the worker (don't widen the OWUI
  one). Dashboard → My Profile → API Tokens → Create Custom Token → add
  "Access: Apps and Policies: Edit" on the account. Then `wrangler secret put
  CF_API_TOKEN` (+ `CF_ACCESS_APP_ID`/`CF_ACCESS_POLICY_ID`, found via the Access app's
  Policies in Zero Trust), and flip `CF_ACCESS_READY="1"` in `wrangler.toml`.
- Until then: redemptions/checkouts succeed and **queue** the grant in KV; the
  `sync-premium-allowlist.sh` bridge still grants premium `chad` access
  (shim allowlist) independent of CF Access — CF Access only gates whether the email
  can *log in* to OWUI at all, which for existing users is already satisfied.
- **Effort:** S once the token is minted (flip one var + 3 secrets).

### D. Runs app → newest smithers.sh

**Research verified — 2026-10-01 (trial install + bun runtime check):**

- **Version gap:** chad-smithers pins `smithers-orchestrator` + `@smithers-orchestrator/agents` at `^0.26.1`; latest is **0.32.0** (6 minors: 0.27→0.32).
- **What we import:** `createSmithers`, `Debate`, `Loop`, `Poller`, `ScanFixVerify` — all top-level, re-exported from `@smithers-orchestrator/components` (per [[reference_smithers_composites_import]]).
- **Compatibility: VERIFIED SAFE at the import level.** Trial-installed 0.32.0 in a throwaway copy (773 pkgs, clean, exit 0). Under **bun 1.3.13** all 5 symbols resolve; `@smithers-orchestrator/agents` resolves; `smithers --version` → 0.32.0. (Note: the core entry uses `bun:` scheme imports → must run under **bun**, not node — which is how `smithers up` already runs.) Exports are purely **additive** — 0.32.0 adds DelegationV2, Monitor/DriftDetector/DeriskLoop composites, and the full gateway surface; nothing we use was removed/renamed.
- **Runs-UI migration is now unblocked.** `gateway-client`, `gateway-react`, `gateway-ui` ship at 0.32.0 as **subpath exports** of `smithers-orchestrator` (also as matching scoped packages) — verified `smithers-orchestrator/gateway-client` resolves. Version-skew constraint in `GATEWAY-UI-MIGRATION-PLAN.md` (gateway pkgs must match core) is satisfied by upgrading core to 0.32.0. **So the core bump is the prerequisite for Upgrade A/B.**
- **Residual risk:** behavioral prop/semantic drift in `createSmithers` options + composite props across 6 minors. No compile step exists (JSX run via `smithers up`), so the validation gate is `DRY_RUN=1 smithers up experiments.jsx` on a branch after the bump — not catchable statically.

**Upgrade plan:**
1. Branch; bump both deps to `^0.32.0`; `npm install` in `scripts/chad-smithers/`.
2. `DRY_RUN=1 smithers up experiments.jsx` + `node agents.js --probe` → fix any prop drift the dry-run surfaces. Gate: scaffolds parse + plan.
3. Then execute `GATEWAY-UI-MIGRATION-PLAN.md` Upgrade A (live run detail via `smithers-orchestrator/gateway-client`, behind `CHAD_RUNS_GATEWAY=1`), verify exit criteria, then Upgrade B (gateway-ui island + Bun build).
- **Effort:** core bump **S** (verified low-risk); Upgrade A **M**; Upgrade B **L** (new build toolchain).

### E. Upstream nemoclaw auto-sync + merge
- **Now:** none; maintainer skills (`nemoclaw-maintainer-day/*`) are manual.
- **Build:** a scheduled routine (cron agent) that: `git fetch upstream` →
  create a sync branch → merge → on conflict, open a PR with the conflict surface
  for review (never auto-merge conflicts to `main`/`chad-dev`) → run `make check`
  + tests as a gate. Codify "additions that make the repo Chad" as a documented
  **rebase/merge policy** (which files are Chad-local and must survive upstream
  merges — e.g. `scripts/openwebui/`, `scripts/chad-*`).
- **Effort:** M. **Risk:** conflict handling must be PR-gated, not autonomous
  writes to a shared branch (see [[project_chad_autonomy_git_boundary]]).

### F. Code/feature audit for full functionality
- Terminal stack: ✅ hardened this week (WebVM + Docker + agent bridge + tools).

**Live audit — 2026-10-01 (post-recovery):**

| Item | Status | Finding |
|------|--------|---------|
| Crons registered + scheduled | ✅ | 10 crons, correct schedules (email-check hourly, backup /6h, dream 03:30, prune Sun 02:00, etc.) |
| Cron **work** executes | ✅ | Latest `workspace-backup` pushed **36 files incl. brain/chat exports, 0 errors** — the gbrain fix means the brain backs up now too |
| Cron **delivery** (announce) | ⚠️ | All crons show `announce -> last -> no route, will fail-closed: Channel…`; `openclaw channel list` is **empty** → results never reach a chat. Work still completes; only operator notification is lost. Root cause is the tabled Moshi/channel route ([[project_moshi_approval_buttons_tabled]]). Not a functional break. |
| `chad_rate_limit` filter | 🐛→✅ | Was `is_active=1` but `is_global=0` → **not actually enforcing** on chad-lite (filters only run on attached models unless global). **Fixed 2026-10-01: toggled global**; now caps chad-lite, chad+admins exempt via the filter's own logic. |
| chad-shim :8901 (premium) | ✅ | Responding (404 on /health = no health route; chat path works, tiers verified earlier) |
| LM Studio :1234 (chad-lite) | ✅ | `nvidia/nemotron-3-nano-4b` loaded. **Bonus:** `text-embedding-nomic-embed-text-v1.5` is already loaded here → the deferred nomic-embed swap (§5b follow-up) is now cheap (model already served; just needs pod→host:1234 + L7 policy). |
| nvidia-proxy :3002 | ✅ | HTTP 200; still live for NVIDIA-hosted route |
| searxng | ✅ | Up (web search for chad-lite tools) |
| OWUI functions inventory | ✅ | Only `chad_rate_limit` installed (now global+active). No stray/dead functions. |
| Un-gated launch sites (§[[project_chad_operator_allowlist_gate]]) | ✅ | Closed in prior work (shim fail-closed + gate-sync). |

- **Net:** everything functional; the one latent bug (rate-limit not global) is fixed.
  The only open gap is cron→operator delivery (no channel), which is the tabled Moshi
  item, not a regression. **Effort remaining: S** (optional: wire a delivery channel).

### G. Skills + gbrain/gstack re-test
- **Now:** openwebui skill updated this week.
- **Build:** run each gstack skill's self-check; re-test gbrain MCP wiring
  (embed stack is fragile — see [[project_gbrain_embed_stack]]: model EOL/dim
  mismatches); verify the gbrain↔subagent brain-sharing pattern
  ([[project_gbrain_gstack_integration]]). Produce a skills health matrix.
- **Effort:** M.

### H. Missing policies (L7/OPA + security)
- **Now:** 80 allowlist refs; L7 presets per-binary (see
  [[feedback_openshell_l7_binary_identity]], [[feedback_l7_binary_symlink]]).
- **Build:** consolidated policy audit — every outbound host the shim/wrappers
  need, every binary on an L7 preset, close the 5 un-gated launch sites, confirm
  no fail-open allowlist. Document the policy set in one place.
- **Effort:** M. **Security priority: high.**

### I. Dead-code / security-hole sweep
- §1 cleans artifacts. Add: secret scan (no keys in repo — `credentials.json` is
  pod-local/uncommitted, keep it that way), the CSO skill run (`/cso`), and remove
  the dead chip/menu helpers left no-op'd this week once confirmed unused.
- **Effort:** S–M.

### J. Keep-in-sync automations (the end state)
- Upstream-sync cron (E), a nightly **drift check** (deployed loader/relay vs
  source — this week we hit source↔deploy divergence twice), a **skills-watch**
  (already exists: `chad-skill-watch`), and a **backup verifier** (confirm the
  GitHub restore set is fresh so §1a stays safe to prune).

---

## 4. Recommended sequence

1. **§1 cleanup + `.gitignore`** (unblocks a clean commit) — S, do first.
2. **§H policy/security audit** + **§I secret/dead-code sweep** — high value, de-risks everything.
3. **§A tier registry + §B rate-limit** (shim-side) — the backbone for monetization.
4. **§B paywall (Stripe link → webhook) + §C invite links + CF Access automation** — the revenue path.
5. **§E upstream-sync cron** (PR-gated) — keeps the repo current while the above lands.
6. **§D runs/smithers upgrade** + **§G skills/gbrain re-test** — platform polish.
7. **§F broad functionality audit** — continuous, checklist-driven.

## 5. Clean-commit plan
- Branch: `chad-dev` (current). Commit in logical chunks, not one mega-commit.
- Before commit: apply §1b `.gitignore` + remove `.db.bak`s; review this week's
  terminal fixes (loader, relay.py, wrappers, skill docs) as one "terminal +
  agent bridge" commit; this doc as a "planning" commit.
- Follow the repo's Conventional Commits + SPDX rules (`CLAUDE.md`); run
  `make check` + tests pre-push.

---

## 5b. gbrain embed stack (fixed 2026-10-01)

After the ~10-day-ago pod restart, a `chad-ops doctor` found Chad badly degraded:
0 crons, skills dark, 39 binaries absent, gbrain embed 401. Recovered **without**
the stale-backup restore (premium chat had kept writing newer state): creds-sync
→ deploy → **forced fresh workspace backup** → gbrain-config → **chown** (gateway
WS connects were closing 1000 — the `/sandbox/.openclaw` ownership issue) →
bonjour-off → restart-gateway → cron-reload (10) → skills-register →
restart-gateway → gate-sync. One self-inflicted snag: the deploy pushed the
gbrain **wrapper** over the real binary without the `cp gbrain → gbrain-bin`
guard chad-setup uses, so `gbrain-bin` was missing — restored it as the launcher
`exec bun /usr/local/lib/gbrain/node_modules/gbrain/src/cli.ts` (extracted from
the sandbox image).

**The real embed bug (pre-existing since 2026-08-25):**
`nvidia/llama-nemotron-embed-1b-v2` (1536d) reached **EOL → 410 Gone**, so embed
coverage had been 0% for ~5 weeks. The only available NVIDIA embed successors
(`nemotron-3-embed-1b`, `llama-nemotron-embed-vl-1b-v2`) emit **2048d with no
truncation** — and **2048 exceeds pgvector's HNSW 2000-dim cap**, so the
1536-based schema could not just swap models. Fix: migrated the live
`content_chunks.embedding` column to **`vector(2048)` with NO hnsw index**
(seq-scan; fine at this brain's scale — 34 pages/42 chunks), repointed config to
`nemotron-3-embed-1b @ 2048`, re-embedded → **100% coverage, health 5→7/10**,
semantic search verified. Durability: `chad-ops.sh` (gbrain-config) + `chad-setup.sh`
updated to the new model/dims. **Open caveat:** a fresh `gbrain init` recreates
`vector(2048)` and its `CREATE INDEX ... hnsw` **fails** at >2000 dims — so either
(a) patch gbrain's schema to use `halfvec(2048)` + halfvec HNSW (durable, needs
image rebuild), or (b) switch to a local ≤2000-dim embed model (e.g. LM Studio's
`nomic-embed-text` @ 768, which also ends the NVIDIA EOL churn). Tracked as a
follow-up. See [[project_gbrain_embed_stack]].

### Follow-up: should gbrain move to local nomic-embed @768? (deferred)
Assessed 2026-10-01 — **defer; do it on a trigger, not now.**
- **Quality:** NOT an upgrade. `nemotron-3-embed-1b` (1B retrieval model, 2048d)
  is *higher* retrieval quality than `nomic-embed-text-v1.5` (~137M, 768d). The
  swap is a small quality trade-down.
- **Wins are operational, not quality:** (1) ends the NVIDIA embed **EOL churn**
  (410'd twice — the root cause of this whole incident); (2) 768 < 2000 → restores
  the **HNSW index** (seq-scan today; matters as the brain grows); (3) smaller
  vectors (~2.7×), lower latency, no cloud rate-limits.
- **Blocker/cost:** the chad **K8s pod** must reach LM Studio on the Mac host
  (`:1234`) — not the easy `host.docker.internal` path the OWUI container has;
  needs network wiring + an L7/OPA allowlist entry. Also couples gbrain to LM
  Studio being up.
- **Do-it trigger:** when (a) the next NVIDIA embed EOL lands, or (b) the brain
  grows enough that seq-scan on vector(2048) is slow. Until then, current
  nemotron@2048 is fine (works, higher quality, tiny brain).

## 6. Implementation research appendix (file-anchored, 2026-10-01)

Concrete anchors so each workstream is build-ready, not just named.

### Shim = the tier/rate-limit backbone — `scripts/openwebui/chad-shim.py`
A stdlib `BaseHTTPRequestHandler` (519 lines). Request flow is clean and the
whole monetization gate is **one place**:
- `_load_operator_allowlist()` **:69** — loads a flat `set` from env →
  `credentials.json` → file. **Replace with `_load_tier_registry()`** returning
  `{email: {tier, quota_daily, status, agent_id?}}` (same 3-source precedence).
- `_operator_context()` **:291** — builds `op` (`email, name, user_id, role,
  chat_id, slug, identity`). **Add `op["tier"]`** from the registry here.
- `do_POST()` **:348**, gate at **:413** (`if OPERATOR_ALLOWLIST and
  op["email"] not in OPERATOR_ALLOWLIST: DENY`). This becomes:
  - premium model + `op["tier"] != "premium"` → `DENY_MESSAGE` + upgrade CTA
    (already the shape today);
  - **rate-limit:** before `run_openclaw()`, check a per-email daily counter
    (small sqlite/JSON in the pod state dir); over the tier's `quota_daily` →
    refuse with an upgrade CTA. Fail-closed quota, fail-open identity (matches
    today's opt-in allowlist). Keep [[feedback_headless_smithers_nemotron_only]]
    in mind (no CLI fallback in cron).
- Registry lives in `credentials.json` (pod-local, uncommitted, in the backup
  set) so it persists across restarts; `chad-webui` gets `tier set/get` verbs.

### Upstream auto-sync (§E) — remotes already configured
`git remote`: `origin=tantodefi/NemoClaw`, **`upstream=NVIDIA/NemoClaw`**. So the
cron only needs: fetch upstream → sync branch → merge → **conflict ⇒ open a PR**
(never auto-merge to `chad-dev`/`main`; honor [[project_chad_autonomy_git_boundary]])
→ gate on `make check` + tests. Codify the Chad-local fileset that must survive
merges (`scripts/openwebui/`, `scripts/chad-*`, `docs/design/multi-user-chad.md`,
this doc). The `nemoclaw-maintainer-day/*` skills already encode merge priorities
— wrap them in a routine.

### Invite links + CF Access automation (§C) — token scope is the blocker
`CF_API_TOKEN` in `scripts/openwebui/.env` is **valid/active** but its scope is
**insufficient**: cache-purge is confirmed-denied (hit this during the terminal
work), and Access:Edit is unverified/likely absent. **Prereq:** mint/expand a
token with `Access: Apps and Policies:Edit` (+ `Cache Purge` while at it) before
building the invite Worker. Host the Worker + intake on **`supachad-landing`**
(already a Cloudflare Pages/Worker site: `wrangler.toml` + `index.html`) — add a
`/invite/<token>` route (KV-backed single-use) that calls the CF Access API +
flips the shim tier registry.

### Paywall/onboarding (§B) — host + flow
Intake + Stripe on `supachad-landing`. MVP ladder: Stripe **Payment Link**
(zero backend) → webhook Worker that, on `customer.subscription.active`, adds the
email to CF Access + sets `tier=premium` in the registry. Rate-limit lives in the
shim (above); OpenWebUI has no native quota.

### Runs → Smithers upgrade (§D) — version gap
`chad-smithers` pins `smithers-orchestrator@^0.26.1`; **latest is 0.32.0** (6
minor versions — expect API drift; `createSmithers()` primitives vs top-level
composites per [[reference_smithers_composites_import]]). Bump + reconcile first,
then execute `GATEWAY-UI-MIGRATION-PLAN.md` Upgrade A (live sync) behind
`CHAD_RUNS_GATEWAY=1`, then Upgrade B (components + Bun build).

### Security/policy audit (§H) — concrete targets
- 5 un-gated agent launch sites ([[project_chad_operator_allowlist_gate]]) — the
  shim gate only covers one path; the other launch sites can reach the agent
  without the allowlist. **Close these before monetizing.**
- Empty `CHAD_OPERATOR_ALLOWLIST` = fail-open — fine for opt-in today, but once a
  tier registry gates billing it must **fail-closed** for the premium model.
- L7/OPA: per-binary presets ([[feedback_openshell_l7_binary_identity]],
  [[feedback_l7_binary_symlink]]) — audit every outbound host the new Worker
  callbacks/Stripe/CF-API paths need.
- Run `/cso` (security skill) as the formal pass; secret scan (confirm
  `credentials.json` stays uncommitted — `.gitignore` already covers `secrets.*`).

---
_Linked memory: [[project_browservm_terminal_loader]], [[project_chad_autonomy_roadmap]],
[[project_chad_operator_allowlist_gate]], [[project_chad_pending]],
[[project_gbrain_embed_stack]], [[project_chad_autonomy_git_boundary]]._
