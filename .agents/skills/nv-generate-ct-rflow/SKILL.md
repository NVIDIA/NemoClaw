---
name: nv-generate-ct-rflow
description: Used for generating synthetic CT volumes and masks with NV-Generate-CTMR rflow-ct. Not for production training data without review.
license: Apache-2.0
allowed-tools: Bash
metadata:
  author: NVIDIA MedTech Team
  tags:
    - MedTech
    - CT
    - generation
---

# NV-Generate-CT (rflow-ct)

## Purpose
- Used for generating synthetic CT volumes and masks with NV-Generate-CTMR rflow-ct. Not for production training data without review.
- Use the wrapper exactly as documented; do not replace the upstream entrypoint with a handwritten implementation.
- Do not write custom inference code for normal runs. The wrapper owns config staging, output paths, label mapping evidence, and validation.
- Manifest I/O: inputs are `config_infer_override`; outputs are `synthetic_ct_volumes` and `result_json`.

## Instructions
- Read `skill_manifest.yaml` before changing arguments, side effects, or validation gates.
- Run `scripts/run_rflow_ct.py` through the documented command below; keep outputs under a caller-provided run directory.
- If a host agent exposes `run_script`, use `run_script("scripts/run_rflow_ct.py", args=[...])`; otherwise run the Bash/Python command shown below.
- Emit a single bash code block, and keep the `python -m pip install -r "$NV_GENERATE_ROOT/requirements.txt"` step in that same command — the runtime may be a fresh environment without `nibabel`/MONAI, so dropping the install fails with `ModuleNotFoundError`.
- Do not add `rm`, `mkdir`, or any cleanup of `--output-dir`; the wrapper creates it. Use a fresh `--output-dir` instead of deleting one.
- Check the emitted JSON and paired verifier guidance before treating the run as evidence.

## Available Scripts
| Script | Purpose | Arguments |
|---|---|---|
| `scripts/_anatomy.py` | Internal helper used by the primary entrypoint. | Imported only; do not call directly. |
| `scripts/_summary_card.py` | Internal helper used by the primary entrypoint. | Imported only; do not call directly. |
| `scripts/list_anatomies.py` | Helper command for catalog or anatomy lookup. | `[--region REGION] [--filter TEXT] [--controllable]` |
| `scripts/run_rflow_ct.py` | Primary entrypoint declared by skill_manifest.yaml. | `CONFIG_INFER.json --output-dir OUT_DIR [--random-seed N] [--version rflow-ct] [--yes]` |
| `scripts/run_ct_mask.py` | Advanced diagnostic helper for standalone raw MAISI mask generation. | `REQUEST.json --output-dir OUT_DIR [--random-seed N] [--preflight-only] [--yes]` |
| `scripts/run_ct_from_mask.py` | Advanced helper for CT image generation from a MAISI label mask. | `REQUEST.json --output-dir OUT_DIR [--random-seed N] [--yes]` |
| `scripts/run_ct_image.py` | Advanced helper for CT image-only generation without paired labels. | `MODEL_CONFIG.json --output-dir OUT_DIR [--version rflow-ct] [--random-seed N] [--yes]` |

## Prerequisites
- Required environment variables: `NV_GENERATE_ROOT`.
- Runtime requirements: GPU/CUDA when declared by the manifest; Python packages listed in `runtime.side_effects.pip_packages`.
- Side effects: writes generated outputs under the caller's `--output-dir`, may cache model assets under `~/.cache/huggingface/`, and may contact `https://huggingface.co` or `https://github.com` during setup.
- Run commands from the repository root unless an existing section below says otherwise.

## Limitations
- This is a thin wrapper. Inference, sampling, and decoding are delegated entirely to NVIDIA-Medtech/NV-Generate-CTMR's `scripts.inference`. Do not modify code under $NV_GENERATE_ROOT.
- rflow-ct requires CUDA and ≈ 16 GB VRAM minimum for the default 256³ output_size. Larger output_size (e.g. 512×512×768) needs an A100/H100.
- Output volumes are synthetic. They are not safe to use as training data for production medtech models without an independent quality review.
- Not for clinical deployment, clinical interpretation, autonomous diagnosis, regulatory submission.

## Troubleshooting
| Error | Cause | Fix |
|---|---|---|
| Missing dependency or import error | Runtime package drift from `skill_manifest.yaml`. | Install the packages declared in the manifest or use the documented setup command. |
| Empty or schema-invalid output | Wrong input path, unsupported modality, or upstream failure. | Re-run with a known fixture and inspect the wrapper JSON plus stderr. |
| Validation gate failure | Output violated a declared engineering invariant. | Keep the failed evidence pack and use the gate message to repair inputs or wrapper code. |

Wraps the upstream
[`NVIDIA-Medtech/NV-Generate-CTMR`](https://github.com/NVIDIA-Medtech/NV-Generate-CTMR)
rectified-flow synthesis pipeline. The wrapper does not reimplement diffusion,
sampling, or autoencoder decoding — it shells out to the upstream
`scripts.inference` entry point exactly as the project's README documents and
inspects the produced image/mask pairs.

## Preconditions

1. Clone the upstream repo and point `NV_GENERATE_ROOT` at it (one-time):

   ```bash
   test -d "$HOME/nv-generate-ctmr/.git" || \
     git clone https://github.com/NVIDIA-Medtech/NV-Generate-CTMR.git $HOME/nv-generate-ctmr
   export NV_GENERATE_ROOT=$HOME/nv-generate-ctmr
   pip install -r "$NV_GENERATE_ROOT/requirements.txt"
   ```

2. Download the `rflow-ct` weights **and** the mask-candidate datasets
   into the clone (one-time, ≈ 5.5 GB):

   ```bash
   cd "$NV_GENERATE_ROOT"
   python -m scripts.download_model_data --version rflow-ct --root_dir "./"
   ```

   The mask candidates (`datasets/all_masks_flexible_size_and_spacing_4000`)
   condition the diffusion sampler; omitting them via `--model_only` will
   make the inference script fail with a missing-file error at startup.
   The anatomy-size condition file is also part of the full CT download and is
   needed for controllable mask generation.

3. NVIDIA GPU with ≥ 16 GB VRAM and CUDA. There is no CPU fallback.

For agent-generated user run commands, prefer the short wrapper command in
Usage. Do not prepend clone or model-download setup steps when `NV_GENERATE_ROOT`
or the repo-local upstream cache is already present. In a fresh Python
environment, still include `pip install -r "$NV_GENERATE_ROOT/requirements.txt"`
before the wrapper unless the active environment has already proven those
imports are available; cached weights do not imply cached Python packages. Run
the wrapper from the medical-AI-skills repo root. If setup requires `cd "$NV_GENERATE_ROOT"`, return to the Medical AI Skills repo before invoking
`skills/nv-generate-ct-rflow/scripts/run_rflow_ct.py`.

## Usage

```bash
export NV_GENERATE_ROOT="${NV_GENERATE_ROOT:-$HOME/nv-generate-ctmr}" && \
python -m pip install -r "$NV_GENERATE_ROOT/requirements.txt" && \
python skills/nv-generate-ct-rflow/scripts/run_rflow_ct.py \
  PATH_TO_CONFIG_INFER.json \
  --output-dir runs/nv_generate_ct_rflow_demo \
  --random-seed 0 \
  --version rflow-ct
```

Replace `PATH_TO_CONFIG_INFER.json` with the user's actual request/config
path. Do not copy the fixture path from this document unless the user
explicitly asked to run that fixture. If the user says "the case request is at
`runs/.../chest_lung_tumor_controllable.json`", that exact path is the first
positional argument to `scripts/run_rflow_ct.py`.

The fixture argument is a `config_infer.json` override file: it can replace
`num_output_samples`, `body_region`, `anatomy_list`, `controllable_anatomy_size`,
`output_size`, and `spacing`. Pass `default` to use the upstream config
verbatim. The wrapper stages the override into the upstream tree before
running.

### Fixture catalog

`fixtures/` ships curated configs for common paired synthesis use cases: chest
lung lobes, chest with controllable lung tumor, abdomen solid organs,
abdomen with controllable hepatic tumor, head + cervical spine, pelvis.
See [`fixtures/README.md`](fixtures/README.md) for the full table.

### Helper commands

```bash
# Browse the 132-class label_dict grouped by body region.
python skills/nv-generate-ct-rflow/scripts/list_anatomies.py --region chest
python skills/nv-generate-ct-rflow/scripts/list_anatomies.py --controllable
python skills/nv-generate-ct-rflow/scripts/list_anatomies.py --filter tumor

# Validate a fixture and preview cost without launching inference.
NV_GENERATE_ROOT=$HOME/nv-generate-ctmr \
  python skills/nv-generate-ct-rflow/scripts/run_rflow_ct.py \
    skills/nv-generate-ct-rflow/fixtures/abdomen_liver_spleen.json \
    --output-dir runs/preview --preflight-only
```

Advanced helpers stay inside this skill for debugging and less-common CT
generation modes. Use them only when the user explicitly asks for that mode:

```bash
# Raw MAISI mask diagnostic, useful for checking lung tumor -> label 23.
python skills/nv-generate-ct-rflow/scripts/run_ct_mask.py \
  skills/nv-generate-ct-rflow/fixtures/ct_mask_lung_tumor.json \
  --output-dir runs/ct_mask_debug --preflight-only

# CT image from an existing MAISI label mask with body label 200.
python skills/nv-generate-ct-rflow/scripts/run_ct_from_mask.py \
  skills/nv-generate-ct-rflow/fixtures/ct_from_mask_request_example.json \
  --output-dir runs/ct_from_mask_demo

# CT image-only generation without paired labels.
python skills/nv-generate-ct-rflow/scripts/run_ct_image.py \
  skills/nv-generate-ct-rflow/fixtures/ct_image_only_default.json \
  --output-dir runs/ct_image_only_demo --version rflow-ct
```

The wrapper runs preflight on every invocation (regardless of
`--preflight-only`): config-schema bounds, anatomy names matched
against the upstream label_dict, body_region in the supported set,
controllable_anatomy_size constraints, upstream CT output-size/spacing
contracts, body-region-aware x/y FOV minimums, dataset presence under
`$NV_GENERATE_ROOT/datasets/`, CUDA available, and an estimated peak VRAM /
wall-time. Runs estimated to exceed 5 min wall-time or 30 GB VRAM peak require
`--yes` to proceed.

Each invocation runs `python -m scripts.inference -t configs/config_network_rflow.json
-i configs/config_infer.json -e configs/environment_rflow-ct.json --random-seed <s>
--version rflow-ct`. Output evidence records the upstream git commit, model
checkpoint hashes, the rendered config, per-sample image/mask geometry, mask
label set, image HU range summary, and per-class voxel volumes.

When `controllable_anatomy_size` is non-empty, upstream ignores the broader
`anatomy_list` for the saved paired label map and filters labels to the
controllable anatomy names. The saved paired label values are local `1..N`
ordinals, not raw MAISI label IDs. Read `output.output_label_mapping` in
`result_json` to map saved output labels back to source labels; for example,
output label `1` can represent MAISI label `23` (`lung tumor`).
For curated lung-tumor examples, prefer a controllable size around `0.5` or
larger; smaller requests such as `0.2` can produce absent or extremely small
label-23 components for some seeds.

For FOV and setup details, see `references/fov-and-downloads.md`. For
advanced helper label-space details, see
`references/ct-mask-label-space.md` and `references/ct-from-mask-format.md`.

### Visual sample card

Alongside the NIfTI pairs, the wrapper writes `summary.html` to the
output directory: a per-sample mid-slice triptych (axial / coronal /
sagittal) with label overlay, plus a table of the rendered config and
verifier-facing aggregates. Lets you eyeball the result without firing
up 3D Slicer. Pass `--no-summary-card` to skip.

Anatomy plausibility (label-set sanity, voxel HU range as CT, image/mask
geometry match, declared output labels present, lung-lobe HU floor) is checked by
`verifiers/ct_synthesis_quality_v1`.

Not for clinical interpretation, training data for production deployment, or
any non-synthetic-research use.
