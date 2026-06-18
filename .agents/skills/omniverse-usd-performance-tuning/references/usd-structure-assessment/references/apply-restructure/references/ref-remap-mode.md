<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Ref Remap Mode

Use this reference for `apply-restructure` mode=`ref_remap` after Phase 4 mesh
ops produce optimized sub-asset USDs.

## Impact Set

For each `original_path -> optimized_path` pair, find every parent assembly
that references the original. Walk recursively up the composition graph until
the stage root. The impact set is:

```json
{
  "parent_layer_path": [
    {
      "prim_path": "/World/Asset",
      "original": "/path/original.usd",
      "optimized": "/path/optimized.usdc"
    }
  ]
}
```

If a layer in the impact set references back to another impacted parent, stop
and surface the cycle. Do not guess an automatic rewrite for cyclic reference
graphs.

## Parent Rewrite

For each impacted layer:

- Copy it to `output_dir/assemblies/`.
- Preserve the composition arc structure.
- Rewrite only the relevant reference asset paths to the optimized children.
- Prefer `UsdUtils.ModifyAssetPaths` for bulk asset-path remapping.

The new assembly root is the rewritten copy of the input root layer when it is
in the impact set. If the input root only points at impacted parents, copy the
root and apply the same path-remap policy.

## Stage-Level Cleanup

After references are stable, run lossless cleanup on the new assembly root via
`so-run-operations`:

- `computeExtents`
- `pruneLeaves`
- `removePrims`

Do not include bounded-loss operations such as `decimateMeshes` or
`removeSmallGeometry` in this cleanup by default. They belong in Phase 4 and
require explicit user confirmation.

`deduplicateGeometry` may be useful for residual stage-level cleanup, but ask
before adding it because the value is usually small after per-asset work.

When optimized prototypes share material networks, include
`optimizeMaterials` with an explicit `materialsPath` at the assembly-root edit
target. Per-prototype invocations cannot delete materials introduced through
references.

For the Python/API fallback path, use
`skills/omniverse-usd-performance-tuning/references/so-run-operations/references/invocation.md`.

## Instanceability

After reference rewriting and export, re-apply `instanceable=true` to every
candidate path approved by `instancing-readiness`.

## Output Validation

Run the runner's minimum-openability check on every written USD. Record
`pass | fail | skipped` in the manifest and never delete failed outputs.
