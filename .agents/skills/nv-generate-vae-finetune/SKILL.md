---
name: nv-generate-vae-finetune
description: Used for finetuning the NV-Generate-CTMR MAISI VAE from CT/MRI NIfTI datalists. Not for clinical or production data approval.
license: Apache-2.0
allowed-tools: Bash
metadata:
  author: NVIDIA MedTech Team
  tags:
    - MedTech
    - CT
    - MRI
    - VAE
    - finetune
---

# NV-Generate-VAE-Finetune

## Purpose
- Used for finetuning the NV-Generate-CTMR MAISI VAE/autoencoder from user-supplied CT or MRI NIfTI training volumes.
- Not for clinical interpretation, regulatory use, or approving synthetic data for production training.
- Upstream currently documents VAE training in `train_vae_tutorial.ipynb` and provides configs/helpers, but not a `scripts.train_vae` CLI. This skill does not execute the notebook; it stages the required config/datalist glue locally and uses upstream helper APIs.
- Manifest I/O: inputs are `datalist` and `data_base_dir`; outputs are `autoencoder_checkpoint`, `discriminator_checkpoint`, and `result_json`.
- The underlying training contract is the upstream config/env JSON (`config_maisi_vae_train.json` + `environment_maisi_vae_train.json`, as used in `train_vae_tutorial.ipynb`). The wrapper stages those JSON files for you and exposes the most-tuned fields as CLI flags; the sections below document the fields, their defaults, and how to monitor/tune a run.

## Instructions
- Read `skill_manifest.yaml` before changing arguments, side effects, or validation gates.
- Run `scripts/run_vae_finetune.py` from the Medical AI Skills repo root.
- If a host agent exposes `run_script`, use `run_script("scripts/run_vae_finetune.py", args=[...])`; otherwise run the Bash/Python command below.
- Use `--preflight` first when checking a new datalist; remove `--preflight` only when the user explicitly wants to launch GPU finetuning.
- For a staged preflight input bundle directory, use `BUNDLE/preflight_datalist.json` as the datalist and `BUNDLE/preflight_dataset` as `--data-base-dir` when those files are present.

## Examples

Validate and stage a preflight finetune check from an input bundle (the recommended first step — no GPU, no training). This is the single canonical command; replace `INPUT_BUNDLE` and `OUT_DIR` with your paths:

```bash
export NV_GENERATE_ROOT="${NV_GENERATE_ROOT:-.workbench_data/upstreams/NV-Generate-CTMR}" && \
python skills/nv-generate-vae-finetune/scripts/run_vae_finetune.py \
  INPUT_BUNDLE/preflight_datalist.json \
  --data-base-dir INPUT_BUNDLE/preflight_dataset \
  --output-dir OUT_DIR \
  --modality mri \
  --preflight
```

For real GPU finetuning and other variations, see [Usage](#2-usage-one-line-training) below.

## Available Scripts
| Script | Purpose | Arguments |
|---|---|---|
| `scripts/run_vae_finetune.py` | Primary entrypoint declared by `skill_manifest.yaml`. | `DATALIST.json --data-base-dir DATA_DIR --output-dir OUT_DIR [--epochs N] [--modality mri] [--patch-size 64,64,64] [--preflight]` |

## Prerequisites
- `NV_GENERATE_ROOT` may point to a current checkout of `https://github.com/NVIDIA-Medtech/NV-Generate-CTMR` containing `configs/config_maisi_vae_train.json`, `scripts/transforms.py`, and `scripts/utils.py`.
- If `NV_GENERATE_ROOT` is unset, the wrapper searches `.workbench_data/upstreams/NV-Generate-CTMR`.
- `CUDA_VISIBLE_DEVICES` is optional and can be used to select the GPU for real training.
- Runtime requirements: NVIDIA CUDA GPU for real training, Python packages from the upstream `requirements.txt`, `lpips`, and downloaded VAE weights unless using `--train-from-scratch`.
- Side effects: writes staged configs, checkpoints, TensorBoard logs, and run summaries under the caller-provided `--output-dir`; may write model caches under the upstream checkout, `~/.cache/huggingface/`, and `~/.cache/torch/`; may contact `https://huggingface.co`, `https://github.com`, and `https://download.pytorch.org`.
- The datalist is a MONAI-style JSON object with non-empty `training[]` and `validation[]` or `testing[]`. Each entry has an `image` path relative to `--data-base-dir` and optional `class` or `modality` of `ct` or `mri`.

## 1. Config and environment JSON (adapt to your data)

The wrapper copies the upstream VAE config/env JSON from `$NV_GENERATE_ROOT/configs`, rewrites the fields below, and writes the staged copies under `OUT_DIR/workflow/configs/`. You normally only set your datalist and data root; the listed CLI flags override individual fields when you need to.

Environment JSON (`environment_maisi_vae_train.json`):

| Field | Set from | Notes |
|---|---|---|
| `model_dir` | `--output-dir` | Where `autoencoder.pt`/`discriminator.pt` and best checkpoints are saved. |
| `tfevent_path` | `--output-dir` | TensorBoard event directory. |
| `finetune` | `--train-from-scratch` | `true` (default) loads `trained_autoencoder_path`; the flag sets it `false`. |
| `trained_autoencoder_path` | upstream weights / `--trained-autoencoder-path` | Starting VAE checkpoint when finetuning. |

Training fields (`config_maisi_vae_train.json`):

| Field | Flag | Type | Default | Notes |
|---|---|---|---|---|
| `autoencoder_train.n_epochs` | `--epochs` | int | `1` | |
| `autoencoder_train.batch_size` | `--batch-size` | int | `1` | Per-GPU (single-GPU runner). |
| `autoencoder_train.patch_size` | `--patch-size` | int,int,int | `64,64,64` | Training crop. |
| `autoencoder_train.val_batch_size` | `--val-batch-size` | int | `1` | |
| `autoencoder_train.val_sliding_window_patch_size` | `--val-sliding-window-patch-size` | int,int,int | `96,96,64` | Sliding-window validation ROI. |
| `autoencoder_train.lr` | `--lr` | float | `1e-4` | |
| `autoencoder_train.perceptual_weight` | `--perceptual-weight` | float | `0.3` | LPIPS term. |
| `autoencoder_train.kl_weight` | `--kl-weight` | float | `1e-7` | KL term. |
| `autoencoder_train.adv_weight` | `--adv-weight` | float | `0.1` | Adversarial term. |
| `autoencoder_train.recon_loss` | `--recon-loss` | `l1`\|`l2` | `l1` | |
| `autoencoder_train.val_interval` | `--val-interval` | int | `1` | Epochs between validation passes. |
| `autoencoder_train.cache` | `--cache-rate` | float | `0.0` | MONAI `CacheDataset` fraction. |
| `autoencoder_train.amp` | `--no-amp` | flag | on | Mixed precision; flag disables it. |
| `data_option.random_aug` | `--no-random-aug` | flag | on | Random augmentation; flag disables it. |
| `data_option.spacing_type` | `--spacing-type` | `original`\|`fixed`\|`rand_zoom` | `original` | |
| `data_option.spacing` | `--spacing` | float,float,float | unset | Required when `spacing_type` is `fixed`/`rand_zoom`. |
| `data_option.select_channel` | `--select-channel` | int | `0` | Channel for multi-channel inputs. |

`--modality` (`ct` or `mri`, default `mri`) fills the per-entry `class` for datalist items missing one. Validation/testing entries are required because the training loop runs a validation pass.

For an end-to-end reference including example data download, see the upstream tutorial `train_vae_tutorial.ipynb`.

## 2. Usage (one-line training)

Preflight only:

```bash
export NV_GENERATE_ROOT="${NV_GENERATE_ROOT:-.workbench_data/upstreams/NV-Generate-CTMR}" && \
python skills/nv-generate-vae-finetune/scripts/run_vae_finetune.py \
  PATH_TO_DATALIST.json \
  --data-base-dir PATH_TO_DATA_ROOT \
  --output-dir runs/nv_generate_vae_finetune_preflight \
  --preflight
```

Preflight bundle input:

```bash
export NV_GENERATE_ROOT="${NV_GENERATE_ROOT:-.workbench_data/upstreams/NV-Generate-CTMR}" && \
python skills/nv-generate-vae-finetune/scripts/run_vae_finetune.py \
  PATH_TO_INPUT_BUNDLE/preflight_datalist.json \
  --data-base-dir PATH_TO_INPUT_BUNDLE/preflight_dataset \
  --output-dir runs/nv_generate_vae_finetune_preflight \
  --preflight
```

GPU finetuning:

```bash
export NV_GENERATE_ROOT="${NV_GENERATE_ROOT:-.workbench_data/upstreams/NV-Generate-CTMR}" && \
python -m pip install -r "$NV_GENERATE_ROOT/requirements.txt" && \
python -m pip install lpips tensorboard && \
python skills/nv-generate-vae-finetune/scripts/run_vae_finetune.py \
  PATH_TO_DATALIST.json \
  --data-base-dir PATH_TO_DATA_ROOT \
  --output-dir runs/nv_generate_vae_finetune \
  --epochs 1 \
  --modality mri \
  --patch-size 64,64,64 \
  --download-model-data
```

Replace `PATH_TO_DATALIST.json` and `PATH_TO_DATA_ROOT` with the user's actual paths. Do not use the fixture datalist for real training; it is a preflight-only placeholder.

## 3. Monitor training (TensorBoard)

The runner writes TensorBoard scalars (per-iteration and per-epoch `recons_loss`, `kl_loss`, `p_loss`, adversarial/real/fake losses, and a validation `scale_factor`) under `OUT_DIR/artifacts/tfevent/autoencoder`. Launch TensorBoard against the output directory:

```bash
python -m pip install tensorboard && \
tensorboard --logdir runs/nv_generate_vae_finetune/artifacts/tfevent
```

The same per-epoch loss history is also captured in `OUT_DIR/artifacts/workflow_summary.json` and echoed in the JSON the wrapper prints to stdout (`loss_history`, best-checkpoint paths, `exit_code`, `stderr_tail`).

## 4. Hyperparameter tuning and common pitfalls

- **Reconstructions blurry** — raise `--perceptual-weight` (default `0.3`); try `--recon-loss l2` if edges look washed out.
- **Posterior collapse / over-regularized latents** — `--kl-weight` is intentionally tiny (`1e-7`); increasing it too much degrades reconstruction.
- **Adversarial training unstable** — lower `--adv-weight` (default `0.1`) or `--lr`; a warmup schedule already ramps the LR over the first 20 epochs.
- **Out-of-memory** — reduce `--patch-size` (e.g. `48,48,48`) and `--val-sliding-window-patch-size`, keep `--batch-size 1`, and lower `--cache-rate`.
- **`datalist must include non-empty validation[] or testing[]`** — the validation loop is mandatory; add `validation[]` (or `testing[]`) entries.
- **Single-GPU only** — the runner asserts exactly one CUDA GPU; set `CUDA_VISIBLE_DEVICES` to pick which one.

## 5. Evaluate the finetuned VAE

Validation reconstruction loss (lowest-`val_weighted_loss` epoch) is tracked automatically and the best autoencoder is saved as `autoencoder_epochN.pt` under `OUT_DIR/artifacts/models`. To evaluate downstream:

- Compare validation `recons_loss`/`p_loss` curves across runs in TensorBoard, and
- Plug the finetuned autoencoder into a diffusion finetune/generation run (e.g. [`nv-generate-mr-brain-finetune`](../nv-generate-mr-brain-finetune/SKILL.md) via `--trained-autoencoder-path`) to confirm latents still decode to usable volumes.

This skill gates file accounting and reconstruction bookkeeping only — image quality and downstream utility must be judged by a domain expert.

## Limitations
- Requires a current upstream `NV-Generate-CTMR` checkout with VAE configs and helper APIs. The skill owns the runner glue and does not depend on the notebook.
- Full training can be expensive and is not deterministic across hardware, CUDA, and package versions.
- The wrapper gates file accounting and command provenance, not anatomical realism, reconstruction quality, or downstream model utility.
- Not for clinical deployment, clinical interpretation, autonomous diagnosis, regulatory submission, or production training-data approval.

## Troubleshooting
| Error | Cause | Fix |
|---|---|---|
| `VAE configs/helpers were not found` | `NV_GENERATE_ROOT` does not point at a current NV-Generate-CTMR checkout. | Clone or update `https://github.com/NVIDIA-Medtech/NV-Generate-CTMR` and set `NV_GENERATE_ROOT`. |
| `datalist must include non-empty validation[] or testing[]` | VAE training requires validation data for the configured validation loop. | Add `validation[]` or `testing[]` entries with relative image paths. |
| CUDA, MONAI, or LPIPS import failure | Runtime environment lacks upstream dependencies. | Install `"$NV_GENERATE_ROOT/requirements.txt"` plus `lpips tensorboard` in the selected environment. |
