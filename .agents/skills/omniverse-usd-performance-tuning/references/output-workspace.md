---
agent_context: usd-performance-workflow
agent_routes:
  - omniverse-usd-performance-tuning
agent_next:
  - setup-usd-performance-tuning/references/runtime-context-header.md
freshness: 2026-05-20
version: "0.1.0"
---
<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Output Workspace Contract

Every USD performance tuning run that writes probes, scripts, profiles,
optimized USDs, logs, or reports writes into a single user-provided
`output_path`. The output path is the run workspace. Do not write generated
artifacts under the skill repo or the shell working directory.

## Required Layout

```text
<output_path>/
├── setup-preflight.json
├── scripts/
│   ├── probe_setup.py
│   ├── profile_quick.py
│   ├── sa_assess.py
│   └── ...
├── profiles/
├── <asset_stem>.optimized.usdc
├── baseline_profile.json
├── sa_report.json
├── dedupe_candidates.json
└── *.log
```

`setup-preflight.json` is the canonical session-scoped runtime configuration.
The setup, validation, Scene Optimizer, compare, and report references all read
this exact filename from this exact location.

## Runtime Gate

If `output_path` is missing and the request will write any artifact, ask the
user for one before continuing. If `<output_path>/setup-preflight.json` is
missing or unreadable, invoke `setup-usd-performance-tuning`; do not improvise a
silent runtime probe. If the file exists, print the runtime context before
asking the user to continue, change Kit, switch to standalone, or refresh the
probe.

```text
─── Runtime context ───────────────────────────────────────────────────────
Kit application:    {runtime_context.kit.application} {runtime_context.kit.version}
  path:             {runtime_context.kit.path}
  build:            {runtime_context.kit.build}
Scene Optimizer:    {runtime_context.sceneOptimizer.extension} {runtime_context.sceneOptimizer.version}
Asset Validator:    {runtime_context.assetValidator.package} {runtime_context.assetValidator.version} via {runtime_context.assetValidator.source}
───────────────────────────────────────────────────────────────────────────
```

## Anti-Patterns

- Do not create `_work/`, `tmp/`, or repo-local artifact folders for a tuning
  run.
- Do not write `probe_result.json` or any other substitute for
  `setup-preflight.json`.
- Do not run generated Python scripts inline and discard them. Write scripts to
  `<output_path>/scripts/` so the run can be audited and reproduced.
- Do not save optimized layers in place unless the user explicitly approved
  in-place mutation.

## Related References

- `skills/omniverse-usd-performance-tuning/references/setup-usd-performance-tuning/references/runtime-context-header.md`
- `skills/omniverse-usd-performance-tuning/references/profile-stage/README.md`
- `skills/omniverse-usd-performance-tuning/references/optimization-report/README.md`
