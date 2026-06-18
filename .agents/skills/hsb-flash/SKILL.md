---
name: hsb-flash
description: Flash the FPGA on an HSB board connected to an NVIDIA devkit. Supports HSB Lattice boards (FPGA versions 2407, 2412, 2507, 2510) and Leopard Imaging VB1940 "all-in-one" cameras (FPGA versions 2507, 2510). Uses release-specific YAML manifests and board-type-specific program commands. Lattice and VB1940 commands must never be mixed.
author: "Holoscan Team <holoscan-team@nvidia.com>"
license: "Apache-2.0"
version: "1.0.0"
tags:
  - holoscan-sensor-bridge
  - hsb
  - fpga-flashing
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
    - fpga-flashing
  agents:
    - claude-code
    - codex
---

# HSB FPGA Flash

Use this skill when the user wants to flash (upgrade or downgrade) the FPGA firmware on an HSB board connected to a supported NVIDIA devkit.

**This skill supports two board types:**

1. **HSB Lattice boards** — standalone FPGA board with a Lattice CPNX100 FPGA
2. **Leopard Imaging VB1940** — "all-in-one" camera with an integrated Lattice FPGA

**CRITICAL SAFETY RULE: Never mix board-type commands.** Using `program_leopard_cpnx100` on a Lattice board or `program_lattice_cpnx100` on a VB1940 **can permanently brick the device**. The skill must detect and confirm the board type before any flash operation, and refuse to proceed if the board type is ambiguous or mismatched.

This workflow has side effects (it permanently modifies FPGA firmware). Never run it automatically. Only run it when the user explicitly invokes it.

**Usage warning:** This skill flashes the FPGA with new firmware. Before invoking it, ask the user to make sure they have enough Claude Code usage/tokens to complete the workflow.

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

**Gate 2 — Present the flash summary and phase plan.** Before taking any action:

If the user's request already includes board type, current FPGA version, and target FPGA version, state the following before the phase plan: flash tool (`program_lattice_cpnx100` for Lattice, `program_leopard_cpnx100` for VB1940 — never mix), manifest release and filename, CLI flags (`--force --accept-eula`), whether the procedure is single-step or two-step via gateway 2412. For VB1940, also state that no v2.0.0 interim repo is needed. For two-step upgrades from FPGA 2407, state that step 1 uses `hololink --force fpga_version` (not `hololink enumerate`, which is incompatible with FPGA 2407) and uses v2.0.0 flag placement: `hololink --force program scripts/manifest.yaml --accept-eula` (`--force` before the subcommand).

Then show the phase plan and ask explicitly: `Shall I proceed with the flash workflow? [Y/n]` — do not start Gate 3 until the user confirms:

```
HSB Flash — Phase Plan
  Phase 0: Token-budget preflight
  Phase 1: Verify board connectivity, detect board type (Lattice or VB1940), read FPGA version
  Phase 2: Select target FPGA version
  Phase 3: Prepare flash infrastructure and YAML files, present flash plan for approval
  Phase 4: Execute flashing procedure (with power cycle verification)
  Phase 5: Summary report (with option to save)
  Phase 6: Clean up flash artifacts
```

**Gate 3 — Token-budget preflight (Phase 0).** Run after the phase plan (Gate 2) has been presented and the user has confirmed. Do not run the token-budget check before the phase plan is shown. Do not proceed to Phase 1 until the budget check passes.

**Gate 4 — Confirm board type explicitly.** Before any flash command, confirm with the user whether the board is **Lattice** or **VB1940**. Never mix `program_lattice_cpnx100` and `program_leopard_cpnx100` — wrong tool can brick the device.

## Instructions

Invoke this skill by typing `/hsb-flash [OPTIONS]`. The skill detects the board type automatically, presents a flashing plan, and prompts for confirmation before each flash step. See [references/help-text.md](references/help-text.md) for the full `--help` output.

## What this skill must do

0. **Run the mandatory token-budget preflight before any remote command, repo checkout, container build, or flash preparation.** Estimate the tokens needed to complete all phases, check the user's remaining subscription-plan usage with the best available Claude Code/account usage mechanism, display the estimate and result to the user, and stop if the available budget is insufficient or cannot be verified.
1. Verify that an HSB board is connected to a devkit, that SSH and board connectivity work, read the current FPGA version, and **identify the board type** (Lattice or VB1940). Try `hololink enumerate` first; if it fails (which is expected for FPGA 2407 boards), fall back to `hololink --force fpga_version`. For Lattice boards, if all methods fail with the existing repo's container, checkout HSB release repo v2.0.0 and retry using the v2.0.0 container. If that also fails, assume the version is 2407 and continue. For VB1940 boards, ask the user if the version cannot be read.
2. Ask the user for the target FPGA version they want to flash to (or accept "latest"). The available versions depend on the board type.
3. **Handle undocumented FPGA versions** (applies to both Lattice and VB1940): If the current or target FPGA version is not listed in this skill's supported versions or mapping tables, it may belong to a newer HSB release not yet documented here, or it may be an unreleased development build. Proceed as follows:
   - **Check for a newer release**: Fetch the public release notes at `https://github.com/nvidia-holoscan/holoscan-sensor-bridge/blob/main/RELEASE_NOTES.md` and look for a release that introduces the undocumented FPGA version. If a matching release is found, checkout that release repo on the devkit and use it for flashing following the same rules described below for the detected board type. Also update this skill's mapping tables, supported FPGA versions lists, and transition matrices with the new release and its corresponding FPGA version.
   - **Development or unreleased FPGA**: If no published release corresponds to the FPGA version, use the existing HSB repo already on the devkit (from `/hsb-setup`) to flash, following the same rules for the detected board type. If the flash fails, report the error and prompt the user for further instructions.
4. Determine the correct flashing procedure and prepare flash scripts and YAML files:
   - **Lattice boards**:
     1. Read the FPGA version currently flashed on the HSB board. Determine the required HSB release repo based on the flash direction: for upgrades, use the repo corresponding to the target FPGA version; for downgrades, use the repo corresponding to the current FPGA version (see "FPGA version to repo mapping" below). Checkout this repo if it does not already exist on the devkit.
     2. Copy the target FPGA manifest YAML from the relevant `scripts/` directory of this skill to the checked-out repo, and patch the file as needed for any missing details (e.g., `fpga_uuid`).
     3. Determine the flashing procedure:
        - **Single-step upgrade**: If the current version is 2412 or newer and the target is also 2412 or newer, or if upgrading from any version to exactly 2412. Flash directly from the current version to the target using the repo that corresponds to the target FPGA version (see "FPGA version to repo mapping").
        - **Single-step downgrade**: If both the current and target versions are 2412 or newer. Flash directly from the current version to the target using the repo that matches the current FPGA version.
        - **Two-step downgrade**: If the target is older than 2412 (i.e., 2407) and the current version is newer than 2412. Step 1: flash from the current version to 2412 using the repo that matches the current FPGA version. Step 2: flash from 2412 to the target using HSB release repo v2.0.0. Power cycle required between steps. (Special case: if the current version is exactly 2412, only step 2 is needed.)
        - **Two-step upgrade**: If the current version is older than 2412 (i.e., 2407) and the target is newer than 2412. Step 1: flash from the current version to 2412 using v2.0.0 (which corresponds to target FPGA 2412). Step 2: flash from 2412 to the target using the repo that corresponds to the target FPGA version. Power cycle required between steps.
     4. Read the user guide of the HSB repo being used for flashing and extract the flash command. Always add `--force` and `--accept-eula` to ensure non-interactive execution inside the container. **Note:** v2.0.0 places `--force` before the subcommand and `--accept-eula` after — see "v2.0.0 CLI flag placement" below.
     5. After flashing is complete, clean up all interim HSB release repos that were checked out by this skill and differ from the user's original repo that existed on the devkit before the skill was invoked.
   - **VB1940 cameras**: Use the existing HSB repo on the devkit directly (no v2.0.0 interim repo needed). Flashing is always single-step.
   Present the full flashing plan to the user for approval.
5. Execute the flashing procedure:
   - Perform required pre-flash safety checks (ping board, confirm board type and current FPGA version).
   - Run each flash step with full logging; announce the operation before flashing.
   - Require explicit user confirmation before each critical flash and after any required board/camera power cycle.
   - All program commands must be executed **inside the demo container** (no sudo needed within the container).
   - After flashing, verify the new FPGA version matches the intended target before proceeding.
   - Handle any error or mismatch by stopping the workflow, reporting the state, and offering to clean up.
6. Produce a summary report of the entire procedure with the option to save it.
7. Clean up all flash artifacts so the devkit is ready for the user to checkout any HSB release they need.

## Supported board types

| Board Type | Identifier | Description |
|------------|-----------|-------------|
| **Lattice** | `lattice` | HSB Lattice CPNX100-ETH-SENSOR-BRIDGE standalone FPGA board |
| **VB1940**  | `vb1940`  | Leopard Imaging VB1940 "all-in-one" Eagle Camera with integrated Lattice FPGA |

The board type is detected from the `hololink enumerate` output during Phase 1 and confirmed with the user. If detection is ambiguous, the user must explicitly specify the board type.

## Supported FPGA versions

### Lattice board FPGA versions

| Version | YAML Source Release | Notes |
|---------|-------------------|-------|
| 2407    | v2.0.0            | Oldest supported version |
| 2412    | v2.0.0            | Gateway version for two-step flashing |
| 2507    | v2.3.1            | |
| 2510    | v2.5.0            | Latest supported version |

### VB1940 FPGA versions

| Version | YAML Source Release | HSB Release | Notes |
|---------|-------------------|-------------|-------|
| 2507    | v2.3.0            | v2.3.0      | |
| 2510    | v2.5.0            | v2.5.0      | Latest supported version |

The VB1940 does **not** support versions 2407 or 2412 — these are Lattice-only.

**Versions not listed above:** FPGA versions newer than the latest documented version for either board type may still be flashable — see "Handling undocumented FPGA versions" below. For Lattice boards, versions older than 2407 or between known versions (e.g., 2409) are not supported. For VB1940, versions older than 2507 are not supported. In either case, refuse and show the supported versions for the board type.

## Flashing infrastructure

See [references/flashing-infrastructure.md](references/flashing-infrastructure.md) for GitHub release tags, bundled manifest YAML layout, board-specific flash commands, v2.0.0 CLI flag differences, and FPGA 2407 enumerate workaround.


## Repo selection and checkout (Lattice only)

The "Lattice board FPGA versions" table above determines which HSB release repo to use. The lookup key depends on direction:

- **Upgrades**: Look up the **target** FPGA version's YAML Source Release.
- **Downgrades**: Look up the **current** FPGA version's YAML Source Release.

> **Self-updating**: If an undocumented FPGA version is encountered, the skill checks the public release notes for a matching HSB release (see "Handling undocumented FPGA versions"). If found, the skill updates the "Supported FPGA versions" tables, the transition matrix, and notes the new release's manifest files.

### Repo checkout logic

1. **Check for an existing repo**: If the user already has an HSB repo on the devkit (from `/hsb-setup`), read its version from the `VERSION` file.
2. **Determine the required repo**: For upgrades, look up the target FPGA version in the mapping table. For downgrades, look up the current FPGA version.
3. **Checkout if needed**: If the existing repo does not match the required version, clone and checkout the required repo version into a separate directory. The existing repo is left untouched.
4. **Two-step case**: If a two-step flash is required, both step repos must be available. For two-step downgrade (current > 2412, target = 2407), step 1 uses the current FPGA's repo and step 2 uses v2.0.0. For two-step upgrade (current = 2407, target > 2412), step 1 uses v2.0.0 (target 2412's repo) and step 2 uses the repo corresponding to the final target FPGA version. If any required repo is not already present, it is checked out.

> **VB1940 note**: VB1940 flashing **always** uses the existing repo on the devkit — the FPGA-to-repo mapping does not apply. The existing repo must be at version v2.3.0 or later. If no existing repo is found, instruct the user to run `/hsb-setup` first.

### What to save from detection

During Phase 1, when scanning for an existing repo and detecting the board type, save these variables to the session state:

- `BOARD_TYPE` — the detected board type: `lattice` or `vb1940`
- `EXISTING_REPO_DIR` — absolute path to the existing HSB repo (empty if none found)
- `EXISTING_REPO_VERSION` — the repo's release version (e.g., `2.3.1`), read from the `VERSION` file
- `FLASH_REPO_DIR` — absolute path to the repo that will be used for flashing (may differ from `EXISTING_REPO_DIR` if a different version was checked out)
- `FLASH_REPO_VERSION` — the version of the flash repo (looked up from the FPGA-to-repo mapping)
- `INTERIM_REPOS` — list of repo directories checked out by this skill (for cleanup in Phase 6)

## Linux/Windows-friendly wrapper variables

Reuse the same environment variables from the `hsb-setup` skill:

- `SSH_TARGET` for the remote login target (e.g. `nvidia@agx-thor-host`)
- `REMOTE_ROOT` for the remote working directory where flash workspace will be created
- `REMOTE_SUDO` for privileged commands
- `REMOTE_SSH_OPTS` for additional SSH options
- `HSB_PLATFORM` as an optional platform hint

If these are set, notify the user of these settings and use them without re-asking.

Before Phase 1, print the resolved remote execution settings.

## Mandatory interaction pattern

Before making changes, show this phase plan:

- Phase 0: Token-budget preflight; verify the user's remaining plan usage can cover a complete flash workflow
- Phase 1: Verify board connectivity, **detect board type** (Lattice or VB1940), and read current FPGA version
- Phase 2: Select target FPGA version (available versions depend on board type)
- Phase 3: Prepare flash infrastructure and YAML files, present flashing plan for approval
  - **Lattice**: Checkout the required repo (target FPGA's repo for upgrades, current FPGA's repo for downgrades — if not already present), copy and patch manifest YAML
  - **VB1940**: Use existing repo directly
- Phase 4: Execute flashing procedure (with power cycle verification)
- Phase 5: Generate summary report (with option to save)
- Phase 6: Clean up flash artifacts

Then execute one phase at a time.

**After each non-final phase (Phases 0–5):**

1. Show a phase summary with key outcomes.
2. **Prompt the user** with `Proceed to Phase <N+1>? [Y/n]` and specify what the next phase does. Wait for confirmation before continuing.

**Exception**: When `--y` (auto-approve mode) is active, phase gates are skipped and phases run automatically. See "Auto-approve mode (`--y`)" section for details.

If something fails, do **not** just dump raw logs. Summarize:

- the exact command that failed
- the likely root cause
- what safe action you recommend
- whether the issue is blocking


## Phase details

See [references/phase-details.md](references/phase-details.md) for full step-by-step phase instructions, flashing procedure logic, execution rules, safety constraints, phase gate rules, verbosity behavior, force mode, and auto-approve mode.

## Built-in help (`--help`)

See [references/help-text.md](references/help-text.md) for the full `--help` output text.

## Invocation examples

See [references/help-text.md](references/help-text.md) for the full `--help` output including all invocation examples.
