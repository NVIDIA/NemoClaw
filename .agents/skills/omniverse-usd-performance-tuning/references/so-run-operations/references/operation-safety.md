<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Operation Safety

Use this reference before running any Scene Optimizer chain that may delete,
collapse, regenerate, or otherwise irreversibly change authored content.
Scene Optimizer operation mechanics are owned by upstream
[usd-optimize](https://github.com/NVIDIA-omniverse/usd-optimize/) and the
prebuilt Scene Optimizer package. Resolve guidance from an extracted package
root via `$SCENE_OPTIMIZER_PACKAGE_ROOT`, then `$SO_HOME`. If no package
root exists, download/extract the published `scene_optimizer_core_...release.zip`
package (direct archive URLs are in `references/upstreams/usd-optimize.md`) or
use the package path, URL, or extracted root supplied by the user. Do not clone the
source repo just to read SO guidance. This file owns only the digitaltwin
approval gate and confirmation focus.

## Confirmation Prompt

Always prepend the full runtime context block from
`skills/omniverse-usd-performance-tuning/references/setup-usd-performance-tuning/references/runtime-context-header.md`
Format A. A destructive-op approval must name the Kit application, Scene
Optimizer version, and Asset Validator version that will mutate the stage.

## Parameter Prerequisites Gate

Before composing the confirmation prompt for any destructive or bounded-loss
operation, read its YAML frontmatter `parameter_prerequisites` block (in
`references/operations/<key>.md`).

For each entry:

- **`field:` entries with `required: true`** — verify the named field exists in
  the SA report (`asset_physical_context` section) or `setup-preflight.json`. If
  missing, **BLOCK** with reason: `"asset preflight incomplete: missing {field}"`.
  Do not proceed to the confirmation prompt.
- **`field:` entries with `required: false`** — if present, use the value to
  enrich suggested defaults or context derivation. If absent, proceed normally;
  do not block.
- **`elicit_from_user:` entries** — include the `canonical_question` with its
  `defaults` as options in the single upfront confirmation prompt. Use the
  `conversion` formula to map the user's answer to the SO parameter. If a
  `context_derivation` is present and the referenced field is available, use
  it to suggest a default.
- **`skip_option`** — always offer the skip option. If the user selects it,
  remove that operation from the chain.
- **`default_option`** — if present, this is the pre-selected answer when the
  user doesn't express a preference. It does NOT remove the operation (unlike
  `skip_option`).

All `elicit_from_user` questions for a given operation MUST be batched into a
single prompt (the "single upfront prompt" pattern). Do not ask them as
separate mid-run gates.

### Anti-pattern: rate-framing

**Do not frame tolerance questions as "reduce by X%" or "how much to keep?"**
unless the user has explicitly provided a target reduction rate (memory budget,
LOD level target, explicit percentage).

The canonical framing is fidelity-budget: "what detail to preserve?" This maps
to `maxMeanError` which preserves silhouette quality proportional to the
specified tolerance.

Rate-mode (`reductionFactor` as primary stop) bypasses the silhouette-preserving
default and produces decisions the user cannot evaluate without first seeing
rendered output. It is acceptable ONLY when:

1. The user explicitly says "reduce to N triangles" or "keep X%", or
2. The workflow is LOD generation with known level targets.

### Anti-pattern: improvised option sets

Do not present options that don't trace to a `parameter_prerequisites` block
or a user-supplied constraint. If the agent is about to ask "10% or 25%?", the
contract says: "no — tolerance questions go through the `elicit_from_user`
template; rate questions require explicit user-supplied targets."

See also: `references/so-run-operations/references/units-and-tolerances.md` for
the shared unit conversion formula and parameter glossary.

List the destructive operations in the proposed chain, explain what each one
does, then ask for confirmation before invoking the runner.

## Destructive Or Bounded-Loss Operations

| Op | Risk | Confirmation focus |
|---|---|---|
| `findOccludedMeshes` → `removePrims` | Deletes internal geometry. | Two-stage: (1) approve T3 analysis cost on SA containment pairs, (2) approve deletion of discovered occluded prims. Exclude transparent enclosures. Runs FIRST in op chain. |
| `deduplicateHierarchies` | Replaces subtrees with instanceable references to shared prototypes. | Confirm dedupe-candidate groups (from hierarchy-dedupe-candidates report). Lossless but structural — changes composition topology. |
| `decimateMeshes` | Drops vertices. | mm tolerance (maxMeanError); applied uniformly to all meshes. See upstream `.agents/operations/decimateMeshes.md`. |
| `fitPrimitives` | Replaces mesh geometry with analytic primitives. | Analysis first and data-preservation intent; see upstream `.agents/operations/fitPrimitives.md`. |
| `removeSmallGeometry` | Removes small meshes. | Threshold, visibility, user intent; see upstream `.agents/operations/removeSmallGeometry.md`. |
| `meshCleanup` with `makeManifold: true` | Repairs topology. | Topology repair vs. simpler cleanup; see upstream `.agents/operations/meshCleanup.md`. |
| `optimizeMaterials` with `convertToColor: true` | Replaces material networks with colors. | Only run on explicit flat-color requests; see upstream `.agents/operations/optimizeMaterials.md`. |
| `removePrims` / `deletePrims` / `removeUntypedPrims` / `deleteHiddenPrims` | Deletes prims. | Affected prim list, variant/runtime visibility, reversible alternatives; see the matching operation reference. |
| `boxClip` | Removes or retains geometry by AABB. | Extent and keep-vs-clip mode; see `references/operations/boxClip.md`. |
| `diceMeshes`, `manifoldMeshes`, `remeshMeshes`, `shrinkwrap` | Regenerates or slices topology. | Grid/voxel settings, topology loss, preview scope. |
| `merge` | Collapses multiple meshes into one or more meshes. | Loss of source hierarchy/path identity and instancing risk. |
| `pythonScript` | Executes user-supplied code. | Require a user-supplied or reviewed script. |
| `removeAttributes` | Removes or blocks attributes. | Exact attribute list and downstream consumers. |
| `sparseMeshes` | Analysis that often drives split/dice follow-ups. | Confirm acting on the analysis result. |

## Conservative Fallback

If the user is uncertain, run only `safe-cleanup` first:

- `computeExtents`
- `pruneLeaves`
- `deduplicateGeometry`
- `optimizeMaterials`
- `optimizeTimeSamples`

Run destructive or bounded-loss operations as a later pass after the user has
reviewed the safe-cleanup result.

## Pipeline Notes

For named pipelines, only `mesh-count-reduction` and `data-quality-baseline`
contain destructive ops today. `safe-cleanup`, `memory-reduction`, and
`load-time-reduction` are lossless. For hierarchy-level dedupe, use
`usd-hierarchy-dedupe-candidates` plus `apply-restructure`; do not substitute
mesh merge for a USD-authored hierarchy rewrite.

### Anti-pattern: silent deferral of destructive ops

**Do NOT skip, defer, or omit a destructive op from the plan without the user
explicitly selecting its `skip_option`.**

If validator findings support a destructive op, present it in the plan with its
`parameter_prerequisites` canonical question and let the user decide. The
workflow contract says: *"Approval for each destructive operation is requested
alongside plan approval."*

Acceptable: "decimateMeshes is recommended — what's the smallest detail to
preserve? [0.1 / 0.5 / 1.0 / 2.0 / 5.0 mm / skip decimation]"

Not acceptable: "I'll run lossless ops now and defer lossy ops for later."
That removes user agency. The user may want decimation NOW.

---

## Red Flag: SO Operation Returns Success With Zero Work on Known-Heavy Target

| Signal | Meaning |
|--------|---------|
| `elapsed_ms: 0` or < 1ms on a target with known high vertex/mesh count | Operation could not find meshes to process |
| `success: true` but vertex_count delta = 0 on a target SA flagged for optimization | Structural blockage, not "nothing to do" |
| Multiple operations show zero work on same target | Almost certainly a traversal issue (Over-spec ancestors, population mask, wrong root prim) |

**Action:** Do NOT report "operation found nothing to optimize" when SA or manifest
metadata indicates the target should have significant geometry. Instead:

1. Check specifiers on ancestor prims (Over vs Def) — see `restructure-mode.md`
   §"Authoring Requirements" for the diagnostic snippet.
2. Check that the target's `defaultPrim` is set correctly.
3. Check that the stage is not masked or filtered in a way that excludes content.
4. Report the structural issue to the user rather than rationalizing the no-op.
