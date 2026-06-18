<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# USD Layer Health

> Layer-health checks are performed as a section of `usd-structure-assessment` Phase 1.3; this reference holds the deeper checklist, file-format guidance, asset-path hygiene, and flattening policy.

---

## Purpose

Use this guidance when an audit finds many layers, slow opens, `.usda` data files, `.usdz` runtime assets, missing dependencies, or pressure to flatten. Do not use it for mesh-level validation or processor selection.

## Prerequisites

- Stage path or audit report with root layer, sublayers, references, payloads, and generated layers.
- Resolver context needed to check asset paths and dependencies.
- Access to layer files when file format, size, or portability is being judged.

## Examples

- "Assess layer health for this aggregate USD before optimizer handoff."
- "Check whether this .usdz package is appropriate as a runtime asset."

## Limitations

- Identifies layer and packaging risks; it does not repair paths or rewrite layers.
- Layer counts are not asset counts and should not be used alone for scope.
- Flattening guidance assumes source layers are versioned elsewhere.

## Troubleshooting

- If asset paths do not resolve, capture resolver context and missing paths before judging layer health.
- If tiny layers dominate the stack, group them by publisher or automation source before recommending cleanup.
- If flattening is requested, confirm whether the output is a delivery artifact or an editable source.

## Layer checks

- Count used layers.
- Identify root, session, sublayers, references, payload targets, and generated override layers.
- Flag repeated tiny layers that accumulate through publishing or automation.
- Flag layers that are referenced many times across an aggregate stage.
- Identify anonymous or temporary layers before processor execution.

## File-format checks

Prefer:

- `.usdc` for data-heavy geometry, materials, and large composed assets.
- Small `.usda` files for interface layers, debugging, and human-readable overrides.
- `.usd` when the writer defaults to crate for data-heavy outputs.

Avoid:

- Large `.usda` data files in runtime paths.
- `.usdz` as a working runtime format when load performance matters.
- Flattened monoliths as a default optimization.

## Asset path hygiene

Flag:

- Missing asset paths.
- Absolute paths in portable content.
- Paths that only resolve on one OS.
- References or payloads crossing expected package boundaries.
- Generated outputs that overwrite source asset paths.

## Flattening guidance

Flatten only when:

- The user explicitly needs a delivery artifact.
- All source layers are versioned elsewhere.
- The flattened result is not expected to remain editable as source.
- Validation runs on the flattened output.

Do not flatten to hide layer-stack complexity during diagnosis. The right first move is to identify which layers are causing cost or confusion.

## Output

Layer-health findings should be included in the `usd-structure-assessment` umbrella report (preferred) and used by `usd-edit-target-planner` before processor execution.
