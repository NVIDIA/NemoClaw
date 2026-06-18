# Structural-Defect Generation (PCBA)


## Table of Contents

- [Defect modes](#defect-modes)
- [When to use](#when-to-use)
- [Pipeline](#pipeline)
- [Submit](#submit)
- [Parameters](#parameters)
  - [How `defect_modes` patches the cookbook](#how-defect_modes-patches-the-cookbook)
  - [Sizing the output](#sizing-the-output)
  - [Eligible component pool](#eligible-component-pool)
- [Outputs](#outputs)
- [Pairing with the good-image lane (ChangeNet)](#pairing-with-the-good-image-lane-changenet)
- [Troubleshooting](#troubleshooting)

Procedural pose-defect generation via IsaacSim's `sdg_pipeline.py` with
`pipeline_type: defect`. Defects are simulated geometrically — components are
shifted, tilted, or flipped — not prompted into the image via diffusion.
Per-component crops via `crop_components.py`.

## Defect modes

| Mode | Geometric op | Cookbook default |
|---|---|---|
| `shift` | XY translation (±0.2 mm) + Z rotation (±15°) | `enabled: true`, `ratio: 0.2` |
| `tombstone` | Y-axis tilt 70–90° (one pad edge lifts) | `enabled: true`, `ratio: 0.2` |
| `sideflip` | X-axis flip 70–90° | `enabled: true`, `ratio: 0.2` |

Selection is non-overlapping across modes — each defect type independently
picks its components from the remaining pool.

## When to use

- Building a structural-defect training set (shift / tombstone / sideflip /
  polarity-reversal labeled data).
- Generating ChangeNet pairs by submitting `good_image_generation.yaml` and
  `structural_defect_generation.yaml` against the same `name` and pairing the
  crops post hoc.

**NOT for missing-component frames** — anomalygen's AMP/SDG pass on
`texture_defect_generation_day0.yaml` synthesizes missing components by occluding
clean ROIs with mask templates. Submitting "missing-component" intent here will
not produce them.

**NOT for texture defects** (solder bridge, scratch, discoloration). Those
require diffusion-based appearance edits, which the texture lane handles.

## Pipeline

```
isaac-render-defect — one task, one pod (paidf-simulation):
  Stage 1: Kit + sdg_pipeline.py with defect_image.yaml
    → runs/<name>/structural_defect/trigger_NNNN/{rgb_*.png, semantic_segmentation_*.png,
                                                    bounding_box_2d_tight_*.npy + labels}
  Stage 2: python3 + crop_components.py --offset {{ crop_offset }}
    → runs/<name>/structural_defect/cropped/{rgb,semantic_segmentation,component_instance}/<NNNN>.png
   ▼
augment-image-edit (cosmos_augmentation image, Qwen OVSL2SL via image_edit_endpoint)
  → reads structural_defect/cropped/rgb/
  → runs/<name>/structural_defect_edited/rgb/<NNNN>.png — lighting-style-transferred RGBs
```

Identical shape to `good_image_generation.yaml`; the only differences are the
render cookbook (`defect_image.yaml`) and the optional `defect_modes` patching
step that disables non-requested modes at task start. Render and crop share one
pod — raw triggers never round-trip through MinIO between them. OVSL2SL is
appearance-only, so the geometric pose perturbation from the render step is
preserved through the image-edit hop.

## Submit

Default — all three defect modes (shift, tombstone, sideflip) enabled, on the
0603_H100 board, restyled through the local cluster Qwen OVSL2SL endpoint:

```bash
STAMP=$(cat /proc/sys/kernel/random/uuid | cut -c1-8)
osmo workflow submit skills/physical-ai-defect-image-generation/assets/configs/structural_defect_generation.yaml \
  --pool <pool> \
  --set name=structural_defect_gen-$STAMP \
        dig_url_root=<dig_url_root> \
        board=0603_H100 \
        image_edit_endpoint=http://qwen-image-edit-nvpcb-ovsl2sl.osmo-nims.svc.cluster.local:8000/v1 \
        image_edit_model=nvidia/Qwen-Image-Edit-NVPCB-OVSL2SL
```

`image_edit_endpoint` and `image_edit_model` default to the in-cluster service
from `references/nim/`; a bare submit (no override) works against the standard
deployment.

Subset of modes (only tombstone):

```bash
--set defect_modes=tombstone
```

Multiple modes (comma-separated, no spaces):

```bash
--set defect_modes=shift,tombstone
```

Alternate board:

```bash
--set board=1152819000
```

Smoke test:

```bash
--set render_patches=5
```

## Parameters

| Knob | Default | Notes |
|---|---|---|
| `board` | `0603_H100` | Alternates: `1152819000`. The `1152819000` cookbook narrows `component_types` to a single IC, so the default `render_patches=5` yields too few defected frames for a reasonable training set; when submitting with `board=1152819000`, pass `render_patches=-1` (full scan_grid coverage) unless the user explicitly specifies otherwise. |
| `defect_modes` | `all` | Comma-separated subset of `shift,tombstone,sideflip`, or the literal `all` to keep cookbook defaults. Unknown values fail fast in the patching script. |
| `render_patches` | `5` (cookbook default) | `-1` = **full coverage** (render every scan_grid cell defined by the board's cookbook). Floor is `1` (zero produces no crops, fails the task). Yield is **non-linear** — see "Sizing" below. For `board=1152819000` (IC-narrow cookbook), use `-1` to get a reasonable IC yield — the default `5` is too few frames to defect the narrowed component set. |
| `scene_filename` | `spark_lighting.usd` | USD basename. |
| `crop_offset` | `10` | Padding pixels. |
| `dig_url_root` | `s3://osmo-workflows/dig` | |
| `image_edit_endpoint` | `http://qwen-image-edit-nvpcb-ovsl2sl.osmo-nims.svc.cluster.local:8000/v1` | Qwen OVSL2SL endpoint. |
| `image_edit_model` | `nvidia/Qwen-Image-Edit-NVPCB-OVSL2SL` | Model ID at the endpoint. |
| `isaac_render_image` | `nvcr.io/nvidia/paidf-simulation:1.0.0` | |
| `augmentation_image` | `nvcr.io/nvidia/paidf-augmentation:1.0.0` | Same image as the texture-defect lane. |

### How `defect_modes` patches the cookbook

When `defect_modes != "all"`, the render task runs a small Python patch
against `defect_image.yaml` at task start:

```python
ALL_MODES = {"shift", "tombstone", "sideflip"}
for mode in ALL_MODES:
    cfg["defects"][mode]["enabled"] = mode in requested
```

The resolved config (with mode toggles applied) is saved alongside the render
output at `structural_defect/render_config.yaml` for reproducibility.

### Sizing the output

**There is no `crop_max_emit` knob in this flow.** `crop_components.py` emits one crop per defected component; the only throttle is `render_patches` plus the cookbook's `ratio` / `component_types` / `defects.<mode>.enabled` settings. Yield is non-linear in `render_patches` — each enabled defect mode draws independently per frame, so doubling frames adds ~1.6–1.7× crops, not 2×.

Validated yield on `0603_H100` spark (23 component families, `ratio: 0.2`, 3 modes enabled):

| `render_patches` | Approx. total crops |
|---|---|
| 1 | ~30 (≈10/mode) — floor; smoke test |
| 2 | ~50 |
| 3 | ~75 |
| 5 (default) | ~120 |
| 10 | ~250 |

For a target of `N` images: `render_patches ≈ ceil(N / 30)` on the spark board. Sub-30 targets need cookbook tuning (lower `ratio` or narrow `component_types`) — `render_patches=0` is not valid (fails the task).

For a custom board, base rate ≈ `enabled_modes × component_families × ratio` per patch; calibrate by submitting `render_patches=1` and counting `cropped/*/rgb/*.png`, then scale.

To shrink yield without editing the cookbook: pass `defect_modes=tombstone` (or any subset) — each disabled mode cuts ~33% of crops.

### Eligible component pool

All three defect modes draw from the cookbook's top-level `component_types:`
list (substring-matched against prim names under `pcba_root`). Each board ships
its own `defect_image.yaml` under `assets/cookbooks/pcb/<board>/` and is
selected at submit time via `--set board=<id>` (the workflow YAML mounts
`cookbooks/pcb/{{ board }}/defect_image.yaml` into the pod). The shipped
`0603_H100/defect_image.yaml` lists the spark board's full passive pool
(capacitors, resistors, inductors across 0201–2512 footprints); the shipped
`1152819000/defect_image.yaml` narrows to the single IC under test
(`_115_2819_000_1`). To support a new board, create a new
`cookbooks/pcb/<new_board>/defect_image.yaml` (copy an existing one as a
starting point) and submit with `--set board=<new_board>`. `sdg_pipeline.py`
raises `KeyError: 'component_types'` without an explicit list (no `ALL`
sentinel handler upstream).

To add a new defect mode for a custom board, add a `defects.<mode>` block to
the cookbook with its own substring filter under `component_types`, then
extend the workflow YAML's `ALL_MODES` set in
`structural_defect_generation.yaml` to whitelist it.

## Outputs

| Stage | Output URL | Contents |
|---|---|---|
| `isaac-render-defect` | `<dig_url_root>/runs/<name>/structural_defect/` | `trigger_0000/rgb_*.png` + semantic-seg + bbox (full-frame pose-defect renders), plus `cropped/{rgb,semantic_segmentation,component_instance}/<NNNN>.png` (per-component crops), plus resolved `render_config.yaml` (with `defects.*.enabled` reflecting the requested subset) + `pcba_target.yaml` snapshot |
| `augment-image-edit` | `<dig_url_root>/runs/<name>/structural_defect_edited/` | `rgb/<NNNN>.png` — Qwen OVSL2SL-restyled RGBs (pose geometry preserved; lighting transferred) |

## Pairing with the good-image lane (ChangeNet)

Submit `good_image_generation.yaml` and `structural_defect_generation.yaml` with
the same `name` and `board`. The two will write under sibling URLs:

```
<dig_url_root>/runs/<name>/usd2roi-components/crop/<MAT>/<cell>/normal_img/    # good-image (clean halves)
<dig_url_root>/runs/<name>/structural_defect/cropped/                          # structural (defect halves)
```

Note the layouts differ: good-image emits the multi-cell ROI tree
(`crop/<MAT>/<cell>/normal_img/<NNNN>.png`) via `usd2roi_crop.py`, while
structural emits a flat per-component crop set (`cropped/rgb/<NNNN>.png` plus
matching `semantic_segmentation/` and `component_instance/`) via
`crop_components.py`. Pair them downstream by component identity (semantic ID
from the labels JSON), not by directory layout.

(A dedicated `paired` flow that emits both halves in one workflow is on the
backlog; today the pairing is a two-submission convention.)

## Troubleshooting

- **`ERROR: unknown defect_modes: [...]`** → the patching script rejects unknown
  modes. Valid values: `shift`, `tombstone`, `sideflip`, comma-separated, or the
  literal `all`. The cookbook can be hand-extended with new modes, but the
  patcher's `ALL_MODES` whitelist in `structural_defect_generation.yaml` must
  be updated to match.
- **`KeyError: 'component_types'`** → cookbook is missing the top-level
  `component_types:` list. sdg_pipeline.py has no `ALL` sentinel — the list
  must be explicit substrings matching prim names under `pcba_root`. The
  shipped `0603_H100/defect_image.yaml` mirrors the spark board's eligible
  pool; each per-board cookbook under `assets/cookbooks/pcb/<board>/` must
  carry its own list.
- **All defects of one mode, none of others** → check `defects.<mode>.ratio` in
  the cookbook; high `ratio` for one mode can drain the pool before subsequent
  modes draw from it. Cookbook defaults are 0.2 for shift/tombstone/sideflip.
- Other issues mirror `good_image_generation.md` — see that ref for the shared
  render/crop troubleshooting list.

See `references/troubleshooting.md` "IsaacSim render" subsection for the full
upstream issue table.
