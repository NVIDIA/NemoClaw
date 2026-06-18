---
name: nv-generate-mr
description: Used for generating synthetic body MRI volumes with NV-Generate-CTMR rflow-mr. Not for paired masks or production training data.
license: Apache-2.0
allowed-tools: Bash
metadata:
  author: NVIDIA MedTech Team
  tags:
    - MedTech
    - MRI
    - generation
---

# NV-Generate-MR

## Purpose
- Used for generating synthetic body MRI volumes with NV-Generate-CTMR rflow-mr. Not for paired masks or production training data.
- Use the wrapper exactly as documented; do not replace the upstream entrypoint with a handwritten implementation.
- Do not write custom inference code for normal runs. The wrapper owns config staging, output paths, and validation.
- Manifest I/O: inputs are `model_config_override`; outputs are `synthetic_mr_volumes` and `result_json`.

## Instructions
- Read `skill_manifest.yaml` before changing arguments, side effects, or validation gates.
- Run `scripts/run_mr.py` through the documented command below; keep outputs under a caller-provided run directory.
- If a host agent exposes `run_script`, use `run_script("scripts/run_mr.py", args=[...])`; otherwise run the Bash/Python command shown below.
- Emit a single bash code block, and keep the `python -m pip install -r "$NV_GENERATE_ROOT/requirements.txt"` step in that same command — the runtime may be a fresh environment without `nibabel`/MONAI, so dropping the install fails with `ModuleNotFoundError`.
- Do not add `rm`, `mkdir`, or any cleanup of `--output-dir`; the wrapper creates it. Use a fresh `--output-dir` instead of deleting one.
- Check the emitted JSON and paired verifier guidance before treating the run as evidence.

## Available Scripts
| Script | Purpose | Arguments |
|---|---|---|
| `scripts/run_mr.py` | Primary entrypoint declared by skill_manifest.yaml. | `MODEL_CONFIG.json --output-dir OUT_DIR --modality mri_t1 [--random-seed N] [--yes]` |

## Prerequisites
- Runtime requirements: GPU/CUDA when declared by the manifest; Python packages listed in `runtime.side_effects.pip_packages`.
- Side effects: writes generated outputs under the caller's `--output-dir`, may cache model assets under `~/.cache/huggingface/`, and may contact `https://huggingface.co` or `https://github.com` during setup.
- Run commands from the repository root unless an existing section below says otherwise.

## Limitations
- This is a thin wrapper. Inference, sampling, and decoding are delegated entirely to NVIDIA-Medtech/NV-Generate-CTMR's `scripts.diff_model_infer`. Do not modify code under $NV_GENERATE_ROOT or the repo-local fallback at .workbench_data/upstreams/NV-Generate-CTMR.
- rflow-mr generates image-only synthetic MRI volumes. It does not emit paired segmentation masks.
- The upstream README recommends `rflow-mr-brain` instead for brain MRI synthesis; use `skills/nv-generate-mr-brain` for that path.
- NV-Generate-MR weights are listed by upstream as NVIDIA Non-Commercial. Do not use outputs as production training data without legal and quality review.
- Not for clinical deployment, clinical interpretation, autonomous diagnosis, regulatory submission.

## Troubleshooting
| Error | Cause | Fix |
|---|---|---|
| Missing dependency or import error | Runtime package drift from `skill_manifest.yaml`. | Install the packages declared in the manifest or use the documented setup command. |
| Empty or schema-invalid output | Wrong input path, unsupported modality, or upstream failure. | Re-run with a known fixture and inspect the wrapper JSON plus stderr. |
| Validation gate failure | Output violated a declared engineering invariant. | Keep the failed evidence pack and use the gate message to repair inputs or wrapper code. |

Wraps the upstream
[`NVIDIA-Medtech/NV-Generate-CTMR`](https://github.com/NVIDIA-Medtech/NV-Generate-CTMR#25-mr-image-generation)
MR image-only generation workflow. The wrapper does not reimplement diffusion
sampling or autoencoder decoding. It stages config overrides, runs the
documented `python -m scripts.diff_model_infer` command for `rflow-mr`, then
summarizes the generated NIfTI volume.


## Exact Runnable Surface

For user run commands in a fresh benchmark environment, use this setup plus
repo-root wrapper command exactly:

```bash
export NV_GENERATE_ROOT="${NV_GENERATE_ROOT:-.workbench_data/upstreams/NV-Generate-CTMR}" && \
python -m pip install -r "$NV_GENERATE_ROOT/requirements.txt" && \
python skills/nv-generate-mr/scripts/run_mr.py PATH_TO_MR_CONFIG.json --output-dir OUT_DIR --modality mri_t1 --random-seed 0
```

Do not invent `generate.sh`, `infer.py`, `Medical AI Skills run`, or `python -m nv_generate_mr` commands. `PATH_TO_MR_CONFIG.json` must be the user's supplied request path.

## Preconditions

Clone and install the upstream repo once. In this Medical AI Skills checkout, prefer
the repo-local cache path when it exists:

```bash
mkdir -p .workbench_data/upstreams
test -d .workbench_data/upstreams/NV-Generate-CTMR/.git || \
  git clone https://github.com/NVIDIA-Medtech/NV-Generate-CTMR.git \
    .workbench_data/upstreams/NV-Generate-CTMR
export NV_GENERATE_ROOT=.workbench_data/upstreams/NV-Generate-CTMR
pip install -r "$NV_GENERATE_ROOT/requirements.txt"
```

Download the MR weights:

```bash
cd "$NV_GENERATE_ROOT"
python -m scripts.download_model_data --version rflow-mr --root_dir ./ --model_only
```

Runtime needs an NVIDIA GPU with at least 16 GB VRAM. There is no CPU
fallback in the upstream path.

The wrapper also searches `.workbench_data/upstreams/NV-Generate-CTMR` if
`NV_GENERATE_ROOT` is unset or points at a stale clone.

For agent-generated user run commands, use the command in Usage. Do not prepend
clone or model-download setup steps when the repo-local upstream cache already
exists. In a fresh Python environment, still include
`pip install -r "$NV_GENERATE_ROOT/requirements.txt"` before the wrapper unless
the active environment has already proven those imports are available; cached
weights do not imply cached Python packages. If setup requires `cd "$NV_GENERATE_ROOT"`, return to the Medical AI Skills repo before invoking
`skills/nv-generate-mr/scripts/run_mr.py`.

## Usage

```bash
export NV_GENERATE_ROOT="${NV_GENERATE_ROOT:-.workbench_data/upstreams/NV-Generate-CTMR}" && \
python -m pip install -r "$NV_GENERATE_ROOT/requirements.txt" && \
python skills/nv-generate-mr/scripts/run_mr.py \
  PATH_TO_MR_CONFIG.json \
  --output-dir runs/nv_generate_mr_demo \
  --modality mri_t1 \
  --random-seed 0
```

Replace `PATH_TO_MR_CONFIG.json` with the user's actual request/config path.
Do not copy the fixture path from this document unless the user explicitly
asked to run that fixture. If the user says "the request is at
`runs/.../default_mri_t1.json`", that exact path is the first positional
argument to `scripts/run_mr.py`.

Supported rflow-mr modality names are `mri`, `mri_t1`, `mri_t2`, and
`mri_flair`, matching the upstream MR image-generation guide. The upstream
README recommends `rflow-mr-brain` instead when synthesizing brain images;
use `skills/nv-generate-mr-brain` for that path.
For FOV and setup details, see `references/fov-and-downloads.md`.

The fixture argument is a small JSON override for
`configs/config_maisi_diff_model_rflow-mr.json`. Pass `default` to use the
upstream defaults plus the CLI modality and random seed. Common override keys
are `dim`, `spacing`, `num_inference_steps`, `cfg_guidance_scale`, and
`modality`.

Each run records the staged config, model inventory, upstream command, output
geometry, spacing, affine, intensity range, and non-constant / finite-data
checks. Output volumes are synthetic and are not safe as production training
data without independent review.

Not for clinical interpretation, production deployment, autonomous diagnosis,
or regulatory submission.
