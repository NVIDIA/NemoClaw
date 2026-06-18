<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Config From Evidence

Use this reference when the user has validator findings, structure assessment,
profile metrics, renderer metrics, or runtime symptoms and asks for an
operation chain. Validator findings are one evidence source; they are not the
only way to compose a responsible recipe.

Scene Optimizer operation mechanics are owned by upstream
[usd-optimize](https://github.com/NVIDIA-omniverse/usd-optimize/) and the
prebuilt Scene Optimizer package. Resolve guidance from an extracted package
root via `$SCENE_OPTIMIZER_PACKAGE_ROOT`, then `$SO_HOME`. If no package
root exists, download/extract the published `scene_optimizer_core_...release.zip`
package (direct archive URLs are in `references/upstreams/usd-optimize.md`) or
use the package path, URL, or extracted root supplied by the user. Do not clone
the source repo just to read SO guidance.

## Checklist

1. **Internal geometry removal (runs FIRST when evidence exists).**
   - Evidence: SA `flagged_assets` with `reason: containment` AND
     `enclosure_opaque: true`. These are opaque-enclosed asset pairs
     (equipment, machines, vehicles, cabinets, housings).
   - Chain: `findOccludedMeshes` (analysis on scoped pairs) →
     `removePrims` (delete confirmed-occluded paths).
   - Ordering: this pair runs BEFORE all other ops — no point cleaning,
     deduping, or decimating geometry that will be deleted.
   - Exclusion: skip pairs where enclosure has transparent material
     (opacity < 1.0, glass shader, transmission). Those internals are
     visible through the enclosure.
   - Two-stage approval: (1) confirm analysis cost (T3), (2) confirm
     deletion of discovered internals.
   - If no containment pairs exist or all are transparent, skip this step.
2. **Read the remaining evidence.**
   - `so-interpret-validators` report. The Operation column lists the operation
     key for each firing rule.
   - `usd-structure-assessment` summary counts, flagged assets, references,
     payloads, prototype/instance counts, material counts, and mesh-size
     distribution.
   - `profile-stage` / renderer metrics such as load time, GPU memory,
     `rtxMeshCount`, unique mesh counts, and resource-limit symptoms.
3. **Name the bottleneck and target metrics.** Examples: renderer resource
   cardinality measured by `rtxMeshCount`, GPU memory, triangle count, draw
   calls, open/load time, disk size, or validation blockers.
4. **Choose an existing recipe or synthesize one.** Use
   upstream `usd-optimize/.agents/operations/PIPELINES.md` for operation roles
   and dependency ordering. Keep only local evidence, target set, approval
   state, and report fields here.
5. **Apply validator-tier discipline when validator findings are present.**
   Include Tier 1 rules with defaults, include Tier 2 only with an iteration
   note, and never auto-include Tier 3 rules without manual review.
6. **Group related operations.** Emit one `meshCleanup` step with the union of
   relevant flags instead of separate cleanup entries for each checker.
7. **Avoid premature decimation.** Do not auto-add `decimateMeshes` for
   high-vertex-count findings. Prefer `deduplicateGeometry`,
   `removeSmallGeometry`, merge/resource-cardinality fixes, or structure
   changes first. Add decimation only after the user confirms the reduction
   goal.
8. **Build the JSON config.** Read each operation's upstream
   `usd-optimize/.agents/operations/<key>.md` guide for parameter names,
   defaults, and risky fields before emitting the final chain.
9. **Prepare the user-facing rationale.** Name the evidence each step
   addresses, why the order matters, which steps are destructive or
   bounded-loss, and which before/after metrics will prove the recipe worked.

## Confirmation

Before running, show:

- The final JSON operation chain.
- The validator findings, structural evidence, or profile/runtime metrics each
  step addresses.
- Destructive or bounded-loss operations from `operation-safety.md`.
- Any Tier 2 assumptions or parameters likely to require iteration.

## Mechanics Handoff

For execution-context flags, operation argument syntax, named pipelines, and
analysis-mode mechanics, use upstream
`usd-optimize/.agents/skills/run-operations/SKILL.md` and
`usd-optimize/.agents/operations/INVOCATION.md`. For read-only "what would this
do?" analysis, prefer `so-run-validators` and upstream validator docs.
