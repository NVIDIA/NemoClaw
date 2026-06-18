# USD Edit Target Planner

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

## When to Use

Use when choosing where USD optimization edits are authored; do not use for processor execution.

## Instructions

1. Confirm the target asset, artifact, or user intent and check the prerequisites listed below.
2. Read only the referenced files needed for the current phase, failure mode, or output contract.
3. Follow the workflow, rules, and safety gates in this reference before invoking downstream references or shell commands.
4. Return the result using the Output Format section and name any blocked prerequisite or unresolved user decision.

## Output Format

Return a concise status or report that names the input, selected runtime or evidence source, actions planned or performed, artifacts written, blockers, and the next validation or user-decision step. When a schema or template is referenced below, conform to that contract.

## Purpose

Use this reference after composition audit and before running processors to choose
whether changes belong in source assets, generated outputs, payload targets, or
override layers. Do not use it to run validators/processors or to decide which
defects exist.

## Prerequisites

- Composition audit or structure assessment with layer stack, references,
  payloads, variants, and source asset paths.
- User goal for diagnosis vs. publishable output, including whether source
  asset edits are in scope.
- Writable output directory for generated artifacts and rollback copies.

## Limitations

- Produces an authoring plan; it does not validate or mutate USD.
- Source edits require asset ownership and post-change validation.
- Variant-dependent content may require separate plan entries per variant.

## Troubleshooting

- If a root-layer edit would duplicate referenced data, switch to per-asset
  optimization plus reference remapping.
- If `.usdc` output grows after edits, follow
  `references/output-saving.md` and export to a new file instead of saving in
  place.
- If ownership or rollback path is unclear, choose generated output or override
  layer and record the uncertainty.

## Decision guide

Prefer per-asset optimization with reference remapping when:

- The composition audit shows geometry in referenced or payloaded asset layers.
- The scene is an assembly that composes many individual assets.
- Modifying the root stage would author overs that duplicate referenced data.

In this case:

1. Use the referenced asset manifest from the composition audit.
2. Open each asset layer as its own stage.
3. Run validators and operations on each asset independently.
4. Write each optimized asset to a new output path (do not overwrite originals).
5. Create a copy of the root/assembly layer with references remapped to the optimized output paths.

Prefer a generated processor output when:

- The operation is destructive.
- The target content comes from references or payloads.
- The user needs before/after comparison.
- The operation may need tuning.

Prefer a new override layer when:

- The fix is an opinion-level change such as activation, load control, visibility, variant selection, or metadata.
- The source asset should remain unchanged.

Prefer source asset edits only when:

- The user explicitly wants source-pipeline repair.
- The source repo or asset owner is in scope.
- Validation can run on the changed source asset.

Treat each variant separately when:

- Geometry, materials, or payload targets differ by variant.
- The processor result depends on the selected variant.

## Variant and payload gates

Apply these gates before invoking processors. If any gate fails, **stop** and either remediate or ask the user to override.

- **Loaded payloads required** when the processor changes meshes, materials, normals, extents, hidden geometry, decimation, mesh merge, or dedupe. Unloaded payloads are incomplete evidence; do not mark them as safe to optimize.
- **Single-variant publish stop** when output is meant to be published as a reusable asset and variants affect geometry/materials. A single selected variant is enough only for diagnosis of the current composed scene; publishable output requires per-variant validation and processor outputs.
- **Mask coverage check** - if a population mask excludes prims the processor would need, stop and rerun audit with an appropriate mask.
- **Draw-mode preservation** - if draw-mode metadata stands in for heavy geometry (cards, bounds, origin), preserve the model hierarchy unless the user explicitly asks to replace it.
- **Output folder policy per variant** - prefer separate output directories when variants or payload targets diverge; record all selected variants, payload load decisions, and excluded content in the optimization plan.

For deeper trade-off framing (when to use unloaded vs loaded payload audit, the variant strategy decision tree, the output policy template), read `references/variants-payloads.md`.

## Output saving policy

Before writing optimized layers, read `references/output-saving.md`. It is the
canonical policy for `Save()` vs layer `Export()` vs stage `Export()`, `.usdc`
file-size bloat after destructive edits, and when a flattened deliverable is
actually intended.

## Required plan fields

- Selected edit target.
- Reasoning.
- Mutation policy.
- Output directory.
- Rollback path.
- Modified layer manifest.
- Pre-validation gate.
- Post-validation gate.

## Output

Emit or update an optimization plan matching `../../scripts/optimization-plan.schema.json`.

## References

Before choosing an edit strategy, read:

- `skills/omniverse-usd-performance-tuning/references/usd-structure-assessment/references/optimization-tradeoffs.md` — the three-phase pipeline (extraction → structuring → optimization), packaging strategies, and why authoring structure is not deployment structure.
- `skills/omniverse-usd-performance-tuning/references/usd-structure-assessment/references/asset-structure-principles.md` — asset interface/payload layering and where opinions should be authored.
- `skills/omniverse-usd-performance-tuning/references/usd-structure-assessment/references/usd-edit-target-planner/references/output-saving.md` — output path, file-format, and Save-vs-Export policy for optimized layers.

If you have network access, prefer the live URLs (noted in each reference file) for the most current version.
