---
name: hsb-setup
description: Clone the latest NVIDIA Holoscan Sensor Bridge repo, ask which supported devkit is being used, configure the host per platform, build the correct demo container, run it, and verify HSB connectivity by pinging 192.168.0.2. Use for Holoscan Sensor Bridge setup, build, container launch, and first-connectivity bring-up.
author: "Holoscan Team <holoscan-team@nvidia.com>"
license: "Apache-2.0"
version: "1.0.0"
tags:
  - holoscan-sensor-bridge
  - hsb
  - setup
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
    - setup
  agents:
    - claude-code
    - codex
---

# Holoscan Sensor Bridge demo bring-up

Use this skill when the user wants to bring up the Holoscan Sensor Bridge demo environment end to end.

This workflow has side effects. Never run it automatically. Only run it when the user explicitly invokes it.

## Before you start — required gates (do these first, in order)

**Gate 1 — Read environment variables.** Before doing anything else, check these variables and print their resolved values to the user:

```
SSH_TARGET      Remote devkit login (e.g. nvidia@192.168.1.50). Ask the user if not set.
REMOTE_ROOT     Remote working directory (e.g. /home/nvidia). Ask the user if not set.
REMOTE_SUDO     sudo / sudo -n / "" — default to "sudo" if not set.
REMOTE_SSH_OPTS Additional SSH options (optional).
HSB_PLATFORM    Platform hint — may be empty; will detect from hardware.
HSB_REPO        Custom repo URL — defaults to https://github.com/nvidia-holoscan/holoscan-sensor-bridge.git
```

**SSH_TARGET and REMOTE_ROOT are required. Stop and ask the user for them if either is missing.**

**Gate 2 — Present the phase plan.** Before taking any action, show the user this exact plan and wait for acknowledgement:

```
HSB Setup — Phase Plan
  Phase 0: Token-budget preflight
  Phase 1: Confirm platform, set up SSH, clone repo, study user guide
  Phase 2: Host prerequisite checks and network setup
  Phase 3: Native CLI build (AGX Thor only — skipped for other platforms)
  Phase 4: Build demo container, run it, ping 192.168.0.2, verify FPGA version
  Phase 5: Issues report (with option to save)
  Phase 6: Stop apps, exit container, hand control back to user
```

**Gate 3 — Token-budget preflight (Phase 0).** Run this before any SSH connection or devkit change. See `## Token-budget preflight` section for the full procedure. Do not proceed to Phase 1 until the budget check passes.

## Instructions

Invoke this skill by typing `/hsb-setup [PLATFORM] [OPTIONS]`. The skill walks through each phase interactively, prompting for confirmation before making changes.

## What this skill must do

0. **Run the mandatory token-budget preflight before any remote command or devkit configuration change.** Estimate the tokens needed to complete all setup phases, check the user's remaining subscription-plan usage with the best available Claude Code/account usage mechanism, display the estimate and result to the user, and stop if the available budget is insufficient or cannot be verified.
1. prompt the user to confirm that the devkit is connected to the holoscan sensor bridge and everything is powered up and there is an active network connection to the outside world and that the devkit was installed with the proper OS version. if all profile parameters are known look into the repo user guide and draw a diagram of the devkit to sensor for the user to confirm that this is the setup they have.
2. Once the user confirms the setup is ready, build the ssh connection to the devkit if the user is running the claude skill from an external computer. you can skip this step if claude installed directly on the devkit.
3. Verify the host devkit platform by running `cat /sys/class/dmi/id/product_name` on the devkit and comparing the result to the `HSB_PLATFORM` environment variable using the product-name-to-platform mapping (see "Host platform auto-detection" section). If the command returns a recognized non-empty platform name that differs from `HSB_PLATFORM`, or if `HSB_PLATFORM` is empty, update `HSB_PLATFORM` to match the detected platform and alert the user about the change. If the command returns empty or fails and `HSB_PLATFORM` is already set, keep the existing value.
4. Clone or refresh the GitHub repository from the latest `main` branch. By default this is the public `nvidia-holoscan/holoscan-sensor-bridge` repo, but the user can override it with a custom repo URL via the `HSB_REPO` environment variable or the `--repo <URL>` command-line flag. if the repo is an ssh repo, alert the user if no ssh key is set and provide instructions how to set up the ssh key.
5. Ask the user which devkit/platform they want to use **if it is not already clear**.
6. under the cloned repo root dir, study and understand the user guide at docs/user_guide to learn how to set up host environment for each devkit and OS, demo container, running applications inside and outside the container (where applicable) and flashing the FPGA.
7. Map that platform to the correct host setup and container build mode and make sure host set up is configured properly per user guide instructions, fix and add any missing configuration or prompt the user with instruction how to fix.
8. Build the demo container.
9. Run the demo container.
10. Verify connectivity to the board at `192.168.0.2`. if the connection to the board fails, prompt the user for a possiblity of a different ip address.
11. Verify the FPGA version reading register 0x80. if the FPGA version on the sensor does not match the hsb host software that is on the devkit, suggest the user to use the hsb-flash-skill to flash the board to the proper FPGA version.
12. Report progress in phases, explain failures clearly, and attempt safe fixes before giving up.
13. For every issue encountered, create a report that specifies what was the issue and how you overcame it.
14. Allow the user an option to export the final report to an md file.
15. once you are done setup, stop any running apps and exit the container giving up control on the devkit to the user at repo home directory on terminal window.

## Supported platforms and build mapping

Use the following mapping unless the repository or current docs in the working tree clearly say otherwise:

- **IGX Orin with dGPU OS/configuration** → build with `sh docker/build.sh --dgpu`
- **IGX Orin iGPU** → build with `sh docker/build.sh --igpu`
- **AGX Orin** → build with `sh docker/build.sh --igpu`
- **AGX Thor** → build with `sh docker/build.sh --igpu`
- **DGX Spark** → build with `sh docker/build.sh --igpu`

If the user says only “IGX Orin”, explicitly ask whether it is **iGPU** or **dGPU OS/configuration**.


## Host platform auto-detection

During Phase 1 (after SSH is established or when running locally), verify the actual devkit hardware by reading the DMI product name and comparing it to the `HSB_PLATFORM` environment variable.

### Product-name-to-platform mapping

The following table maps known `/sys/class/dmi/id/product_name` values to supported `HSB_PLATFORM` values. Match using **case-insensitive substring** search — the product name may contain additional text (e.g., "Developer Kit", revision numbers).

| `product_name` contains (case-insensitive) | Mapped `HSB_PLATFORM` | Notes |
|---|---|---|
| `IGX Orin` | `IGX Orin` | Still need to ask iGPU vs dGPU if not already known |
| `AGX Orin` | `AGX Orin` | |
| `AGX Thor` | `AGX Thor` | |
| `DGX Spark` | `DGX Spark` | |

If the product name does not match any known pattern, treat it as **unrecognized** and fall through to the manual platform question in step 5.

### Detection and reconciliation logic

Run the following on the devkit (inside the Phase 1 SSH heredoc or locally):

```bash
DETECTED_PRODUCT=""
if [ -f /sys/class/dmi/id/product_name ]; then
  DETECTED_PRODUCT=$(cat /sys/class/dmi/id/product_name 2>/dev/null | tr -d '\n')
fi

DETECTED_PLATFORM=""
if echo "$DETECTED_PRODUCT" | grep -qi "IGX Orin"; then
  DETECTED_PLATFORM="IGX Orin"
elif echo "$DETECTED_PRODUCT" | grep -qi "AGX Orin"; then
  DETECTED_PLATFORM="AGX Orin"
elif echo "$DETECTED_PRODUCT" | grep -qi "AGX Thor"; then
  DETECTED_PLATFORM="AGX Thor"
elif echo "$DETECTED_PRODUCT" | grep -qi "DGX Spark"; then
  DETECTED_PLATFORM="DGX Spark"
fi

echo "DETECTED_PRODUCT=$DETECTED_PRODUCT"
echo "DETECTED_PLATFORM=$DETECTED_PLATFORM"
echo "HSB_PLATFORM=${HSB_PLATFORM:-}"
```

After collecting the output, apply the following reconciliation rules:

1. **`DETECTED_PLATFORM` is non-empty and `HSB_PLATFORM` is empty** → set `HSB_PLATFORM` to `DETECTED_PLATFORM`. Alert the user:
   ```
   Platform auto-detected from hardware: <DETECTED_PLATFORM> (product_name: <DETECTED_PRODUCT>).
   HSB_PLATFORM was not set — updating to "<DETECTED_PLATFORM>".
   ```

2. **`DETECTED_PLATFORM` is non-empty and differs from `HSB_PLATFORM`** → override `HSB_PLATFORM` with `DETECTED_PLATFORM`. Alert the user:
   ```
   WARNING: Hardware reports "<DETECTED_PLATFORM>" (product_name: <DETECTED_PRODUCT>),
   but HSB_PLATFORM was set to "<HSB_PLATFORM>".
   Updating HSB_PLATFORM to match the detected hardware: "<DETECTED_PLATFORM>".
   ```

3. **`DETECTED_PLATFORM` is non-empty and matches `HSB_PLATFORM`** → no change needed. Confirm:
   ```
   Platform verified: <HSB_PLATFORM> matches hardware (product_name: <DETECTED_PRODUCT>).
   ```

4. **`DETECTED_PLATFORM` is empty** (file missing, unreadable, or unrecognized product name) **and `HSB_PLATFORM` is set** → keep the existing `HSB_PLATFORM`. Warn:
   ```
   Could not auto-detect platform from hardware (product_name: "<DETECTED_PRODUCT>").
   Keeping existing HSB_PLATFORM: "<HSB_PLATFORM>".
   ```

5. **Both `DETECTED_PLATFORM` and `HSB_PLATFORM` are empty** → fall through to the manual platform question in step 5.

After reconciliation, persist the updated `HSB_PLATFORM` in the remote session state file so subsequent phases use the correct value.

## Linux/Windows-friendly wrapper variables

When this skill is used from Linux/Windows with a local Claude Code session that shells out to SSH, prefer these environment variables when present:

- `SSH_TARGET` for the remote login target such as `nvidia@agx-thor-host`
- `REMOTE_ROOT` for the remote working directory where the repo should live
- `REMOTE_SUDO` for privileged commands. Accept `sudo`, `sudo -n`, or empty string
- `REMOTE_SSH_OPTS` for additional SSH options
- `HSB_PLATFORM` as an optional platform hint
- `HSB_REPO` for a custom GitHub repository URL to clone (e.g. `https://github.com/myorg/my-hsb-fork.git`). If not set, defaults to `https://github.com/nvidia-holoscan/holoscan-sensor-bridge.git`

If these are set, notify the user of these settings and use them without re-asking unless the user explicitly overrides them.

Before Phase 1, print the resolved remote execution settings you will use, with secrets redacted if needed.

## Mandatory interaction pattern

Present the phase plan from Gate 2 above before making any changes. Skip Phase 3 for non-Thor platforms.

Then execute one phase at a time.

**After each non-final phase (Phases 0–5):**

1. Show a phase summary. The detail level depends on `--verbose` mode (see "Verbosity mode" section):
   - **Verbose**: full output + detailed status block (phase name, what ran, result, next action).
   - **Concise** (default): bullet-point summary with issues highlighted.
2. **Prompt the user** with `Proceed to Phase <N+1>? [Y/n]` while specifing what is phase N+1 and wait for confirmation before continuing (see "Phase gate" section).

If something fails, do **not** just dump raw logs. Summarize:

- the exact command that failed
- the likely root cause
- what safe repair you will try next
- whether the repair succeeded

## Token-budget preflight

### Phase 0 - token-budget preflight

This phase is mandatory and must run before any SSH connection, repo clone, package/configuration check, container build, reboot, or devkit setting change.

1. **Estimate the full-run token budget** for the entire setup workflow, not just the next phase. The values below are conservative heuristics, not measured historical usage. Treat them as initial safety budgets and refine them from actual `/hsb-setup` run logs once measured token usage is available:
   - Reserve at least **280,000 tokens** for a complete setup run on IGX Orin, AGX Orin, or DGX Spark.
   - Reserve at least **340,000 tokens** for AGX Thor because native build and SIPL/FuSa checks add more phases and troubleshooting.
   - Add **60,000 tokens** when `--verbose`, custom repo handling, SSH key remediation, reboot recovery, or extra troubleshooting is expected.
   - Use the larger estimate if the platform is not yet known.

2. **Check remaining usage** using the best available Claude Code/account usage source for the current subscription plan. Prefer machine-readable or product-provided usage data when available. If no reliable usage source is available, ask the user to provide their current remaining usage/quota from the Claude Code account or plan UI.

   When asking the user because usage cannot be self-verified, present the options in this exact order so the safe stop choices appear first:
   1. **I can't verify — stop**: The user cannot determine remaining usage. Stop before Phase 1.
   2. **I have < {estimate} available — stop**: The user checked their plan/account UI and confirms less than the estimated budget remains. Stop before Phase 1.
   3. **I have ≥ {estimate} available — proceed**: The user checked their plan/account UI and confirms at least the estimated budget remains. Proceed to Phase 1.
   4. **Type something**: Treat as a question or free-form instruction, answer it, then re-prompt with the same ordered options.

   Do not put the proceed option first. The user must intentionally move past the stop choices before selecting proceed.

3. **Display the result to the user** before continuing:

   ```text
   Token-budget preflight
   - Estimated tokens required for complete /hsb-setup run: <estimate>
   - Estimate basis: conservative heuristic; refine from actual run logs when available
   - Safety margin included: <margin>
   - Remaining plan usage available: <available or "unverified">
   - Result: PASS / FAIL
   ```

4. **Stop on insufficient or unverifiable budget**:
   - If remaining usage is lower than the estimate, stop before Phase 1 and explain that the skill is refusing to start because it may run out of tokens while modifying devkit settings.
   - If remaining usage cannot be verified, stop before Phase 1 and ask the user to start a fresh session, upgrade/refresh usage, or provide verifiable remaining usage.
   - `--y` must not bypass this preflight.

## Platform questions to ask when missing

Ask only the minimum required questions:

1. Which platform are you using?
   - IGX Orin iGPU
   - IGX Orin dGPU
   - AGX Orin
   - AGX Thor
   - DGX Spark
2. Is the HSB board already physically connected and powered on?
3. Are you okay with commands that require `sudo` for network and Docker setup?

If the user already provided any of these, do not ask again.


## Available Scripts

| Script | Purpose | Arguments |
|--------|---------|-----------|
| `scripts/hsb_phase_runner.sh` | Structured shell execution with timestamped logs per phase | `<phase_name> <command>` |

Use `run_script(scripts/hsb_phase_runner.sh, <phase_name>, <command>)` to run phase steps with automatic logging.

## Phase details

See [references/phase-details.md](references/phase-details.md) for full step-by-step phase instructions, output style, verbosity behavior, auto-approve mode, phase gate rules, and the persistent SSH session model.

## Recovery playbook

Try these fixes in order when applicable:

1. Re-run the failing command once if the failure looks transient.
2. Fix missing prerequisites (`git-lfs`, Docker access, `xhost`, network route).
3. Refresh repo state and LFS content.
4. Re-run only the failed phase, not the whole workflow.
5. If still blocked, stop with a concise diagnosis and a copy-paste command list for the user.


## Supporting files in this skill

- See [docs/platform-mapping.md](docs/platform-mapping.md) for the authoritative build and host-setup summary used by this skill.
- See [docs/failure-playbook.md](docs/failure-playbook.md) for common remediation logic.
- Use [scripts/hsb_phase_runner.sh](scripts/hsb_phase_runner.sh) as a helper when you want structured shell execution and timestamped logs.

## Built-in help (`--help`)

If `$ARGUMENTS` contains `--help` or `-h`, **do not run the workflow**. Instead, print the following help text verbatim and stop:

```
Holoscan Sensor Bridge — Demo Bring-Up Skill

USAGE
  /hsb-setup [PLATFORM] [OPTIONS]

PLATFORM (optional — will prompt if omitted)
  AGX Orin          NVIDIA Jetson AGX Orin (iGPU, build with --igpu)
  AGX Thor          NVIDIA Jetson AGX Thor (iGPU, build with --igpu)
  IGX Orin iGPU     NVIDIA IGX Orin in iGPU configuration (build with --igpu)
  IGX Orin dGPU     NVIDIA IGX Orin with discrete GPU (build with --dgpu)
  DGX Spark         NVIDIA DGX Spark (iGPU, build with --igpu)

OPTIONS
  --help, -h        Show this help message and exit
  --verbose         Show full raw command output for every phase
                    (default is concise bullet-point summaries)
  --y               Auto-approve all phase gates (skip user confirmation
                    between phases). Not recommended — a confirmation
                    warning is shown before proceeding. All output is
                    saved to a timestamped log file.
  --repo <URL>      Clone a custom GitHub repo instead of the default
                    nvidia-holoscan/holoscan-sensor-bridge.
                    Can also be set via the HSB_REPO env var.
                    Priority: --repo flag > HSB_REPO env var > default repo

ENVIRONMENT VARIABLES (set before invoking the skill)
  SSH_TARGET        Remote login target (e.g. ubuntu@10.0.0.1)
  REMOTE_ROOT       Remote working directory for repo clone and builds
  REMOTE_SUDO       Privilege escalation: 'sudo', 'sudo -n', or ''
  REMOTE_SSH_OPTS   Additional SSH options (e.g. -o ServerAliveInterval=30)
  HSB_PLATFORM      Platform hint (same values as PLATFORM above)
  HSB_REPO          Custom GitHub repo URL (overridden by --repo flag)

WORKFLOW PHASES
  Phase 0   Token-budget preflight; verify enough plan usage for a full run
  Phase 1   Confirm platform, clone repo, and study user guide
  Phase 2   Host prerequisite checks and network setup
  Phase 3   Native build of CLI tools (AGX Thor only, skipped otherwise)
  Phase 4   Build, run demo container, and verify connectivity
  Phase 5   Produce issues report, optionally export to file
  Phase 6   Stop apps, exit container, hand off to user

  The skill prompts for confirmation between each phase.

EXAMPLES
  /hsb-setup AGX Thor
  /hsb-setup AGX Thor --verbose
  /hsb-setup AGX Thor --y
  /hsb-setup IGX Orin dGPU --repo https://github.com/myorg/my-fork.git
  /hsb-setup --help
```

After printing the help text, do not proceed with any phases or ask any questions.

See the `EXAMPLES` section in [Built-in help (`--help`)](#built-in-help---help) for invocation examples.

When `$ARGUMENTS` contains a platform, use it instead of asking again. Strip `--verbose`, `--y`, `--repo <URL>`, and `--help` from the arguments before parsing the platform name.
