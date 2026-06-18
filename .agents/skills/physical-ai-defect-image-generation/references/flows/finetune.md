# Finetune Only


## Table of Contents

- [URL Contract](#url-contract)
- [Cookbook](#cookbook)
- [Cookbook render (in-pod, automatic)](#cookbook-render-in-pod-automatic)
- [Submit](#submit)
- [Output](#output)
- [Extending a Use Case](#extending-a-use-case)
- [Troubleshooting](#troubleshooting)

Train anomalygen on a raw AOI data URL and emit a checkpoint under
`<dig_url_root>/runs/<name>/finetune`. The checkpoint can be copied into
`<dig_url_root>/models/<usecase>` for later Day 0 or Day 1 passthrough runs, or
used directly by a workflow variant that points at that run output.

The finetune task runs anomalygen Phase 1 end-to-end inside one pod:
`validate_dataset.py` (structural sanity + mask counting) → `prep_testcase.sh`
(AMP placement, n_seeds=1 per mask → `/tmp/validation/validation.jsonl` +
`/tmp/validation/amp/`) → torchrun (`predict2_anomaly_gen_ddp_2b`). No
pre-baked validation artifact is required.

## URL Contract

Set `dig_url_root` once; default is `s3://osmo-workflows/dig`.

| Purpose | URL |
|---|---|
| Pretrained model tree | `<dig_url_root>/models/pretrained` |
| Raw training data | `<dig_url_root>/datasets/<usecase>/raw` |
| finetuned checkpoint output | `<dig_url_root>/runs/<name>/finetune` |

Preflight:

```bash
DIG_URL_ROOT=s3://osmo-workflows/dig bash scripts/preflight_urls.sh finetune pcb
```

Built-in `usecase` values are `pcb`, `metal_surface`, and `glass` — uniform
across `--set usecase=`, URL paths (`datasets/<usecase>/raw`,
`models/<usecase>`), and cookbook directories (`assets/cookbooks/<usecase>/`).
The `metal_surface` value matches the trained model's material name baked
into the checkpoint taxonomy.

## Cookbook

The cookbook is the exact training config the shipped checkpoint was trained
against. It should usually be treated as a recipe and patched only for run
identity and mounted input paths.

| URL usecase | Cookbook | Shipped anomaly types |
|---|---|---|
| `pcb` | `assets/cookbooks/pcb/ag_config.yaml` | `[[IC,bridge],[passive_component,excess_solder],[passive_component,missing]]` |
| `metal_surface` | `assets/cookbooks/metal_surface/ag_config.yaml` | `[[metal_surface,MT_Blowhole],[metal_surface,MT_Break],[metal_surface,MT_Crack],[metal_surface,MT_Fray],[metal_surface,MT_Uneven]]` |
| `glass` | `assets/cookbooks/glass/ag_config.yaml` | `[[Phone,oil],[Phone,scratch],[Phone,stain]]` |

The raw data URL must contain `<MATERIAL>/anomaly_image/<defect>/`,
`<MATERIAL>/mask/<defect>/`, and `defect_spec.jsonl`. The relevant
`setup/setup_<case>.yaml` creates that shape for the shipped cases. `validation.jsonl` + `amp/` are
generated fresh inside the finetune task — no need to ship them.

## Cookbook render (in-pod, automatic)

There is **no pre-submit render step**. The cookbook at
`assets/cookbooks/<usecase>/ag_config.yaml` is uploaded to the pod via
`localpath:` and rendered in-pod by `yq` right after Phase 1 Step 2 produces
`validation.jsonl`. The render patches 5 fields:

| Field | Source |
|---|---|
| `.job.group` | `EXP_NAME` (= `--set name=…`) |
| `.job.name` | `${EXP_NAME}_training_FP32_lr0.02_bs=2_2b_512x512` (auto-derived) |
| `.dataloader_train.dataset.dataset_dir` | `{{input:1}}` (raw dataset URL) |
| `.dataloader_val.dataset.input_data_path` | `/tmp/validation/validation.jsonl` (Phase 1 Step 2 output) |
| `.model.config.ag_config.mask_encoder.encoder_config.init_cfg.checkpoint` | `checkpoints/NVDINOV2/nv_dinov2_classification_model.ckpt` |

and drops the `trainer.early_stop` block (which the image's `TrainerConfig`
rejects). Cookbook selection is driven by `--set usecase=…`:

```
usecase=pcb           → assets/cookbooks/pcb/ag_config.yaml
usecase=metal_surface → assets/cookbooks/metal_surface/ag_config.yaml
usecase=glass         → assets/cookbooks/glass/ag_config.yaml
```

## Submit

```bash
STAMP=$(cat /proc/sys/kernel/random/uuid | cut -c1-8)
NAME=finetune-$STAMP
osmo workflow submit assets/configs/finetune.yaml \
  --pool <pool> \
  --set name=$NAME \
        dig_url_root=<dig_url_root> \
        usecase=<pcb|metal_surface|glass>
```

`--set` carries only OSMO concerns: run name, DIG root, URL usecase, and GPU
resources. Training recipe knobs stay in the cookbook (rendered in-pod from
`assets/cookbooks/<usecase>/ag_config.yaml`). The `$STAMP` (8 hex chars from
`/proc/sys/kernel/random/uuid`) makes the storage path unique per submission
— see SKILL.md §"Name stamping".

Defaults are sized for 1 GPU. For multi-GPU finetune, pass `train_gpu`,
`train_cpu`, and `train_memory` together — the per-GPU scaling table lives
in `references/gpu_sizing.md`. Example for 4-GPU training:

```bash
osmo workflow submit assets/configs/finetune.yaml \
  --pool <pool> \
  --set name=$NAME dig_url_root=<dig_url_root> usecase=<usecase> \
        train_gpu=4 train_cpu=32 train_memory=192Gi
```

## Output

```bash
osmo data list --no-pager s3://osmo-workflows/dig/runs/$NAME/finetune
osmo data download s3://osmo-workflows/dig/runs/$NAME/finetune ./output/$NAME-finetune/
```

Best-step selection is based on the highest `nn_score` from validation logs.
See `skills/anomalygen/SKILL.md` Phase 1 for the detailed procedure.

## Extending a Use Case

Start from the closest shipped cookbook. If adding defects, update both
`anomaly_types` copies in the cookbook:

- `dataloader_train.dataset.anomaly_types`
- `model.config.ag_config.anomaly_embedding.anomaly_types`

Then upload or prepare matching data under
`<dig_url_root>/datasets/<usecase>/raw`. The material and defect names must
match the cookbook, `defect_spec.jsonl`, and `anomaly_types_json` used by
inference.

## Troubleshooting

- **`ERROR: /tmp/ag_config.yaml not mounted`** — render Step 1 before submitting.
- **`ERROR: pretrained tree not at .../pretrained`** — rerun setup for `models/pretrained`.
- **`ERROR: $DATASET_DIR/defect_spec.jsonl missing in raw dataset`** — the raw URL is incomplete; rerun the relevant `setup/setup_<case>.yaml` for the usecase.
- **`ERROR: prep_testcase.sh produced an empty validation.jsonl`** — the raw dataset is missing training masks (`<MATERIAL>/mask/<defect>/`). Verify with `osmo data list --no-pager <dig_url_root>/datasets/<usecase>/raw`.
- **dshm OOM** — see `references/setup.md` Troubleshooting.
