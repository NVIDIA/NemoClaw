# Instancing Readiness

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

## When to Use

Use when checking repeated USD references for safe instanceable authoring after structure assessment.

## Instructions

1. Confirm the target asset, artifact, or user intent and check the prerequisites listed below.
2. Read only the referenced files needed for the current phase, failure mode, or output contract.
3. Follow the workflow, rules, and safety gates in this reference before invoking downstream references or shell commands.
4. Return the result using the Output Format section and name any blocked prerequisite or unresolved user decision.

## Output Format

Return a concise status or report that names the input, selected runtime or evidence source, actions planned or performed, artifacts written, blockers, and the next validation or user-decision step. When a schema or template is referenced below, conform to that contract.

## Purpose

Use this reference after `usd-structure-assessment` identifies repeated references
that are instancing candidates. This reference determines whether each candidate
can safely be marked `instanceable = true` without breaking the scene.

## Prerequisites

- Structure assessment output with candidate prim paths and repeated reference
  groups.
- Access to the referencing layer where `instanceable = true` would be authored.
- USD Python API access to inspect prim specs, relationships, variants, and
  active opinions.

## References

Before checking readiness, read:

- `references/instancing-guide.md` - covers scenegraph instancing mechanics,
  prototype generation, instance proxies, and the rules for what can/cannot
  vary across instances.
- `references/instancing-tradeoffs.md` - merge safety, decision tree between
  scenegraph instancing vs point instancing vs hierarchy dedupe vs mesh-level
  dedupe. Read this when the user asks about merge or whole-stage dedupe
  alongside readiness; instancing-readiness only covers the per-candidate
  `instanceable=true` safety gate, not the broader "should we merge?" question.

If you have network access, prefer the live URL:
https://docs.omniverse.nvidia.com/usd/latest/learn-openusd/independent/modularity-guide/instancing.html

## What breaks instancing

A prim marked `instanceable = true` shares its subtree (descendants) as a
prototype. All instances of the same asset share one prototype. This means:

1. **Descendant overrides in the referencing layer** — if the root/assembly
   layer authors properties on children of an instance candidate (e.g., a
   unique material binding, a transform tweak, a visibility override), those
   overrides will be lost or will force a separate prototype.

2. **Variant selections on descendants** — if different instances have
   different variant selections within their subtree, each unique combination
   creates a separate prototype (reducing the instancing benefit).

3. **Relationship targets crossing instance boundaries** — relationships
   that point from inside an instance to outside (or vice versa) may not
   resolve as expected.

4. **Active/inactive opinions on descendants** — deactivating a child prim
   inside an instance candidate breaks sharing.

## Readiness check procedure

For each instancing candidate prim:

1. **Check for descendant specs in the referencing layer:**
   ```python
   root_layer = stage.GetRootLayer()
   spec = root_layer.GetPrimAtPath(candidate_path)
   # Walk all child specs — if any have authored properties, flag it
   ```

2. **Check for variant selections on descendants** that differ between
   instances of the same asset.

3. **Check for relationships targeting paths inside the candidate subtree**
   from outside.

4. **Check for active=false opinions** on any descendants in the
   referencing layer.

## Output

For each candidate, report:

- `safe`: no overrides, can be marked instanceable immediately.
- `overrides_found`: list descendant paths with authored opinions.
  The user must decide: remove the overrides, or skip instancing for this prim.
- `variant_divergence`: different instances select different variants.
  Each unique selection will create a separate prototype.

## Applying instancing

When all candidates pass readiness:

```python
from pxr import Sdf

with Sdf.ChangeBlock():
    for prim_path in safe_candidates:
        prim = stage.GetPrimAtPath(prim_path)
        if prim and not prim.IsInstanceable():
            prim.SetInstanceable(True)
```

This is a metadata-only change on the referencing layer. It does not modify
the referenced asset. Wrap the flip in a `Sdf.ChangeBlock` when applying it
to thousands of prims — without it, each `SetInstanceable` triggers a
change-notification round-trip and the loop dominates wall time at scale.

### Saving without losing the instanceable flags

`SetInstanceable(True)` authors metadata on the **edit-target layer at the
prim spec**. The flag survives `stage.GetRootLayer().Export(new_path)` and
direct `Sdf.Layer.Save()` calls. **It is lost** when the new layer is
produced by `Sdf.Layer.TransferContent` from an intermediate layer that
doesn't carry the spec, or by composing through a flatten step that
collapses the referencing layer into the prototype layer.

The safe save path is:

```python
stage.GetRootLayer().Export(new_path)         # preserves instanceable
# or
stage.Export(new_path)                        # flattens composed stage; use only when intended
```

If a downstream tool needs to rewrite the new root via `TransferContent`
or `apply-restructure mode=ref_remap`, re-apply `SetInstanceable(True)` to
every approved candidate **after** the rewrite and **before** the final
`Save()` / `Export()`. The standalone `Phase 5` path in
`usd-structure-assessment/references/apply-restructure/README.md` does exactly this; mirror that pattern in any
custom rewrite.

Do not use `stage.Flatten()` as the save path — flattening composes
references into a single layer, which dissolves the prototype boundary
and turns `instanceable=true` into a no-op.

See `skills/omniverse-usd-performance-tuning/references/usd-structure-assessment/references/usd-edit-target-planner/references/output-saving.md` for
the USDC save guidance (binary `.usdc` preferred for instance-heavy stages so
mmap can share prototype pages).

## Rules

- Never mark a prim instanceable without checking for descendant overrides first.
- Instancing is a metadata opinion — it belongs in an override layer or the
  root assembly layer, never in the source asset layer.
- If the readiness check finds overrides, present them to the user before
  deciding. Don't silently skip instancing — the user may want to remove
  the overrides instead.
- Primvar overrides on the instance root prim itself (not descendants) are
  safe — primvars inherit and don't break prototype sharing.

## Limitations

- This reference determines readiness; it does not remove overrides or choose which
  source edits the user should make.
- It checks prototype-sharing risks, not geometric duplicate detection or
  asset-level deduplication opportunities.
- Instanceability can add prototype setup cost, so evaluate before/after
  profiles rather than treating open-time deltas alone as regressions.

## Expected tradeoffs after instancing

Marking prims instanceable has a known cost:

- **Scene open time increases slightly** — the renderer builds acceleration
  structures for each unique prototype. Measured: ~0.3ms per prototype on L40.
  67 prototypes ≈ 18ms added to scene open.

- **Per-frame render time decreases** — shared prototypes reduce GPU draw calls
  and memory. Measured: 9-13% faster Hydra/RTX render per frame.

- **Net positive after a few frames** — the one-time open cost is recovered
  within seconds of steady-state rendering.

Do not flag the scene-open increase as a regression. It is the expected
prototype setup cost. Only investigate if the open-time increase is
disproportionate (>1ms per prototype) or if per-frame rendering does not improve.

## Troubleshooting

- If descendant overrides are found, report the affected paths and ask whether
  the user wants to remove overrides or skip that candidate.
- If variant divergence creates many prototypes, group the report by unique
  variant-selection combinations before recommending instancing.
- If relationships cross candidate boundaries, inspect the targets before
  authoring `instanceable = true`; broken relationship resolution can outweigh
  the draw-call benefit.
- If open time rises slightly after instancing, compare it with per-frame render
  improvement before calling it a regression.
