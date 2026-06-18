---
doc_type: scene_optimizer_operation
operation: findOccludedMeshes
title: Find Occluded Meshes
source: scene-optimizer-core/source/operations/findOccludedMeshes/FindOccludedMeshes.cpp
category: analysis
loss_class: analysis-only
requires_confirmation: true
risk_class: medium
args_count: 7
requires_mesh: true
pipelines: []
keywords: [find, occluded, interior, hidden, analysis, internal, enclosed]
since_version: 2026-02-11T07:51:19Z
requires_extension: omni.scene.optimizer.core
parameter_prerequisites:
  ordering:
    position: first
    rationale: >
      Remove internal geometry before spending compute on meshCleanup,
      deduplicateGeometry, decimation, or any other op. Dead weight is
      removed first.
    invariants:
      - "findOccludedMeshes + removePrims BEFORE meshCleanup"
      - "findOccludedMeshes + removePrims BEFORE deduplicateGeometry"
      - "findOccludedMeshes + removePrims BEFORE decimateMeshes"
      - "findOccludedMeshes + removePrims BEFORE removeSmallGeometry"
  scoping:
    trigger: SA flagged_assets with reason=containment AND enclosure_opaque=true
    exclude: >
      Pairs where the enclosing geometry has a transparent/translucent
      material (opacity < 1.0, transmission shader, glass MDL, alpha-blend
      mode). Objects visible through transparent enclosures must NOT be
      removed.
    asset_types: >
      Equipment, machines, vehicles, cabinets, housings, enclosures, pumps,
      motors, compressors, sealed assemblies — anything with an opaque
      shell/casing that could hide internal parts.
  fields:
    - field: containment_pairs
      source: SA flagged_assets where reason=containment AND enclosure_opaque=true
      required: true
      description: >
        List of (inner_asset, enclosing_asset) pairs from SA §2.2 where the
        enclosure is confirmed opaque. Without this, findOccludedMeshes has
        no scope and must not run on the full stage.
  elicit_from_user:
    - id: confirm_analysis
      canonical_question: >
        These enclosed assets contain internal geometry that may be invisible
        from outside. Run occlusion analysis? (Tier 3 cost: minutes per pair)
      context: Present the containment pair list from SA with asset names.
      skip_option: "Skip occlusion removal"
  action_chain:
    analysis_op: findOccludedMeshes
    action_op: removePrims
    pattern: >
      Run findOccludedMeshes in analysis mode on the scoped pairs. It
      produces a list of fully-occluded prim paths. Feed those paths to
      removePrims (requires separate user confirmation for the deletion
      step).
  two_stage_approval:
    stage_1: "Approve running the analysis (T3 cost gate)"
    stage_2: "Approve removing the discovered occluded meshes (destructive gate)"
---
<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Find Occluded Meshes

Detects geometry that is completely hidden inside other geometry and therefore
never visible from outside. Used as the first step of internal geometry removal
— the highest-priority optimization in the Phase 4 op chain.

## Integration Pattern

This is a **two-step detect→act** operation:

1. **Detect:** `findOccludedMeshes` (analysis-only) reports fully-occluded prim paths.
2. **Act:** `removePrims` (destructive) deletes those paths after user confirmation.

The two steps are consecutive — no other ops run between them. The prim paths
from step 1 feed directly into step 2.

## Scoping: Opaque Enclosures Only

Run only on SA-flagged `containment` pairs where `enclosure_opaque: true`.

**Excluded from analysis:**
- Transparent enclosures (glass, acrylic, mesh screens)
- Enclosures with opacity < 1.0 on their bound material
- Assets with transmission/glass shaders (MDL glass, UsdPreviewSurface with opacity)
- Runtime-toggled visibility (animation channels on visibility attribute)

If the enclosing geometry is see-through, the internal parts ARE visible and
must not be candidates for removal.

## Ordering

**First in the Phase 4 op chain.** Remove dead weight before spending compute on:
- meshCleanup (why repair topology on meshes you'll delete?)
- deduplicateGeometry (why instance internal junk across enclosures?)
- decimateMeshes (why reduce vertices on invisible geometry?)
- removeSmallGeometry (occlusion removal handles these in context)

## Upstream Mechanics

This file's YAML frontmatter is the local routing stub source for operation
selection, risk, confirmation, ordering, and workflow metadata.

For Scene Optimizer operation mechanics, parameters, defaults, and implementation
notes, use [Operation Index](README.md) and the centralized [`usd-optimize`
upstream handoff](../upstreams/usd-optimize.md). Resolve the package operation
guide by the `operation` key in this file; do not restate upstream mechanics
here.
