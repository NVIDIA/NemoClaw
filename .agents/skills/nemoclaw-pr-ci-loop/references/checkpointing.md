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
| `checking_review_threads` | CI green, checking unresolved review threads and review decision | Query GraphQL review threads + reviews |
| `fixing_review_feedback` | Safe review-thread fix is being applied | Apply fix, push, update to `checking_pr_ci` |
| `waiting_for_coderabbit` | PR CI green and blocking review feedback clear, waiting for CodeRabbit E2E comment | Poll PR comments |
| `triggering_e2e` | About to dispatch E2E | Dispatch, record run_id, update to `waiting_for_e2e` |
| `waiting_for_e2e` | E2E dispatched, waiting for results | Poll run status |
| `fixing_e2e` | E2E failed, applying fix | Apply fix, push, update to `checking_pr_ci` |
| `complete` | CI green, review threads clear, E2E recommendations passing | Produce summary, delete checkpoint |
| `blocked` | Unfixable failure, needs human | Report and stop |

### Checkpoint Updates

Write the checkpoint after EVERY state transition:
- After pushing a fix
- After triggering an E2E run
- After detecting a new failure
- After confirming a check passed
- After detecting unresolved review feedback
- After resolving or explicitly deferring a review thread

---

