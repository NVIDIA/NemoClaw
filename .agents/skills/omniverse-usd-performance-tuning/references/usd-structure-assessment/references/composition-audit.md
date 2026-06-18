<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# USD Composition Audit

> Composition audit is performed as part of `usd-structure-assessment` SA Stage 1; this reference holds the deeper checklist, findings taxonomy, and output schema mapping.

---

## Purpose

Audit the composed stage and authored layers before any processor changes USD content, so downstream optimization can choose safe edit targets and understand composition risks.

This is invoked as a section of `usd-structure-assessment` SA Stage 1 (composition inventory, asset inventory) and consulted from `usd-edit-target-planner` and `apply-restructure` when deeper composition detail is needed.

## Schema reconciliation

This reference is the canonical guidance for composition auditing. It produces findings consumed by:

- The umbrella `usd-structure-assessment` JSON shape (the agent's day-to-day output) - composition findings appear under that report's `composition`, `assets`, and `layer_health` sections (see `usd-structure-assessment/README.md` Output section).
- The standalone `../scripts/audit-report.schema.json` shape, which is preserved for tools and pipelines that consume composition-only audit output without the full SA umbrella. Treat `audit-report.schema.json` as a sub-shape: the SA report is a superset that includes (and may inline) the audit-report fields.

When in doubt, write the SA umbrella shape - the audit-report subset is recoverable from it.

## Prerequisites

- A USD asset path and the intended processor or optimization scope.
- Read the reference files listed under "References" before making composition claims.
- Inspect the stage read-only; do not flatten or author changes during the audit.

## Limitations

- This guidance reports composition risk and edit targets; it does not mutate stages or choose operation parameters.
- Selected variants and current load state do not prove uncovered variants or unloaded payloads are safe.
- Referenced asset manifests are evidence for planning, not proof that a downstream optimizer can edit every asset in place.

## Troubleshooting

- Treat unresolved asset paths, unloaded payloads, and ambiguous generated layers as blockers or open questions in the report.
- If no safe edit target is obvious, hand off to `usd-edit-target-planner` instead of guessing.
- For data-heavy `.usda` or runtime `.usdz` inputs, call out the packaging risk before Scene Optimizer handoff.

## Examples

- "Audit this factory USD before optimizer handoff and list safe edit targets."
- "Find references, payloads, variants, and unresolved paths in this asset."

## Audit checklist

- Root layer identifier and real path.
- Session layer presence.
- Default prim.
- Used layers and layer count.
- Sublayer stack.
- References - enumerate the unique referenced asset layer paths.
- Payloads and load state.
- Variant sets and selected variants.
- Instanceable prims and prototype usage.
- Population mask or load rules when available.
- Unresolved asset paths.
- Data-heavy `.usda` files.
- Runtime `.usdz` usage.
- Existing generated or override layers.

## Findings to produce

- Composition risks.
- Processor blockers.
- Candidate edit targets.
- Payloads or variants requiring separate coverage.
- Evidence needed before Scene Optimizer handoff.
- **Referenced asset manifest** - a list of unique asset layer paths that contain geometry or material data via references or payloads. Downstream skills (`usd-edit-target-planner`, `apply-restructure`, Scene Optimizer handoff) need this list to plan per-asset optimization.

## Output

Emit composition findings into the `usd-structure-assessment` umbrella report (preferred), or into a standalone object matching `../scripts/audit-report.schema.json` when an external consumer needs the composition slice in isolation.

## Rules

- The composed stage is not the same as the authored source layer.
- Do not flatten by default.
- Do not assume selected variants cover all variants.
- Do not assume unloaded payloads are irrelevant.
- Do not mark `instanceable=true` on copied local hierarchies and expect dedupe benefits; repeated assets must be referenced or payloaded to share scenegraph data.

## References

Before auditing, read these to understand asset structure and the distinction between assets, layers, and composition arcs:

- `skills/omniverse-usd-performance-tuning/references/usd-structure-assessment/references/asset-structure-principles.md` - what an asset is, interface/payload/geometry layers, the reference-payload pattern.
- `skills/omniverse-usd-performance-tuning/references/usd-structure-assessment/references/factory-level-structuring.md` - how assets compose into assemblies, asset boundary identification.

If you have network access, prefer the live URLs (noted in each reference file) for the most current version.
