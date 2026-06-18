---
doc_type: scene_optimizer_operation
operation: removeSmallGeometry
title: Remove Small Geometry
source: scene-optimizer-core/source/operations/removeSmallGeometry/RemoveSmallGeometry.cpp
category: geometry
loss_class: bounded-loss
requires_confirmation: true
risk_class: medium
args_count: 4
requires_mesh: true
pipelines: [mesh-count-reduction]
keywords: [remove, small, screen-space, lod, cleanup]
since_version: 2026-02-11T07:51:19Z
requires_extension: omni.scene.optimizer.core
---
<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Remove Small Geometry

This local file is a routing stub only. Its YAML frontmatter is the local
catalog source for operation selection, risk, confirmation, and workflow
metadata.

For Scene Optimizer operation mechanics, parameters, defaults, and implementation
notes, use [Operation Index](README.md) and the centralized [`usd-optimize`
upstream handoff](../upstreams/usd-optimize.md). Resolve the package operation
guide by the `operation` key in this file; do not restate upstream mechanics
here.
