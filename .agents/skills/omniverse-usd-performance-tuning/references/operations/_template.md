---
doc_type: scene_optimizer_operation
operation: <operation-key>
title: <Operation Display Name>
source: scene-optimizer-core/source/operations/<operation-key>/<OperationClass>.cpp
category: geometry
loss_class: lossless
requires_confirmation: false
risk_class: low
args_count: 0
requires_mesh: true
pipelines: []
keywords: []
since_version: 2026-01-01T00:00:00Z
requires_extension: omni.scene.optimizer.core
# parameter_prerequisites:  (add for bounded-loss/destructive ops)
#   - field: asset_physical_context.<field>
#     source: sa_report.json
#     required: true
#   - elicit_from_user: <param_name>
#     canonical_question: "<exact question text for the user>"
#     defaults: [<value1>, <value2>]
#     default_option: "<pre-selected if user doesn't express preference>"
#     skip_option: "skip <operation>"
#     conversion: "<formula from user input to SO parameter>"
---
<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# <Operation Display Name>

This local file is a routing stub only. Its YAML frontmatter is the local
catalog source for operation selection, risk, confirmation, and workflow
metadata.

For Scene Optimizer operation mechanics, parameters, defaults, and implementation
notes, use [Operation Index](README.md) and the centralized [`usd-optimize`
upstream handoff](../upstreams/usd-optimize.md). Resolve the package operation
guide by the `operation` key in this file; do not restate upstream mechanics
here.
