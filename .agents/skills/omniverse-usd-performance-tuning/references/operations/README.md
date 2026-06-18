<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- AUTO-GENERATED FROM references/operations/manifest.json -->
<!-- Source data lives in manifest.json. -->

# Operation Index

Catalog of all Scene Optimizer operations known to this workflow. Each row
corresponds to a local `<key>.md` handoff stub whose YAML frontmatter carries
the same routing fields shown below. Use this to find operations by category,
loss class, or argument count; use upstream `usd-optimize` or the prebuilt
Scene Optimizer package for operation behavior, parameters, defaults, and
implementation gotchas.

The package resolution rule is centralized once in
[`usd-optimize` upstream handoff](../upstreams/usd-optimize.md): derive the
upstream operation guide from the operation key as
`.agents/operations/<operation-key>.md`, then resolve it under the selected
Scene Optimizer package root. Do not duplicate package URLs, root fallbacks, or
upstream parameter/default tables in the per-operation stubs. Before executing
any operation, consume `<output_path>/setup-preflight.json` and confirm the op
appears in `sceneOptimizer.operationsAvailable`.

**Companion docs:**
- [Execution reference](EXECUTION.md) — docs-class wrapper/API invocation shape, batch orchestration, and validator import variants.
- [Classification rubric](CLASSIFICATION.md) — curation tiers and the canonical-over-specialty selection rule.
- [`pipelines.md`](../so-run-operations/references/pipelines.md) — curated multi-op chains organized by bottleneck.
- [`_template.md`](_template.md) — template for new operation guides (includes the frontmatter schema).
- [`manifest.json`](manifest.json) — machine-readable catalog (same data as below).
- [`usd-optimize` upstream handoff](../upstreams/usd-optimize.md) — central upstream operation-guide and prebuilt package resolution.

**Loss class.** `lossless` reorganizes / dedups / regenerates derived data only.
`bounded-loss` removes or modifies authored content (the agent should confirm
with the user before running). `analysis-only` is read-only (`context.analysisMode = 1`).


## Geometry
| Operation | Key | Args | Loss | Risk | Confirm | Pipelines |
|---|---|---|---|---|---|---|
| [Dice Meshes](diceMeshes.md) | `diceMeshes` | 22 | bounded-loss | medium | yes | — |
| [Fit Primitives](fitPrimitives.md) | `fitPrimitives` | 20 | bounded-loss | high | yes | — |
| [Split Meshes](splitMeshes.md) | `splitMeshes` | 16 | lossless | low | no | — |
| [Primitives to Meshes](primitivesToMeshes.md) | `primitivesToMeshes` | 13 | lossless | low | no | — |
| [Mesh Cleanup](meshCleanup.md) | `meshCleanup` | 11 | bounded-loss | low | yes | `mesh-count-reduction`, `data-quality-baseline` |
| [De-duplicate Geometry](deduplicateGeometry.md) | `deduplicateGeometry` | 9 | lossless | low | no | `safe-cleanup`, `memory-reduction`, `mesh-count-reduction` |
| [Decimate Meshes](decimateMeshes.md) | `decimateMeshes` | 8 | bounded-loss | medium | yes | `mesh-count-reduction` |
| [Shrinkwrap](shrinkwrap.md) | `shrinkwrap` | 7 | bounded-loss | high | yes | — |
| [Generate Normals](generateNormals.md) | `generateNormals` | 6 | lossless | low | no | `data-quality-baseline` |
| [Merge Vertices](mergeVertices.md) | `mergeVertices` | 5 | lossless | low | no | — |
| [Subdivide Meshes](subdivideMeshes.md) | `subdivideMeshes` | 5 | lossless | low | no | — |
| [Remesh Meshes](remeshMeshes.md) | `remeshMeshes` | 4 | bounded-loss | high | yes | — |
| [Remove Small Geometry](removeSmallGeometry.md) | `removeSmallGeometry` | 4 | bounded-loss | medium | yes | `mesh-count-reduction` |
| [Triangulate Meshes](triangulateMeshes.md) | `triangulateMeshes` | 2 | lossless | low | no | — |
| [Manifold Meshes](manifoldMeshes.md) | `manifoldMeshes` | 1 | bounded-loss | medium | yes | — |
| [Sparse Meshes](sparseMeshes.md) | `sparseMeshes` | 0 | bounded-loss | medium | yes | — |

## Hierarchy
| Operation | Key | Args | Loss | Risk | Confirm | Pipelines |
|---|---|---|---|---|---|---|
| [Remove Prims](removePrims.md) | `removePrims` | 8 | bounded-loss | high | yes | — |
| [Prune Leaves](pruneLeaves.md) | `pruneLeaves` | 3 | lossless | low | no | `safe-cleanup`, `memory-reduction`, `load-time-reduction` |
| [Flatten Hierarchy](flattenHierarchy.md) | `flattenHierarchy` | 2 | lossless | medium | no | — |
| [Organize Prototypes](organizePrototypes.md) | `organizePrototypes` | 2 | lossless | low | no | — |
| [Delete Prims](deletePrims.md) | `deletePrims` | 1 | bounded-loss | high | yes | — |
| [De-duplicate Hierarchies](deduplicateHierarchies.md) | `deduplicateHierarchies` | 0 | lossless | medium | yes | `memory-reduction`, `mesh-count-reduction`, `instancing` |
| [Delete Hidden Prims](deleteHiddenPrims.md) | `deleteHiddenPrims` | 0 | bounded-loss | medium | yes | — |
| [Optimize Skeleton Roots](optimizeSkelRoots.md) | `optimizeSkelRoots` | 0 | lossless | low | no | — |
| [Remove Untyped Prims](removeUntypedPrims.md) | `removeUntypedPrims` | 0 | bounded-loss | low | yes | — |

## Materials
| Operation | Key | Args | Loss | Risk | Confirm | Pipelines |
|---|---|---|---|---|---|---|
| [Optimize Materials](optimizeMaterials.md) | `optimizeMaterials` | 4 | lossless | low | no | `safe-cleanup`, `memory-reduction`, `load-time-reduction` |

## Uv
| Operation | Key | Args | Loss | Risk | Confirm | Pipelines |
|---|---|---|---|---|---|---|
| [generateAtlasUVs](generateAtlasUVs.md) | `generateAtlasUVs` | 7 | lossless | medium | no | — |
| [Generate Projection UVs](generateProjectionUVs.md) | `generateProjectionUVs` | 7 | lossless | low | no | — |
| [Remove Unused UVs](removeUnusedUVs.md) | `removeUnusedUVs` | 3 | lossless | low | no | — |

## Metadata
| Operation | Key | Args | Loss | Risk | Confirm | Pipelines |
|---|---|---|---|---|---|---|
| [Optimize Primvars](optimizePrimvars.md) | `optimizePrimvars` | 6 | lossless | low | no | — |
| [Optimize Time Samples](optimizeTimeSamples.md) | `optimizeTimeSamples` | 6 | lossless | low | no | `safe-cleanup`, `load-time-reduction` |
| [Edit Stage Metrics](editStageMetrics.md) | `editStageMetrics` | 4 | lossless | low | no | — |
| [Remove Attributes](removeAttributes.md) | `removeAttributes` | 3 | bounded-loss | medium | yes | — |
| [Compute Extents](computeExtents.md) | `computeExtents` | 1 | lossless | low | no | `safe-cleanup`, `load-time-reduction`, `data-quality-baseline` |

## Transform
| Operation | Key | Args | Loss | Risk | Confirm | Pipelines |
|---|---|---|---|---|---|---|
| [Merge Static Meshes](merge.md) | `merge` | 14 | bounded-loss | high | yes | — |
| [Box Clip](boxClip.md) | `boxClip` | 11 | bounded-loss | high | yes | — |
| [Compute Pivot](pivot.md) | `pivot` | 4 | lossless | low | no | — |

## Analysis
| Operation | Key | Args | Loss | Risk | Confirm | Pipelines |
|---|---|---|---|---|---|---|
| [Find Occluded Meshes](findOccludedMeshes.md) | `findOccludedMeshes` | 7 | analysis-only | medium | yes | — |
| [Find Coinciding Geometry](findCoincidingGeometry.md) | `findCoincidingGeometry` | 4 | analysis-only | low | no | — |
| [Find Overlapping Meshes](findOverlappingMeshes.md) | `findOverlappingMeshes` | 4 | analysis-only | low | no | — |
| [Count Vertices](countVertices.md) | `countVertices` | 3 | analysis-only | low | no | — |
| [Find Flat Hierarchies](findFlatHierarchies.md) | `findFlatHierarchies` | 3 | analysis-only | low | no | — |
| [Print Stats](printStats.md) | `printStats` | 3 | analysis-only | low | no | — |
| [RTX Mesh Count](rtxMeshCount.md) | `rtxMeshCount` | 1 | analysis-only | low | no | — |

## Utility
| Operation | Key | Args | Loss | Risk | Confirm | Pipelines |
|---|---|---|---|---|---|---|
| [Generate Scene](generateScene.md) | `generateScene` | 12 | lossless | low | no | — |
| [Utility Function](utilityFunction.md) | `utilityFunction` | 2 | lossless | low | no | — |
| [Python Script](pythonScript.md) | `pythonScript` | 1 | bounded-loss | high | yes | — |

## Summary

Total operations: **47**
- geometry: 16
- hierarchy: 9
- materials: 1
- uv: 3
- metadata: 5
- transform: 3
- analysis: 7
- utility: 3
