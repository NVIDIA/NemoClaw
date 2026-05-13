---
name: nemoclaw-e2e-strategy
description: NemoClaw E2E testing strategy, coverage gaps, and gap analysis patterns. Use when planning E2E work, evaluating whether a change needs E2E coverage, assessing test gaps, deciding where to add tests, or when someone asks "would our tests catch this?" or "what's our E2E strategy?" or "what are our testing gaps?". Also use when writing new E2E tests, reviewing a PR's test plan, or re-enabling cloud-experimental-e2e.
author: Julie Yaunches
author_email: jyaunches@nvidia.com

---

# NemoClaw E2E Testing Strategy & Gap Analysis

This skill encodes the E2E testing strategy, known coverage gaps, and patterns for identifying where tests are missing. It's grounded in ongoing analysis of what bugs E2E catches vs. what reaches NV QA or community users first.

## When to Use

- Planning E2E test work or writing new E2E tests
- Evaluating whether a code change has adequate test coverage
- Answering "would our tests catch this?" for a proposed change
- Reviewing a PR's test plan
- Re-enabling cloud-experimental-e2e or adding new nightly jobs
- Periodic gap analysis ("what are we missing?")

## How to Use This Skill for Gap Analysis

When performing a gap analysis, follow this process:

### Step 1: Gather Recent Bug Fix PRs

```bash
REPO="NVIDIA/NemoClaw"
SINCE="$(date -v-21d '+%Y-%m-%dT00:00:00Z' 2>/dev/null || date -d '21 days ago' '+%Y-%m-%dT00:00:00Z')"

# All merged fix PRs in the period
gh pr list --repo "$REPO" --state merged --limit 200 \
  --json number,title,author,mergedAt,labels \
  --jq "[.[] | select(.mergedAt >= \"$SINCE\") | select(.title | test(\"^fix\"))] | sort_by(.mergedAt) | .[] | \"\(.mergedAt) #\(.number) @\(.author.login) \(.title)\""
```

### Step 2: Gather Bug Issues Filed in the Period

```bash
# NV QA bugs
gh issue list --repo "$REPO" --state all --limit 200 --label "NV QA" \
  --json number,title,state,createdAt,author \
  --jq "[.[] | select(.createdAt >= \"$SINCE\")] | sort_by(.createdAt) | .[] | \"\(.createdAt) #\(.number) [\(.state)] @\(.author.login) \(.title)\""

# Community bugs (non-NV QA, non-bot)
gh issue list --repo "$REPO" --state all --limit 200 --label "bug" \
  --json number,title,state,createdAt,author,labels \
  --jq "[.[] | select(.createdAt >= \"$SINCE\") | select(.labels | map(.name) | any(test(\"NV QA\")) | not) | select(.author.login != \"app/github-actions\")] | sort_by(.createdAt) | .[] | \"\(.createdAt) #\(.number) [\(.state)] @\(.author.login) \(.title)\""
```

### Step 3: Check Nightly E2E Run History

```bash
# Last 10 completed nightly runs (schedule + dispatch, excluding cancelled)
gh run list --repo "$REPO" --workflow=nightly-e2e.yaml --limit 30 \
  --json databaseId,conclusion,createdAt,event \
  --jq '[.[] | select(.conclusion != "" and .conclusion != null and .conclusion != "cancelled")] | .[:10] | .[] | "\(.createdAt) [\(.conclusion)] (\(.event)) run:\(.databaseId)"'

# Job-level results for a specific run
gh run view <RUN_ID> --repo "$REPO" --json jobs \
  --jq '.jobs[] | select(.conclusion != "skipped") | "\(.conclusion) \(.name)"'
```

### Step 4: Categorize Each Fix PR by Discovery Channel

For each fix PR, determine how the bug was found:

| Category | Description | What It Means |
|----------|-------------|---------------|
| **A: NV QA found** | QA team filed the bug, E2E didn't catch it | Test gap — E2E should cover this class |
| **B: Community found** | External user reported via Slack/Discord/GitHub | Test gap — E2E should have caught before users |
| **C: Nightly E2E caught** | Nightly run failed, fix PR addresses it | Working as designed |
| **D: Internal dev/review** | Found during code review or security audit | May or may not need E2E |
| **E: E2E infra fix** | Fix to the test infrastructure itself | Meta — keeps tests healthy |

Read the PR body's "Related Issue" or "Fixes #" links to trace back to the original report. Check the issue author — NV QA team members (`@zNeill`, `@hulynn`, `@wangericnv`, `@xiaoming-nv`, `@cr7258`) file QA bugs. Community reporters have varied usernames.

### Step 5: Group Uncaught Bugs by Failure Domain

After categorizing, group Category A + B bugs by what area of the system they affect. Look for clusters — if 5+ bugs hit the same domain, that's a systematic gap, not a one-off.

Common failure domains in NemoClaw:

| Domain | What It Covers | Example Bugs |
|--------|---------------|--------------|
| Non-root / restricted execution | Landlock, seccomp, no-new-privileges, Brev Launchable, DGX Spark | Entrypoint crashes, permission denied, blocked syscalls |
| Onboard input validation | Bad env vars, invalid tokens, stale sessions, wrong provider | Crashes on bad input instead of graceful error |
| Rebuild / lifecycle operations | rebuild, destroy, upgrade, snapshot | Data loss, non-atomic operations, registry corruption |
| Platform-specific environments | Docker versions, macOS/WSL/Jetson/Brev, kernel features | Works on ubuntu-latest but fails on user's machine |
| Networking / proxy / TLS | HTTP proxy rewrite, WebSocket tunneling, CA certificates, port conflicts | Connection errors, TLS failures, auth leaks |
| Gateway stability / auth | Unhandled rejections, token injection, dashboard health | Gateway crashes, "Missing token", "Offline" status |
| Messaging / channel integration | Slack/Discord/Telegram bridge lifecycle | Channel fails silently, wrong policy, token not propagated |
| Policy / permissions | Binary allowlists, file permissions, policy presets | 403 errors, missing tools, wrong permissions |

### Step 6: Assess E2E Catch Rate

Calculate:
- **Total externally-reported bugs** = Category A + Category B + Category C
- **Caught by E2E** = Category C
- **Catch rate** = Category C / Total externally-reported

If the catch rate is below 30%, there are systematic gaps. Map the uncaught bugs to the gap inventory below and identify which gaps are responsible for the most misses.

### Step 7: Produce Recommendations

For each failure domain with 3+ uncaught bugs, recommend:
1. Which existing E2E job should be extended (or which new job is needed)
2. What specific test case would catch the pattern
3. Effort estimate (low/medium/high)
4. Whether it's a nightly job, push-to-main gate, or manual workflow

## Current E2E Architecture

### Nightly E2E Workflow (`.github/workflows/nightly-e2e.yaml`)

Runs daily at midnight UTC and on `workflow_dispatch`. All jobs run on `ubuntu-latest` (root privileges, Docker available).

| Job | What It Tests | Status |
|-----|--------------|--------|
| `cloud-e2e` | Full install → onboard → cloud inference | ✅ Running |
| `cloud-experimental-e2e` | Landlock, security checks, TUI smoke, custom policy, docs | ⚠️ **DISABLED** (`vars.CLOUD_EXPERIMENTAL_E2E_ENABLED`) |
| `messaging-providers-e2e` | Provider/placeholder/L7-proxy chain (Telegram + Discord, fake tokens) | ✅ Running |
| `token-rotation-e2e` | Rotating messaging token propagates to sandbox | ✅ Running |
| `sandbox-survival-e2e` | Sandbox survives gateway restart | ✅ Running |
| `hermes-e2e` | Hermes Agent install → onboard → health → inference | ✅ Running |
| `skip-permissions-e2e` | `--dangerously-skip-permissions` activates permissive policy | ✅ Running |
| `sandbox-operations-e2e` | list/connect/status/logs/destroy, gateway recovery, multi-sandbox | ✅ Running |
| `inference-routing-e2e` | Credential isolation + error classification | ✅ Running |
| `network-policy-e2e` | deny-by-default, whitelist, live policy-add, dry-run, hot-reload, SSRF | ✅ Running |
| `deployment-services-e2e` | Deployment lifecycle operations | ✅ Running |
| `snapshot-commands-e2e` | Snapshot create/list/restore lifecycle | ✅ Running |
| `shields-config-e2e` | Shields down/up, config get/set/rotate-token, audit trail | ✅ Running |
| `rebuild-openclaw-e2e` | OpenClaw rebuild upgrade (old → rebuild → verify workspace) | ✅ Running |
| `upgrade-stale-sandbox-e2e` | Old NemoClaw → upgrade → stale sandbox detected and rebuilt | ✅ Running |
| `rebuild-hermes-e2e` | Hermes rebuild upgrade | ✅ Running |
| `diagnostics-e2e` | Diagnostic information collection | ✅ Running |
| `gpu-e2e` | Local Ollama on GPU self-hosted runner | ⚠️ Gated by `GPU_E2E_ENABLED` |

### Other E2E Workflows

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| `sandbox-images-and-e2e.yaml` | Every push to main | Build sandbox images + gateway isolation + port override E2E |
| `e2e-brev.yaml` | `workflow_dispatch` | Ephemeral Brev cloud instance E2E |
| `macos-e2e.yaml` | PRs + push to main | Build + vitest on macOS Apple Silicon |
| `wsl-e2e.yaml` | PRs + push to main | Build + test inside WSL on Windows |

### E2E Test Scripts (`test/e2e/`)

Shell-based scripts following phase patterns: Phase 0 (cleanup), Phase 1 (prereqs/install), Phase 2+ (test cases), final cleanup.

### GPU / Self-Hosted Runners

Use the E2E Advisor recommendations and current workflow definitions to decide when GPU or self-hosted runner validation is needed. Keep runner-specific recovery notes outside the shared repo skills unless the infrastructure is team-owned and documented.

## Known Coverage Gaps

These gaps are derived from the pattern of bugs that repeatedly reach NV QA or community before E2E catches them.

### GAP 1: Non-Root / Landlock / Seccomp Execution — CRITICAL

**What's missing:** Every nightly E2E sandbox runs as **root**. The Brev Launchable and DGX Spark run with `no-new-privileges` / Landlock / seccomp restrictions. The only Landlock test coverage (`cloud-experimental-e2e`) has been disabled.

**Bug pattern it produces:** Entrypoint writes that pass DAC but fail under Landlock. Syscalls blocked by seccomp (`getifaddrs`, `os.networkInterfaces`). Token/config injection that assumes writable paths. File permission bugs that only manifest without root.

**Bugs in this gap (Apr 7–27):** #2472, #2482, #2427, #2456, #2478, #2466, #2376 — **7 bugs, including a 5-day outage**.

**cloud-experimental-e2e re-enablement status:**
The job definition exists at line 77 of `nightly-e2e.yaml`, gated by `vars.CLOUD_EXPERIMENTAL_E2E_ENABLED == 'true'`. All four original blockers from Issue #2104 are resolved:
- ✅ check-docs parity (Phase 5f) — fixed by #2446/#2388
- ✅ Landlock read-only failures — Issue #1739 closed, OpenShell fix in v0.0.29+
- ✅ Token rotation timeouts — passing in nightly
- ✅ Snapshot ambiguous matching — passing in nightly

To re-enable: set `CLOUD_EXPERIMENTAL_E2E_ENABLED` to `true` in repo variables. If Phase 5f fails again, use `E2E_CLOUD_EXPERIMENTAL_SKIP_TAGS=phase5f` — do NOT disable the entire job.

**What cloud-experimental covers:**
- `04-landlock-readonly.sh` — `.bashrc`/`.profile`/`.openclaw` are Landlock read-only
- `03-security-checks.sh` — API key not in `ps` output
- `02-inference-local-http.sh` — `https://inference.local/v1/models` responds from inside sandbox
- Phase 5b — live chat completion inside sandbox
- Phase 5e — `openclaw tui` smoke (expect-driven)

### GAP 2: Onboard Input Validation / Error Recovery

**What's missing:** Nightly E2E runs a single happy-path onboard with valid inputs. No tests exercise bad inputs, edge cases, or recovery from partial failures.

**Bug pattern it produces:** Bad env var crashes onboard instead of graceful error. Stale session blocks re-onboard. Invalid credentials accepted silently. Port conflicts show stack traces.

**Bugs in this gap (Apr 7–27):** #2434, #2430, #2428, #2389, #2304, #2413, #2220 — **7 bugs**.

**What's needed:** An onboard negative-path E2E job that:
- Passes invalid `NEMOCLAW_POLICY_MODE` and verifies graceful fallback
- Passes an invalid API key and verifies rejection message
- Runs onboard twice on the same port and verifies conflict message (not stack trace)
- Interrupts onboard mid-way and verifies `--resume` works correctly
- Verifies non-interactive mode respects all `NEMOCLAW_*` env vars

### GAP 3: Platform-Specific Environments

**What's missing:** Nightly E2E runs on `ubuntu-latest` only. macOS (`macos-e2e.yaml`) and WSL (`wsl-e2e.yaml`) run vitest but not full sandbox E2E. No Jetson, no Docker 26+, no Colima.

**Bug pattern it produces:** Works on ubuntu-latest but fails on user's machine. Docker version differences, kernel feature gaps, path differences, cgroup v2 issues.

**Bugs in this gap (Apr 7–27):** #2487, #2418, #2347, #2348, #2096, #2514 — **5 bugs**.

**What's needed:** At minimum, the nightly should test against Docker 26+ (the default for new installs) since it changes the storage driver default. Platform-specific onboard (macOS with Colima, WSL2) is harder but high-value.

### GAP 4: FORWARD-Mode Proxy / Custom Endpoints

**What's missing:** All E2E inference goes through the DNS-rewritten NVIDIA Endpoints path. Custom OpenAI-compatible endpoints (deepinfra, together.ai, etc.) use the FORWARD-mode proxy branch, never tested.

**Bug pattern it produces:** Proxy field leaks, TLS mismatches, header corruption — only visible when routing through a forward proxy to a non-NVIDIA endpoint.

**Bugs in this gap (Apr 7–27):** #2490, #2296, #2345, #2346 — **4 bugs**.

**What's needed:** An E2E test that configures a custom endpoint and sends a chat completion through the FORWARD-mode proxy path. PR #2490 added unit-level coverage (`http-proxy-fix-rewrite.test.ts`, `http-proxy-fix-e2e.test.ts`) which pins every strip, but the full sandbox → gateway → proxy → upstream path isn't exercised.

### GAP 5: Rebuild / Lifecycle Operations

**What's missing:** `rebuild-openclaw-e2e` tests the happy-path rebuild. No tests for `--from` Dockerfile, multi-sandbox, gateway drift, or failure recovery.

**Bug pattern it produces:** Non-atomic rebuild destroys sandbox before recreate can succeed. Registry corruption when gateway name drifts. `--from` path not forwarded on resume.

**Bugs in this gap (Apr 7–27):** #2302, #2366, #2330, #2201 — **4 bugs**.

**What's needed:** Extend `rebuild-openclaw-e2e` with:
- Rebuild with `--from` Dockerfile — verify the path survives resume
- Stop/start gateway between operations — verify registry survives
- Fail the recreate step intentionally — verify backup is usable

### GAP 6: Brev Launchable Install Flow

**What's missing:** Community users install via `curl ... | PLUGIN_REF=main bash`, getting main HEAD (not a tagged release). No CI gate validates this path.

**Bug pattern it produces:** Breaking changes on main reach Brev Launchable users before any release validation.

**What's needed:** A nightly or per-push smoke test that runs `launch-plugin.sh` with `PLUGIN_REF=main` and verifies gateway starts + basic inference works.

### GAP 7: Coupling Security Tests to Unrelated Checks

**What's missing:** A design principle preventing security-relevant test phases from being disabled by cosmetic failures.

**Pattern it produces:** `cloud-experimental-e2e` was disabled for a month because Phase 5f (docs parity) failed — taking Landlock, TUI, and security coverage with it.

**Principle going forward:**
- Security-critical phases should be in a separate job OR use `E2E_CLOUD_EXPERIMENTAL_SKIP_TAGS` to exclude non-critical phases
- The job already supports tag filtering via `E2E_CLOUD_EXPERIMENTAL_ONLY_TAGS` and `E2E_CLOUD_EXPERIMENTAL_SKIP_TAGS`
- Never disable an entire multi-phase job because one non-security phase fails

## Decision Framework: Does This Change Need E2E?

### Definitely needs E2E 🔴

| Change Area | Why |
|-------------|-----|
| `scripts/nemoclaw-start.sh` or entrypoint scripts | Shell behavior under `set -e`, variable expansion, process lifecycle differ between root and non-root |
| `Dockerfile` or build-time config | Layer ordering, permissions, baked values need real container |
| Gateway auth / token flow | Token generation, injection, export, runtime file paths |
| HTTP proxy / request rewriting | Forward vs DNS-rewrite paths, header stripping, TLS |
| OpenShell version bump | Landlock policy changes, seccomp restrictions, sandbox semantics |
| Network policies | Egress rules, SSRF filters, proxy routing |
| Sandbox lifecycle operations | Create, destroy, rebuild, snapshot, connect |
| Landlock / security policies | Only testable under real enforcement |

### Needs E2E on specific execution mode 🟡🔴

| Change | Required E2E Mode |
|--------|-------------------|
| Writes to `.bashrc` / `.profile` / `.openclaw` in entrypoint | Non-root / Landlock mode |
| Token / credential injection at startup | Both root and non-root |
| Process preloads (`NODE_OPTIONS=--require`) | Non-root mode (Landlock may block reads) |
| Network syscalls (`os.networkInterfaces`) | Seccomp-restricted mode |
| Custom endpoint / proxy configuration | FORWARD-mode proxy path |
| Platform-specific code (Docker version, Colima, WSL) | That specific platform |

### Unit tests sufficient 🟢

- Pure logic / config transforms
- Type-only changes
- Documentation
- CLI argument parsing (no Docker/sandbox interaction)
- Deterministic utilities

## Priority-Ordered Action Items

| Priority | Action | Gap | Bugs It Would Have Caught | Effort |
|----------|--------|-----|--------------------------|--------|
| **P0** | Re-enable `cloud-experimental-e2e` | GAP 1 | 7 bugs including 5-day outage | Low — flip repo variable |
| **P1** | Add onboard negative-path tests | GAP 2 | 7 onboard validation bugs | Medium |
| **P2** | Add FORWARD-mode proxy E2E | GAP 4 | 4 networking bugs | Medium |
| **P3** | Test rebuild with `--from` + failure recovery | GAP 5 | 4 lifecycle bugs | Medium |
| **P4** | Add Docker 26+ to nightly matrix | GAP 3 | overlayfs break + others | Medium |
| **P5** | Add Brev Launchable install-flow smoke | GAP 6 | Community install breakage | Medium |
| **P6** | Decouple Phase 5f from security phases | GAP 7 | Prevents future coverage loss | Low |

## Key Files

| File | Purpose |
|------|---------|
| `.github/workflows/nightly-e2e.yaml` | Nightly E2E workflow — all job definitions |
| `test/e2e/test-e2e-cloud-experimental.sh` | Cloud-experimental main script (Phases 0–6) |
| `test/e2e/e2e-cloud-experimental/checks/` | Security check scripts (Landlock, API key leak, inference) |
| `test/e2e/e2e-cloud-experimental/openclaw-tui-in-sandbox.sh` | TUI smoke test |
| `test/e2e/test-full-e2e.sh` | Full cloud E2E (install → onboard → inference) |
| `scripts/nemoclaw-start.sh` | Main sandbox entrypoint |
| `scripts/lib/sandbox-init.sh` | Shared entrypoint library |
| `nemoclaw-blueprint/scripts/http-proxy-fix.js` | HTTP proxy rewrite |
| `test/http-proxy-fix-rewrite.test.ts` | Proxy field stripping unit tests |

## Tracking Issues

| Item | Status | What |
|------|--------|------|
| Issue #2104 | OPEN | Nightly E2E triage & fix plan (all 4 re-enablement blockers resolved) |
| Issue #1739 | CLOSED | OpenShell Landlock enforcement (fixed in v0.0.29) |
| Issue #2390 | OPEN | Dashboard delivery chain consolidation |

## Related Skills

- `/skill:nemoclaw-e2e-health-review` — Audit recent nightly runs, find failures and patterns
- `/skill:nemoclaw-pr-review` — Pre-merge review against architecture and security model
- `CONTRIBUTING.md` and `src/lib/README.md` — Current build, test, and architecture guidance
- `.github/workflows/e2e-advisor.yaml` — Semantic PR-specific E2E recommendations
