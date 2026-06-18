<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# so-run-operations - Local Execution Policy and Upstream Handoff

This local reference preserves the digitaltwin workflow milestone. Scene
Optimizer mechanics for this step are owned by upstream `usd-optimize`.

- Public repository: [https://github.com/NVIDIA-omniverse/usd-optimize/](https://github.com/NVIDIA-omniverse/usd-optimize/)
- Package path: `.agents/skills/run-operations/SKILL.md`
- Upstream web URL: [https://github.com/NVIDIA-omniverse/usd-optimize/blob/main/.agents/skills/run-operations/SKILL.md](https://github.com/NVIDIA-omniverse/usd-optimize/blob/main/.agents/skills/run-operations/SKILL.md)

Resolve the upstream guide without cloning the source repo:

1. `$SCENE_OPTIMIZER_PACKAGE_ROOT/.agents/skills/run-operations/SKILL.md`
2. `$SO_HOME/.agents/skills/run-operations/SKILL.md`

If no package root is available, download and extract the published
`scene_optimizer_core_...release.zip` package for the target platform (direct
archive URLs are in `references/upstreams/usd-optimize.md`), or use the package
path/URL supplied by the user. If the user supplies an extracted
package root directly, resolve this same package path under that root. If
GitHub raw fetch is available, the web URL above is acceptable for docs-only
reads. Do not clone the source repo just to read upstream SO guidance.

## Local Responsibilities

- Run the session runtime gate from `setup-usd-performance-tuning/references/runtime-context-header.md` and consume `<output_path>/setup-preflight.json`.
- Cross-check every planned op key against `sceneOptimizer.operationsAvailable`; block with `blocked_missing_scene_optimizer` or `blocked_missing_so_operation` when required.
- Apply local output workspace policy and `runtime-artifact-token-budget.md`; keep logs on disk and read bounded summaries only.
- Apply destructive-operation approval gates via `references/operation-safety.md` before mutation.
- Keep digitaltwin evidence-to-config routing in `references/config-from-evidence.md`.
- Treat `references/invocation.md` as the only local source of truth for
  Python/API invocation shapes.
- For Phase 4b multi-target optimization, use `references/batch-mode.md` for target enumeration, adaptive concurrency, prototype-first ordering, hash-based output names, resource observations, and remainder-script prompts.
- Preserve logical milestone name `so-run-operations` and hand results to profile/compare/report phases.


## Pre-flight Checklist

Before executing the op chain, re-read and confirm:

- [ ] `references/operation-safety.md` — parameter prerequisites gate,
   confirmation prompt format, destructive-op approval policy.
- [ ] Every op key cross-checked against `setup-preflight.json`
   `sceneOptimizer.operationsAvailable`.
- [ ] Per-op `parameter_prerequisites` frontmatter read for each destructive op.
- [ ] `references/units-and-tolerances.md` — conversion formula for any
   tolerance-based op.
- [ ] `references/invocation.md` for local invocation mechanics and upstream
  handoff.
- [ ] `references/batch-mode.md` for multi-target orchestration.
- [ ] `runtime-artifact-token-budget.md` §"Stderr Production Guard" — redirect
  subprocess stderr, cap at 50 MB, retain head/tail samples.
## Execution Handoff

Use `references/invocation.md` for supported Python/API invocation shapes,
optional helper wrappers, selected-runtime API probing, output saving, and
generic failure handling. Use this local file only for digitaltwin workflow
gating, batch orchestration policy, and reporting policy.
