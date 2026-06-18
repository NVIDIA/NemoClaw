<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# USD Variants and Payloads - Strategy and Trade-offs

> The day-to-day stop-gates (require loaded payloads, single-variant publish stop, mask coverage check, draw-mode preservation, output folder policy per variant) have been folded into `usd-edit-target-planner` as a "Variant and payload gates" subsection. This reference holds the deeper trade-off framing, payload/variant strategy bullets, output policy detail, and stop-conditions that the planner cites.

---

## Purpose

Use this reference after composition audit when payloads, variant sets, population masks, unloaded content, or draw-mode/model-hierarchy behavior affects processor decisions. Do not use it to execute processors or validate mesh data.

## Prerequisites

- Composition audit listing payloads, load state, population masks, and variant selections.
- Processor or validation goal that may require geometry, material, or topology evidence.
- Edit-target planning context for where variant and payload opinions can be authored.

## Limitations

- Unloaded payload audits are incomplete evidence for geometry-changing work.
- A single selected variant is insufficient for publishable reusable assets when variants affect geometry or materials.
- This reference plans coverage and outputs; it does not confirm defects or apply changes.

## Troubleshooting

- If required prims are masked out, stop and rerun audit with an appropriate population mask.
- If variants diverge, create separate validation and output entries for each relevant variant.
- If draw-mode metadata stands in for heavy geometry, preserve the model hierarchy unless the user explicitly asks to replace it.

## Decisions this reference informs

- Whether payloads must be loaded before a processor runs.
- Whether the current variant selection is sufficient evidence.
- Whether each variant needs a separate output.
- Whether an optimization should target the lightweight interface layer, the payload target, or an override layer.
- Whether population masks or load rules made the audit incomplete.
- Whether draw-mode or model hierarchy metadata should be preserved rather than replaced by heavy geometry.

These decisions are owned in practice by `usd-edit-target-planner` (which now includes the corresponding stop-gates inline). This reference holds the deeper rationale.

## Payload strategy

Use unloaded payload audit when:

- The task is load-time diagnosis.
- The goal is to inspect structure, layer count, asset paths, model hierarchy, or missing metadata.
- The processor does not need geometry data.

Require loaded payload audit when:

- The processor changes meshes, materials, normals, extents, hidden geometry, decimation, mesh merge, or dedupe.
- Validation findings mention prims inside payload content.
- Before/after metrics depend on triangle count, vertex count, material bindings, or mesh topology.

Do not mark unloaded payloads as safe to optimize. Mark them as incomplete evidence unless the plan explicitly excludes payload content.

## Variant strategy

Audit selected variants first, then decide coverage:

- Single selected variant is enough for diagnosis only when the user asks about the current composed scene.
- All relevant variants need coverage when output is meant to be published as a reusable asset.
- Variant-dependent geometry or materials require per-variant validation and processor output.
- Variant selection opinions should usually be authored in an override layer, not by mutating asset source layers.

## Output policy

Prefer separate outputs when variants or payload targets diverge:

```text
outputs/
  asset_lod_high/
  asset_lod_low/
  payload_loaded/
  payload_unloaded_audit/
```

Record all selected variants, payload load decisions, and excluded content in the optimization plan.

## Stop conditions

Stop before processor execution if:

- Required payloads are unloaded.
- A population mask excludes prims the processor would need.
- Variant-dependent content is being published from only one selected variant.
- The edit target planner has not chosen where variant or payload edits will be authored.
