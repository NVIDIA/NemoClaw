---
name: nv-segment-ct-finetune
description: Used for smoke or dataset finetuning of NV-Segment-CT VISTA3D on CT NIfTI labels. Not for clinical validation.
license: Apache-2.0
allowed-tools: Bash
metadata:
  author: NVIDIA MedTech Team
  tags:
    - MedTech
    - CT
    - finetuning
    - segmentation
---

# NV-Segment-CT Finetune

## Purpose

- Used for smoke or dataset finetuning of NV-Segment-CT VISTA3D on CT NIfTI labels. Not for clinical validation.
- Wraps the upstream MONAI bundle entrypoint; do not replace it with handwritten training or inference code.
- Manifest inputs are `dataset_dir`, `datalist`, `target_anatomy`, `label_mapping`, `smoke`, `sanity`, `auto_seg`, and `skip_formal_eval`.
- Manifest outputs are `finetuned_ckpt` and schema-checked `result_json`.

## Instructions

- Run `scripts/run_finetune.py`; do not patch files under `bundle/` or upstream checkouts during normal skill use.
- For standalone Bash, include the fresh-environment setup line before the wrapper; benchmark venvs start empty.
- Run the committed script in place from the repo root. Do not copy this skill to a runtime directory, and do not use `rm` or cleanup commands in generated invocations.
- If a host exposes `run_script`, use `run_script("scripts/run_finetune.py", args=[...])`; otherwise run from the repo root.
- For the shortest workflow check, use `--smoke`; for MSD Task06 Lung Tumor reproduction, use `--sanity`.
- Read `references/task06-and-results.md` only when you need Task06 reference details, output-field definitions, or manual bundle setup notes.

## Available Scripts

| Script | Purpose | Arguments |
|---|---|---|
| `scripts/run_finetune.py` | Primary entrypoint declared by `skill_manifest.yaml`; stages configs, runs MONAI, and writes `output.json`. | `[FIXTURE_OR_DATASET] --output-dir OUT_DIR [--smoke] [--sanity] [--auto-seg] [--dataset-dir DIR] [--datalist JSON] [--target-anatomy TEXT] [--label-mapping JSON] [--patch-size JSON]` |

## Prerequisites

- Python 3.10+ with CUDA-capable Torch for GPU runs.
- Runtime packages from `skill_manifest.yaml`, especially `monai==1.4.0`, `numpy<2`, `nibabel`, `scipy`, `typer`, `PyYAML`, `fire`, `pytorch-ignite`, `einops`, and `huggingface_hub`.
- Optional environment variables: `CUDA_VISIBLE_DEVICES` restricts visible GPUs; `NPROC_PER_NODE` overrides GPU count and values `>=2` select multi-GPU mode for non-sanity runs.
- Side effects: writes generated bundle configs under `skills/nv-segment-ct-finetune/bundle/configs/`, including `skills/nv-segment-ct-finetune/bundle/configs/auto_override.json`, `skills/nv-segment-ct-finetune/bundle/configs/train_continual_task06_lung.json`, and `skills/nv-segment-ct-finetune/bundle/configs/dfw_no_logging.json`; writes checkpoints/evidence under `--output-dir`, may cache model assets under `~/.cache/huggingface/`, and may contact `https://huggingface.co` or `https://raw.githubusercontent.com`.

Fresh environment setup:

```bash
python -m pip install "monai==1.4.0" "numpy<2" pytorch-ignite einops nibabel scipy typer PyYAML fire huggingface_hub
```

Known upstream compatibility constraints:

- DFW Task06 reference: Python `3.10.16`, MONAI `1.4.0`, Torch `2.7.0+cu126`.
- Use exact `monai==1.4.0` for smoke, sanity, and evidence runs; MONAI 1.5.x can crash the upstream finetune loss on boolean labels.
- Do not float the dependency as `monai>=1.4,<1.6` in generated commands.

## Usage

Smoke-scale workflow check:

```bash
python -m pip install "monai==1.4.0" "numpy<2" pytorch-ignite einops nibabel scipy typer PyYAML fire huggingface_hub && \
python skills/nv-segment-ct-finetune/scripts/run_finetune.py \
  PATH_TO_DATASET \
  --smoke \
  --patch-size '[64,64,64]' \
  --output-dir runs/nvseg_smoke
```

Use the staged dataset as `PATH_TO_DATASET`. For the micro fixture, use `skills/nv-segment-ct-finetune/fixtures/spleen_micro`. Smoke mode proves wiring, config generation, checkpoint loading, and runtime compatibility; it is not a quality bar.

MSD Task06 Lung Tumor sanity reproduction:

```bash
python skills/nv-segment-ct-finetune/scripts/run_finetune.py \
  /path/to/Task06 \
  --sanity \
  --output-dir runs/nvseg_task06_sanity
```

The sanity preset follows the single-GPU DFW recipe: fold-0 validation, label mapping `[[1, 23]]` for `lung tumor`, automatic class-prompt segmentation, patch `[128,128,128]`, 5 epochs, and original-spacing `configs/evaluate.json` scoring before and after training. Expected reference range is pretrained Dice about `0.6697`, training-best Dice about `0.6905`, and fine-tuned formal Dice about `0.6836`.

User-data finetune:

```bash
python skills/nv-segment-ct-finetune/scripts/run_finetune.py \
  --dataset-dir /path/to/dataset \
  --datalist /path/to/datalist.json \
  --target-anatomy "lung tumor" \
  --auto-seg \
  --epochs 5 \
  --patch-size '[128,128,128]' \
  --output-dir runs/nvseg_user_finetune
```

Use `--label-mapping '[[1, 23]]'` when local label values are custom or the anatomy name is ambiguous.

## Examples

Smoke run on a staged tiny dataset:

```bash
python skills/nv-segment-ct-finetune/scripts/run_finetune.py \
  runs/with_vs_without_nv/_inputs/nv_segment_ct_finetune/input_dataset \
  --smoke \
  --patch-size '[64,64,64]' \
  --output-dir runs/nvseg_smoke
```

Task06 sanity run on a local MSD cache:

```bash
python skills/nv-segment-ct-finetune/scripts/run_finetune.py \
  .workbench_data/datasets/Task06_Lung \
  --sanity \
  --output-dir runs/nvseg_task06_sanity
```

## Data Contract

- Preferred layout: `dataset/imagesTr/*.nii.gz` and `dataset/labelsTr/*.nii.gz`.
- Labels must align one-to-one with images by basename.
- The target label value must be present in the training labels.
- Use a datalist when patient-level splitting matters. The bundle default `fold` is `0`, so `fold: 0` entries are validation and all other folds are training.
- Every trained foreground label must map to an existing VISTA3D global class id from `bundle/label_dict.json`; this skill cannot invent a new class.

## Results

Check `output.json` in the run directory first:

- `formal_pretrained_val_dice` and `formal_finetuned_val_dice`: original-spacing pre/post scores when formal eval is enabled.
- `training_start_val_dice`, `val_dice_per_epoch`, and `training_best_val_dice`: training-time validation trace.
- `finetuned_ckpt_matches_pretrained_weights`: detects the epoch-0 checkpoint trap when `val_at_start=true`.
- `recommended_ckpt`: checkpoint to keep. Do not blindly use the last epoch or `model_finetune.pt`.
- `runtime.oom`, `runtime.peak_gpu_mb`, and phase logs: distinguish OOM, slow validation, and process failure.

Decision rule: prefer formal original-spacing pre/post scores when present; reject tensor-identical "fine-tuned" checkpoints for sanity recovery; treat `improved: false` as valid evidence rather than a wrapper failure.

## Limitations

- Thin wrapper. Training, validation, transforms, and checkpointing are delegated to the upstream bundle in `bundle/`.
- The auto-derived plan is heuristic; caller-provided `--patch-size`, `--cache-rate`, `--epochs`, and `--learning-rate` win.
- The Task06 sanity recipe intentionally forces single-GPU execution to match the DFW reference. Multi-GPU mode for other datasets requires host `torchrun` support.
- The paired verifier is CPU-only and audits the evidence pack; it does not re-run GPU segmentation.
- Not for clinical deployment, clinical interpretation, autonomous diagnosis, or regulatory submission.

## Troubleshooting

| Error | Cause | Fix |
|---|---|---|
| Missing dependency or import error | Runtime drift from `skill_manifest.yaml`. | Install the packages above or use the documented environment. |
| Low Task06 pretrained Dice | Wrong config, wrong checkpoint, data split drift, or dependency drift. | Compare environment fields and staged configs before changing training logic. |
| `model_finetune.pt` matches pretrained | `val_at_start=true` selected epoch 0 as best. | Use `recommended_ckpt`; treat sanity recovery as failed unless a changed checkpoint improves formal Dice. |
| Missing formal Dice fields | Formal eval failed or was skipped. | Inspect `eval_pretrained.log`, `eval_finetuned.log`, and `metrics.csv`. |
| GPU out of memory | Patch/cache settings too large. | Reduce `--patch-size`, lower `--cache-rate`, or reduce workers. |
| No validation cases | Datalist lacks `fold: 0`. | Provide at least one validation entry. |

## Verification

Run the implemented verifier when quality gates matter:

```bash
python -m eval_engine.run_trusted skills/nv-segment-ct-finetune \
  --fixture skills/nv-segment-ct-finetune/fixtures/spleen_micro \
  --out runs/nvseg_trusted
```
