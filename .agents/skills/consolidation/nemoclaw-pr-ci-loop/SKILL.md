---
name: nemoclaw-pr-ci-loop
description: Persistent CI enforcement loop for a single NemoClaw PR. Monitors PR checks, waits for CodeRabbit E2E recommendations, triggers recommended tests, fixes failures, and loops until fully green. Designed for /loop usage. Use when user says "get CI green", "fix CI", "loop until green", "enforce CI", "keep going until tests pass", "CI loop", "make this PR green", or wants automated CI shepherding on a PR.
author: Julie Yaunches
author_email: jyaunches@nvidia.com

---

# NemoClaw PR CI Enforcement Loop

A persistent loop that shepherds a single PR to fully-green CI. Monitors checks, triggers E2E tests, diagnoses failures, applies fixes, and repeats until done.

**Designed for `/loop` usage** — e.g., `/loop 5m /nemoclaw-pr-ci-loop`

## When to Use

- After opening a PR and wanting all CI to go green without manual babysitting
- When PR checks are failing and you want automated fix-and-retry
- When you want E2E tests triggered and validated before merge
- When CodeRabbit has posted E2E recommendations and you want them actioned

## Constants

```
WORKTREE_BASE="${NEMOCLAW_WORKTREE_BASE}"
REPO="NVIDIA/NemoClaw"
```

## Inputs

The skill needs ONE of:
- A PR number (explicit)
- The current worktree (inferred from `pwd` + branch → open PR)

## Persistence: Checkpoint & Resume

The loop MUST survive session death. All state is checkpointed to disk.

### Checkpoint File

```
~/.nemoclaw/ci-loop/<PR_NUMBER>.json
```

Schema:
```json
{
  "pr": 3128,
  "branch": "issue-2342-brev-launchable-version-pin-and-gateway-token",
  "worktree": "${NEMOCLAW_WORKTREE_BASE}/issue-2342",
  "started": "2026-05-06T15:00:00Z",
  "iteration": 5,
  "status": "waiting_for_e2e",
  "waiting_for": {
    "type": "e2e_run",
    "run_id": 25445645261,
    "jobs": ["device-auth-health-e2e", "cloud-e2e"],
    "triggered_at": "2026-05-06T15:44:50Z"
  },
  "coderabbit_e2e_jobs": ["cloud-e2e", "sandbox-operations-e2e"],
  "e2e_triggered": true,
  "fixes_applied": [
    {
      "iteration": 2,
      "timestamp": "2026-05-06T15:10:00Z",
      "issue": "E2E timeout: 15m too short for cold Docker build",
      "fix": "Bumped workflow timeout to 30m, script timeout to 1200s",
      "commit": "e0c18a201"
    }
  ],
  "log": [
    {"iteration": 1, "timestamp": "...", "action": "...", "result": "..."}
  ]
}
```

### On Startup: Always Check for Existing Checkpoint

```bash
CHECKPOINT="$HOME/.nemoclaw/ci-loop/${PR_NUMBER}.json"
if [ -f "$CHECKPOINT" ]; then
  # RESUME from where we left off
  # Read status, iteration, waiting_for, etc.
else
  # FRESH START — create new checkpoint
fi
```

**The first thing this skill does on EVERY invocation is check for a checkpoint.**
If one exists, it resumes. If not, it starts fresh.

### Status Values

| Status | Meaning | Next Action |
|--------|---------|-------------|
| `checking_pr_ci` | Waiting for PR checks to complete | Poll `gh pr checks` |
| `fixing_ci` | Actively fixing a failure | Apply fix, push, update to `checking_pr_ci` |
| `waiting_for_coderabbit` | PR CI green, waiting for CodeRabbit E2E comment | Poll PR comments |
| `triggering_e2e` | About to dispatch E2E | Dispatch, record run_id, update to `waiting_for_e2e` |
| `waiting_for_e2e` | E2E dispatched, waiting for results | Poll run status |
| `fixing_e2e` | E2E failed, applying fix | Apply fix, push, update to `checking_pr_ci` |
| `complete` | All green | Produce summary, delete checkpoint |
| `blocked` | Unfixable failure, needs human | Report and stop |

### Checkpoint Updates

Write the checkpoint after EVERY state transition:
- After pushing a fix
- After triggering an E2E run
- After detecting a new failure
- After confirming a check passed

---

## Kickstart Mechanism: Self-Spawning Background Watcher

When waiting for long-running CI or E2E (10-30 minutes), the session may die.
The skill solves this by spawning a **background watcher process** on its first
run that periodically re-invokes the agent until the loop completes.

### How It Works

On the FIRST invocation (fresh start), after creating the checkpoint, the skill
spawns a background watcher:

```bash
# Spawn background watcher (runs until checkpoint is removed)
CI_LOOP_DIR="$HOME/.nemoclaw/ci-loop"
PIDFILE="${CI_LOOP_DIR}/${PR_NUMBER}.pid"
LOGFILE="${CI_LOOP_DIR}/${PR_NUMBER}.log"
CHECKPOINT="${CI_LOOP_DIR}/${PR_NUMBER}.json"
INTERVAL=300  # 5 minutes

# Only spawn if not already running
if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  echo "Watcher already running (PID $(cat $PIDFILE))"
else
  nohup bash -c '
    echo $$ > '"$PIDFILE"'
    while [ -f '"$CHECKPOINT"' ]; do
      sleep '"$INTERVAL"'
      # Re-check: checkpoint might have been removed while sleeping
      [ -f '"$CHECKPOINT"' ] || break
      echo "[$(date -Iseconds)] Watcher invoking the agent..." >> '"$LOGFILE"'
      <agent-cli> -p "Resume CI loop for PR '"$PR_NUMBER"'" >> '"$LOGFILE"' 2>&1
      echo "[$(date -Iseconds)] agent exited with code $?" >> '"$LOGFILE"'
    done
    rm -f '"$PIDFILE"'
    echo "[$(date -Iseconds)] Watcher exiting — checkpoint removed (loop complete)" >> '"$LOGFILE"'
  ' &>/dev/null &
  echo "Background watcher started (PID $!) — will re-check every ${INTERVAL}s"
  echo "  Log: $LOGFILE"
  echo "  Stop: kill $(cat $PIDFILE) or remove $CHECKPOINT"
fi
```

### Watcher Lifecycle

| Event | What Happens |
|-------|-------------|
| Skill first invoked | Checkpoint created, watcher spawned |
| Watcher fires (every 5m) | Runs `<agent-cli> -p "Resume CI loop for PR <N>"` |
| agent invocation finds work | Does the work, updates checkpoint |
| agent invocation finds "still waiting" | Reports status, exits quickly |
| Loop completes (all green) | Checkpoint archived/removed → watcher exits on next check |
| User kills watcher | `kill $(cat ~/.nemoclaw/ci-loop/<PR>.pid)` |
| User abandons loop | `rm ~/.nemoclaw/ci-loop/<PR>.json` → watcher self-terminates |
| Machine reboots | Watcher dies, user re-invokes skill → resumes from checkpoint, re-spawns watcher |

### Watcher Guard Rails

1. **PID file prevents duplicates** — won't spawn a second watcher if one is running
2. **Checkpoint-gated** — watcher exits when checkpoint disappears (success or abandon)
3. **Log file for observability** — every invocation logged with timestamp
4. **No orphan risk** — the `while [ -f checkpoint ]` loop guarantees termination
5. **User can always kill it** — PID file makes it easy to stop

### Manual Override: Re-invoke Without Watcher

The skill works fine without the watcher — user can always just open a session
and say "check on CI" or "ci loop". The checkpoint resume logic is the same
regardless of whether it was invoked by the watcher or the user.

### Adjusting the Interval

The 5-minute default is tuned for NemoClaw CI:
- PR checks take 2-3 minutes
- E2E jobs take 10-25 minutes
- 5-minute polling avoids wasted invocations while still being responsive

For faster feedback during active development, the skill can be invoked
manually at any time (it's idempotent). The watcher is the safety net,
not the primary interface.

### Idempotency Guarantee

The skill MUST be safe to invoke multiple times while waiting:
- If `status == waiting_for_e2e` and the run is still in progress → just report status, don't re-trigger
- If `status == checking_pr_ci` and checks are still pending → just report, don't re-push
- Never trigger the same E2E run twice
- Never apply the same fix twice (check if HEAD already contains the fix)

---

## State Tracking

Maintain a running log across loop iterations (persisted in checkpoint):

```
ITERATION: <N>
TIMESTAMP: <ISO>
ACTION: <what was done>
RESULT: <outcome>
```

At the end, this becomes the summary.

---

## Loop Phases

### Phase 0: Identify PR, Check Checkpoint, Gather State

```bash
# If not given a PR number, infer from current worktree
cd "$WORKTREE_PATH"
BRANCH=$(git branch --show-current)
PR_NUMBER=$(gh pr list --repo "$REPO" --head "$BRANCH" --state open --json number --jq '.[0].number')

# CHECK FOR EXISTING CHECKPOINT (resume support)
CHECKPOINT="$HOME/.nemoclaw/ci-loop/${PR_NUMBER}.json"
if [ -f "$CHECKPOINT" ]; then
  echo "Resuming from checkpoint (iteration $(jq .iteration $CHECKPOINT))..."
  # Read: status, waiting_for, fixes_applied, e2e_triggered, etc.
  # Jump to the appropriate phase based on status
fi

# Gather full PR state
PR_DATA=$(gh pr view "$PR_NUMBER" --repo "$REPO" --json \
  number,title,headRefName,statusCheckRollup,comments,reviews,files)
```

**Resume routing based on checkpoint status:**
| Checkpoint Status | Jump To |
|-------------------|---------|
| `checking_pr_ci` | Phase 1 |
| `waiting_for_coderabbit` | Phase 2 |
| `waiting_for_e2e` | Phase 5 |
| `fixing_ci` / `fixing_e2e` | Phase 3 (re-check if fix was pushed) |
| `complete` | Phase 6 (re-display summary) |

### Phase 1: Check PR CI Status

```bash
# Get all check statuses
gh pr checks "$PR_NUMBER" --repo "$REPO"
```

Classify each check:
- ✅ **PASS** — no action needed
- ❌ **FAIL** — needs diagnosis and fix
- 🔄 **PENDING/IN_PROGRESS** — wait (do not take action yet)
- ⏭ **SKIPPED** — ignore

**If any checks are PENDING/IN_PROGRESS → report status and WAIT for next loop iteration.**

**If all checks are PASS → proceed to Phase 2.**

**If any checks FAIL → proceed to Phase 3 (Fix CI).**

### Phase 2: CodeRabbit E2E Recommendations

After PR CI is green, check for CodeRabbit's E2E recommendations.

```bash
# Look for CodeRabbit comments recommending E2E tests
gh pr view "$PR_NUMBER" --repo "$REPO" --json comments \
  --jq '.comments[] | select(.author.login == "coderabbitai") | .body' \
  | grep -i "e2e\|nightly\|workflow"
```

#### If CodeRabbit has NOT commented yet:
- Report "Waiting for CodeRabbit review with E2E recommendations"
- **WAIT for next loop iteration**

#### If CodeRabbit has commented with E2E recommendations:
Extract the recommended job names. Common patterns in CodeRabbit comments:
- "Consider running `sandbox-operations-e2e`"
- "Recommended E2E: cloud-e2e, sandbox-survival-e2e"
- Job names matching the nightly-e2e.yaml job list

Also apply the **path-to-job mapping** as a fallback/supplement:

| Changed path | Recommended jobs |
|-------------|-----------------|
| `scripts/nemoclaw-start.sh`, `scripts/lib/sandbox-init.sh` | sandbox-survival-e2e, sandbox-operations-e2e, cloud-e2e |
| `Dockerfile`, `Dockerfile.base` | cloud-e2e, sandbox-survival-e2e, hermes-e2e, rebuild-openclaw-e2e |
| `src/lib/onboard.ts` | cloud-e2e, sandbox-operations-e2e, rebuild-openclaw-e2e |
| `src/nemoclaw.ts` | sandbox-survival-e2e, sandbox-operations-e2e |
| `nemoclaw-blueprint/policies/**` | network-policy-e2e |
| `src/lib/sandbox-process-recovery-action.ts` | sandbox-survival-e2e, sandbox-operations-e2e |
| `agents/hermes/**` | hermes-e2e, rebuild-hermes-e2e |
| `test/e2e/test-*.sh` | The corresponding job name |

### Phase 3: Fix Failing CI

For each failing check:

#### 3a: Get failure logs

```bash
# For GitHub Actions checks
RUN_ID=$(gh pr checks "$PR_NUMBER" --repo "$REPO" --json \
  name,state,link --jq '.[] | select(.state == "FAILURE") | .link' \
  | grep -oP 'runs/\K[0-9]+' | head -1)

gh run view "$RUN_ID" --repo "$REPO" --log-failed 2>&1 | tail -100
```

#### 3b: Diagnose the failure

Common failure categories and actions:

| Failure Pattern | Diagnosis | Fix Action |
|----------------|-----------|------------|
| `commitlint` / commit message | Bad commit message format | Interactive rebase to fix message |
| `tsc --noEmit` / type errors | TypeScript compile error | Fix the type error in source |
| `biome check` / lint errors | Formatting or lint violation | Run `npx biome check --write` |
| `vitest` / unit test failure | Test assertion broken | Read test, understand failure, fix code or test |
| `shellcheck` | Shell script lint | Fix the shellcheck warning |
| `build-sandbox-images` | Docker build error | Fix Dockerfile or build deps |
| `dco-check` | Missing sign-off | `git commit --amend -s` |
| E2E timeout | Test took too long | Increase timeout or optimize |
| E2E assertion failure | Product bug or test bug | Analyze logs, fix product or test code |

#### 3c: Apply the fix

1. Make the code change
2. Commit with appropriate conventional commit message
3. Push to the PR branch

```bash
git add <files>
git commit -m "fix(<scope>): <description of fix>"
git push origin "$BRANCH"
```

#### 3d: Log the fix

Record in the running log:
```
ITERATION: 2
TIMESTAMP: 2026-05-06T16:00:00Z
ACTION: Fixed biome lint error in src/lib/verify-deployment.ts (trailing comma)
RESULT: Pushed commit abc1234, waiting for CI re-run
```

**After pushing → WAIT for next loop iteration** (CI will re-trigger).

### Phase 4: Trigger E2E Tests

Once PR CI is green AND CodeRabbit recommendations are known:

```bash
# Trigger selective nightly dispatch
BRANCH=$(gh pr view "$PR_NUMBER" --repo "$REPO" --json headRefName --jq '.headRefName')
JOBS="job1,job2,job3"  # From CodeRabbit + path mapping

gh workflow run nightly-e2e.yaml --repo "$REPO" \
  --ref "$BRANCH" -f jobs="$JOBS"
```

Track which E2E jobs were triggered and their run IDs:

```bash
sleep 10
RUN_ID=$(gh run list --repo "$REPO" --workflow=nightly-e2e.yaml \
  --branch "$BRANCH" --limit 1 --json databaseId --jq '.[0].databaseId')
```

### Phase 5: Monitor E2E Results

```bash
gh run view "$RUN_ID" --repo "$REPO" --json status,conclusion,jobs \
  --jq '{status, conclusion, jobs: [.jobs[] | select(.conclusion != "skipped") | {name, status, conclusion}]}'
```

- **If still running → WAIT for next loop iteration**
- **If all passed → proceed to Phase 6 (Done)**
- **If any failed → go back to Phase 3 with E2E failure logs**

For E2E failures, get logs:
```bash
gh run view "$RUN_ID" --repo "$REPO" --log-failed 2>&1 | tail -100
```

### Phase 6: All Green — Summary

When ALL of the following are true:
- ✅ All PR CI checks passing
- ✅ CodeRabbit E2E recommendations have been triggered
- ✅ All triggered E2E jobs passing

**EXIT the loop** and produce the final summary.

---

## Summary Format

```markdown
## PR #<N> CI Enforcement Summary

**Branch:** `<branch>`
**Total iterations:** <N>
**Duration:** <start> → <end>

### CI Checks: ✅ All Green
| Check | Status |
|-------|--------|
| checks | ✅ |
| dco-check | ✅ |
| commit-lint | ✅ |
| ... | ... |

### E2E Tests: ✅ All Green
| Job | Status | Triggered By |
|-----|--------|-------------|
| cloud-e2e | ✅ | CodeRabbit recommendation |
| sandbox-operations-e2e | ✅ | Path mapping (src/lib/onboard.ts) |
| device-auth-health-e2e | ✅ | Explicit (new test in PR) |

### Issues Found & Fixed
| # | Iteration | Issue | Fix | Commit |
|---|-----------|-------|-----|--------|
| 1 | 2 | biome lint: trailing comma | Removed trailing comma | abc1234 |
| 2 | 3 | E2E timeout: 15m too short | Bumped to 30m | def5678 |
| 3 | 5 | sandbox_exec: 000 in CI | Switched to SSH pattern | 2f47f5e |

### Waiting Periods
| Iteration | Waited For | Duration |
|-----------|-----------|----------|
| 1 | PR CI to complete | ~3 min |
| 4 | CodeRabbit review | ~5 min |
| 6 | E2E run 25445645261 | ~18 min |
```

---

## Loop Behavior Rules

1. **Never loop faster than the CI can respond.** If checks are pending, report and wait.
2. **Only one fix per iteration.** Don't stack multiple fixes — push one, let CI validate, then address the next.
3. **Distinguish product bugs from test bugs.** If an E2E test fails due to a test infrastructure issue (not a product bug), fix the test. If it's a product bug, fix the product code.
4. **Don't force-push unless absolutely necessary** (repo rules may block it). Prefer fixup commits.
5. **Track everything.** Every action, every wait, every fix goes in the log.
6. **Exit conditions:**
   - ✅ All green (success)
   - ❌ Unfixable failure (report and ask user for input)
   - ❌ Max iterations exceeded (default: 20)
   - ❌ User interrupts

## Anti-patterns

- **Don't trigger E2E before PR CI is green** — waste of compute
- **Don't re-trigger an E2E that's still running** — check status first
- **Don't fix a CodeRabbit style comment in the CI loop** — that's PR review, not CI enforcement
- **Don't loop on a check that's been pending for >30 minutes** — flag it and ask user

## Checkpoint Cleanup

When the loop completes (all green) or is explicitly abandoned:

```bash
# On success: archive to completed/
mkdir -p ~/.nemoclaw/ci-loop/completed
mv ~/.nemoclaw/ci-loop/${PR_NUMBER}.json ~/.nemoclaw/ci-loop/completed/${PR_NUMBER}-$(date +%Y%m%d).json

# On explicit abandon:
rm ~/.nemoclaw/ci-loop/${PR_NUMBER}.json
```

Stale checkpoints (PR merged/closed) should be cleaned up on next invocation:
```bash
# Check if PR is still open
PR_STATE=$(gh pr view "$PR_NUMBER" --repo "$REPO" --json state --jq '.state')
if [ "$PR_STATE" != "OPEN" ]; then
  rm ~/.nemoclaw/ci-loop/${PR_NUMBER}.json
  echo "PR #${PR_NUMBER} is ${PR_STATE} — removing stale checkpoint"
  exit 0
fi
```

## Integration with Other Skills

- Uses E2E Advisor / CodeRabbit recommendations for dispatch decisions
- Uses current workflow definitions for dispatch mechanics
- Complements `nemoclaw-pr-sweep` (sweep is breadth-first across PRs; this is depth-first on one PR)
- Can be followed by `nemoclaw-pr-review` once CI is green
