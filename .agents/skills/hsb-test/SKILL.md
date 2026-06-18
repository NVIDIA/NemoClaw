---
name: hsb-test
description: Execute QA test plans on Holoscan Sensor Bridge hardware. Reads a user-provided test document, filters tests by the user's setup, determines which tests can run automatically, executes them with pass/fail evaluation, and produces a structured test results report.
author: "Holoscan Team <holoscan-team@nvidia.com>"
license: "Apache-2.0"
version: "1.0.0"
tags:
  - holoscan-sensor-bridge
  - hsb
  - testing
tools:
  - Read
  - Write
  - Edit
  - Grep
  - Glob
  - Bash
disable-model-invocation: true
allowed-tools: Read,Write,Edit,MultiEdit,Grep,Glob,Bash
metadata:
  author: "Holoscan Team <holoscan-team@nvidia.com>"
  team: holoscan
  tags:
    - holoscan-sensor-bridge
    - hsb
    - testing
  agents:
    - claude-code
    - codex
---

# HSB QA Test Runner

Use this skill when the user wants to execute a QA test plan against an HSB board and devkit. The skill reads a test document (local file or web link), filters tests to those that can run automatically on the user's specific hardware setup, executes each test with pass/fail evaluation, and produces a comprehensive results report.

This skill assumes the devkit is already set up (SSH, demo container built, host configured, board connected). If setup is not complete, it will offer to invoke `/hsb-setup` first.

This workflow runs test applications inside the demo container. Only run it when the user explicitly invokes it.

## Before you start — required gates (do these first, in order)

**Gate 1 — Read environment variables.** Before doing anything else, check these variables and print their resolved values to the user:

```
SSH_TARGET      Remote devkit login (e.g. nvidia@192.168.1.50). Ask the user if not set.
REMOTE_ROOT     Remote working directory (e.g. /home/nvidia). Ask the user if not set.
REMOTE_SUDO     sudo / sudo -n / "" — default to "sudo" if not set.
REMOTE_SSH_OPTS Additional SSH options (optional).
HSB_PLATFORM    Platform hint (optional).
```

**SSH_TARGET and REMOTE_ROOT are required. Stop and ask the user for them if either is missing.**

**Gate 2 — Present the phase plan, ask for the test document, and get confirmation.** Before taking any action:

1. Show the phase plan:

```
HSB Test — Phase Plan
  Phase 0: Verify devkit SSH, board ping, and demo container availability
  Phase 1: Obtain test document, confirm setup, build executable test plan
  Phase 2: Execute tests, record pass/fail, analyze failures
  Phase 3: Produce test results report (with option to save)
  Phase 4: Clean up test artifacts
```

2. **If the user has not provided a test document path or URL, STOP and ask for it — do not proceed to Phase 0 or any phase until the user provides it**: `Please provide the path or URL to your test document:`. If the user has already specified specific tests (e.g., "connectivity checks only"), state which phases will run and which will be skipped, and note that tests will be filtered to the user's platform/board/sensor configuration and classified as automatable vs. manual.

3. Ask explicitly: `Shall I proceed with Phase 0? [Y/n]` — do not start Phase 0 until the user confirms.

## What this skill must do

1. Verify that the devkit is reachable over SSH, the HSB board is connected and responsive, and the demo container is available. Read the current FPGA version and board identity. Verify the type of sensor/camera and hsb devkit and release repo used either from already set environment variables or from prompting the user. If the setup is not ready, offer to invoke `/hsb-setup` to prepare the devkit.
2. Obtain a test plan document from the user (file path or URL). Confirm the user's setup details collected in Phase 0 (repo location, HSB version, platform, board type, sensors). Study the test plan and the repository's `examples/` directory to determine which tests can run automatically. Skip manual tests and tests requiring additional equipment. Present the executable test plan for user approval.
3. Execute each test case in sequence. For each test: run the application, evaluate pass/fail against the criteria in the test plan, log the result. On failure, analyze logs, suggest fixes, and let the user decide how to proceed before running the next test.
4. Produce a structured test results report with per-test pass/fail status, issues encountered, and fixes applied. Offer to save the report.
5. Clean up all test artifacts (containers, temporary files, session state).

## Linux/Windows-friendly wrapper variables

Reuse the same environment variables from the other HSB skills:

- `SSH_TARGET` for the remote login target (e.g. `nvidia@agx-thor-host`)
- `REMOTE_ROOT` for the remote working directory
- `REMOTE_SUDO` for privileged commands
- `REMOTE_SSH_OPTS` for additional SSH options
- `HSB_PLATFORM` as an optional platform hint

If these are set, notify the user of these settings and use them without re-asking.

Before Phase 0, print the resolved remote execution settings.

## Mandatory interaction pattern

### First run in a session (no prior verification)

When no valid session state exists, show the full phase plan:

- Phase 0: Verify board connectivity, demo container readiness, and user setup (release repo, platform, sensor/camera)
- Phase 1: Obtain test plan, confirm setup, build executable test list
- Phase 2: Execute test plan with per-test pass/fail evaluation
- Phase 3: Generate test results report (with option to save)
- Phase 4: Cleanup

Then execute one phase at a time.

### Subsequent runs in the same session (fast path)

When the session state file (`/tmp/.claude_hsb_test_session/state.sh`) exists **and** contains `_SESSION_VERIFIED=true`, the skill skips Phase 0 and Phase 1 setup confirmation because connectivity, hardware, release repo, platform, and sensor/camera were already verified. Instead, inform the user and jump directly to test plan intake:

```
Session already verified — skipping connectivity checks.
  SSH target: $SSH_TARGET
  Release repo: /home/work/holoscan-sensor-bridge (HSB vX.X.X)
  Platform: AGX Thor
  Board: HSB Lattice | FPGA: XXXX
  Sensors: Dual IMX274

Proceeding directly to test plan intake.
```

Then execute:
- Phase 1 (test plan intake and test list building — setup confirmation is skipped)
- Phase 2: Execute test plan
- Phase 3: Test results report
- Phase 4: Cleanup

### When to re-run Phase 0 from the beginning

Phase 0 must be re-run (ignoring the fast path) when:

1. **New session**: No session state file exists on the remote host, or a new Claude Code session is started.
2. **Execution failure suggesting connectivity loss**: If Phase 2 fails with symptoms indicating the board or devkit is unreachable (ping failure, SSH timeout, container launch failure, `No such device` errors), clear `_SESSION_VERIFIED` from the session state and re-run Phase 0 before retrying.
3. **User explicitly requests it**: If the user says "re-verify", "start over", "run from the beginning", or invokes `/hsb-test --full`, run Phase 0 from scratch.

See [## Phase gate](#phase-gate--user-confirmation-between-phases) below for the full confirmation protocol.

If something fails, do **not** just dump raw logs. Summarize:

- the exact command that failed
- the likely root cause
- what safe action you recommend
- whether the issue is blocking

## Phase details

See [references/phase-details.md](references/phase-details.md) for full step-by-step phase instructions.

## Execution rules

### SSH heredoc pattern

Use the same persistent SSH session model as the other HSB skills. Each phase runs as a single SSH heredoc block:

```bash
ssh -o BatchMode=yes $REMOTE_SSH_OPTS $SSH_TARGET bash -s <<'REMOTE'
set -e

# restore state from previous phase
source /tmp/.claude_hsb_test_session/state.sh 2>/dev/null || true
cd "${_CLAUDE_CWD:-__REMOTE_ROOT__}"

# phase commands
echo "=== Phase N: description ==="
command1
command2

# save state for next phase (preserves _SESSION_VERIFIED if already set)
_PREV_VERIFIED="${_SESSION_VERIFIED:-}"
mkdir -p /tmp/.claude_hsb_test_session
{
  echo "export _CLAUDE_CWD=\"$(pwd)\""
  echo "export PATH=\"$PATH\""
  echo "export REPO_DIR=\"$REPO_DIR\""
  echo "export VERSION=\"$VERSION\""
  echo "export HSB_PLATFORM=\"$HSB_PLATFORM\""
  echo "export BOARD_TYPE=\"$BOARD_TYPE\""
  echo "export SENSORS=\"$SENSORS\""
  echo "export FPGA_VERSION=\"$FPGA_VERSION\""
  echo "export TEST_PLAN_SOURCE=\"$TEST_PLAN_SOURCE\""
  [ "$_PREV_VERIFIED" = "true" ] && echo "export _SESSION_VERIFIED=true"
} > /tmp/.claude_hsb_test_session/state.sh
REMOTE
```

Replace `__REMOTE_ROOT__` with the literal value of `$REMOTE_ROOT` when composing the heredoc.

### Container usage for tests

Test commands run inside the demo container. Use the detached pattern with a named container and a watchdog for timeout enforcement.

Default timeout per test: **120 seconds** (2 minutes). Overridden by:
- `--timeout N` on the skill invocation (applies to all tests)
- Per-test timeout specified in the test plan

### Cleanup after each test container

After every test run, stop and remove the container. See [references/phase-details.md](references/phase-details.md) for the cleanup pattern.

### Session teardown

Handled by Phase 4. If the workflow is aborted before Phase 4:

```bash
docker ps --filter "name=hsb_test_" --format '{{.Names}}' | xargs -r docker stop -t 2 2>/dev/null || true
ssh -o BatchMode=yes $REMOTE_SSH_OPTS $SSH_TARGET "rm -rf /tmp/.claude_hsb_test_session"
```

## Phase gate — user confirmation between phases

After completing each phase (Phases 0–3), **always prompt the user for confirmation** before starting the next phase.

**Exception**: When `--y` (auto-approve mode) is active, phase gates are skipped. See "Auto-approve mode (`--y`)" section.

**Exception**: Phase 4 (cleanup) runs automatically after Phase 3 without a gate.

```
Proceed to Phase <N+1> (<phase description>)? [Y/n]
```

### User response handling

All prompts in this skill require explicit typed responses. Never treat a blank or Enter-only input as a selection — re-prompt the user instead.

- **"y"**, **"yes"**, **"Y"**, **"ok"**, **"go"**, **"continue"**, **"next"** → proceed to the next phase.
- **"n"**, **"no"**, **"stop"**, **"abort"** → stop execution. Print:
  ```
  QA testing paused after Phase N.
  You can resume by re-invoking the skill.
  ```
  Then run session teardown.
- **Any other text** → treat as a question or instruction about the current phase. Answer it, then re-prompt.
- **"retry"** → re-execute the current phase, show summary again, then re-prompt.

### Exceptions

- **Phase 4** (cleanup) is the final phase — it runs automatically after Phase 3 completes or after the user declines to run another test plan.
- **If a phase FAILs** and cannot be recovered, stop and report clearly, then run cleanup.

## Built-in help (`--help`)

If `$ARGUMENTS` contains `--help` or `-h`, print the following and stop:

```
HSB QA Test Runner Skill

USAGE
  /hsb-test [OPTIONS]

OPTIONS
  --help, -h        Show this help message and exit
  --verbose         Show full raw command output for every phase
  --y               Auto-approve all phase gates and skip interactive
                    debugging on test failures. Not recommended — a
                    confirmation warning is shown before proceeding.
                    All output is saved to a timestamped log file.
  --timeout N       Set per-test runtime in seconds (default: 120s).
                    Tests stop after N seconds or when pass/fail can
                    be determined, whichever comes first.
  --full            Force full verification from Phase 0, even if the
                    session was already verified

ENVIRONMENT VARIABLES (set before invoking the skill)
  SSH_TARGET        Remote login target (e.g. ubuntu@10.0.0.1)
  REMOTE_ROOT       Remote working directory
  REMOTE_SUDO       Privilege escalation: 'sudo', 'sudo -n', or ''
  REMOTE_SSH_OPTS   Additional SSH options
  HSB_PLATFORM      Platform hint

WORKFLOW PHASES
  Phase 0   Verify board connectivity, demo container readiness,
            and user setup (release repo, platform, sensor/camera)
            (skipped on repeat runs in the same session)
  Phase 1   Obtain test plan, confirm setup, build executable test list
            (setup confirmation skipped on repeat runs)
  Phase 2   Execute test plan with per-test pass/fail evaluation
  Phase 3   Generate and optionally save test results report
  Phase 4   Cleanup (automatic)

EXAMPLES
  /hsb-test
  /hsb-test --verbose
  /hsb-test --timeout 60
  /hsb-test --y
  /hsb-test --y --timeout 60
  /hsb-test --full
  /hsb-test --help
```

## Invocation examples

- `/hsb-test`
- `/hsb-test --verbose`
- `/hsb-test --timeout 60`
- `/hsb-test --timeout 60 --verbose`
- `/hsb-test --y`
- `/hsb-test --y --timeout 60`
- `/hsb-test --full`
- `/hsb-test --full --verbose`
- `/hsb-test --help`

## Verbosity mode (`--verbose`)

The skill supports a `--verbose` flag:

### Detecting the flag

Check whether `$ARGUMENTS` (the text after the slash command) contains any of: `--help` / `-h`, `--verbose`, `--y`, `--timeout N`, or `--full` (case-insensitive). Strip all flags (and their values) from arguments before further parsing.

When `--full` is present, ignore any cached session state and run Phase 0 from scratch.

### Verbose mode (when set)

- Show complete raw output of every SSH command
- Show full test application output inline (all stdout/stderr)
- Show detailed phase status blocks

### Concise mode (default, no `--verbose`)

- Show bullet-point summaries after each phase
- Suppress raw command output
- Show key test output lines (startup, errors, pass/fail indicators) but not every line
- Show issues with the 4-line format (Symptom, Cause, Resolution, Blocking)

## Auto-approve mode (`--y`)

The skill supports a `--y` flag that skips all phase gates and runs the entire workflow from start to finish without waiting for user confirmation between phases. This is **not recommended** for QA testing.

### Confirmation warning

When `--y` is detected, display a warning and ask the user to confirm:

```
⚠  WARNING: Auto-approve mode (--y) is enabled.

This is NOT RECOMMENDED for QA testing. All phase gates will be skipped
and the entire test plan will execute without pausing for your
confirmation between phases or tests.

You will not be able to review intermediate results, intervene on
failures, or abort between tests. All output will be saved to a
timestamped log file.

NOTE: In auto-approve mode, you must still provide the test plan in
Phase 1. Failed tests are logged but not interactively debugged —
testing continues to the next test automatically.

Type 'yes' to confirm auto-approve mode, or anything else to cancel:
```

- If the user responds with **"yes"** (exact match, case-insensitive) → enable auto-approve mode.
- Any other response → cancel auto-approve mode and run interactively.

### Behavior when `--y` is active

1. **Phase gates are skipped** between phases.
2. **Test plan approval is skipped** — the generated test plan executes automatically.
3. **Failed tests do not pause** — failures are logged and testing continues to the next test case automatically.
4. **Inter-test prompts are skipped** — tests run back-to-back without confirmation.
5. **Default timeout applies** — 120 seconds per test, or `--timeout N` if specified.
6. **Log file**: Created at start as `hsb-test-log-YYYY-MM-DD-HHMMSS.md` in `$REMOTE_ROOT/` or current directory.
7. **Phase summaries are still shown** in real time.
8. **Blocking connectivity failures still stop the workflow** and trigger re-verification.

### Combining with other flags

- `--y --verbose`: Auto-approve with full raw output.
- `--y --timeout N`: Auto-approve with a custom per-test timeout.
- `--y --full`: Auto-approve with forced full verification from Phase 0.

## Timeout handling (`--timeout`)

The skill supports a `--timeout N` flag where N is the number of seconds to run each test.

### Behavior

- **When set**: Each test runs for at most N seconds, then is stopped. Pass/fail is evaluated from the output collected during that window.
- **When not set**: Each test runs for at most **120 seconds** (2 minutes) by default, or until pass/fail can be determined from the output, whichever comes first.
- **Per-test override**: If the test plan specifies a timeout for a specific test, that value takes precedence over both the default and the `--timeout` flag.

### Validation

- N must be a positive integer
- Minimum: 5 seconds
- Maximum: 3600 seconds (1 hour)
- If invalid, show an error and ask the user to provide a valid timeout
