<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Runtime context header

> **Audience:** every agent that prompts the user inside the USD Performance Tuning workflow.
> **Rule:** print one of the two formats below **before** asking the user anything that depends on the active Kit / Scene Optimizer / Asset Validator runtime — runtime choice at Phase 0, restructure decision at Phase 2e, destructive-op approval in `so-run-operations`, verdict in `compare-profiles`, and the runtime block in `optimization-report`. The user must always be able to see which Kit application and which package versions are about to act on their asset.

## Why this exists

Three concrete pains have repeatedly surfaced when the runtime isn't visible:

- A user authorizes a destructive operation without knowing which Kit version is about to mutate their stage — when something goes sideways later, reproduction is guesswork.
- The agent recommends an SO operation that the user's installed runtime doesn't ship. The user only finds out when the op silently no-ops mid-chain.
- Two team members run the same workflow against the same asset and get different validator counts because they're on different Kit / AV versions, and neither tracked which.

Always-showing the runtime context puts that information where the decision happens.

## Where artifacts live (the output_path workspace)

Every DTP run that writes anything (probe results, profiles, reports,
optimized USDs, generated scripts) writes into a single **`output_path`**
provided by the user. The output_path is the run's workspace; nothing
DTP-generated should live anywhere else.

Required layout under `output_path`:

```
<output_path>/
├── setup-preflight.json         ← session-scoped runtime config (probe output)
├── scripts/                     ← agent-generated Python scripts
│   ├── probe_setup.py
│   ├── profile_quick.py
│   ├── sa_assess.py
│   └── ...
├── profiles/                    ← profile-stage captures
├── <asset_stem>.optimized.usdc  ← optimized USD outputs
├── baseline_profile.json
├── sa_report.json
├── dedupe_candidates.json
└── *.log                        ← per-skill logs alongside the scripts
```

**Anti-patterns:**

- Do not create a `_work/` directory inside the skill repo or the
  working directory. Every artifact lives under `output_path`.
- Do not write `setup-preflight.json` under any other name (e.g.,
  `probe_result.json`) or any other location. Downstream skills read
  this exact filename at this exact location.
- Do not run agent-generated Python scripts inline only to discard the
  source. Write them to `<output_path>/scripts/` so the run is
  reproducible / auditable.

**When `output_path` is unknown:** if the user's first request does not
name an output_path and the request will write any artifact, the agent
asks the user for one before continuing. Do not pick a default.

## Mandatory session-start gate

**Before any other user-facing output**, the **entry skill** of every
DTP session MUST run the session-start gate exactly once. The entry
skill is whichever workflow skill the agent invokes first for the
user's request — typically `omniverse-usd-performance-tuning`, but can be
`so-run-operations`, `so-run-validators`, or `usd-validation-runner`
when the user invokes one of those directly. Downstream skills
(`apply-restructure`, `so-interpret-validators`, `compare-profiles`,
`optimization-report`, etc.) inherit the gate's result via the
preflight JSON and do not re-run it.

The gate's steps:

1. **Determine `output_path`.** Read it from the user's request, or
   prompt the user if they did not name one. The path must be writable
   and outside the skill repo (otherwise the repo gets polluted with
   run artifacts).

2. **Check `<output_path>/setup-preflight.json`.**
   - **Missing or unreadable** → invoke `setup-usd-performance-tuning`
     to run the full Step 1 flow (which will fire Step 1b's "provide
     path / scan / standalone / install" prompt when there's nothing to
     auto-detect). The setup skill writes its output to
     `<output_path>/setup-preflight.json` (canonical filename, canonical
     location). Do not improvise a probe, a different filename, or a
     different directory; the setup skill owns that flow.
   - **Present and parseable** → continue to step 3 below.

3. **Print Format A and ask the user to confirm.**

   ```
   ─── Runtime context ───────────────────────────────────────────────────────
   Kit application:    {runtime_context.kit.application} {runtime_context.kit.version}
     path:             {runtime_context.kit.path}
     build:            {runtime_context.kit.build}
   Scene Optimizer:    {runtime_context.sceneOptimizer.extension} {runtime_context.sceneOptimizer.version}
   Asset Validator:    {runtime_context.assetValidator.package} {runtime_context.assetValidator.version} via {runtime_context.assetValidator.source}
   ───────────────────────────────────────────────────────────────────────────

   This runtime will be used for the work that follows. Continue, or change it?

     > 1. Continue with this runtime
       2. Change Kit installation (re-runs setup-usd-performance-tuning Step 1)
       3. Switch to standalone (pip-installed libraries, no Kit)
       4. Re-run the runtime probe (refresh versions, re-detect)
   ```

4. **Route the answer.**
   - Option 1 → proceed to the actual work; subsequent messages in the
     same session may use Format B and skip the prompt.
   - Option 2 / 3 / 4 → invoke `setup-usd-performance-tuning` and
     overwrite the preflight before continuing.

The gate fires **once per session**. Subsequent skill invocations within
the same conversation reuse the preflight (and the user's "continue"
answer) without re-prompting; they use Format B for routine status.

**Anti-pattern — do not skip the gate just because preflight exists.**
A user who's coming back to a directory days later has no way to know
which Kit was chosen earlier or whether the previous probe is still
correct. Surfacing Format A + confirmation at session start is the only
way to make that visible.

**Anti-pattern — do not improvise a silent probe.** If the agent finds
itself running `python.bat` directly, scanning `LOCALAPPDATA`, or
`Test-Path`-checking `kit.exe` outside of `setup-usd-performance-tuning`,
the session-start gate has been skipped and the agent must back out and
run the gate instead.

## Source of truth

Both formats below read from the **`runtime_context`** object in `<output_path>/setup-preflight.json` (canonical filename + location; see *Where artifacts live* above). `runtime_context` is the canonical block the probe writes and downstream skills consume; the header never reads the raw probe `kit` / `sceneOptimizer` / `assetValidator` source fields directly. The fields the header consumes are:

- `runtime_context.kit.application` — friendly name (e.g. `USD Composer`, `Isaac Sim`, `Kit SDK`)
- `runtime_context.kit.version` — release version (e.g. `110.1.0`)
- `runtime_context.kit.path` — absolute install path
- `runtime_context.kit.build` — full build identifier when present (e.g. `110.1.0+main.10181.f4b28ef2.gl.windows-x86_64.release`)
- `runtime_context.sceneOptimizer.extension` — extension name (e.g. `omni.scene.optimizer.core`)
- `runtime_context.sceneOptimizer.version` — extension version
- `runtime_context.assetValidator.package` — package or extension name
- `runtime_context.assetValidator.version` — version
- `runtime_context.assetValidator.source` — `kit-extension`, `pip`, or `standalone` (informs the user whether AV runs through Kit or as a standalone Python install)

If `<output_path>/setup-preflight.json` is unavailable when an agent reaches a prompt that requires the header, it must invoke `setup-usd-performance-tuning` first. The header must never be skipped or partially filled.

## Format A — full block

Use at every decision point where the user is authorizing something that mutates state or sets the workflow direction. Required at:

- `setup-usd-performance-tuning` runtime-choice prompt
- `restructure-decision` Phase 2e prompt
- `so-run-operations` destructive-op confirmation
- The first user-facing message in any session that starts mid-workflow

```
─── Runtime context ───────────────────────────────────────────────────────
Kit application:    {runtime_context.kit.application} {runtime_context.kit.version}
  path:             {runtime_context.kit.path}
  build:            {runtime_context.kit.build}
Scene Optimizer:    {runtime_context.sceneOptimizer.extension} {runtime_context.sceneOptimizer.version}
Asset Validator:    {runtime_context.assetValidator.package} {runtime_context.assetValidator.version} via {runtime_context.assetValidator.source}
───────────────────────────────────────────────────────────────────────────
```

If the user has more than one Kit installed and the workflow has not yet committed to one, also append the choice prompt described in `setup-usd-performance-tuning` Step 1.5 below the block.

## Format B — compact one-liner

Use for routine status messages, ack messages, and follow-up prompts in the same session where the user has already seen Format A.

This file is the **single source of truth** for the Format B string. Any skill that prints it (`omniverse-usd-performance-tuning` initial ack, `compare-profiles` verdict header) must reproduce it character-for-character:

```
[Kit: {runtime_context.kit.application} {runtime_context.kit.version}  |  SO: {runtime_context.sceneOptimizer.version}  |  AV: {runtime_context.assetValidator.version}]
```

Required at:

- `omniverse-usd-performance-tuning` initial acknowledgement
- `compare-profiles` verdict header
- Per-prototype progress lines in `so-run-operations` batch mode (Phase 4b)

## When to refresh the block

The runtime can change mid-session if the user installs a new Kit or switches Python environments. The agent must re-print Format A whenever:

- `setup-usd-performance-tuning` is re-invoked
- An install reference (`install-kit`, `install-so-via-kit`, `install-so-standalone`, `install-asset-validator-standalone`) reports a successful install
- The agent explicitly requests a runtime switch from the user

Otherwise the cached preflight is fresh enough for the duration of the workflow.

## Examples

### A — fresh session, single Kit install detected

```
─── Runtime context ───────────────────────────────────────────────────────
Kit application:    USD Composer 110.1.0
  path:             D:\build\chk\usd_composer-fat\110.1.0+main.10181.f4b28ef2.gl.windows-x86_64.release\kit
  build:            110.1.0+main.10181.f4b28ef2.gl.windows-x86_64.release
Scene Optimizer:    omni.scene.optimizer.core 110.0.4
Asset Validator:    omniverse-asset-validator 1.x.y via kit-extension
───────────────────────────────────────────────────────────────────────────

I will run usd-structure-assessment on /path/to/asset.usd. OK?
```

### A with a multi-Kit choice prompt

```
─── Runtime context ───────────────────────────────────────────────────────
Kit application:    (not yet chosen — see Kit candidates below)
Scene Optimizer:    (version determined by Kit choice)
Asset Validator:    (version determined by Kit choice)
───────────────────────────────────────────────────────────────────────────

Multiple Kit installations were found. The newest one is pre-selected.
Press Enter to accept, or type the number of a different one.

  > 1. USD Composer 110.1.0    D:\build\chk\usd_composer-fat\110.1.0+main.…\kit         (newest, pre-selected)
    2. USD Composer 109.0.4    %LOCALAPPDATA%\ov\pkg\usd-composer-2025.1.0\kit
    3. Isaac Sim 5.1.0         %LOCALAPPDATA%\ov\pkg\isaac-sim-2025.1\kit
    4. Use standalone libraries instead (no Kit application)
```

### B — compact, mid-session

```
[Kit: USD Composer 110.1.0  |  SO: 110.0.4  |  AV: 1.x.y]

profile-stage: starting BASELINE capture in quick mode...
```

## Anti-patterns

- Do not print Format A more than once in the same session unless the runtime actually changed; users will start skimming it. Use Format B for everything after the first prompt.
- Do not print just the version without the path. The path is what lets the user reproduce the run on another machine or check whether they're pointed at a build they don't expect.
- Do not paraphrase the version. Print exactly what `<output_path>/setup-preflight.json` records. Paraphrasing creates ambiguity when someone later asks "which build?"
- Do not skip the block in `so-run-operations` destructive-op confirmation. The user authorizing a destructive op must see the runtime explicitly at the moment of authorization, not earlier in the session.

## Cross-references

- `setup-usd-performance-tuning` README.md — the source of the version probe and the multi-Kit selection prompt.
- `optimization-report` README.md — the report's `runtime_context` field mirrors these fields verbatim so post-hoc audits can reconstruct the run's runtime.
- The `optimization-report` reference's `scripts/optimization-report.schema.json` — the schema definition for the `runtime_context` object.
