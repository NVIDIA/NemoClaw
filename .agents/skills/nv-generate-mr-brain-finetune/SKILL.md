---
name: nv-generate-mr-brain-finetune
description: Used for finetuning NV-Generate-CTMR MR-brain diffusion UNet from a NIfTI datalist. Not for clinical or production data approval.
license: Apache-2.0
allowed-tools: Bash
metadata:
  author: NVIDIA MedTech Team
  tags:
    - MedTech
    - MRI
    - brain
    - finetune
---

# NV-Generate-MR-Brain-Finetune

## Purpose
- Used for finetuning the NV-Generate-CTMR `rflow-mr-brain` diffusion UNet from user-supplied NIfTI training volumes.
- Not for clinical interpretation, regulatory use, or approving synthetic data for production training.
- The wrapper stages the config glue locally and delegates execution to existing upstream scripts: `scripts.diff_model_create_training_data`, `scripts.diff_model_train`, and optionally `scripts.diff_model_infer`. It does not execute the notebook.
- Manifest I/O: inputs are `datalist` and `data_base_dir`; outputs are `finetuned_checkpoint`, optional `inference_outputs`, and `result_json`.
- The underlying training contract is the upstream config/env JSON (the same one driven from cell `[10]` of `train_diff_unet_tutorial.ipynb`). The wrapper stages those JSON files for you and exposes the most-tuned fields as CLI flags; the sections below document the fields, their defaults, and how to monitor/tune a run.

## Instructions
- Read `skill_manifest.yaml` before changing arguments, side effects, or validation gates.
- Run `scripts/run_mr_brain_finetune.py` from the Medical AI Skills repo root.
- If a host agent exposes `run_script`, use `run_script("scripts/run_mr_brain_finetune.py", args=[...])`; otherwise run the Bash/Python command below.
- Use `--preflight` first when checking a new datalist; remove `--preflight` only when the user explicitly wants to launch GPU finetuning.
- For a staged preflight input bundle directory, use `BUNDLE/preflight_datalist.json` as the datalist and `BUNDLE/preflight_dataset` as `--data-base-dir` when those files are present.

## Examples

Validate and stage a preflight finetune check from an input bundle (the recommended first step — no GPU, no training). This is the single canonical command; replace `INPUT_BUNDLE` and `OUT_DIR` with your paths:

```bash
export NV_GENERATE_ROOT="${NV_GENERATE_ROOT:-.workbench_data/upstreams/NV-Generate-CTMR}" && \
python skills/nv-generate-mr-brain-finetune/scripts/run_mr_brain_finetune.py \
  INPUT_BUNDLE/preflight_datalist.json \
  --data-base-dir INPUT_BUNDLE/preflight_dataset \
  --output-dir OUT_DIR \
  --modality mri_t1 \
  --preflight
```

For real GPU finetuning and other variations, see [Usage](#2-usage-one-line-training) below.

## Available Scripts
| Script | Purpose | Arguments |
|---|---|---|
| `scripts/run_mr_brain_finetune.py` | Primary entrypoint declared by `skill_manifest.yaml`. | `DATALIST.json --data-base-dir DATA_DIR --output-dir OUT_DIR [--epochs N] [--modality mri_t1] [--num-gpus N] [--no-amp] [--model-config FILE] [--run-inference] [--preflight]` |

## Prerequisites
- `NV_GENERATE_ROOT` may point to a current checkout of `https://github.com/NVIDIA-Medtech/NV-Generate-CTMR` containing `scripts/diff_model_create_training_data.py`, `scripts/diff_model_train.py`, and `scripts/diff_model_infer.py`.
- If `NV_GENERATE_ROOT` is unset, the wrapper searches `.workbench_data/upstreams/NV-Generate-CTMR`.
- `CUDA_VISIBLE_DEVICES` is optional and can be used to select the GPU for real training.
- Runtime requirements: NVIDIA CUDA GPU for real training, Python packages from the upstream `requirements.txt`, and downloaded MR-brain weights.
- Side effects: writes staged configs, embeddings, checkpoints, optional inference images, and logs under the caller-provided `--output-dir`; may write model caches under the upstream checkout and `~/.cache/huggingface/`; may contact `https://huggingface.co` for model assets and `https://github.com` for the upstream checkout.
- The datalist is a MONAI-style JSON object with `training[].image` paths relative to `--data-base-dir`. `training[].modality` is optional and defaults to `mri_t1`.

## 1. Config and environment JSON (adapt to your data)

This is a thin wrapper around the upstream `train_diff_unet_tutorial.ipynb` flow. Each run performs four steps, delegating the heavy lifting to the model author's scripts:

1. **Stage configs** — copy the three config JSONs and rewrite only the run-specific paths and `n_epochs` (notebook cell 15).
2. `python -m scripts.diff_model_create_training_data` → latent `*_emb.nii.gz` embeddings (cell 17).
3. **Write embedding sidecars** — a `<emb>.nii.gz.json` per embedding with `spacing`/`modality` (and body-region indices when the model uses them). This is the one piece of glue that lives in the notebook (cell 19), not in upstream `scripts/`, and `diff_model_train` requires it; the skill owns it.
4. `python -m scripts.diff_model_train` (cell 21), optionally `python -m scripts.diff_model_infer`.

**Tune by editing the config JSON, not by adding flags.** All training/inference hyperparameters (`lr`, `batch_size`, `cache_rate`, inference `dim`/`spacing`/`num_inference_steps`/`cfg_guidance_scale`, …) live in `config_maisi_diff_model_rflow-mr-brain.json`. Edit the upstream copy, or pass your own with `--model-config FILE` (and `--env-config` / `--model-def` for the other two). The wrapper only ever rewrites the fields below.

Environment JSON (`environment_maisi_diff_model_rflow-mr-brain.json`) — fields the wrapper rewrites per run:

| Field | Set from | Notes |
|---|---|---|
| `data_base_dir` | `--data-base-dir` | Root for relative `training[].image` paths. |
| `json_data_list` | your datalist | Staged copy with per-entry `modality` filled in. |
| `embedding_base_dir`, `model_dir`, `output_dir` | `--output-dir` | Latent embeddings, checkpoints, inference images. |
| `modality_mapping_path` | upstream | Maps modality name → integer code. |
| `model_filename` | `--model-filename` | Output checkpoint name (default `diff_unet_3d_rflow-mr-brain_v0.pt`). |
| `existing_ckpt_filepath` | upstream weights / `--existing-ckpt-filepath` | Starting checkpoint; cleared by `--train-from-scratch`. |
| `trained_autoencoder_path` | upstream weights / `--trained-autoencoder-path` | VAE used to encode/decode latents. |

Model config (`config_maisi_diff_model_rflow-mr-brain.json`) — the only fields the wrapper touches:

| Field | Set from | Default | Notes |
|---|---|---|---|
| `diffusion_unet_train.n_epochs` | `--epochs` | `2` (upstream config ships `1000`) | Convenience override (cell 15 does the same); wrapper default is small for verification. |
| `diffusion_unet_inference.modality` | `--modality` | from `modality_mapping.json` | Kept consistent with the training modality for optional `--run-inference`. |

Everything else in that file (`lr`, `batch_size`, `cache_rate`, the rest of `diffusion_unet_inference`) is left exactly as written — edit the JSON to change it.

Runtime flags (not config fields): `--num-gpus N` (`>1` launches `torch.distributed.run`), `--no-amp` (disable mixed precision, passed through to `diff_model_train`).

`--modality` selects the integer code from `configs/modality_mapping.json`. Supported brain values: `mri` (8), `mri_t1` (9, default), `mri_t2` (10), `mri_flair` (11), `mri_swi` (20), and their `*_skull_stripped` variants (29/30/31/32). Per-case `training[].modality` overrides `--modality`. The modality also feeds the step-3 embedding sidecars.

For an end-to-end reference including example data download and checkpoint loading, see the upstream tutorial `train_diff_unet_tutorial.ipynb`.

## 2. Usage (one-line training)

Preflight only:

```bash
export NV_GENERATE_ROOT="${NV_GENERATE_ROOT:-.workbench_data/upstreams/NV-Generate-CTMR}" && \
python skills/nv-generate-mr-brain-finetune/scripts/run_mr_brain_finetune.py \
  PATH_TO_DATALIST.json \
  --data-base-dir PATH_TO_DATA_ROOT \
  --output-dir runs/nv_generate_mr_brain_finetune_preflight \
  --preflight
```

Preflight bundle input:

```bash
export NV_GENERATE_ROOT="${NV_GENERATE_ROOT:-.workbench_data/upstreams/NV-Generate-CTMR}" && \
python skills/nv-generate-mr-brain-finetune/scripts/run_mr_brain_finetune.py \
  PATH_TO_INPUT_BUNDLE/preflight_datalist.json \
  --data-base-dir PATH_TO_INPUT_BUNDLE/preflight_dataset \
  --output-dir runs/nv_generate_mr_brain_finetune_preflight \
  --preflight
```

GPU finetuning:

```bash
export NV_GENERATE_ROOT="${NV_GENERATE_ROOT:-.workbench_data/upstreams/NV-Generate-CTMR}" && \
python -m pip install -r "$NV_GENERATE_ROOT/requirements.txt" && \
python skills/nv-generate-mr-brain-finetune/scripts/run_mr_brain_finetune.py \
  PATH_TO_DATALIST.json \
  --data-base-dir PATH_TO_DATA_ROOT \
  --output-dir runs/nv_generate_mr_brain_finetune \
  --epochs 2 \
  --modality mri_t1 \
  --run-inference
```

Replace `PATH_TO_DATALIST.json` and `PATH_TO_DATA_ROOT` with the user's actual paths. Do not use the fixture datalist for real training; it is a preflight-only placeholder.

## 3. Monitor training (TensorBoard)

`scripts.diff_model_train` writes TensorBoard event files under the staged `model_dir` (`OUT_DIR/artifacts/models`). Launch TensorBoard against the output directory and watch the loss curve:

```bash
python -m pip install tensorboard && \
tensorboard --logdir runs/nv_generate_mr_brain_finetune/artifacts
```

The run summary is written to `OUT_DIR/artifacts/workflow_summary.json` (checkpoint path, embedding sidecars, inference outputs); the JSON the wrapper prints to stdout mirrors the same paths plus `exit_code` and a `stderr_tail` for quick triage.

## 4. Hyperparameter tuning and common pitfalls

- **Loss not decreasing / unstable** — lower `diffusion_unet_train.lr` (default `1e-5`) in the model-config JSON, or keep AMP on (default); `--no-amp` is slower but more numerically stable on older GPUs.
- **Out-of-memory** — keep `diffusion_unet_train.batch_size` at `1` and `cache_rate` at `0` in the config JSON, and confirm the autoencoder/UNet fit your GPU before scaling. Multi-GPU (`--num-gpus N`) shards the batch via `torch.distributed.run`.
- **Few cases / quick check** — keep `--epochs` small (the wrapper default `2` is for verification, not convergence; the upstream config ships `1000`).
- **Wrong modality conditioning** — set `--modality` or per-case `training[].modality` to a value present in `configs/modality_mapping.json`; a mismatch produces a clear error rather than silently mislabeling latents.
- **Slow startup on first run** — `diff_model_create_training_data` precomputes latent embeddings once; reuse the same `--output-dir` to avoid recomputing them.

## 5. Evaluate the finetuned model

Use the staged checkpoint (`OUT_DIR/artifacts/models/<model_filename>`) as the diffusion UNet for generation, then inspect the synthesized volumes:

- Pass `--run-inference` here for a quick built-in sanity render, or
- Point the [`nv-generate-mr-brain`](../nv-generate-mr-brain/SKILL.md) inference skill at the finetuned checkpoint to generate fresh brain MRI volumes for qualitative review.

This skill gates file accounting and command provenance only — anatomical realism and downstream utility must be judged by a domain expert on the generated images.

## Limitations
- Requires a current upstream `NV-Generate-CTMR` checkout with the existing diffusion training scripts. The skill itself stages the required config and datalist glue locally and does not depend on the notebook or PR #33.
- Full training can be expensive and is not deterministic across hardware, CUDA, and package versions.
- The wrapper gates file accounting and command provenance, not anatomical realism or downstream model utility.
- Not for clinical deployment, clinical interpretation, autonomous diagnosis, regulatory submission, or production training-data approval.

## Troubleshooting
| Error | Cause | Fix |
|---|---|---|
| `diffusion training scripts were not found` | `NV_GENERATE_ROOT` does not point at a current NV-Generate-CTMR checkout. | Clone or update `https://github.com/NVIDIA-Medtech/NV-Generate-CTMR` and set `NV_GENERATE_ROOT`. |
| `missing datalist image` | `training[].image` paths are not relative to `--data-base-dir` or files are absent. | Fix the datalist or pass the correct data root. |
| CUDA or MONAI import failure | Runtime environment lacks upstream dependencies. | Install `"$NV_GENERATE_ROOT/requirements.txt"` in the selected environment. |
