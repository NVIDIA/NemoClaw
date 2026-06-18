# Day 0 — Full Pipeline (PCBA CAD -> Image-Edit -> AnomalyGen)


## Table of Contents

- [URL Contract](#url-contract)
- [Graph](#graph)
- [Finetune-mode cookbook render (in-pod, automatic)](#finetune-mode-cookbook-render-in-pod-automatic)
- [Image-Edit Endpoint](#image-edit-endpoint)
- [Submit](#submit)
- [Output](#output)
- [Troubleshooting](#troubleshooting)

End-to-end PCBA pipeline starting from the PCBA USD asset tree under the AOI URL
root. It renders per-cell CAD ROIs, sends them through the
`nvidia/Qwen-Image-Edit-NVPCB-OVSL2SL` endpoint for OV-to-SL appearance transfer,
and runs AnomalyGen inference with labels emitted inline. **The image-edit model
must be `nvidia/Qwen-Image-Edit-NVPCB-OVSL2SL`** — AnomalyGen was finetuned
against its appearance distribution; substituting the generic `qwen-image-edit`
checkpoint causes silent inference-quality regressions.

## URL Contract

Set `dig_url_root` once; default is `s3://osmo-workflows/dig`.

| Purpose | URL |
|---|---|
| PCBA checkpoint | `<dig_url_root>/models/pcb` |
| Pretrained model tree | `<dig_url_root>/models/pretrained` |
| Raw PCBA training data + submasks | `<dig_url_root>/datasets/pcb/raw` |
| PCBA USD assets | `<dig_url_root>/datasets/pcb/assets` |
| usd2roi output | `<dig_url_root>/runs/<name>/usd2roi-components` |
| image-edit output | `<dig_url_root>/runs/<name>/augment` |
| finetune output, optional | `<dig_url_root>/runs/<name>/finetune` |
| final labeled output | `<dig_url_root>/runs/<name>/anomaly` |

Preflight:

```bash
DIG_URL_ROOT=s3://osmo-workflows/dig bash scripts/preflight_urls.sh 0 pcb
```

For finetune-from-scratch preflight, skip the shipped checkpoint requirement:

```bash
USE_PRETRAINED_CHECKPOINT=false DIG_URL_ROOT=s3://osmo-workflows/dig \
  bash scripts/preflight_urls.sh 0 pcb
```

## Graph

Passthrough mode (`use_pretrained_checkpoint=true`, default):

```
usd2roi-render -> augment-image-edit -> anomaly-infer
```

Finetune mode (`use_pretrained_checkpoint=false`):

```
usd2roi-render -> augment-image-edit -> finetune-job -> anomaly-infer
```

The final inference task consumes the augmented images and CAD masks from task
outputs, then reads PCBA submasks from `datasets/pcb/raw`, pretrained weights
from `models/pretrained`, and either the shipped checkpoint from `models/pcb`
or the finetune task output. When `use_pretrained_checkpoint=false` the
finetune-job task builds its validation set on the fly via `prep_testcase.sh`
(anomalygen Phase 1 Step 2) before torchrun starts.

## Finetune-mode cookbook render (in-pod, automatic)

In finetune mode (`use_pretrained_checkpoint=false`) the cookbook at
`assets/cookbooks/pcb/ag_config.yaml` is uploaded to the pod via `localpath:`
and rendered in-pod by `yq` right after Phase 1 Step 2 produces
`validation.jsonl`. **No pre-submit render step.** The 5 patched fields and
the `trainer.early_stop` drop are described in `finetune.md` §"Cookbook render
(in-pod, automatic)".

## Image-Edit Endpoint

Use an existing endpoint reachable from OSMO pods, or deploy the local cluster
service from `references/nim/`.

```bash
IMAGE_EDIT_ENDPOINT=http://qwen-image-edit-nvpcb-ovsl2sl.osmo-nims.svc.cluster.local:8000/v1
IMAGE_EDIT_MODEL=nvidia/Qwen-Image-Edit-NVPCB-OVSL2SL
```

## Submit

Generate a fresh run stamp (see SKILL.md §"Name stamping"):

```bash
STAMP=$(cat /proc/sys/kernel/random/uuid | cut -c1-8)
NAME=texture_defect_gen_day0-$STAMP
```

Default passthrough:

```bash
osmo workflow submit assets/configs/texture_defect_generation_day0.yaml \
  --pool <pool> \
  --set name=$NAME \
        dig_url_root=<dig_url_root> \
        image_edit_endpoint=${IMAGE_EDIT_ENDPOINT} \
        image_edit_model=${IMAGE_EDIT_MODEL}
```

Finetune-from-scratch:

```bash
osmo workflow submit assets/configs/texture_defect_generation_day0.yaml \
  --pool <pool> \
  --set name=$NAME \
        dig_url_root=<dig_url_root> \
        use_pretrained_checkpoint=false \
        image_edit_endpoint=${IMAGE_EDIT_ENDPOINT} \
        image_edit_model=${IMAGE_EDIT_MODEL}
```

Useful smoke-test knobs:

```bash
--set render_patches=5 num_sdg=15
```

The default taxonomy is:

```bash
'anomaly_types_json=[["IC","bridge"],["passive_component","excess_solder"],["passive_component","missing"]]'
```

## Output

> See [Output Retrieval](../output_retrieval.md).

## Troubleshooting

- **Missing URL artifacts** — submit `setup/setup_pcb.yaml` + `setup/setup_pretrained.yaml`, or upload under the same `dig_url_root`.
- **`ERROR: no USD found under <ASSETS_IN>`** — inspect `<dig_url_root>/datasets/pcb/assets`; it must contain the USD tree from the PCBA assets artifact.
- **`ERROR: $DATASET_DIR/defect_spec.jsonl missing in raw dataset`** — `<dig_url_root>/datasets/pcb/raw` is incomplete; rerun `setup/setup_pcb.yaml`.
- **`ERROR: prep_testcase.sh produced an empty validation.jsonl`** — the raw PCBA dataset has no training masks under `<MATERIAL>/mask/<defect>/`.
- **`submask dir not found`** — the raw PCBA data must have `<material>/mask/<defect>/` directories matching `anomaly_types_json`.
- **Image-edit failures** — verify `image_edit_endpoint` from inside the cluster and check `references/nim/README.md`.
