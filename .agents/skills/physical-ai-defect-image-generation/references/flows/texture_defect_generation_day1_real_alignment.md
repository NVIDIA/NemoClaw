# Day 1 — Inference and Labeling (real-photo alignment)


## Table of Contents

- [URL Contract](#url-contract)
- [Pipeline](#pipeline)
- [Submit](#submit)
- [Custom boards](#custom-boards)
- [Spatial dependency](#spatial-dependency)
- [Output](#output)
- [Troubleshooting](#troubleshooting)

**This is the default Day 1 path for PCBA.** Always runs the `usd2roi-render-day1`
group: a CAD-derived USD is Kit-rendered, MI-registered against a real PCBA photo,
and cropped per-ROI. AnomalyGen inference runs on the aligned ROI crops.

For metal/glass Day 1 (no USD flow exists) or PCBA experimentation when the
user explicitly asks to skip alignment, use
`texture_defect_generation_day1_manual_roi.md` instead.

## URL Contract

Set `dig_url_root` once; default is `s3://osmo-workflows/dig`.

| Purpose | URL |
|---|---|
| PCBA USD assets + per-board real photos | `<dig_url_root>/datasets/pcb/assets` |
| Submask templates | `<dig_url_root>/datasets/<usecase>/raw` |
| Shipped checkpoint | `<dig_url_root>/models/<usecase>` |
| Pretrained model tree | `<dig_url_root>/models/pretrained` |
| usd2roi day-1 intermediate output | `<dig_url_root>/runs/<name>/usd2roi-day1` |
| finetune output, optional | `<dig_url_root>/runs/<name>/finetune` |
| final labeled output | `<dig_url_root>/runs/<name>/anomaly` |

Preflight:

```bash
DIG_URL_ROOT=s3://osmo-workflows/dig bash scripts/preflight_urls.sh 1 pcb real-alignment
```

The canonical `pcb-assets` artifact ships per-board real photos at
`input_real_image/<board>.jpg` (e.g. `0603_H100.jpg`, `115_2819_000.jpg`).
Pick the board with `--set board=<dir-name>` — the matching cookbook lives at
`assets/cookbooks/pcb/<board>/usd2roi_nvpcb.yaml`.

## Pipeline

```
usd2roi-render-day1  ──► usd2roi-day1 (GPU-render) ← datasets/pcb/assets (USD tree + input_real_image/<board>.jpg)
                                                   ↳ Stage 1: Kit ortho-render the CAD USD
                                                   ↳ Stage 2: cupy MI registration → align synth to real photo
                                                   ↳ Stage 3: per-ROI bbox crop → crop/<MAT>/{normal_img,cad_mask}/
                                                     → runs/<name>/usd2roi-day1
                                  ▼
finetune-job (optional, omitted when use_pretrained_checkpoint=true)
                                  ▼
anomaly-infer        ──► infer-all-defects (GPU)   ← usd2roi-day1 output + datasets/<usecase>/raw + models/pretrained + checkpoint
                                                   ↳ stage aligned ROIs as clean_image + cad_mask
                                                   ↳ overlay per-defect submask templates
                                                   ↳ prep_testcase.sh → validate_jsonl.py → run_sdg.sh → verify_output.sh
                                                     → runs/<name>/anomaly
```

## Submit

Generate a fresh run stamp (see SKILL.md §"Name stamping"):

```bash
STAMP=$(cat /proc/sys/kernel/random/uuid | cut -c1-8)
NAME=texture_defect_gen_day1_real_alignment-$STAMP
```

Default (passthrough against the shipped PCBA checkpoint, board 0603_H100):

```bash
osmo workflow submit assets/configs/texture_defect_generation_day1_real_alignment.yaml \
  --pool <pool> \
  --set name=$NAME \
        usecase=pcb \
        'anomaly_types_json=[["passive_component","excess_solder"],["passive_component","missing"]]'
```

Alternate board (1152819000):

```bash
osmo workflow submit assets/configs/texture_defect_generation_day1_real_alignment.yaml \
  --pool <pool> \
  --set name=$NAME \
        board=1152819000 \
        real_image_filename=input_real_image/115_2819_000.jpg \
        usecase=pcb \
        'anomaly_types_json=[["IC","bridge"]]'
```

The two `--set` knobs go together — when `board` changes, the matching
`input_real_image/<board>.jpg` must exist in `<dig_url_root>/datasets/pcb/assets`.

## Custom boards

To add a new board:

1. Add `assets/cookbooks/pcb/<board>/usd2roi_nvpcb.yaml` (mirror `0603_H100/`
   or `1152819000/` — set `semantics:` to your component's mesh paths and
   adjust `registration.sx_range`/`sy_range`/`rot_range_deg` / `camera.translate`).
2. Upload the real AOI photo to
   `<dig_url_root>/datasets/pcb/assets/input_real_image/<board>.jpg`.
3. Submit with `--set board=<board> real_image_filename=input_real_image/<board>.jpg`.

## Spatial dependency

`default_spatial_dependency` defaults to `cad`. The usd2roi image emits a single
global `semantic_segmentation_labels.json` at `crop/` root that CADParser
consumes natively, so this lane runs in `cad` mode without extra setup.

Fall back to `default_spatial_dependency=free` only if:
- labels JSON is missing under `crop/`,
- MI alignment moved the cad_mask off the component, or
- the scene's cad_mask was rendered without `colorize_semantic_segmentation`.

For non-spark scenes, edit `assets/cookbooks/pcb/usd2roi_day1.yaml` (the
fallback config) in place — semantics, camera, and registration ranges.

## Output

> See [Output Retrieval](../output_retrieval.md).

The intermediate `runs/<name>/usd2roi-day1/` directory (unique to this flow) contains:
- `crop/<MAT>/{normal_img,cad_mask}/<NNNN>.png` — per-ROI aligned crops + masks
- `aligned/params.json` — MI registration parameters (rotation, scale, shift)
- `usd2roi_day1.yaml` — resolved cookbook (with `__SCENE__`/`__REAL_IMAGE__`/`__OUTPUT__` substituted)

## Troubleshooting

- **`usd2roi_register.py exited 2`** — MI score below `min_mi` (default 0.5). Widen `registration.sx_range`/`sy_range`/`rot_range_deg`, lower `min_mi`, or re-check `camera.translate` + `horizontal_aperture` against the real photo. See troubleshooting.md "usd2roi day-1 MI alignment" entry.
- **`ERROR: real_image_filename=... not found`** — the photo at the configured path isn't in `datasets/pcb/assets`. Verify with `osmo data list --no-pager <dig_url_root>/datasets/pcb/assets/input_real_image/`.
- **`ERROR: scene_filename=... not found`** — `spark_lighting.usd` is the default; canonical `pcb-assets` ships it. If you've replaced the assets bundle, pass `--set scene_filename=<your.usd>`.
- **`0 ROI crops emitted`** — registration succeeded but no semantic regions matched the cookbook's `crop.classes` whitelist. Confirm the `semantics:` block in `<board>/usd2roi_nvpcb.yaml` matches mesh paths in your USD.
- **Mode A/B-style inputs (no real photo)** — wrong workflow; use `texture_defect_generation_day1_manual_roi.yaml`.
