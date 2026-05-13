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

Read the PR body's "Related Issue" or "Fixes #" links to trace back to the original report. Prefer current issue labels such as `NV QA`, `UAT`, and `bug` over hardcoded reporter usernames when classifying discovery channel.

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

## Discover the Current E2E Architecture

Do **not** rely on a frozen job inventory in this skill. Before making recommendations, inspect the repository and recent GitHub Actions history:

```bash
# Workflow definitions and dispatch inputs
ls .github/workflows/*e2e*.yaml .github/workflows/main.yaml 2>/dev/null

# Current nightly jobs and conditions
python3 - <<'PY'
import yaml, pathlib
p = pathlib.Path('.github/workflows/nightly-e2e.yaml')
if p.exists():
    data = yaml.safe_load(p.read_text())
    for name, job in (data.get('jobs') or {}).items():
        print(name, 'if=' + str(job.get('if', '')))
PY

# Current test scripts / harnesses
find test/e2e -maxdepth 2 -type f | sort

# Recent workflow outcomes
gh run list --repo "$REPO" --workflow=nightly-e2e.yaml --limit 30 \
  --json databaseId,event,headBranch,status,conclusion,createdAt
```

For each relevant workflow, read the file directly to determine:
- trigger type (`schedule`, `pull_request`, `push`, `workflow_dispatch`, `workflow_call`)
- dispatch inputs and whether branch-specific refs are supported
- job names, skip conditions, runner labels, environment/secrets requirements
- whether the workflow runs against PR HEAD, base branch, or a generated branch

## Derive Current Coverage Gaps

Do **not** bake old bug counts, issue numbers, enabled/disabled states, or dated re-enablement plans into the skill. Recompute the gap inventory at runtime from:

1. Recent externally reported bugs (`NV QA`, `UAT`, `bug`, security labels)
2. Recent merged fix PRs and their linked issues
3. Recent nightly / PR E2E failures and passes
4. Current workflow definitions and test files
5. Open tracking issues labeled `e2e`, `test`, `ci/cd`, `arch-improve`, or related labels

Useful gap categories to check:

| Domain | What to inspect |
|--------|-----------------|
| Restricted execution | Non-root, Landlock, seccomp, `no-new-privileges`, sandbox file permissions |
| Onboard input validation | Bad env vars, invalid tokens, interrupted/resumed setup, port conflicts |
| Platform-specific environments | macOS, WSL, DGX Spark, Jetson, Docker/Colima variants, Brev/remote VMs |
| Networking / proxy / TLS | HTTP proxy rewrite, custom OpenAI-compatible endpoints, WebSocket tunneling, CA certificates |
| Lifecycle operations | create, destroy, rebuild, upgrade, snapshot, restore, multi-sandbox, failure recovery |
| Messaging / channels | Slack, Discord, Telegram, token rotation, policy presets, bridge lifecycle |
| Security boundary coverage | credential leaks, policy bypass, SSRF, dangerous workflow/secrets patterns |

For each suspected gap, provide evidence:
- one or more recent issue/PR/run links
- current tests that partially cover it
- missing assertion or missing execution mode
- whether adding coverage belongs in PR CI, scheduled nightly, manual regression, or a platform-specific workflow

## Current Tracking Sources

At runtime, search current tracking issues and project state instead of relying on issue numbers embedded here:

```bash
gh issue list --repo "$REPO" --state open --limit 100 \
  --search 'label:e2e OR label:test OR label:"ci/cd" OR label:arch-improve'

gh pr list --repo "$REPO" --state open --limit 100 \
  --search 'e2e OR test OR nightly OR workflow'
```

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

Build this table from the runtime gap analysis rather than from static entries:

| Priority | Action | Gap | Evidence | Effort |
|----------|--------|-----|----------|--------|
| **P0/P1/...** | <specific current action> | <gap domain> | <issue/PR/run links> | Low/Medium/High |

## Key Files

Discover key files at runtime from the current workflows, failing jobs, changed files, and grep results. Include only files you actually inspected.

## Tracking Issues

Discover current tracking issues at runtime with `gh issue list` / `gh search issues`; include status and updated date in the report.

## Related Skills

- `/skill:nemoclaw-e2e-health-review` — Audit recent nightly runs, find failures and patterns
- `/skill:nemoclaw-pr-review` — Pre-merge review against architecture and security model
- `CONTRIBUTING.md` and `src/lib/README.md` — Current build, test, and architecture guidance
- `.github/workflows/e2e-advisor.yaml` — Semantic PR-specific E2E recommendations
