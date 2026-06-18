<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# USD Instancing and Dedupe - Tradeoffs and Decision Tree

> The actionable decisions in the agent flow are split between `usd-hierarchy-dedupe-candidates` (find candidate subtrees, read-only) and `instancing-readiness` (per-candidate safety gate). This reference holds the deeper trade-off framing, merge safety policy, and findings taxonomy that both skills cite.

---

## Purpose

Guide decisions between scenegraph instancing, point instancing, hierarchy dedupe, mesh-level dedupe, and merge operations for repeated digital twin content.

This reference is consulted by:

- `usd-hierarchy-dedupe-candidates` when choosing between hierarchy dedupe vs unscoped mesh dedupe.
- `instancing-readiness` when explaining merge safety to the user before authoring `instanceable=true`.
- `apply-restructure` when planning Phase 2f restructure orchestration.
- `so-interpret-validators` when recommending merge or dedupe ops based on validator findings.

## Prerequisites

- Composition or structure context for repeated assets, payloads, variants, and edit boundaries.
- Current performance signals such as prim count, mesh count, draw-call pressure, or validator findings.
- User constraints for editability, semantic part identity, streaming, and visual-review tolerance.

## Limitations

- This is decision guidance only; it does not run Scene Optimizer operations or rewrite the stage.
- Mesh-level dedupe does not collapse copied hierarchies or create shared asset boundaries by itself.
- Point instancing and mesh merge reduce editability, so they need explicit fit with the user's workflow.

## Troubleshooting

- If `instanceable=true` gives no benefit on copied local hierarchies, rewrite duplicates as references or payloads first.
- If unscoped mesh dedupe would touch very large mesh counts, prefer hierarchy candidates, explicit prototypes, or scoped mesh paths.
- If merge crosses composition boundaries or semantic parts, keep it out of the recommendation unless the user explicitly accepts that tradeoff.

## Examples

- "Decide whether repeated racks should use references, point instancers, or mesh dedupe."
- "Review merge risk before running deduplicateGeometry on a factory stage."

## Decision tree

Repeated full assets:

- Prefer references or payloads to one prototype asset.
- Mark referenced or payloaded prims `instanceable=true` when the prototype is identical and read-only instance behavior is acceptable.
- Do not expect `instanceable=true` to help copied local hierarchies that duplicate mesh data.

Large numbers of small repeated objects:

- Prefer `UsdGeomPointInstancer` for bolts, fasteners, vegetation, repeated fixtures, and similar small objects.
- Keep per-instance variation constraints explicit; point instancers reduce editability.

Duplicated hierarchies:

- Detect repeated subtrees by source names, asset metadata, or subtree hashes.
- Rewrite duplicates as references to one prototype before relying on mesh dedupe.
- Run mesh-level dedupe after hierarchy reuse has been established.
- Use `usd-hierarchy-dedupe-candidates` for a read-only candidate pass when the stage is monolithic, has copied assemblies, or has high mesh count with little or no instancing.

Duplicate mesh data:

- Scene Optimizer dedupe can help at the mesh-data level.
- It does not collapse entire repeated hierarchies by itself.
- Avoid whole-stage mesh dedupe on very large mesh counts unless the user explicitly accepts a long run. Prefer explicit prototypes, authored sub-assets, or scoped `meshPrimPaths`.
- If a stage has ~50K+ meshes and no instancing, treat unscoped `deduplicateGeometry` as high-risk for customer friction.

## Merge safety

Do not recommend mesh merge when:

- The stage is already heavily scenegraph-instanced.
- The repeated content should become point instanced instead.
- Geometry streaming is in use.
- Editability or semantic part identity must be preserved.
- The merge target crosses payload, reference, or variant boundaries without explicit approval.

Consider merge when:

- The bottleneck is draw-call or prim-count overhead.
- The content is static.
- Materials and spatial clustering make the merge coherent.
- Before/after validation and visual review are part of the plan.

## Findings taxonomy

When emitting findings (e.g. from `usd-hierarchy-dedupe-candidates` or `so-interpret-validators`), use these tags so downstream references can route consistently:

- `copied-hierarchy-candidate`
- `reference-instancing-candidate`
- `point-instancer-candidate`
- `mesh-dedupe-candidate`
- `merge-risk-instanced-content`
- `merge-risk-geometry-streaming`

## Handoff to Scene Optimizer

Only hand off dedupe or merge operations after:

- Composition audit identifies repeated content boundaries.
- Hierarchy-level duplication has been assessed or ruled out.
- Edit target planner chooses output isolation.
- Validation has no structural blockers.
- The operation package includes whether the target is mesh-level or hierarchy-level.

## References

Before assessing instancing opportunities, read:

- `skills/omniverse-usd-performance-tuning/references/usd-structure-assessment/references/asset-structure-principles.md` - instancing granularity, variant/primvar compatibility, the reference-payload pattern.
- `skills/omniverse-usd-performance-tuning/references/usd-structure-assessment/references/factory-level-structuring.md` - instance at rigid-body level, deduplication informs granularity.

If you have network access, prefer the live URLs (noted in each reference file) for the most current version.
