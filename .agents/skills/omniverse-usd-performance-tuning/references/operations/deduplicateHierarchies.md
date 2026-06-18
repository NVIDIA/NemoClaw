---
doc_type: scene_optimizer_operation
operation: deduplicateHierarchies
title: De-duplicate Hierarchies
source: scene-optimizer-core/source/operations/deduplicateHierarchies/DeduplicateHierarchies.cpp
category: hierarchy
loss_class: lossless
requires_confirmation: true
risk_class: medium
args_count: 0
requires_mesh: false
pipelines: [memory-reduction, mesh-count-reduction, instancing]
keywords: [dedup, instancing, hierarchy, prototype, reference]
since_version: 2026-04-17T00:00:00Z
requires_extension: omni.scene.optimizer.core
---
<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# De-duplicate Hierarchies

Identifies structurally-identical sub-hierarchies within a stage and collapses
them into shared prototypes referenced from each original site. The referencing
prims are marked `instanceable=true`.

Unlike `deduplicateGeometry` (which operates on individual mesh data),
`deduplicateHierarchies` operates at the subtree level — entire prim
hierarchies are compared and deduplicated.

This local file is a routing stub only. Its YAML frontmatter is the local
catalog source for operation selection, risk, confirmation, and workflow
metadata.

For Scene Optimizer operation mechanics, parameters, defaults, and implementation
notes, use [Operation Index](README.md) and the centralized [`usd-optimize`
upstream handoff](../upstreams/usd-optimize.md). Resolve the package operation
guide by the `operation` key in this file; do not restate upstream mechanics
here.
