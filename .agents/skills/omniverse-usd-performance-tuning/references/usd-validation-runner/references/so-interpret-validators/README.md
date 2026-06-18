<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# so-interpret-validators - Local Recommendation Policy and Upstream Handoff

This local reference preserves the digitaltwin workflow milestone. Scene
Optimizer mechanics for this step are owned by upstream `usd-optimize`.

- Public repository: [https://github.com/NVIDIA-omniverse/usd-optimize/](https://github.com/NVIDIA-omniverse/usd-optimize/)
- Package path: `.agents/skills/interpret-validators/SKILL.md`
- Upstream web URL: [https://github.com/NVIDIA-omniverse/usd-optimize/blob/main/.agents/skills/interpret-validators/SKILL.md](https://github.com/NVIDIA-omniverse/usd-optimize/blob/main/.agents/skills/interpret-validators/SKILL.md)

Resolve the upstream guide without cloning the source repo:

1. `$SCENE_OPTIMIZER_PACKAGE_ROOT/.agents/skills/interpret-validators/SKILL.md`
2. `$SO_HOME/.agents/skills/interpret-validators/SKILL.md`

If no package root is available, download and extract the published
`scene_optimizer_core_...release.zip` package for the target platform (direct
archive URLs are in `references/upstreams/usd-optimize.md`), or use the package
path/URL supplied by the user. If the user supplies an extracted
package root directly, resolve this same package path under that root. If
GitHub raw fetch is available, the web URL above is acceptable for docs-only
reads. Do not clone the source repo just to read upstream SO guidance.

## Local Responsibilities

- Preserve logical milestone name `so-interpret-validators`.
- Use `usd-validation-runner/README.md` for tiering, phase-aware subsets,
  selected-validator execution policy, and approval gates.
- Use `rule-reference.md` only for local recommendation routing; upstream owns generic artifact interpretation mechanics.
- Apply `runtime-artifact-token-budget.md` for CSV/log handling and route large artifacts through summaries.

## Pre-flight Checklist

Before producing the curated op chain, re-read and confirm:

- [ ] **SA containment findings** — if SA flagged pairs with
  `reason: containment` AND `enclosure_opaque: true`, include
  `findOccludedMeshes → removePrims` as the FIRST op in the chain.
  Skip pairs where enclosure is transparent.
- [ ] **rule-reference.md** — map every fired validator to its backing op.
- [ ] **operation-safety.md** — classify each mapped op as lossless or destructive.
- [ ] **All destructive ops go into the plan.** They are presented for per-op
   user approval — they are NOT silently deferred or omitted.
- [ ] For each destructive op, read its `parameter_prerequisites` frontmatter
   in `references/operations/<key>.md`. The canonical question will be asked
   at approval time.

## Anti-patterns

### Silent lossy-op omission

**Do NOT produce a "lossless only" chain and silently defer destructive ops.**

If validator findings support a lossy op (`decimateMeshes`,
`removeSmallGeometry` with non-default threshold, `flattenHierarchy`, `merge`,
`fitPrimitives`, `shrinkwrap`, `splitMeshes`), present it for explicit
approval — do not silently defer without asking. Deferring is not the same as
skipping; deferring a lossy op for "later approval" still requires *presenting
it for approval now* so the user can choose.

A "Deferred ops" section in your output that names the ops but does not ask
the user is the anti-pattern. That violates the workflow contract: *"the agent
lays out the full plan, including any destructive operations the plan would
invoke, without withholding the plan itself."*

The only legitimate removal path is the user selecting `skip_option` at the
per-op approval prompt.
