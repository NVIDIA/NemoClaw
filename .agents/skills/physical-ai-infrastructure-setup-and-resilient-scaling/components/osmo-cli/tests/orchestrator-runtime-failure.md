# Test: Runtime Script Failure — Diagnosis and Auto-Recovery

## Objective

Verify that the phase-split orchestration pattern works end-to-end: the
workflow-expert agent handles setup/submission and failure diagnosis in its
isolated context, while the **main conversation** monitors inline with live
status updates visible to the user. The full cycle — submit, detect failure,
diagnose, fix, resubmit, complete — must run without additional user input.

## Why This Test Matters

OSMO validates workflow YAML structure and resource limits at submission time,
but cannot inspect the correctness of embedded shell scripts. A workflow can
pass all server-side validation yet fail seconds after launch due to a script
bug. The phase-split pattern must handle this gracefully:

1. **Workflow expert** submits the workflow and returns the workflow ID
2. **Main agent** monitors inline and detects the FAILED status (user sees this)
3. **Workflow expert** (resumed) pulls logs, diagnoses, fixes, and resubmits
4. **Main agent** monitors the corrected workflow to completion (user sees this)

## Bug Design

The workflow contains **two layered runtime bugs**, both invisible to OSMO
server-side validation:

| #   | Bug                                                       | Why it passes validation                                          | Runtime symptom                                                                 | Expected fix                                                                      |
| --- | --------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| 1   | `jq` used but not installed in `ubuntu:22.04`             | OSMO does not inspect script contents                             | `jq: command not found`, exit code 127                                          | Replace `jq` with pure bash, or prepend `apt-get update && apt-get install -y jq` |
| 2   | `{{outputs}}` (plural) instead of `{{output}}` (singular) | OSMO does not validate template variables inside `files.contents` | `mkdir` creates a literal `{{outputs}}` directory; output dataset path is wrong | Change all `{{outputs}}` to `{{output}}`                                          |

**Bug ordering is deliberate.** Bug 1 triggers first because `set -e` aborts
on the `jq` failure before reaching the `{{outputs}}` lines. This tests
whether the workflow expert, when fixing Bug 1, also proactively reviews the rest
of the script and catches Bug 2 in the same pass — or whether it requires a
second failure-retry cycle.

## Setup

Place the following workflow YAML at `workflow.yaml` in the working directory.
The comments in the YAML **do not** mention the bugs — they read as normal
developer comments so the agent gets no hints.

```yaml
workflow:
  name: hello-world-test
  tasks:
  - name: hello
    image: ubuntu:22.04
    command: ["bash"]
    args: ["/tmp/entry.sh"]
    files:
    - contents: |
        #!/bin/bash
        set -e

        echo "========================================="
        echo "  Hello World from OSMO!"
        echo "========================================="

        echo "Hostname: $(hostname)"
        echo "Date:     $(date)"

        # Generate a structured JSON report
        echo "Generating report..."
        jq -n --arg host "$(hostname)" --arg ts "$(date -u +%FT%TZ)" \
          '{message: "Hello World", host: $host, timestamp: $ts}' \
          > /tmp/report.json

        # Write outputs to the dataset mount
        mkdir -p {{outputs}}
        cp /tmp/report.json {{outputs}}/report.json
        echo "Hello World from OSMO!" > {{outputs}}/hello.txt

        echo "Done!"
      path: /tmp/entry.sh
    outputs:
    - dataset:
        name: hello-world-test-output
  resources:
    default:
      cpu: 2
      gpu: 2
      memory: 8Gi
      storage: 10Gi
```

## Prompt

Give the **main agent** (not the workflow expert directly) this prompt. Do not
provide any hints about the bugs. Pre-authorize submission to avoid the
Phase 3 confirmation pause:

> I have a hello world workflow ready in workflow.yaml. Submit it now to an
> available GPU pool, monitor it, and report the results when it's done. If
> it fails, diagnose from logs, fix the workflow, and resubmit automatically
> without asking me. Run fully autonomously until completion or 3 retries.

## Expected Behavior (Phase-Split Architecture)

The workflow expert handles setup/submit and failure diagnosis in its isolated
context, while the main conversation monitors inline so the user sees live
status updates.

### Step 1: Main agent spawns workflow expert — Resource Check → Submit

- The main agent reads the user prompt and matches it to the osmo skill's
  "Orchestrate a Workflow End-to-End" use case.
- It spawns the `workflow-expert` agent with a prompt that asks it to
  **check resources and submit only** — NOT to monitor.
- The workflow expert detects that `workflow.yaml` already exists and uses it.
- It checks pool availability, picks a pool with free GPUs, and submits.
- Submission **succeeds** — no YAML structure or resource validation errors.
- The workflow expert returns: workflow ID, pool name, monitoring commands,
  and its agent ID for later resume.

**What to verify:**
- The prompt sent to the workflow expert does NOT include monitoring instructions
  (no "poll status", no "monitor until complete", no "report progress").
- The workflow expert returns promptly after submission without polling.

### Step 2: Main agent monitors inline — user sees live status updates

- The main agent polls `osmo workflow query <id> --format-type json` itself.
- The user sees each status update in real time:
  - `Status: SCHEDULING (queued 5s)`
  - `Workflow transitioned: SCHEDULING → RUNNING`
  - `Status: RUNNING (task "hello" active)`
- The workflow moves to RUNNING, then FAILED within seconds.
- The main agent detects the FAILED status from its own polling.

**What to verify:**
- Status updates appear in the main conversation (not hidden in a subagent).
- The main agent detects FAILED without the workflow expert's help.

### Step 3: Main agent resumes workflow expert — Failure Diagnosis

- The main agent resumes the workflow expert (using the `resume` parameter with
  the agent ID from Step 1) and passes the failure context.
- The workflow expert fetches logs via `osmo workflow logs <id> -n 10000`.
- Logs contain: `jq: command not found` and a non-zero exit code.
- **Root cause**: The workflow expert identifies `jq` is not in `ubuntu:22.04`.
- **Fix**: Edits `workflow.yaml` to either:
  - (a) Replace the `jq` invocation with bash-native alternatives, OR
  - (b) Add `apt-get update && apt-get install -y jq` before the `jq` call
- **Ideal**: While editing, the workflow expert also notices `{{outputs}}` should
  be `{{output}}` and fixes both bugs in one pass.
- The workflow expert resubmits the corrected workflow and returns the new
  workflow ID.

**What to verify:**
- The workflow expert is resumed (not spawned fresh) — preserves prior context.
- Root-cause explanation is clear and in plain language.
- workflow.yaml is actually modified with the fix.

### Step 4: Main agent resumes inline monitoring

- The main agent monitors the new workflow inline (same as Step 2).
- If the corrected workflow fails again (Bug 2 not caught in first pass):
  - The main agent resumes the workflow expert again for a second diagnosis.
  - The workflow expert catches `{{outputs}}` → `{{output}}`, fixes, resubmits.
  - The main agent monitors the third submission.
- After the fully corrected workflow completes, proceed to Step 5.

### Step 5: Main agent reports results

- The main agent (not the workflow expert) reports to the user:
  - Workflow ID and COMPLETED status
  - OSMO Web link
  - What the workflow produced
  - Offers to download the `hello-world-test-output` dataset

## Success Criteria

| #   | Criterion                                                  | Required | Notes                                                   |
| --- | ---------------------------------------------------------- | -------- | ------------------------------------------------------- |
| 1   | Workflow expert prompt does NOT include monitoring            | Yes      | Main agent follows SKILL.md orchestration pattern       |
| 2   | Submission succeeds on first attempt                       | Yes      | No YAML/resource validation errors                      |
| 3   | Live status updates visible to user during monitoring      | Yes      | Main agent polls and reports inline, not in subagent    |
| 4   | Main agent detects FAILED status from its own polling      | Yes      | Not detected by the workflow expert                        |
| 5   | Workflow expert is resumed (not spawned fresh) for diagnosis  | Yes      | Uses `resume` parameter with agent ID                   |
| 6   | Workflow expert fetches and reads logs                        | Yes      | Must use `osmo workflow logs`                           |
| 7   | Workflow expert identifies `jq: command not found`            | Yes      | Clear root-cause statement in plain language             |
| 8   | Workflow expert fixes Bug 1 in workflow.yaml                  | Yes      | Either approach (a) or (b)                              |
| 9   | Workflow expert resubmits without asking user                 | Yes      | Mode 2 auto-retry                                       |
| 10  | Workflow expert fixes Bug 2 (`{{outputs}}` → `{{output}}`)   | Yes      | First or second pass                                    |
| 11  | Main agent reports final COMPLETED status                  | Yes      | With workflow ID, web link, and output info             |
| 12  | Total retries ≤ 3                                          | Yes      | No infinite loops                                       |
| 13  | No user input required after initial prompt                | Yes      | Core requirement                                        |

## Scoring

- **A — Both bugs fixed in one pass + correct phase split**: The main agent
  monitors inline (user sees live updates), the workflow expert catches both bugs
  in a single diagnosis pass, and the second submission succeeds. Demonstrates
  both the phase-split pattern and thorough proactive script review.
- **B — Correct phase split + bugs fixed across two retries**: The main agent
  monitors inline correctly. The workflow expert fixes Bug 1 first, then catches
  Bug 2 on the second failure. Acceptable — the retry loop works correctly.
- **C — Bugs fixed but workflow expert monitors**: Both bugs are fixed and the
  workflow completes, but the main agent delegated monitoring to the workflow
  expert (user saw no live updates). The phase-split pattern failed.
- **Fail**: Agent does not identify the root cause, asks the user what to do
  before exhausting retries, or loops more than 3 times without resolving.

## Cleanup

After the test, delete the test workflow and output dataset:
```bash
echo "y" | osmo dataset delete hello-world-test-output
```
