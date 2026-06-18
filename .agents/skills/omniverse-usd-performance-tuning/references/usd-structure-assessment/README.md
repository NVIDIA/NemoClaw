# USD Structure Assessment

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

## When to Use

Use when scoping USD structural validation; do not use for fixes or validator execution.

## Instructions

1. Confirm the target asset, artifact, or user intent and check the prerequisites listed below.
2. Read only the referenced files needed for the current phase, failure mode, or output contract.
3. Follow the workflow, rules, and safety gates in this reference before invoking downstream references or shell commands.
4. Return the result using the Output Format section and name any blocked prerequisite or unresolved user decision.

## Output Format

Return a concise status or report that names the input, selected runtime or evidence source, actions planned or performed, artifacts written, blockers, and the next validation or user-decision step. When a schema or template is referenced below, conform to that contract.

## Purpose

Use this reference as the first analytical step after performance triage to combine
composition, layer, instancing, variant/payload, and spatial heuristics into one
validation-scope assessment. Do not use it to run geometry validators or apply
fixes.

For detailed guidance on any subtopic, consult these references:

- `references/composition-audit.md` - composition audit checklist + findings taxonomy + audit-report.schema.json mapping.
- `references/layer-health.md` - layer-health checks, file-format guidance, asset-path hygiene, flattening policy.
- `skills/omniverse-usd-performance-tuning/references/usd-structure-assessment/references/instancing-readiness/references/instancing-tradeoffs.md` - instancing/dedupe decision tree, merge safety, findings taxonomy.
- `skills/omniverse-usd-performance-tuning/references/usd-structure-assessment/references/usd-edit-target-planner/references/variants-payloads.md` - payload strategy, variant strategy, output policy, stop conditions.

This reference consolidates the operational checklists into a single pass and adds spatial heuristics that the individual references do not cover.

## Prerequisites

- Stage path and resolver context from performance triage.
- Access to layer metadata, composition arcs, authored extents, and asset paths.
- User goal for diagnosis, restructuring, or optimization handoff.

## Pre-flight Checklist

Before producing the SA report, re-read and confirm:

- [ ] `scripts/usd-structure-assessment-report.schema.json` — required fields
   and strict/permissive boundaries.
- [ ] `references/asset-structure-principles.md` — asset vs layer vs composition
   arc distinctions.
- [ ] SA is structural only — no geometry arrays (points, faceVertexCounts).
   `mesh_count` comes from prim-type traversal, not array reads.
- [ ] Spatial heuristics use authored `extentsHint` only. Skip if absent.

## Limitations

- SA Stage 1 is purely structural: metadata, composition arcs, prim traversal.
  No geometry arrays (points, faceVertexCounts) are read. No renderer, viewport,
  or BBoxCache computation. Mesh-level stats (triangle counts, density) are
  deferred to Phase 2c validators (SO analysis mode).
- SA Stage 2 heuristics flag validation candidates; they do not justify operations
  by themselves.
- Outlier detection (§2.1) uses authored `extentsHint` attributes when present.
  If extents are not authored, SA cannot flag spatial outliers — Phase 2c
  validators (`countVertices` / `MeshDensityChecker`) catch density outliers
  downstream with SO loaded.
## Troubleshooting

- If assets, layers, and composition arcs are conflated, re-read the reference
  docs before estimating scope.
- If duplicate hierarchy patterns appear, run `usd-hierarchy-dedupe-candidates`
  before recommending mesh-level deduplication.
## References

Before running, read:

- `references/asset-structure-principles.md` — asset vs layer vs composition arc; the interface/payload/geometry pattern.
- `references/factory-level-structuring.md` — asset boundaries, kind hierarchy, the seven-step structuring pattern.
- `references/optimization-tradeoffs.md` — three-phase pipeline, packaging strategies.

If you have network access, prefer the live URLs (noted in each reference file).

## SA Stage 1: Structure Analysis (no geometry load)

These checks run without a Kit viewport, GPU, or renderer. SA opens the stage
with `Usd.Stage.Open(path)` (default load rules) and traverses the composed
prim hierarchy. No geometry arrays (points, faceVertexCounts, normals) are
read — SA only inspects metadata, composition arcs, prim types, and authored
attributes like `extentsHint`.

Mesh-level statistics (triangle counts, vertex density) are **not** SA's job.
Those are produced by Phase 2c validators (`countVertices`, `MeshDensityChecker`)
which run Scene Optimizer in analysis mode.

### 1.1 Composition inventory

- Root layer path, default prim, up axis, meters per unit.
- Total layer count, sublayer stack.
- Count authored composition list-op items by type where the Python API exposes
  them: references, payloads, inherits, specializes, variants. For references
  and payloads, read the authored list-op metadata and count list items; do not
  depend on `PrimIndex.GetNodeRange()`, which is not exposed by all USD 25.11
  Python builds. If a runtime only supports prim-level boolean checks, report
  the count as prims-with-authored-arcs and record that limitation in
  `composition.counting_method`.
- Distinguish between assets, layers, and composition arcs (see reference docs).
- **Populate `asset_physical_context`:** `metersPerUnit`, `upAxis`, `scale_hint`
  from stage metadata (zero cost). `mesh_count` from prim-type traversal (count
  prims of type `UsdGeom.Mesh` — no geometry arrays needed).
  These fields are consumed by downstream operations
  (see `so-run-operations/references/units-and-tolerances.md`).
### 1.2 Asset inventory

Group layers into assets. An asset is typically a directory containing:

- Interface layer (e.g., `Robot.usd`) — lightweight, always loaded.
- Payload layer (e.g., `Robot_payload.usd`) — deferred loading wrapper.
- Geometry/content layer (e.g., `Robot.geom.usd`) — heavy mesh data.

Report:

- Total unique assets (not layers, not composition arcs).
- Assets with full interface/payload/geometry structure.
- Assets missing expected layers (no payload, no interface, geometry-only).
- The **referenced asset manifest**: list of geometry layer paths for downstream per-asset work.

### 1.3 Layer health

- File formats (usdc vs usda vs usd).
- Flag large `.usda` data files (>100KB) — should be `.usdc`.
- Flag tiny layers (<500B) — accumulated automation artifacts?
- Flag anonymous or session layers.
- Total size on disk.

### 1.4 Instancing analysis

- Count instanceable prims and active instances.
- Count prototypes.
- Identify repeated references to the same asset — these are instancing candidates.
- Compute instance ratio: instances / total referenceable prims.

### 1.5 Variant and payload state

- Count variant sets and selected variants.
- Identify unloaded payloads.
- Flag variant-dependent geometry or material differences.

### 1.6 Kind hierarchy

- Check that kind metadata is present and consistent (assembly → component → subcomponent).
- Flag prims with geometry but no kind assignment.
- Flag kind assignments that don't match the hierarchy (e.g., a component inside a component).

## SA Stage 2: Structural Heuristics (metadata only, narrows validation scope)

These checks use authored extent metadata (`extentsHint`) and structural
patterns to identify assets that likely need deep validation. They do not
load geometry arrays. If `extentsHint` is not authored on a prim, SA skips
spatial heuristics for that prim — Phase 2c validators catch it downstream.

### 2.1 Outlier detection

Using `extentsHint` or authored extent attributes (when present):

- Flag assets where a single mesh's authored extent spans a large fraction of
  the overall stage extent. This suggests fused architectural geometry that should
  be split into separate assets (e.g., floor + walls + ceiling as one mesh).
- Flag assets with authored extents disproportionately small relative to their
  subtree depth or sibling count — possible over-tessellation candidates.
- If extents are not authored, SA cannot flag spatial outliers. This is expected
  for many real-world assets. Phase 2c validators (`countVertices` /
  `MeshDensityChecker`) provide the density signal when SO is loaded.

### 2.2 Containment detection

Using authored extent overlap analysis (only when `extentsHint` is present):

- Identify asset pairs where one asset's authored extent is fully enclosed
  by another's. These are candidates for occlusion testing — the inner
  asset may be invisible from the outside (e.g., piping inside a cabinet).
- **Check enclosure opacity:** For each containment pair, inspect the
  enclosing asset's bound material for transparency signals:
  - UsdPreviewSurface: `opacity` < 1.0 or `opacityThreshold` present
  - MDL: glass/transmission shader, `ior` parameter, alpha-blend mode
  - Any material with `opacity`, `transmission`, or `ior` inputs
  Set `enclosure_opaque: true` when the enclosing material is fully opaque.
  Set `enclosure_opaque: false` when any transparency signal is detected.
  This is a metadata read (material binding → shader attributes) — no
  geometry access needed.
- **Asset type context:** Containment is most actionable for equipment,
  machines, vehicles, cabinets, housings, enclosures, pumps, motors,
  compressors — sealed assemblies with opaque shells. Flag the asset type
  when identifiable from prim names or kind metadata.
- Only flag pairs, don't confirm occlusion — that requires expensive
  geometry analysis via `findOccludedMeshes` in Phase 4.
- Skip this check for prims without authored extents.

### 2.3 Repetition detection

- Identify assets with similar authored extent dimensions
  that reference different source layers (when extentsHint is authored). These may be near-duplicates
  that could share a common source via deduplication.
- Distinguish from intentional instancing (same source, already shared).
- Treat repeated CAD/BIM assembly names as a deep-tree signal, not just a
  root-level signal. Clean root children or clean depth-2 groups do not rule
  out duplicated modules nested under floor, discipline, category, or linked
  model containers.
- If the stage is monolithic, has no references/payloads, has low instance
  count, or contains repeated CAD/BIM assembly names, invoke
  `usd-hierarchy-dedupe-candidates` for subtree-hash candidate detection before
  recommending mesh-level deduplication.

### 2.4 Hierarchy depth analysis

- Flag deep nesting without kind boundaries (many Xform ancestors before
  reaching a component or assembly kind).
- Flag flat hierarchies where a single prim has hundreds of direct children
  with geometry — may benefit from grouping into subcomponents.

### 2.5 Prim count and mesh sizing interpretation

Use `summary_counts`, extents, and hierarchy context to explain scale before
recommending a downstream validation or optimization path:

- Very large stages, including million-prim scenes, are not automatically
  mesh-merge candidates. First decide whether the count comes from duplicated
  hierarchy, over-fragmented composition, missing instancing, payload policy, or
  genuinely distinct authored content.
- Prefer prototype-local or asset-local cleanup before whole-stage merging.
  Local work preserves references, variants, and reviewability, and it is easier
  to validate before the optimized assets are remapped into the assembly.
- Treat entire-prototype or whole-assembly merging as a high-friction option.
  Before recommending it, surface overlap risk, shared hierarchy semantics,
  reference/payload rewrites, material and primvar preservation, important
  metadata, and the user's intent for future selective loading.
- Small meshes are not always bad. They may be visible details, engineering
  fasteners, collision markers, or source-of-truth geometry. Keep, instance, or
  delete them based on visibility and user intent; do not assume removal is the
  right fix just because the mesh is small.
- Large overlapping meshes can be expensive for ray tracing and selection even
  when prim count looks reasonable. Flag them as split/cull/occlusion-analysis
  candidates, especially when a single mesh spans rooms, floors, disciplines, or
  enclosing shells.
- Any recommendation that may drop geometry, collapse hierarchy, or discard
  authored attrs/metadata requires explicit user confirmation downstream.

### 2.6 Duplicate subtree detection

Identify subtrees that are structurally identical and positioned at the same
transform. This is common in BIM/Revit exports where linked models are
included multiple times.

Check:

- Scan multiple hierarchy depths. For CAD/BIM trees, normalize sibling names at
  each candidate depth by stripping numeric suffixes, generated copy suffixes,
  and export IDs before grouping. A duplicate pattern at depth 3+ is still a
  hierarchy-dedupe candidate even if the scene root and depth-2 containers look
  unique.
- Group candidate roots by normalized sibling-name pattern and by subtree hash.
- For each group with >1 member, compare:
  - Child names (are they identical?).
  - Transforms (are they all identity or all the same?).
  - Instance counts and prototype usage (same count per copy?).
- If copies are structurally identical at the same transform, they are
  export duplicates — the scene contains N× the data it should.
- If the shallow scan is clean but deep normalized names suggest repeated
  modules, report `hierarchy_dedupe.recommended: true` with a reason such as
  "needs deeper scan" and invoke `usd-hierarchy-dedupe-candidates`; do not set
  it to `false` based only on root-level or depth-2 evidence.

Report:

- Which discipline/subtree groups have duplicates.
- Maximum depth scanned and whether repeated names only appear at depth 3+.
- How many copies exist vs how many are needed (1).
- Total redundant prims and the percentage of the scene they represent.
- Whether the copies reference the same prototypes (shared) or generated
  separate prototypes (unshared — each copy inflates the prototype pool).

This is distinct from instancing: instancing shares geometry within a
hierarchy, while duplicate subtrees are entire hierarchy copies that
should not exist at all.

Recommendation:

- Flag as "export duplication — keep one copy per discipline, deactivate rest."
- If transforms differ, it may be intentional (separate building wings) —
  ask the user before deactivating.
- If transforms are identical (all at origin), it is almost certainly an
  export artifact.
- Quantify the saving: removing N-1 copies of each group eliminates
  (N-1)/N of the scene's prims and associated prototypes.

### 2.7 Asset boundary identification

For monolithic stages, identify natural grouping levels that could become
separate assets. Present candidates to the user rather than prescribing a
specific level.

Analyze the existing hierarchy for repeating patterns:

- **Disciplines** (HVAC, Architectural, Structural, Electrical, Plumbing, Facades)
- **Spatial units** (Buildings, Wings/Blocks, Floors, Rooms)
- **Categories** (Walls, Doors, Ducts, Fittings, Equipment)

Report the hierarchy as a tree with prim counts at each level:

```
Scene (123K prims)
├── Discipline (×7): Architectural, HVAC, Plumbing, Electrical, Structural, Facades, Site
│   ├── Floor (×8): L1, L2, L3, L4, L5, M1, Parking, R1
│   │   └── Category: Walls, Ducts, Fittings, Equipment...
```

Ask the user: "Which level should be the asset boundary for selective loading
and optimization?" Common choices:

- **Per-floor** — enables floor-by-floor loading. Good for construction/FM.
- **Per-discipline-per-floor** — enables "show me L3 HVAC only." Most granular.
- **Per-discipline** — enables discipline toggling. Simplest extraction.

The answer drives downstream structuring: each identified asset boundary
becomes a candidate for extraction into a separate layer (payload or reference).

Selective loading is a separate decision from deduplication. A stage can be
well-instanced and still be a poor delivery package if it has `payload_count: 0`
and clear floor, discipline, linked-model, building-wing, or category
boundaries. In that case:

- Set `asset_boundary_suggestions.user_choice_required` to `true`.
- Route to `restructure-decision` even when mesh optimization can proceed
  "as-is".
- Ask whether the user wants loadable sub-assets (for example per-floor or
  per-discipline-per-floor payloads), wants to optimize the monolith as-is, or
  wants a diagnosis-only exit.
- Do not record `choice: optimize-as-is` without presenting that selective
  loading choice to the user.

#### Hash-backed boundary refinement

When `usd-hierarchy-dedupe-candidates` has produced a read-only candidate report
for the same stage, refine the boundary suggestions above using its hash output.
Subtree hashes identify structurally identical (or near-identical) sub-hierarchies;
preferring cut points that align with those hashes creates immediate dedupe wins
when the boundaries are materialized.

Augment the candidate tree from the previous step with hash-backed signal:

- For each candidate boundary level (e.g. per-floor, per-discipline-per-floor),
  count how many of the children at that level have matching subtree hashes.
- Promote boundaries where multiple children share a hash - extracting at that
  level produces fewer, more reusable prototypes.
- Demote boundaries that cut across hash-equal subtrees - extracting there
  fragments what could have been a single shared prototype.

If `usd-hierarchy-dedupe-candidates` has not been run yet and the stage is
monolithic, recommend running it before finalizing the boundary plan. The
combined SA + dedupe-candidates output is what `restructure-decision` (Phase 2e
in the tuning workflow) consumes when asking the user to confirm.

### 2.8 Prototype library assessment

For scenes with explicit prototypes:

- Identify the authored prototype hierarchy path (e.g., `/Root/Prototypes/`).
- Count prototypes and assess whether they should be extracted into a shared
  library layer (per the VFI "component + subcomponent library packaging" pattern).
- Assess whether the prototype pool is inflated by duplicate subtrees (see 2.6).

Extraction recommendation:

- **Prototype library as shared layer** — all prototype definitions in one
  referenced file, assemblies reference them. Reduces duplication if multiple
  stages share the same component library.
- **Keep inline** — for single-file delivery where composition overhead
  should be minimized.

## Output

Emit a structure assessment report containing:

```json
{
  "stage": {
    "identifier": "path/to/stage.usd",
    "rootLayer": "path/to/stage.usd",
    "metersPerUnit": 0.01,
    "upAxis": "Z",
    "scale_hint": "centimeters"
  },
  "asset_physical_context": {
    "metersPerUnit": 0.01,
    "upAxis": "Z",
    "scale_hint": "centimeters",
    "mesh_count": 18200
  },
  "summary_counts": {
    "prim_count": N,
    "mesh_count": N,
    "material_count": N,
    "prototype_count": N,
    "instance_count": N,
    "reference_count": N,
    "payload_count": N
  },
  "composition": {
    "layers": N,
    "references": N,
    "payloads": N,
    "counting_method": "authored_list_op_items | prims_with_authored_arcs",
    ...
  },
  "assets": {
    "total": N,
    "well_structured": N,
    "manifest": ["path/to/A.geom.usd", ...],
  },
  "layer_health": { "large_usda": [...], "tiny": N, ... },
  "instancing": { "instances": N, "prototypes": N, "candidates": N, "ratio": 0.0 },
  "hierarchy_dedupe": {
    "recommended": true,
    "reason": "monolithic stage with repeated assembly names and no instances",
    "top_candidates": [
      { "path_pattern": "...", "subtree_prims": 0, "copies": 0, "estimated_prim_savings": 0 }
    ]
  },
  "scale_assessment": {
    "prim_count_interpretation": "structural_reuse_needed | local_cleanup_first | acceptable",
    "mesh_sizing_flags": ["small_mesh_detail", "large_overlap_candidate"],
    "merge_posture": "prototype_local_preferred | whole_assembly_requires_user_confirmation"
  },
  "asset_boundary_suggestions": {
    "candidate_levels": [
      { "level": "per-floor", "child_count": 8, "hash_matched_groups": 0, "promoted": false },
      { "level": "per-discipline-per-floor", "child_count": 56, "hash_matched_groups": 4, "promoted": true,
        "reason": "4 hash-matched assembly groups align with this cut - immediate dedupe wins on extraction" }
    ],
    "user_choice_required": true,
    "choice_reason": "payload_count is 0 and clear spatial/discipline boundaries exist; selective loading is a user decision even if geometry reuse is already strong",
    "consumed_by": "restructure-decision (Phase 2e)"
  },
  "flagged_assets": [
    { "asset": "...", "reason": "outlier_extent", "details": "..." },
    { "asset": "...", "reason": "containment", "pair": "...", "enclosure_opaque": true, "details": "..." },
    { "asset": "...", "reason": "repetition", "similar_to": "...", "details": "..." },
  ],
  "validation_scope": {
    "per_asset": ["list of assets needing individual validation"],
    "cross_component_pairs": ["list of (A,B) pairs needing spatial analysis"],
    "skip": ["list of assets with no flags — low priority for deep validation"],
  },
  "phase_recommendation": "structuring | optimization | already_optimized"
}
```

The `validation_scope` section feeds directly into `so-run-validators` — it tells
the agent which assets to validate and which to skip.

The `summary_counts` section is the compact handoff consumed by
`usd-validation-runner`: it tells the validator router whether the asset is
monolithic, prototype-heavy, already instanced, or worth restructuring before
expensive validators run.

For `reference_count` and `payload_count`, prefer authored list-op item counts.
If the selected USD Python runtime can only produce prim-level booleans, use
the prims-with-authored-arcs count and write
`composition.counting_method: "prims_with_authored_arcs"` so downstream readers
do not mistake it for a total arc-item count.

The `phase_recommendation` indicates which phase of the three-phase pipeline
(extraction → structuring → optimization) the scene is currently in, based on
the structural evidence. This guides the edit-target planner and Scene Optimizer
handoff decisions.

If `hierarchy_dedupe.recommended` is true, run
`usd-hierarchy-dedupe-candidates` before `restructure-decision` or mesh-level
`so-run-operations`. That skill is read-only and decides whether repeated
subtrees should be turned into shared prototype/reference assets before any
mesh-level dedupe.

## Rules

- Do not read geometry arrays (points, faceVertexCounts, normals). SA is
  structural only. Mesh-level stats belong to Phase 2c validators.
- Do not run geometry validators in this reference; hand validation scope to
  `usd-validation-runner` / `so-run-validators`.
- Do not recommend operations based on structural heuristics alone — heuristics
  flag candidates for validation, not confirmed issues.
- Report `summary_counts` explicitly. Asset counts are the primary scope metric;
  layer counts and arc counts are supporting evidence.
- Report `scale_assessment` when prim count, mesh size, or merge strategy affects
  the validation or optimization path.
- Do not set `hierarchy_dedupe.recommended: false` from only a root-child or
  depth-2 name scan on CAD/BIM exports. Deep repeated names require a deeper
  normalized scan or `usd-hierarchy-dedupe-candidates` evidence.
- If `payload_count` is 0 and clear asset boundaries exist, require a
  `restructure-decision` selective-loading choice even when instancing is
  strong and the mesh-optimization path is otherwise "optimize as-is".
- Use the reference docs to distinguish assets from layers from arcs — conflating
  them leads to incorrect scope estimates.
- Spatial heuristics (§2.1, §2.2, §2.3) use only authored `extentsHint`
  attributes. If extents are not authored, skip the spatial check for that
  prim — do not compute bounds to fill the gap.

## Tools for asset extraction

The `isaacsim.asset.transformer` extension provides a rule-based pipeline
framework for transforming USD assets. It can be configured with custom rules
to perform extraction:

- Extract subtrees into separate layers
- Create interface/payload structure
- Collect and remap external assets
- Re-route references after extraction

The framework handles: flattening, asset collection, path remapping, and
sequential rule execution. Custom rules implement `RuleInterface.process_rule()`
to perform specific extraction logic.

For the actual extraction, also consider plain USD Python API:
- `Sdf.Layer.CreateNew()` + copy prim specs
- `Sdf.CopySpec()` / layer export for subtree extraction
- Reference/payload arc insertion on the assembly layer
- `UsdUtils.ModifyAssetPaths()` for path remapping after restructuring
