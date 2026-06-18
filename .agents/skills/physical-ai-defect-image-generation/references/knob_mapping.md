# User intent → knob mapping

How to translate quantity / scope phrases in user requests into the right
`--set` knob on the right OV stage. SKILL.md §"User intent → knob mapping"
holds the headline rule; this file is the full breakdown the agent loads
when a user asks for a specific count or coverage scope.

**Every OV flow is two-stage**: `sdg_pipeline.py` renders raw patches/frames
→ `usd2roi_crop.py` (or `crop_components.py`) extracts per-component crops
from each. The final dataset size is the *downstream* product of those two
stages, NOT the upstream render count.

**DO NOT auto-map "generate N images" → `render_patches=N`.** That caps
stage 1 (raw patches before cropping), not the final dataset.

## Knob table

| User intent | Knob | Stage | Note |
|---|---|---|---|
| "generate N images", "produce N samples", "I want N final crops" | `crop_max_emit=N` | crop (stage 2) | Per material per cell. Final dataset size on disk. |
| "render N patches", "cover N scan-grid cells", "raw render count" | `render_patches=N` | render (stage 1) | Upstream raw patches; each yields multiple component crops. |
| "smoke test", "quick test", "few images" | `render_patches=5 crop_max_emit=1` | both | Fastest path; ~5 final images. |
| "full board coverage" | `render_patches=-1` (default) + `crop_max_emit=""` (use cookbook) | both | Cover all scan-grid cells with cookbook's per-cell cap (10 for `0603_H100`; `1152819000` ships `max_emit: null` — uncapped). |

## `crop_max_emit` semantics

`crop_max_emit` is a workflow-level `--set` knob in `good_image_generation.yaml`
and `texture_defect_generation_day0.yaml`. It patches `crop.max_emit` in the
cookbook's `day0_crop.yaml` at task start. Set to `""` (blank) or omit to
use the cookbook value; set to `null` to remove the cap entirely; set to a
positive integer to cap per (material, cell).

## Flows where `crop_max_emit` doesn't apply

- **`structural_defect_generation.yaml`** — the equivalent stage-2 cap
  doesn't exist (`crop_components.py` emits one crop per component, by
  design). Use `render_patches=N` to limit defect frames; the per-frame
  component count is determined by `pcba_root` + `component_types`. See
  also SKILL.md §"Structural-defect sizing" for the non-linear yield rule.
- **`texture_defect_generation_day1_real_alignment.yaml`** — the
  usd2roi-day1 stage emits a flat `crop/<MAT>/normal_img/*.png` per ROI
  without a `max_emit` cap; use the per-board cookbook's `crop.classes`
  whitelist to narrow scope.
