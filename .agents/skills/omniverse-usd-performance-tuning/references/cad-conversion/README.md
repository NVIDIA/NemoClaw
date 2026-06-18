<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# CAD-to-USD Conversion Advisor

> CAD conversion is a pre-USD concern; `omniverse-usd-performance-tuning` cites this reference when the user reports `problem_type = conversion quality`.

---

Use this reference for CAD import, tessellation, conversion specs, or conversion-quality problems.

## Purpose

Guide CAD-to-USD conversion diagnosis before optimization. Capture the source format, converter/runtime, conversion spec, tessellation behavior, and post-conversion validation handoff.

## Prerequisites

- A CAD source format or converted USD path.
- Converter name, version, and runtime when available.
- The supplied conversion spec, generated GUI config, or a note that no spec is available.

## Examples

- "Advise conversion settings for a STEP file with faceted curved surfaces."
- "Review this converter spec before I optimize the exported USD."

## Checklist

- Identify source format.
- Capture converter version and runtime.
- Capture the exact conversion spec or generated GUI config.
- Identify whether geometry is being tessellated by the converter or read as already-tessellated source data.
- Validate the converted USD before optimization (route through `usd-validation-runner`).
- Route post-conversion performance issues through composition audit (now part of `usd-structure-assessment`) and validation.

## Known caveats

- Converter spec files may vary by converter backend.
- GUI controls can map to generated JSON config rather than a directly supplied spec.
- Some formats may contain already-tessellated mesh data, so a tessellation LOD knob may not improve faceting.
- Surface tolerance and tessellation controls can be backend-specific.

## Limitations

- Does not execute conversion or Scene Optimizer operations.
- Cannot guarantee a tessellation knob exists for every source format or backend.
- Post-conversion performance issues still need composition audit and validation.

## Troubleshooting

- If tessellation settings have no visible effect, check whether the source is already tessellated mesh data.
- If GUI and CLI settings disagree, capture the generated JSON/config file and map it back to converter controls.
- If the converted stage performs poorly, route through composition audit (`usd-structure-assessment`) and validation (`usd-validation-runner`) before optimization.

## Output

Capture conversion inputs and conclusions in the optimization plan under `inputs.converter`.
