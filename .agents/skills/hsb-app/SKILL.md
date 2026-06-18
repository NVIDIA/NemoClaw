---
name: hsb-app
description: Discover and run Holoscan Sensor Bridge example applications on a connected devkit. Filters available apps by the user's platform, HSB software version, board type, and sensors. Supports timed execution, failure analysis, code-edit suggestions, and iterative re-runs.
author: "Holoscan Team <holoscan-team@nvidia.com>"
license: "Apache-2.0"
version: "1.0.0"
tags:
  - holoscan-sensor-bridge
  - hsb
  - running-app
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
    - running-app
  agents:
    - claude-code
    - codex
---

# HSB Application Runner

Use this skill when the user wants to discover, select, and run Holoscan Sensor Bridge example applications on a devkit with a connected HSB board.

This skill assumes the devkit is already set up (SSH, demo container built, host configured, board connected). If setup is not complete, instruct the user to run `/hsb-setup` first.

This workflow runs applications inside the demo container. Only run it when the user explicitly invokes it.

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

**Gate 2 — Present the phase plan and get confirmation.** Before taking any action:

If the user's request already includes platform, board type, and sensors, also state upfront:
- You will scan `examples/` and filter apps by the user's sensor type and platform
- You will NOT add `--headless` automatically — only if the user explicitly requests it
- If the user specified a timeout (e.g., "60-second timeout"), state you will use that as the watchdog timeout
- Applications run inside the demo container via `docker run`, using `python3` for Python-based examples

Show the phase plan:

```
HSB App — Phase Plan
  Phase 0: Verify board connectivity and demo container readiness
  Phase 1: Discover user setup and select application to run
  Phase 2: Run application with monitoring, failure analysis, and iterative debugging
  Phase 3: Generate session report (with option to save)
```

Then ask explicitly: `Shall I proceed with Phase 0? [Y/n]` — do not start Phase 0 until the user confirms.

**Gate 3 — Fast path check.** After the user confirms in Gate 2, run this check before executing any Phase 0 commands:

```bash
ssh -o BatchMode=yes $REMOTE_SSH_OPTS $SSH_TARGET \
  "grep _SESSION_VERIFIED /tmp/.claude_hsb_app_session/state.sh 2>/dev/null || echo 'no session'"
```

If the output contains `_SESSION_VERIFIED=true`, skip Phase 0 and Phase 1 setup discovery — go directly to app selection and inform the user.

## What this skill must do

1. Verify that the devkit is reachable over SSH, the HSB board is connected and responsive, and the demo container is available. Read the current FPGA version and board identity.
2. Interact with the user to understand their specific setup — repo location on the devkit, HSB software version, board type (Lattice, etc.), and connected sensors (e.g., dual IMX274, VB1940). Then scan the repository's user guide and `examples/` directory to build a list of applications compatible with the user's setup. Present the list and let the user choose an app to run.
3. Run the selected application inside the demo container, monitor output, and if the app fails, analyze the log output and guide the user through debugging — including suggesting code or environment edits and re-running the app.
4. Produce a summary report of the session — issues encountered, fixes applied, and outcome. Offer to save the report to a file.

## Linux/Windows-friendly wrapper variables

Reuse the same environment variables from the `hsb-setup` and `hsb-flash` skills:

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

- Phase 0: Verify board connectivity and demo container readiness
- Phase 1: Discover user setup and select application to run
- Phase 2: Run application with monitoring, failure analysis, and iterative debugging
- Phase 3: Generate session report (with option to save)

Then execute one phase at a time.

### Subsequent runs in the same session (fast path)

When the session state file (`/tmp/.claude_hsb_app_session/state.sh`) exists **and** contains `_SESSION_VERIFIED=true`, the skill skips Phase 0 and Phase 1 setup discovery because connectivity and hardware were already verified. Instead, inform the user and jump directly to app selection:

```
Session already verified — skipping connectivity checks.
  SSH target: $SSH_TARGET
  Board: HSB Lattice | FPGA: XXXX
  Platform: AGX Thor | HSB version: X.X.X
  Sensors: Dual IMX274

Proceeding directly to application selection.
```

Then execute:
- Phase 1 Steps 2–3 only (scan examples, present app list, user selects app)
- Phase 2: Run application
- Phase 3: Session report

### When to re-run Phase 0 from the beginning

Phase 0 must be re-run (ignoring the fast path) when:

1. **New session**: No session state file exists on the remote host, or a new Claude Code session is started.
2. **Execution failure suggesting connectivity loss**: If Phase 2 fails with symptoms indicating the board or devkit is unreachable (ping failure, SSH timeout, container launch failure, `No such device` errors), clear `_SESSION_VERIFIED` from the session state and re-run Phase 0 before retrying.
3. **User explicitly requests it**: If the user says "re-verify", "start over", "run from the beginning", or invokes `/hsb-app --full`, run Phase 0 from scratch.

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

Use the same persistent SSH session model as `hsb-setup` and `hsb-flash`. Each phase runs as a single SSH heredoc block:

```bash
ssh -o BatchMode=yes $REMOTE_SSH_OPTS $SSH_TARGET bash -s <<'REMOTE'
set -e

# restore state from previous phase
source /tmp/.claude_hsb_app_session/state.sh 2>/dev/null || true
cd "${_CLAUDE_CWD:-__REMOTE_ROOT__}"

# phase commands
echo "=== Phase N: description ==="
command1
command2

# save state for next phase (preserves _SESSION_VERIFIED if already set)
_PREV_VERIFIED="${_SESSION_VERIFIED:-}"
mkdir -p /tmp/.claude_hsb_app_session
{
  echo "export _CLAUDE_CWD=\"$(pwd)\""
  echo "export PATH=\"$PATH\""
  echo "export REPO_DIR=\"$REPO_DIR\""
  echo "export VERSION=\"$VERSION\""
  echo "export HSB_PLATFORM=\"$HSB_PLATFORM\""
  echo "export BOARD_TYPE=\"$BOARD_TYPE\""
  echo "export SENSORS=\"$SENSORS\""
  echo "export FPGA_VERSION=\"$FPGA_VERSION\""
  echo "export SELECTED_APP=\"$SELECTED_APP\""
  echo "export APP_OPTIONS=\"$APP_OPTIONS\""
  echo "export APP_TIMEOUT=\"$APP_TIMEOUT\""
  [ "$_PREV_VERIFIED" = "true" ] && echo "export _SESSION_VERIFIED=true"
} > /tmp/.claude_hsb_app_session/state.sh
REMOTE
```

Replace `__REMOTE_ROOT__` with the literal value of `$REMOTE_ROOT` when composing the heredoc.

### Container usage for applications

Application commands run inside the demo container. Use the detached pattern with a named container.

For apps with `--timeout`, use the watchdog pattern. For indefinite-run apps, stream logs and wait for the user to request a stop.

### Cleanup after app containers

After every app run, stop and remove the container. See [references/phase-details.md](references/phase-details.md) for the cleanup pattern.

### Session teardown

After Phase 3 (or on any failure that stops the workflow):

```bash
docker ps --filter "name=hsb_app_" --format '{{.Names}}' | xargs -r docker stop -t 2 2>/dev/null || true
ssh -o BatchMode=yes $REMOTE_SSH_OPTS $SSH_TARGET "rm -rf /tmp/.claude_hsb_app_session"
```

## Phase gate — user confirmation between phases

After completing each phase (Phases 0–2), **always prompt the user for confirmation** before starting the next phase.

**Exception**: When `--y` (auto-approve mode) is active, phase gates are skipped. See "Auto-approve mode (`--y`)" section.

```
Proceed to Phase <N+1> (<phase description>)? [Y/n]
```

### User response handling

All prompts in this skill require explicit typed responses. Never treat a blank or Enter-only input as a selection — re-prompt the user instead.

- **"y"**, **"yes"**, **"Y"**, **"ok"**, **"go"**, **"continue"**, **"next"** → proceed to the next phase.
- **"n"**, **"no"**, **"stop"**, **"abort"** → stop execution. Print:
  ```
  App workflow paused after Phase N.
  You can resume by re-invoking the skill.
  ```
  Then run session teardown.
- **Any other text** → treat as a question or instruction about the current phase. Answer it, then re-prompt.
- **"retry"** → re-execute the current phase, show summary again, then re-prompt.

### Exceptions

- **Phase 3** (session report) is the final phase — do not prompt after it unless the user wants to run another app. Show the report and offer to save.
- **If a phase FAILs** and cannot be recovered, stop and report clearly.

## Built-in help (`--help`)

If `$ARGUMENTS` contains `--help` or `-h`, print the following and stop:

```
HSB Application Runner Skill

USAGE
  /hsb-app [OPTIONS]

OPTIONS
  --help, -h        Show this help message and exit
  --verbose         Show full raw command output for every phase
  --y               Auto-approve all phase gates (skip user confirmation
                    between phases). Not recommended — a confirmation
                    warning is shown before proceeding. All output is
                    saved to a timestamped log file.
  --timeout N       Set app runtime in seconds (default: no timeout,
                    app runs until user asks to stop)
  --full            Force full verification from Phase 0, even if the
                    session was already verified

ENVIRONMENT VARIABLES (set before invoking the skill)
  SSH_TARGET        Remote login target (e.g. ubuntu@10.0.0.1)
  REMOTE_ROOT       Remote working directory
  REMOTE_SUDO       Privilege escalation: 'sudo', 'sudo -n', or ''
  REMOTE_SSH_OPTS   Additional SSH options
  HSB_PLATFORM      Platform hint
  HSB_REPO_DIR      Repo directory name under REMOTE_ROOT (default: holoscan-sensor-bridge)
                    Example: HSB_REPO_DIR=hololink → repo at $REMOTE_ROOT/hololink

WORKFLOW PHASES
  Phase 0   Verify board connectivity and demo container readiness
            (skipped on repeat runs in the same session)
  Phase 1   Discover user setup, scan examples, select application
            (setup discovery skipped on repeat runs)
  Phase 2   Run application with monitoring and iterative debugging
  Phase 3   Generate and optionally save session report

EXAMPLES
  /hsb-app
  /hsb-app --verbose
  /hsb-app --timeout 60
  /hsb-app --timeout 30 --verbose
  /hsb-app --y
  /hsb-app --y --timeout 120
  /hsb-app --full
  /hsb-app --help
```

## Invocation examples

- `/hsb-app`
- `/hsb-app --verbose`
- `/hsb-app --timeout 60`
- `/hsb-app --timeout 30 --verbose`
- `/hsb-app --y`
- `/hsb-app --y --timeout 120`
- `/hsb-app --full`
- `/hsb-app --full --verbose`
- `/hsb-app --help`

## Verbosity mode (`--verbose`)

The skill supports a `--verbose` flag:

### Detecting the flag

Check whether `$ARGUMENTS` (the text after the slash command) contains any of: `--help` / `-h`, `--verbose`, `--y`, `--timeout N`, or `--full` (case-insensitive). Strip all flags (and their values) from arguments before further parsing.

When `--full` is present, ignore any cached session state and run Phase 0 from scratch.

### Verbose mode (when set)

- Show complete raw output of every SSH command
- Show full app output inline (all stdout/stderr)
- Show detailed phase status blocks

### Concise mode (default, no `--verbose`)

- Show bullet-point summaries after each phase
- Suppress raw command output
- Show key app output lines (startup, errors, summary) but not every frame log
- Show issues with the 4-line format (Symptom, Cause, Resolution, Blocking)

## Auto-approve mode (`--y`)

The skill supports a `--y` flag that skips all phase gates and runs the entire workflow from start to finish without waiting for user confirmation between phases. This is **not recommended** for normal use.

### Confirmation warning

When `--y` is detected, display a warning and ask the user to confirm:

```
⚠  WARNING: Auto-approve mode (--y) is enabled.

This is NOT RECOMMENDED. All phase gates will be skipped and the entire
workflow will run without pausing for your confirmation between phases.

You will not be able to review intermediate results, ask questions, or
abort between phases. All output will be saved to a timestamped log file.

NOTE: In auto-approve mode, the app selection in Phase 1 will still
require your input (you must choose which app to run), but the app will
run with default settings automatically. Debug iterations in Phase 2
will be skipped — the app runs once and the result is reported.

Type 'yes' to confirm auto-approve mode, or anything else to cancel:
```

- If the user responds with **"yes"** (exact match, case-insensitive) → enable auto-approve mode.
- Any other response → cancel auto-approve mode and run interactively.

### Behavior when `--y` is active

1. **Phase gates are skipped** between phases.
2. **App selection still requires user input** — the user must choose which app to run.
3. **Default app settings are used automatically** — the "defaults vs. customize" prompt is skipped and the app runs with its default options.
4. **Timeout defaults to 30 seconds** if no `--timeout` was specified on the command line (to avoid indefinite hangs).
5. **Debug iterations are skipped** — if the app fails in Phase 2, the failure is logged but no interactive debugging is performed. The workflow proceeds directly to the report.
6. **Log file**: Created at start as `hsb-app-log-YYYY-MM-DD-HHMMSS.md` in `$REMOTE_ROOT/` or current directory.
7. **Phase summaries are still shown** in real time.
8. **Failures still stop the workflow** if they are blocking.

### Combining with other flags

- `--y --verbose`: Auto-approve with full raw output.
- `--y --timeout N`: Auto-approve with a fixed app runtime.
- `--y` alone: Auto-approve with concise output and no timeout (app runs for a default 30 seconds in auto-approve mode to avoid indefinite hangs).

## Timeout handling (`--timeout`)

The skill supports a `--timeout N` flag where N is the number of seconds to run the application.

### Detecting the flag

Match `--timeout` followed by a whitespace-separated integer in `$ARGUMENTS`. Example: `--timeout 60`.

### Behavior

- **When set**: The app runs for exactly N seconds, then is stopped via `docker stop`. The output collected during that window is shown to the user.
- **When not set (interactive mode)**: The app runs indefinitely until the user asks to stop. The user is informed how to request a stop.
- **When not set (auto-approve mode)**: The app runs for a default of 30 seconds to prevent indefinite hangs.

### Validation

- N must be a positive integer
- Minimum: 5 seconds
- Maximum: 3600 seconds (1 hour)
- If invalid, show an error and ask the user to provide a valid timeout
