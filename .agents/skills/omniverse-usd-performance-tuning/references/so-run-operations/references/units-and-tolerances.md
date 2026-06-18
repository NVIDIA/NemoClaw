<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Units and Tolerances

Shared reference for any operation that converts user-specified mm tolerances
to Scene Optimizer stage-unit parameters. Referenced by `operation-safety.md`
and consumed by any `parameter_prerequisites` block with a `conversion` field.

## Source of Truth

The `asset_physical_context` section of the SA report provides:

| Field | Meaning |
|-------|---------|
| `metersPerUnit` | Stage scale factor (1.0 = meters, 0.01 = cm, 0.001 = mm) |
| `upAxis` | Stage orientation (X, Y, or Z) |
| `scale_hint` | Human label: "meters", "centimeters", "millimeters", "other" |

## Conversion Formula

```
tolerance_stage_units = mm_tolerance / (metersPerUnit × 1000)
```

### Worked Examples

| User says | metersPerUnit | Stage units | Result |
|-----------|---------------|-------------|--------|
| "0.5 mm" | 0.01 (cm) | centimeters | 0.5 / (0.01 × 1000) = **0.05** |
| "1.0 mm" | 1.0 (m) | meters | 1.0 / (1.0 × 1000) = **0.001** |
| "2.0 mm" | 0.001 (mm) | millimeters | 2.0 / (0.001 × 1000) = **2.0** |
| "0.1 mm" | 0.01 (cm) | centimeters | 0.1 / (0.01 × 1000) = **0.01** |

## Elicitation Template

When asking the user for a physical tolerance, follow this structure:
1. **State the asset's physical scale:**
   > "This stage uses {scale_hint} (metersPerUnit = {metersPerUnit})."

2. **Ask the canonical question** from the operation's `parameter_prerequisites`:
   > "{canonical_question}"

3. **Offer defaults** from the prerequisites block:
   > Present the `defaults` array from the operation's `parameter_prerequisites`.
   > The user picks one or provides their own value.

4. **Offer the skip option.**

## Parameter Glossary

| SO Parameter | Unit | Range | Meaning |
|-------------|------|-------|---------|
| `maxMeanError` | stage units | 0.0 = disabled | QEM error budget per vertex. Primary quality knob. |
| `reductionFactor` | integer 0–100 | 100 = keep all | Percentage of triangles to **KEEP**, not remove. Secondary stop condition. |
| `maxTriangles` | integer | 0 = disabled | Absolute triangle cap per mesh. |
| `pinBoundaries` | boolean | — | Preserve mesh boundary edges. Always `true` for sub-mesh decimation. |

**Critical:** `reductionFactor` is "keep percent", NOT "reduce percent".
`reductionFactor: 90` means keep 90% of triangles (remove 10%).

## Anti-Patterns

1. **Do NOT ask "reduce by 10%?"** — that's rate-framing.
   The canonical question is fidelity-budget: "what detail to preserve?"
   See `operation-safety.md § Anti-pattern: rate-framing`.

2. **Do NOT use integer `0` for disabled float conditions** — use `0.0`.
   JSON `"maxMeanError": 0` is ambiguous; `"maxMeanError": 0.0` is explicit.

3. **Do NOT omit `pinBoundaries: true`** when decimating sub-meshes or
   meshes that share boundary edges with neighbors.

4. **Do NOT invent percentage options** without the user first providing a
   rate-based constraint. If the user hasn't said "I want N triangles" or
   "keep X%", the tolerance question is the correct entry point.

5. **Do NOT skip the conversion step.** A user saying "1mm tolerance" on a
   centimeter stage means `maxMeanError: 0.1`, not `maxMeanError: 1.0`.

## Operations That Use This Reference

Any operation with tolerance knobs benefits from this formula:

- `decimateMeshes` — `maxMeanError` (primary)
- `deduplicateGeometry` — `tolerance` (coincidence threshold)
- `findCoincidingGeometry` — `tolerance`
- `mergeVertices` — `tolerance`
- `removeSmallGeometry` — `threshold` (min extent in stage units)
- `findSmallGeometry` — `threshold`

Each operation's `parameter_prerequisites` frontmatter specifies which fields
it needs and what conversion applies. This file owns the shared formula;
individual ops own their specific parameter semantics.
