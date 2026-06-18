# Good-Image Generation (PCBA, usd2roi + Image-Edit)


## Table of Contents

- [When to use](#when-to-use)
- [Pipeline](#pipeline)
- [Inputs](#inputs)
- [Submit](#submit)
- [Output layout](#output-layout)
- [Pairing with structural-defect runs](#pairing-with-structural-defect-runs)
- [Troubleshooting](#troubleshooting)

Procedural clean-PCBA image generation that mirrors the first two groups of
`texture_defect_generation_day0.yaml` (`usd2roi-render` → `augment-image-edit`)
with no defect injection and no AnomalyGen step. **No `sdg_pipeline.py` direct
invocation, no `crop_components.py` post-step** — the workflow renders the
scan_grid (with mesh-level semantics inlined into the cookbook) and then walks
those triggers via `usd2roi_crop.py` to emit the canonical multi-cell ROI tree
that the texture-defect lane already consumes.

## When to use

- Building a clean-image training set (ChangeNet golden halves, AnomalyGen
  finetune positives, downstream real-photo pairing).
- Generating per-cell ROI pairs (`normal_img` + `cad_mask`) for any skill that
  consumes the canonical usd2roi tree but does not need defects.
- Demoing the usd2roi → image-edit half of the texture pipeline without
  spinning up finetune/inference resources.

For pose-defect data (shift / tombstone / sideflip), use
`structural_defect_generation.yaml`. For texture defects (solder bridge /
scratch / discoloration / missing component) and the full anomalygen
training/inference loop, use `texture_defect_generation_day0.yaml`.

## Pipeline

```
usd2roi-render — single task (usd2roi_image — paidf-simulation):
  Stage 1: Kit + sdg_pipeline.py  (scan_grid render, mesh-level semantics)
    → trigger_0000/{rgb_x*_y*.png, semantic_segmentation_*.png,
                    bounding_box_2d_tight_*.npy, ...}
  Stage 2: python3 + usd2roi_crop.py  (semantic-mask-driven multi-cell crop)
    → crop/<MATERIAL>/<x*_y*>/{normal_img,cad_mask}/<NNNN>.png
   ▼
augment-image-edit (augmentation_image — paidf-augmentation, Qwen OVSL2SL)
  reads  usd2roi-components/crop/<MAT>/<cell>/normal_img/<NNNN>.png
  writes augment/crop/<MAT>/<cell>/<NNNN>.<ext>            (SL-restyled RGB)
```

Two task groups — both run on the existing OSMO pod template that the
texture-defect day-0 lane uses; no new prerequisites.

## Inputs

| Input | Source | Required by |
|---|---|---|
| USD asset tree (board scene + components) | `<dig_url_root>/datasets/pcb/assets` (publish via `setup/setup_pcb.yaml`) | `usd2roi-render` |
| Per-board `pcba_target.yaml` | `assets/cookbooks/pcb/<board>/pcba_target.yaml` (mounted via `localpath`) | `usd2roi-render` |
| Per-board `day0_image.yaml` (scan_grid render config + `semantics:` block) | `assets/cookbooks/pcb/<board>/day0_image.yaml` | `usd2roi-render` |
| Per-board `day0_crop.yaml` (multi-cell ROI crop config) | `assets/cookbooks/pcb/<board>/day0_crop.yaml` | `usd2roi-render` |
| Image-edit cookbook (Qwen OVSL2SL prompt + parameters) | `assets/cookbooks/pcb/augmentation_config_ovsl2sl.yaml` | `augment-image-edit` |
| Image-edit endpoint | `image_edit_endpoint` workflow param (default points at the in-cluster service from `references/nim/`) | `augment-image-edit` |

`usd2roi-render` patches `scene:` in `pcba_target.yaml` at task start to point at
the dataset-mounted USD (located by `scene_filename` basename). Both
`day0_image.yaml` and `day0_crop.yaml` carry sentinel placeholders
(`__OUTPUT__`, `__MAX_IMAGE_COUNT__`) that the runner sed-patches before Kit
launches; the resolved YAMLs are persisted alongside the run output for
reproducibility.

## Submit

Generate a fresh run stamp (see SKILL.md §"Name stamping"):

```bash
STAMP=$(cat /proc/sys/kernel/random/uuid | cut -c1-8)
osmo workflow submit skills/physical-ai-defect-image-generation/assets/configs/good_image_generation.yaml \
  --pool <pool> \
  --set name=good_image_gen-$STAMP \
        dig_url_root=<dig_url_root> \
        board=0603_H100 \
        image_edit_endpoint=http://qwen-image-edit-nvpcb-ovsl2sl.osmo-nims.svc.cluster.local:8000/v1 \
        image_edit_model=nvidia/Qwen-Image-Edit-NVPCB-OVSL2SL
```

Useful smoke-test knobs:

- `crop_max_emit=N` — cap the per-cell crop output at the usd2roi-render stage
  (single point of dataset-size control; everything downstream consumes whatever
  this stage emits). Blank = use cookbook default.
- `render_patches=N` — cap the upstream scan_grid render at N patches. Useful
  with `crop_max_emit=1` for fast smoke tests (~N final images).
- `scene_filename=...` — change which USD inside the dataset bundle is used
  as the scene (default `spark_lighting.usd`).

Per-board cookbook directories under `assets/cookbooks/pcb/`:

- `0603_H100/` — demo board, 0603 capacitor passive component
- `1152819000/` — alternate demo board

Each contains `pcba_target.yaml`, `day0_image.yaml`, `day0_crop.yaml`,
`usd2roi_nvpcb.yaml`. Pass `--set board=<dir-name>` to switch which per-board
cookbook the workflow mounts; the workflow YAML resolves
`../cookbooks/pcb/{{ board }}/...` for each file at submit time.

## Output layout

```
<dig_url_root>/runs/<name>/
├─ usd2roi-components/
│  ├─ trigger_0000/
│  │  ├─ rgb_x0_y0.png … rgb_x9_y9.png        # raw scan_grid renders, named by grid cell
│  │  ├─ semantic_segmentation_*.png
│  │  ├─ bounding_box_2d_tight_*.npy + labels
│  │  └─ metadata.json
│  ├─ crop/
│  │  └─ <MATERIAL>/                          # e.g. "passive_component"
│  │     └─ <x*_y*>/                          # one dir per scan cell that matched
│  │        ├─ normal_img/<NNNN>.png          # clean per-component RGB ROI
│  │        └─ cad_mask/<NNNN>_cad_mask.png   # paired CAD-derived component mask
│  ├─ semantic_segmentation_labels.json
│  ├─ pcba_target.yaml                        # patched copy (scene resolved)
│  ├─ day0_image.yaml                         # patched copy (sentinels resolved)
│  └─ day0_crop.yaml                          # patched copy (sentinels resolved)
└─ augment/
   └─ crop/
      └─ <MATERIAL>/
         └─ <x*_y*>/
            └─ <NNNN>.<jpg|png>               # Qwen OVSL2SL-restyled RGB
```

The `usd2roi-components/` tree is identical in shape to what
`texture_defect_generation_day0.yaml` produces, so any downstream skill that
consumes that layout (e.g. real-photo pairing, ChangeNet pair construction)
also works on good-image runs.

The `augment/crop/<MAT>/<cell>/<NNNN>.<ext>` files are the training units —
clean components in the destination lighting style. Pair them with
`usd2roi-components/crop/<MAT>/<cell>/normal_img/<NNNN>.png` for ChangeNet
golden halves, or with `cad_mask/<NNNN>_cad_mask.png` for mask-conditioned
training.

## Pairing with structural-defect runs

To build ChangeNet golden / defect pairs, submit `good_image_generation.yaml`
and `structural_defect_generation.yaml` with the **same `name`** so their
outputs land under the same run prefix. Note: their output trees are
**different** (`usd2roi-components/crop/<MAT>/<cell>/normal_img/` vs
`structural_defect/cropped/<mode>/rgb/`) — pair on filename stems and material
class, not on directory structure.

## Troubleshooting

See `references/troubleshooting.md` for the shared `usd2roi-render` issues —
sentinel resolution, Kit shutdown SIGABRT (image-specific), `usd2roi_crop.py`
emitting 0 ROIs (semantics misalignment), and image-edit endpoint failures.
