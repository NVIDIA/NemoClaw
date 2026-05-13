---
name: nemoclaw-e2e-health-review
description: Comprehensive E2E health review for the NemoClaw repo. Audits the last 3 nightly E2E runs (job-level pass/fail, failure root causes), identifies merges that broke main, reviews open PRs addressing E2E failures (are they still relevant?), and surfaces themes across recent PR activity. Use when asking "e2e health", "nightly status", "what's failing", "e2e review", "test health", "CI health", "what broke main", or "nightly e2e report".
author: Julie Yaunches
author_email: jyaunches@nvidia.com

---

# NemoClaw E2E Health Review

Generate a comprehensive health report covering nightly E2E test results, merges that broke main, open remediation PRs, and thematic analysis of recent PR activity.

## Prerequisites

- `gh` (GitHub CLI) must be installed and authenticated.
- `jq` must be installed.
- You must be in a NemoClaw worktree or the repo root.

## Context

The NemoClaw repo has a rich E2E testing infrastructure:

### Nightly E2E Workflow (`.github/workflows/nightly-e2e.yaml`)

Runs on `schedule` (cron `0 0 * * *` UTC) and `workflow_dispatch`. Jobs run in parallel on `ubuntu-latest`:

| Job ID | What it tests |
|--------|--------------|
| `cloud-e2e` | Cloud inference (NVIDIA Endpoint API) — full install → onboard → verify → inference |
| `cloud-experimental-e2e` | Experimental cloud with custom policy, check-docs, network-policy skip, cleanup |
| `messaging-providers-e2e` | Provider/placeholder/L7-proxy chain for Telegram + Discord (fake tokens) |
| `token-rotation-e2e` | Rotating a messaging token and re-running onboard propagates new credential |
| `sandbox-survival-e2e` | Sandbox survival across gateway restarts |
| `hermes-e2e` | Hermes Agent — install → onboard --agent hermes → health probe → inference |
| `skip-permissions-e2e` | --dangerously-skip-permissions activates permissive policy |
| `sandbox-operations-e2e` | sandbox list/connect/status/logs/destroy, gateway recovery, multi-sandbox isolation |
| `inference-routing-e2e` | Credential isolation + error classification (invalid key, unreachable endpoint) |
| `network-policy-e2e` | deny-by-default, whitelist, live policy-add, dry-run, hot-reload, SSRF |
| `snapshot-commands-e2e` | Snapshot create/list/restore lifecycle |
| `shields-config-e2e` | Shields down/up, config get/set/rotate-token, audit trail |
| `rebuild-openclaw-e2e` | OpenClaw rebuild upgrade (old version → rebuild → verify workspace) |
| `upgrade-stale-sandbox-e2e` | Old NemoClaw → upgrade → stale sandbox detected and rebuilt |
| `rebuild-hermes-e2e` | Hermes rebuild upgrade |
| `gpu-e2e` | Local Ollama on GPU self-hosted runner (controlled by `GPU_E2E_ENABLED` var) |
| `notify-on-failure` | Auto-creates/updates a GitHub issue when any job fails |

**Concurrency:** `group: nightly-e2e`, `cancel-in-progress: true` — a `workflow_dispatch` run will cancel a running `schedule` run (this is a known issue).

### Other E2E Workflows

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| `e2e-brev.yaml` | `workflow_dispatch` / `workflow_call` | Ephemeral Brev cloud instance E2E (full, credential-sanitization, telegram-injection, messaging-providers) |
| `macos-e2e.yaml` | PRs + push to main | Build + vitest on macOS Apple Silicon; conditional full E2E if Docker available |
| `wsl-e2e.yaml` | PRs + push to main | Build + test inside WSL on Windows runner |
| `sandbox-images-and-e2e.yaml` | `workflow_call` from `main.yaml` | Build sandbox images + run E2E on every push to main |

### Main CI Gate (`.github/workflows/main.yaml`)

On every push to main: runs `checks` job (basic checks), then `sandbox-images-and-e2e` (builds images + runs E2E). Failures here mean a merge broke main.

### E2E Test Scripts (`test/e2e/`)

Shell-based test scripts. Each follows a pattern: Phase 0 (prerequisites), Phase 1 (pre-cleanup/install), Phase 2+ (test cases), final cleanup.

## Step 1: Identify the Repo

```bash
REPO="NVIDIA/NemoClaw"
echo "Repo: $REPO"
echo "Date: $(date '+%Y-%m-%d %H:%M %Z')"
```

## Step 2: Last 3 Nightly E2E Runs — Job-Level Results

Fetch the last several `nightly-e2e` workflow runs, filtering to `schedule` events first (the actual nightly cron). If there aren't 3 completed schedule runs (they often get cancelled by `workflow_dispatch` due to the shared concurrency group), supplement with `workflow_dispatch` runs on the `main` branch.

```bash
# Get all nightly runs (schedule + workflow_dispatch)
gh run list --repo "$REPO" --workflow=nightly-e2e.yaml --limit 50 \
  --json databaseId,event,conclusion,createdAt,headBranch | \
  jq '[.[] | select(.conclusion != "" and .conclusion != null and .conclusion != "cancelled")]' \
  > /tmp/nightly-runs.json

# Separate schedule vs dispatch
jq '[.[] | select(.event == "schedule")] | .[:3]' /tmp/nightly-runs.json > /tmp/nightly-schedule.json
jq '[.[] | select(.event == "workflow_dispatch" and .headBranch == "main")] | .[:3]' /tmp/nightly-runs.json > /tmp/nightly-dispatch-main.json

# Build the final prioritized set of 3 runs:
# - take up to 3 schedule runs first
# - fill any remaining slots from workflow_dispatch on main
jq -n \
  --slurpfile s /tmp/nightly-schedule.json \
  --slurpfile d /tmp/nightly-dispatch-main.json \
  '($s[0] + $d[0])[:3]' \
  > /tmp/nightly-selected.json
```

### 2a: Get job-level results for each run

For each run in `/tmp/nightly-selected.json`, fetch job-level details:

```bash
# For each run ID:
gh run view "$RUN_ID" --repo "$REPO" --json jobs \
  --jq '.jobs[] | {name: .name, conclusion: .conclusion, status: .status}'
```

### 2b: Categorize jobs

For each run, produce a table categorizing each job as:
- ✅ **success** — job passed
- ❌ **failure** — job failed (needs investigation)
- ⏭️ **cancelled** — was cancelled (often by concurrency group)
- 🚫 **skipped** — job condition not met (e.g., `gpu-e2e` when `GPU_E2E_ENABLED != true`)

### 2c: Identify failure patterns

Look across the 3 runs for repeating failures. If a job fails in 2+ of the 3 runs, flag it as a **persistent failure**. If it fails in only 1 run, flag it as **intermittent**.

Present a summary table:

```markdown
| Job | Night 1 (date) | Night 2 (date) | Night 3 (date) | Pattern |
```

## Step 3: Failure Root Cause Analysis

For each failed job across the 3 runs, fetch the failure logs:

```bash
gh run view "$RUN_ID" --repo "$REPO" --log-failed 2>&1 | head -200
```

**Important:** The `--log-failed` output can be very large. Focus on:
1. The last 50-100 lines of the failed job's output
2. Lines containing `FAIL`, `Error`, `error`, `exit code`, `timeout`, `killed`
3. The specific test assertion or phase that failed

For each failure, extract and report:
- **Job name**
- **Phase/test case** that failed (e.g., "Phase 5: TC-NET-03")
- **Root cause category**: one of:
  - `infra` — runner/nvm/Docker/network issue (e.g., GitHub runner image change, nvm HTTP 500)
  - `test-bug` — the test script itself has a bug (wrong grep, bad assertion)
  - `product-bug` — the test correctly caught a real product regression
  - `timeout` — test exceeded its timeout
  - `flaky` — non-deterministic failure (timing, resource contention)
  - `concurrency` — cancelled by concurrency group
- **Error excerpt** (2-3 key lines)

### Special: Concurrency Cancellation Pattern

The nightly workflow uses `concurrency: { group: nightly-e2e, cancel-in-progress: true }`. If anyone triggers a `workflow_dispatch` run while the nightly cron is running, the cron run gets cancelled. Note whether the last 2 nightly cron runs were cancelled and flag this as a systemic issue.

## Step 4: Recent Merges That Broke Main

Query the `main` workflow for failures on the `main` branch in the last 7 days:

```bash
gh run list --repo "$REPO" --workflow=main --branch main --limit 50 \
  --json databaseId,conclusion,createdAt,displayTitle | \
  jq '[.[] | select(.conclusion == "failure") |
  select(.createdAt >= "'$(date -v-7d '+%Y-%m-%dT00:00:00Z' 2>/dev/null || date -d '7 days ago' '+%Y-%m-%dT00:00:00Z')'")]'
```

For each failure:
1. **Which job failed** (fetch job-level results with `gh run view`)
2. **Which PR/commit caused it** (from `displayTitle` — usually the PR title)
3. **Was it fixed and how quickly?** (check if a revert or fix was merged shortly after)
4. **Is main currently green?** (check the latest run)

Also check the `macos-e2e` and `wsl-e2e` workflows for main branch failures:

```bash
gh run list --repo "$REPO" --workflow=macos-e2e.yaml --branch main --limit 10 \
  --json conclusion,createdAt,displayTitle | \
  jq '[.[] | select(.conclusion == "failure")]'

gh run list --repo "$REPO" --workflow=wsl-e2e.yaml --branch main --limit 10 \
  --json conclusion,createdAt,displayTitle | \
  jq '[.[] | select(.conclusion == "failure")]'
```

Present a timeline:
```markdown
| Date | Commit/PR | What Failed | Fixed By | Time to Fix |
```

## Step 5: Open PRs Addressing E2E Failures

Find all open PRs with `E2E`, `CI/CD`, or testing-related labels:

```bash
# E2E-labeled PRs
gh pr list --repo "$REPO" --state open --search "label:E2E" \
  --json number,title,author,createdAt,labels,url --limit 50

# CI/CD-labeled PRs
gh pr list --repo "$REPO" --state open --search "label:CI/CD" \
  --json number,title,author,createdAt,labels,url --limit 50

# Also search for e2e/nightly/test-related PRs by title
gh pr list --repo "$REPO" --state open --search "e2e OR nightly in:title" \
  --json number,title,author,createdAt,labels,url --limit 50
```

Deduplicate results by PR number.

### 5a: Relevance check

For each open E2E/CI PR, determine if it's still relevant:

1. **Does it fix a failure still happening?** Cross-reference the PR's target (from title, body, or linked issue) against the failures found in Step 3.
2. **Is it stale?** PRs open > 7 days with no recent activity may be abandoned.
3. **Has the fix already landed via a different PR?** Check if the issue it references was closed by another merge.
4. **Review status:** Does it have approvals? Changes requested? No reviews?

Categorize each PR as:
- 🟢 **Still needed** — fixes a failure still occurring in nightly
- 🟡 **Partially relevant** — addresses a failure that's intermittent or changed
- 🔴 **Possibly stale** — the failure it targets no longer occurs, or another PR fixed it
- ⚪ **New coverage** — adds new tests rather than fixing failures

### 5b: Gap analysis

Are there **failures with no open PRs addressing them**? List any persistent or intermittent failures from Step 3 that have no associated open PR.

## Step 6: Themes Across Recent PR Activity

Analyze PRs merged to `main` in the last 7 days:

```bash
gh pr list --repo "$REPO" --state merged --base main \
  --search "merged:>=$(date -v-7d '+%Y-%m-%d' 2>/dev/null || date -d '7 days ago' '+%Y-%m-%d')" \
  --json number,title,author,mergedAt,labels,additions,deletions \
  --limit 100
```

### 6a: Categorize by theme

Group PRs into themes based on title prefixes, labels, and content:

- **E2E / Testing** — PRs with `E2E`, `CI/CD`, `enhancement: testing` labels or `test(`, `fix(e2e)`, `fix(test)`, `ci(` prefixes
- **Bug Fixes** — PRs with `bug`, `fix` labels or `fix(` prefix
- **Features** — PRs with `enhancement` label or `feat(` prefix
- **Security** — PRs with `security` label
- **Documentation** — PRs with `documentation` label or `docs(` prefix
- **Dependencies** — PRs from `app/dependabot`
- **Platform** — PRs with `Platform:` labels

### 6b: E2E investment analysis

Calculate what fraction of recent PRs are E2E/testing-related. This gives a sense of how much effort the team is spending on test infrastructure vs. product work.

### 6c: Active contributors

List who's contributing to E2E work (author breakdown for E2E-themed PRs).

## Step 7: E2E Strategy Assessment

Based on all data gathered, provide an assessment of the overall E2E testing strategy:

### 7a: Coverage gaps

Compare the nightly E2E job list against the test scripts in `test/e2e/`. Are there test scripts not included in the nightly workflow?

```bash
# Scripts in test/e2e/
ls test/e2e/test-*.sh

# Jobs in nightly-e2e.yaml (from the workflow file)
grep -E '^\s+\w+-e2e:' .github/workflows/nightly-e2e.yaml
```

### 7b: Reliability score

Calculate a simple reliability score for the last 3 nights:
- `(total passing jobs across 3 runs) / (total jobs that ran across 3 runs) × 100`
- Also note how many of the 3 scheduled runs were actually cancelled vs completed.

### 7c: Systemic issues

Flag recurring patterns:
- **Concurrency cancellation:** Are nightly cron runs routinely cancelled by dispatch runs?
- **Infrastructure flakiness:** Are failures caused by runner environment issues (nvm, Docker, network)?
- **Test script maintenance debt:** Are test scripts failing due to stale assertions after product changes?
- **Missing teardown:** Are sandbox leaks from failed runs affecting subsequent runs?

### 7d: Recommendations

Provide 3-5 actionable recommendations prioritized by impact, such as:
- Fix the concurrency group so nightly cron isn't cancelled by dispatches
- Address persistent failure X with PR Y (or open a new issue)
- Retire/update stale test assertions
- Add missing nightly coverage for script Z

## Output Format

Use markdown with clear section headers, tables, emoji indicators, and callout blocks. The full output should read as a single health report:

```markdown
# NemoClaw E2E Health Report
**Date:** <today> | **Repo:** NVIDIA/NemoClaw

## 1️⃣  Nightly E2E Results — Last 3 Runs
### Job-Level Results Matrix
### Failure Pattern Summary
### Persistent Failures
### Intermittent Failures

## 2️⃣  Failure Root Causes
### <Job Name> — <date>
  - Phase/test: ...
  - Category: ...
  - Error: ...

## 3️⃣  Merges That Broke Main (Last 7 Days)
### Timeline
### Is Main Currently Green?

## 4️⃣  Open PRs Addressing E2E Failures
### 🟢 Still Needed
### 🟡 Partially Relevant
### 🔴 Possibly Stale
### ⚪ New Coverage
### ⚠️ Failures With No Open PR

## 5️⃣  Themes Across Recent PRs
### Theme Breakdown
### E2E Investment Ratio
### Active E2E Contributors

## 6️⃣  E2E Strategy Assessment
### Reliability Score
### Coverage Gaps
### Systemic Issues
### 🎯 Top Recommendations
```

## Notes

- The `gh` CLI may truncate large JSON outputs. When this happens, the output is saved to a temp file — always check for truncation messages and use the temp file path with `jq`.
- The nightly workflow's `concurrency: { group: nightly-e2e, cancel-in-progress: true }` means `workflow_dispatch` runs cancel in-progress `schedule` runs. This is a known issue and should always be flagged if observed.
- `gpu-e2e` is gated by `vars.GPU_E2E_ENABLED` — it being `skipped` is normal unless the var is set to `true`.
- `cloud-experimental-e2e` being `skipped` is normal on `workflow_dispatch` runs from non-main branches that don't have the `NVIDIA_API_KEY` secret available in the environment.
- When analyzing failure logs, look for NemoClaw-specific patterns: `install.sh failed`, `nemoclaw onboard` errors, `sandbox` timeout, `K3s` bootstrap failures, `Docker` errors, and `nvm` issues.
- The `notify-on-failure` job auto-creates issues labeled `CI/CD,bug` with title "Nightly E2E failed" — check these for historical context.
- Always run `gh` API calls in parallel where possible to minimize wall-clock time.
