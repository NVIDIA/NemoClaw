# Day 1 — Inference and Labeling (manual ROI)


## Table of Contents

- [URL Contract](#url-contract)
- [Modes](#modes)
- [Finetune-mode cookbook render (in-pod, automatic)](#finetune-mode-cookbook-render-in-pod-automatic)
- [Submit](#submit)
- [Output](#output)
- [Troubleshooting](#troubleshooting)

**Not the default for PCBA.** Use this spec only when:
- The usecase is `metal_surface` or `glass` (no USD/real-photo flow exists for those), or
- The user **explicitly** asks to skip CAD-to-real-photo alignment on PCBA —
  e.g. "use the NGC PCBA artifact directly", "manual ROI", "skip usd2roi",
  "experiment without alignment".

For default PCBA Day 1 (CAD-derived USD + real photo, MI alignment, per-ROI
crop), use `texture_defect_generation_day1_real_alignment.yaml` and see
`texture_defect_generation_day1_real_alignment.md` for the walkthrough.

## URL Contract

Set `dig_url_root` once; default is `s3://osmo-workflows/dig`.

| Purpose | URL |
|---|---|
| Shipped checkpoint | `<dig_url_root>/models/<usecase>` |
| Pretrained model tree | `<dig_url_root>/models/pretrained` |
| Raw inference/training data | `<dig_url_root>/datasets/<usecase>/raw` |
| finetune output, optional | `<dig_url_root>/runs/<name>/finetune` |
| final labeled output | `<dig_url_root>/runs/<name>/anomaly` |

Built-in `usecase` values are `pcb`, `metal_surface`, and `glass` — uniform
across `--set usecase=`, URL paths (`datasets/<usecase>/raw`,
`models/<usecase>`), and cookbook directories (`assets/cookbooks/<usecase>/`).
The `metal_surface` value matches the trained model's material name baked
into the checkpoint taxonomy.

Preflight:

```bash
DIG_URL_ROOT=s3://osmo-workflows/dig bash scripts/preflight_urls.sh 1 metal_surface
DIG_URL_ROOT=s3://osmo-workflows/dig bash scripts/preflight_urls.sh 1 glass
DIG_URL_ROOT=s3://osmo-workflows/dig bash scripts/preflight_urls.sh 1 pcb
```

For finetune-from-scratch preflight, skip the shipped checkpoint requirement:

```bash
USE_PRETRAINED_CHECKPOINT=false DIG_URL_ROOT=s3://osmo-workflows/dig \
  bash scripts/preflight_urls.sh 1 metal_surface
```

## Modes

| Mode | Trigger | Behavior |
|---|---|---|
| A | default; raw URL ships `defect_spec.jsonl` | Use the raw NGC data as-is |
| B | raw URL is a flat user upload | Stage clean images + submasks into canonical layout and render `defect_spec.jsonl` from `anomaly_types_json` |

`use_pretrained_checkpoint=true` (the default) omits `finetune-job` and reads
`models/<usecase>` directly. `use_pretrained_checkpoint=false` trains first
(the finetune task itself runs anomalygen Phase 1 Step 2 to build a
validation set inline via `prep_testcase.sh`) and feeds the freshly produced
`runs/<name>/finetune` checkpoint into inference.

## Finetune-mode cookbook render (in-pod, automatic)

In finetune mode (`use_pretrained_checkpoint=false`) the per-usecase cookbook
at `assets/cookbooks/<usecase>/ag_config.yaml` is uploaded to the pod via
`localpath:` and rendered in-pod by `yq` right after Phase 1 Step 2 produces
`validation.jsonl`. **No pre-submit render step.** Cookbook selection is driven
by `--set usecase=…` (one of `pcb`, `metal_surface`, `glass`). See
`finetune.md` §"Cookbook render (in-pod, automatic)" for the 5 patched fields
and the `trainer.early_stop` drop.

## Submit

Generate a fresh run stamp (see SKILL.md §"Name stamping"):

```bash
STAMP=$(cat /proc/sys/kernel/random/uuid | cut -c1-8)
NAME=texture_defect_gen_day1_manual_roi-$STAMP
```

Metal passthrough:

```bash
osmo workflow submit assets/configs/texture_defect_generation_day1_manual_roi.yaml \
  --pool <pool> \
  --set name=$NAME \
        usecase=metal_surface \
        checkpoint_step=10000 \
        'anomaly_types_json=[["metal_surface","MT_Blowhole"],["metal_surface","MT_Break"],["metal_surface","MT_Crack"],["metal_surface","MT_Fray"],["metal_surface","MT_Uneven"]]' \
        num_sdg=30
```

Glass passthrough:

```bash
osmo workflow submit assets/configs/texture_defect_generation_day1_manual_roi.yaml \
  --pool <pool> \
  --set name=$NAME \
        usecase=glass \
        checkpoint_step=9000 \
        'anomaly_types_json=[["Phone","oil"],["Phone","scratch"],["Phone","stain"]]' \
        num_sdg=30
```

Finetune-from-scratch:

```bash
osmo workflow submit assets/configs/texture_defect_generation_day1_manual_roi.yaml \
  --pool <pool> \
  --set name=$NAME \
        usecase=metal_surface \
        use_pretrained_checkpoint=false \
        'anomaly_types_json=[["metal_surface","MT_Blowhole"],["metal_surface","MT_Break"],["metal_surface","MT_Crack"],["metal_surface","MT_Fray"],["metal_surface","MT_Uneven"]]'
```

## Output

> See [Output Retrieval](../output_retrieval.md).

## Troubleshooting

- **Missing URL artifacts** — submit the relevant `setup/setup_<case>.yaml` + `setup/setup_pretrained.yaml`, or upload under the same `dig_url_root`.
- **`ERROR: pretrained tree not at .../pretrained`** — rerun setup for `models/pretrained`.
- **`submask dir not found`** — the raw data URL must have `<material>/mask/<defect>/` directories matching `anomaly_types_json`.
- **`ERROR: $DATASET_DIR/defect_spec.jsonl missing in raw dataset`** (finetune-from-scratch) — rerun setup for the usecase.
- **`ERROR: prep_testcase.sh produced an empty validation.jsonl`** (finetune-from-scratch) — the raw dataset has no training masks under `<MATERIAL>/mask/<defect>/`.
- **`validate_jsonl.py` "TEXTURE+TYPE_C not supported"** — the taxonomy does not match the checkpoint; use the shipped table or retrain via `finetune.yaml`.
