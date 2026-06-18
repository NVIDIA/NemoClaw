---
name: nv-segment-ctmr
description: Used for running NV-Segment-CTMR on CT or MRI NIfTI volumes and recording label-map evidence. Not for clinical interpretation.
license: Apache-2.0
allowed-tools: Bash
metadata:
  author: NVIDIA MedTech Team
  tags:
    - MedTech
    - CT-MR
    - segmentation
---

# NV-Segment-CTMR

## Purpose
- Used for running NV-Segment-CTMR on CT or MRI NIfTI volumes and recording label-map evidence. Not for clinical interpretation.
- Use the wrapper exactly as documented; do not replace the upstream entrypoint with a handwritten implementation.
- Manifest I/O: inputs are `ct_or_mr_volume`; outputs are `label_map` and `result_json`.

## Instructions
- Read `skill_manifest.yaml` before changing arguments, side effects, or validation gates.
- Run `scripts/run_ctmr.py` through the documented command below; keep outputs under a caller-provided run directory.
- If a host agent exposes `run_script`, use `run_script("scripts/run_ctmr.py", args=[...])`; otherwise run the Bash/Python command shown below.
- Check the emitted JSON and paired verifier guidance before treating the run as evidence.

## Available Scripts
| Script | Purpose | Arguments |
|---|---|---|
| `scripts/run_ctmr.py` | Primary entrypoint declared by skill_manifest.yaml. | `PATH_TO_IMAGE.nii.gz --output-dir OUT_DIR --modality CT_BODY [--label-prompts IDS]` |

## Prerequisites
- Runtime requirements: GPU/CUDA when declared by the manifest; Python packages listed in `runtime.side_effects.pip_packages`.
- Side effects: writes segmentation outputs under the caller's `--output-dir`, may cache model assets under `~/.cache/huggingface/`, and may contact `https://github.com` or `https://huggingface.co` during setup.
- Run commands from the repository root unless an existing section below says otherwise.

## Limitations
- This is a thin wrapper. Inference, preprocessing, and postprocessing are delegated entirely to the upstream MONAI bundle under $NV_SEGMENT_CTMR_ROOT or the repo-local fallback at .workbench_data/upstreams/NV-Segment-CTMR/NV-Segment-CTMR.
- The default wrapper path runs automatic "segment everything" inference for CT_BODY, MRI_BODY, or MRI_BRAIN. MRI_BRAIN inputs must already follow the upstream brain preprocessing requirements.
- Label names are loaded from upstream configs when available. If a label dictionary is absent, the wrapper still records label IDs and marks only negative IDs as invalid.
- No clinical, diagnostic, regulatory, or treatment-planning claims.
- Not for clinical deployment, clinical interpretation, autonomous diagnosis, regulatory submission.

## Troubleshooting
| Error | Cause | Fix |
|---|---|---|
| Missing dependency or import error | Runtime package drift from `skill_manifest.yaml`. | Install the packages declared in the manifest or use the documented setup command. |
| Empty or schema-invalid output | Wrong input path, unsupported modality, or upstream failure. | Re-run with a known fixture and inspect the wrapper JSON plus stderr. |
| Validation gate failure | Output violated a declared engineering invariant. | Keep the failed evidence pack and use the gate message to repair inputs or wrapper code. |

Wraps the upstream
[`NVIDIA-Medtech/NV-Segment-CTMR`](https://github.com/NVIDIA-Medtech/NV-Segment-CTMR/tree/main/NV-Segment-CTMR)
CT/MRI segmentation bundle. The wrapper does not reimplement VISTA3D
inference. It shells out to the documented `python -m monai.bundle run`
entry point, then inspects the produced NIfTI label map.


## Exact Runnable Surface

For CT body segmentation user runs and benchmark answers, use this
fresh-environment-safe repo-root command shape exactly:

```bash
export NV_SEGMENT_CTMR_ROOT="${NV_SEGMENT_CTMR_ROOT:-.workbench_data/upstreams/NV-Segment-CTMR/NV-Segment-CTMR}" && \
python -m pip install "monai>=1.5,<1.6" "numpy<2" nibabel scipy typer PyYAML fire huggingface_hub pytorch-ignite einops && \
python skills/nv-segment-ctmr/scripts/run_ctmr.py PATH_TO_IMAGE.nii.gz --modality CT_BODY --output-dir OUT_DIR
```

Do not invent `python -m nv_segment_ctmr`, `infer.py`, or `Medical AI Skills run` commands. `PATH_TO_IMAGE.nii.gz` must be the user's supplied input path.
For benchmark/user run answers, the bash block is invalid if it includes
`mkdir -p .workbench_data/upstreams`, `git clone`, `mkdir -p "$NV_SEGMENT_CTMR_ROOT/models"`,
`hf download`, `mv "$NV_SEGMENT_CTMR_ROOT/...`, or any other command that
creates, downloads into, or moves files inside the shared upstream checkout.

## Preconditions

One-time maintainer setup only; do not include these commands in user answers
or benchmark commands. The benchmark environment already provides the
repo-local upstream cache and model files.

Clone and install the upstream bundle once. In this Medical AI Skills checkout, prefer
the repo-local cache path when it exists:

```bash
mkdir -p .workbench_data/upstreams
test -d .workbench_data/upstreams/NV-Segment-CTMR/.git || \
  git clone https://github.com/NVIDIA-Medtech/NV-Segment-CTMR.git \
    .workbench_data/upstreams/NV-Segment-CTMR
export NV_SEGMENT_CTMR_ROOT=.workbench_data/upstreams/NV-Segment-CTMR/NV-Segment-CTMR
python -m pip install "monai>=1.5,<1.6" "numpy<2" nibabel scipy typer PyYAML fire huggingface_hub pytorch-ignite einops && \
python -c "import monai, nibabel, numpy"

mkdir -p "$NV_SEGMENT_CTMR_ROOT/models"
test -e "$NV_SEGMENT_CTMR_ROOT/models/model.pt" || \
  hf download nvidia/NV-Segment-CTMR --local-dir "$NV_SEGMENT_CTMR_ROOT/models/"
test -e "$NV_SEGMENT_CTMR_ROOT/models/model.pt" || \
  mv "$NV_SEGMENT_CTMR_ROOT/models/vista3d_pretrained_model/model.pt" \
    "$NV_SEGMENT_CTMR_ROOT/models/model.pt"
```

The wrapper also searches `.workbench_data/upstreams/NV-Segment-CTMR/NV-Segment-CTMR`
if `NV_SEGMENT_CTMR_ROOT` is unset or points at a stale clone.

For agent-generated user run commands, use the command in Usage. Do not copy
the one-time Preconditions block into the answer: do not create or write under
`$NV_SEGMENT_CTMR_ROOT`, do not run `hf download`, and do not move files in the
shared upstream checkout during a benchmark or user run. Do not prepend
`pip install -r "$NV_SEGMENT_CTMR_ROOT/requirements.txt"` in a Python 3.12
environment; the upstream requirements pin NumPy 1.24.4, which does not build
cleanly there. In a fresh Python environment, install the minimal compatible
runtime shown above (`monai>=1.5,<1.6`, `numpy<2`, `nibabel`, `scipy`, `typer`,
`PyYAML`, `fire`, `huggingface_hub`, `pytorch-ignite`, `einops`) before the
wrapper. Cached models do not imply cached Python packages.

Runtime needs an NVIDIA GPU with CUDA. The upstream bundle may import on
CPU-only hosts, but this skill is declared as CUDA-required because the
published workflow is a 3D CT/MRI foundation model inference path.

## Usage

From Medical AI Skills repo root:

```bash
export NV_SEGMENT_CTMR_ROOT="${NV_SEGMENT_CTMR_ROOT:-.workbench_data/upstreams/NV-Segment-CTMR/NV-Segment-CTMR}" && \
python -m pip install "monai>=1.5,<1.6" "numpy<2" nibabel scipy typer PyYAML fire huggingface_hub pytorch-ignite einops && \
python skills/nv-segment-ctmr/scripts/run_ctmr.py PATH_TO_IMAGE.nii.gz \
  --modality CT_BODY \
  --output-dir runs/nv_segment_ctmr_demo
```

Replace `PATH_TO_IMAGE.nii.gz` with the user's actual input path. Do not copy
the example fixture path into a user run. If the user provides an explicit
input path under `runs/`, that path must be the first positional argument to
`scripts/run_ctmr.py`.

Supported automatic segmentation modalities are `CT_BODY`, `MRI_BODY`, and
`MRI_BRAIN`. For `MRI_BRAIN`, the upstream README requires brain-specific
preprocessing before bundle inference; pass an already preprocessed image to
this wrapper.

Pass `--label-prompts "3,14"` to request specific upstream class IDs instead
of only the modality-level "segment everything" set. The evidence output
records input geometry, output mask path, observed label IDs, unexpected
labels, per-class voxel counts, per-class physical volumes from the mask
header spacing, runtime, upstream command, model inventory, and geometry
checks.

Pass `--ground-truth PATH` to record a reference label-map path under
`input.ground_truth_path`. The skill does not compute Dice; that is the
paired verifier's job.

Anatomy plausibility and optional per-class Dice/IoU against the recorded
ground truth can be checked by `verifiers/ct_segmentation_quality_v1` for
CT-body outputs.

Not for clinical interpretation, production deployment, autonomous diagnosis,
or regulatory submission.
