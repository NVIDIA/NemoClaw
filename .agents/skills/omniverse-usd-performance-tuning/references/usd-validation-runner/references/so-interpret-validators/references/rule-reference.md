<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Validator Rule Reference

This table maps a reported **validator signal** to its **canonical concept**
and the **backing operation** that fixes it. It is the interpretation source for
turning findings into op candidates — it is **not** an execution allowlist and
it does **not** publish tiers.

**Single source of truth.** Validator *identity* (`module` + `class_name`),
*tier*, *scope policy*, and *preferred provider* live only in
`../../../validator-concepts.json` (keyed by canonical concept). Do not restate
tier numbers here or in the runner README; if a tier matters, read it from the
registry. Execution goes through `scripts/usd_validation_executor.py`, which
resolves the canonical concept to a unique registered rule class and fails
closed on anything unknown or ambiguous. Never copy a runtime class name (e.g.
`IndexedPrimvarChecker`) or a category (`Geometry`, `Usd:Performance`) into a
scope note — class names are not unique across providers.

Scene Optimizer validator mechanics and operation docs live upstream in
[usd-optimize](https://github.com/NVIDIA-omniverse/usd-optimize/) and the
prebuilt Scene Optimizer package. Resolve guidance from an extracted package
root via `$SCENE_OPTIMIZER_PACKAGE_ROOT`, then `$SO_HOME`. If no package root
exists, download/extract the published `scene_optimizer_core_...release.zip`
package (direct archive URLs are in `references/upstreams/usd-optimize.md`) or
use the package path supplied by the user. To verify a rule's backing
operation, inspect upstream
`source/core/python/omni/scene/optimizer/validators/<module>.py`.

### Scene Optimizer rules (default)

| Validator signal | Canonical concept | Backing op | Notes |
|------|------|-----------|-------|
| SceneOptimizerCoincidingGeometryChecker | `spatial_coinciding` | `findCoincidingGeometry` | Analysis-only; prefer `deduplicateGeometry` before destructive deletion. |
| SceneOptimizerColocatedVerticesChecker | `vertex_weld` | `meshCleanup` | Merges colocated vertices. |
| SceneOptimizerDuplicateFacesChecker | `topology_duplicate_faces` | `meshCleanup` | Removes duplicate faces. |
| SceneOptimizerDuplicateGeometryChecker | `geom_duplicates` | `deduplicateGeometry` | Converts identical meshes to USD instances; run per target or sample, never an unbounded whole-stage default. |
| SceneOptimizerDuplicateHierarchiesChecker | _(structural — no mesh concept)_ | `usd-hierarchy-dedupe-candidates` + `apply-restructure` | Use the hierarchy candidate finder + restructure gate, not a direct mesh op. |
| SceneOptimizerDuplicateMaterialsChecker | `material_duplicates` | `optimizeMaterials` | Merges duplicate material definitions. |
| SceneOptimizerEmptyLeafChecker | `structure_empty_leaf` | `pruneLeaves` | Removes leaf prims with no geometry. |
| SceneOptimizerFlatHierarchiesChecker | `structure_flat_hierarchy` | `findFlatHierarchies` → `flattenHierarchy` | Analysis-only signal; fix is the `flattenHierarchy` operation. |
| SceneOptimizerFuzzyDuplicateGeometryChecker | `geom_duplicates_fuzzy` | `deduplicateGeometry` | Same op, different threshold; run per target or sample. |
| SceneOptimizerIndexedPrimvarChecker | `primvar_indexability` | `optimizePrimvars` | Converts to indexed primvars when the result can change the op plan. |
| SceneOptimizerInvisiblePrimsChecker | `structure_invisible` | `removePrims` | Confirm intent before removing — invisibility may be deliberate. |
| SceneOptimizerIsolatedVerticesChecker | `topology_isolated_vertices` | `meshCleanup` | Removes isolated verts. |
| SceneOptimizerMeshDensityChecker | `perf_high_vertex_count` | `countVertices` | Informational; lossless reducers first, `decimateMeshes` only after the upfront tolerance prompt. |
| SceneOptimizerNonManifoldChecker | `topology_manifold` | `meshCleanup` | Skip for visualization-only workflows; run only for simulation-ready intent. |
| SceneOptimizerNormalsChecker | `normals_validity` | `generateNormals` | Regenerates missing/invalid normals; targeted check only. |
| SceneOptimizerPrimitiveFitChecker | `primitive_fit` | `fitPrimitives` | Bounded-loss; requires the tolerance prompt before applying. Highest-value reducer for converted CAD/BIM content. |
| SceneOptimizerRedundantTimeSamplesChecker | `perf_redundant_timesamples` | `optimizeTimeSamples` | Removes redundant samples on animated attributes. |
| SceneOptimizerRtxMeshCountChecker | `perf_rtx_mesh_count` | `rtxMeshCount` | Informational threshold check. Reduce via `deduplicateGeometry` + `flattenHierarchy` + `removeSmallGeometry`. |
| SceneOptimizerSmallMeshChecker | `perf_small_mesh` | `removeSmallGeometry` | Removes meshes below a screen-space threshold. |
| SceneOptimizerSparseMeshChecker | `perf_sparse_mesh` | `sparseMeshes` | Tune density thresholds. |
| SceneOptimizerUnusedUVsChecker | `primvar_unused` | `removeUnusedUVs` | Removes unbound UV sets when the result can change the op plan. |
| SceneOptimizerWindingsChecker | `normals_winding` | `meshCleanup` | Fixes inconsistent face winding. |
| SceneOptimizerZeroAreaFacesChecker | `topology_zero_area_faces` | `meshCleanup` | Removes degenerate faces. |
| SceneOptimizerZeroExtentChecker | `extents_zero` | `removeSmallGeometry` | Fix removes zero-extent meshes. Use `computeExtents` first when the cause is stale metadata. |

### Scene Optimizer rules (expensive — only present with `--include-expensive`)

| Validator signal | Canonical concept | Backing op | Notes |
|------|------|-----------|-------|
| SceneOptimizerOccludedMeshesChecker | `spatial_occluded` | `findOccludedMeshes` → `removePrims` | **Two-step detect→act.** Analysis identifies fully-occluded prim paths; feed those to `removePrims`. Runs first in the Phase 4 op chain. Scope to SA containment pairs with `enclosure_opaque: true`. Two-stage approval: (1) analysis cost, (2) deletion. |
| SceneOptimizerFindOverlappingMeshesChecker | `spatial_overlapping` | `findOverlappingMeshes` | Analysis-only. Fix: review and remove/merge in DCC. |

These expensive concepts are `gpu_bound` and Tier 3 in the registry; they must be
scoped to flagged pairs (`paths=` / `OpenMasked`) and run in bounded
subprocesses — never full-stage by default on large CAD/BIM/MEP assets.

### Asset Validator (OAV) base rules

The full list lives in the upstream `omniverse-asset-validator` package; we
mirror only the concepts that participate in the performance workflow. Many base
rules map onto a Scene Optimizer operation — surface the equivalent op so the
user has an automated fix path even when the rule itself is upstream.

**Geometry rules with SO operation equivalents:**

| OAV base rule | Canonical concept | Backing op | Notes |
|-----------|------|------------------|------|
| `ExtentsChecker` | `extents_general` | `computeExtents` | Broader than SO `ZeroExtentChecker`. |
| `IndexedPrimvarChecker` | `primvar_indexability` (oav impl) | `optimizePrimvars` | **OAV variant is the slow full audit.** Registry tiers the OAV implementation higher than the SO triage one; the executor picks the SO impl for performance tuning. |
| `WeldChecker` | `vertex_weld` | `meshCleanup` | Welds colocated verts. |
| `NormalsValidChecker` | `normals_validity` | `generateNormals` | Targeted check only. |
| `ZeroAreaFaceChecker` | `topology_zero_area_faces` | `meshCleanup` | — |
| `UnusedMeshTopologyChecker` | `topology_unused_mesh` | `meshCleanup` | Removes unreferenced points. |
| `ManifoldChecker` | `topology_manifold` | `meshCleanup` | Some topology repairs need DCC work; skip for visualization-only targets. |

**Stage / metadata / external references (safety gates — manual fix, no SO op):**

| OAV base rule | Canonical concept | Notes |
|-----------|------|------|
| `KindChecker` | `kind_metadata` | Fix via `prim.SetMetadata('kind', ...)`. |
| `DefaultPrimChecker` | `layout_default_prim` | Fix via `stage.SetDefaultPrim(...)`. |
| `StageMetadataChecker` | `stage_metadata` | Fix via `UsdGeom.SetStageUpAxis(...)`, etc. |
| `LayerSpecChecker` | `layer_spec_health` | Type/value mismatches in layer specs. |
| `MissingReferenceChecker` | `composition_missing_ref` | Unresolvable references — common on assets flattened elsewhere with absolute paths. High-priority gate for conversions. |
| `MaterialPathChecker` | `material_path` | `info:mdl:sourceAsset` pointing at missing files. |
| `NormalMapTextureChecker` | `texture_normalmap` | `UsdUVTexture inputs:file` unresolvable. |

For OAV-equivalent fixes, label the op as a Scene Optimizer operation (not the
validator's own `--fix` — this repo's validators don't ship a `--fix` mode).

For any signal not in this list, treat it as a **manual fix** and surface the
CSV `Suggestion` column verbatim. Don't invent fix commands, and don't assign a
tier here — if the concept matters, add it to `validator-concepts.json`.

---
