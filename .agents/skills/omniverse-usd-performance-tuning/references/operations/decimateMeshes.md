---
doc_type: scene_optimizer_operation
operation: decimateMeshes
title: Decimate Meshes
source: scene-optimizer-core/source/operations/decimateMeshes/OmniMeshDecimate.cpp
category: geometry
loss_class: bounded-loss
requires_confirmation: true
risk_class: medium
args_count: 8
requires_mesh: true
pipelines: [mesh-count-reduction]
keywords: [decimate, polygon-count, lod, qem, silhouette]
since_version: 2026-02-11T07:51:19Z
requires_extension: omni.scene.optimizer.core
parameter_prerequisites:
  - field: asset_physical_context.metersPerUnit
    source: sa_report.json
    required: true
  - elicit_from_user: mm_tolerance
    canonical_question: "What's the smallest surface detail (in mm) you need to preserve?"
    defaults: [0.1, 0.5, 1.0, 2.0, 5.0]
    skip_option: "skip decimation"
    conversion: "maxMeanError = mm_tolerance / (metersPerUnit * 1000)"
recommendation_signals:
  - source: SceneOptimizerMeshDensityChecker
    signal: "High-density outlier meshes detected — meshes with triangle density disproportionate to their physical extent are strong candidates for decimation."
  - source: sa_report.flagged_assets (when extentsHint authored)
    reason: outlier_extent
    signal: "SA flagged meshes with authored extents disproportionate to their hierarchy level — possible over-tessellation candidates."
  - note: >
      maxMeanError is inherently scale-aware: over-tessellated meshes (e.g. a
      1M-poly screw at 20mm) lose most triangles because nearly all vertices
      fall within the error budget. Under-tessellated meshes barely change.
      No per-mesh targeting is needed — apply uniformly to all meshes.
anti_patterns:
  - "Do not frame as 'reduce by X%'. Rate-mode bypasses the silhouette-preserving error budget."
  - "Do not ask which meshes to target. maxMeanError handles density differences automatically."
  - "Do not offer triangle-count or percentage options unless the user explicitly provides a rate-based constraint."
---
<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Decimate Meshes

This local file is a routing stub only. Its YAML frontmatter is the local
catalog source for operation selection, risk, confirmation, and workflow
metadata.

For Scene Optimizer operation mechanics, parameters, defaults, and implementation
notes, use [Operation Index](README.md) and the centralized [`usd-optimize`
upstream handoff](../upstreams/usd-optimize.md). Resolve the package operation
guide by the `operation` key in this file; do not restate upstream mechanics
here.
