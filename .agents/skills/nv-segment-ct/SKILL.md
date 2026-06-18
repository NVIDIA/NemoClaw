---
name: nv-segment-ct
description: Used for running NV-Segment-CT VISTA3D on CT NIfTI volumes and recording label-map evidence.
license: Apache-2.0
allowed-tools: Bash
metadata:
  author: NVIDIA MedTech Team
  tags:
    - MedTech
    - CT
    - segmentation
---

# NV-Segment-CT

## Purpose
- Used for running NV-Segment-CT VISTA3D on CT NIfTI volumes and recording label-map evidence. Not for clinical interpretation.
- Use the wrapper exactly as documented; do not replace the upstream entrypoint with a handwritten implementation.
- Manifest I/O: inputs are `ct_volume`; outputs are `label_map` and `result_json`.

## Instructions
- Read `skill_manifest.yaml` before changing arguments, side effects, or validation gates.
- Run `scripts/run_vista3d.py` through the documented command below; keep outputs under a caller-provided run directory.
- If a host agent exposes `run_script`, use `run_script("scripts/run_vista3d.py", args=[...])`; otherwise run the Bash/Python command shown below.
- Check the emitted JSON and paired verifier guidance before treating the run as evidence.

## Available Scripts
| Script | Purpose | Arguments |
|---|---|---|
| `scripts/run_vista3d.py` | Primary entrypoint declared by skill_manifest.yaml. | `PATH_TO_CT.nii.gz [--output-dir OUT_DIR] [--label-prompts IDS]` |

## Prerequisites
- Runtime requirements: GPU/CUDA when declared by the manifest; Python packages listed in `runtime.side_effects.pip_packages`.
- Side effects: writes the downloaded bundle under `skills/nv-segment-ct/bundle/`, may cache model assets under `~/.cache/huggingface/`, and may contact `https://huggingface.co` during first setup; the optional spleen fixture fetcher downloads MSD09 from `https://msd-for-monai.s3-us-west-2.amazonaws.com`.
- Run commands from the repository root unless an existing section below says otherwise.

## Limitations
- This is a thin wrapper. Inference, preprocessing, and postprocessing are delegated entirely to the official `hugging_face_pipeline.HuggingFacePipelineHelper` in bundle/. Do not modify code under bundle/.
- transformers must be a 4.x release; the HF model code uses pre-5.x idioms (e.g. `_tied_weights_keys`).
- Device auto-detected (cuda if available, else cpu); `--device` flag overrides.
- Output may be schema-valid but semantically empty (e.g. label prompts that do not match the input anatomy). Sanity gates assert at least one foreground voxel per requested anatomy.
- Not for clinical deployment, clinical interpretation, autonomous diagnosis, regulatory submission.

## Troubleshooting
| Error | Cause | Fix |
|---|---|---|
| Missing dependency or import error | Runtime package drift from `skill_manifest.yaml`. | Install the packages declared in the manifest or use the documented setup command. |
| Empty or schema-invalid output | Wrong input path, unsupported modality, or upstream failure. | Re-run with a known fixture and inspect the wrapper JSON plus stderr. |
| Validation gate failure | Output violated a declared engineering invariant. | Keep the failed evidence pack and use the gate message to repair inputs or wrapper code. |

Wraps the upstream `nvidia/NV-Segment-CT` helper. The wrapper does not
reimplement VISTA3D inference.


## Exact Runnable Surface

For CT segmentation user runs, use this repo-root wrapper path exactly:

```bash
python skills/nv-segment-ct/scripts/run_vista3d.py PATH_TO_CT.nii.gz --label-prompts "1,3,5,14" --output-dir OUT_DIR
```

Do not invent `infer.py`, `Medical AI Skills run`, `python -m nv_segment_ct`, or anatomy-name-only flags. For spleen, liver, right kidney, and left kidney, the required VISTA3D label IDs are exactly `1,3,5,14`.

## Preconditions

The skill assumes a Python 3.12 environment with **no pre-installed
runtime deps** — its documented command installs everything it needs.
Pinned dep list is at [`requirements.txt`](./requirements.txt).

Two one-time downloads (the documented command does the first one; the
fixture fetch is a separate step you run when bootstrapping):

```bash
# Spleen example fixture from Decathlon MSD09 (~1.5 GB tar, ~11 MB
# fixture extracted into skills/nv-segment-ct/fixtures/spleen_03.nii.gz):
python skills/nv-segment-ct/fixtures/fetch_spleen_fixture.py
```

Both downloads (the bundle below, and the fixture) are gitignored
(Medical AI Skills policy: no medical data or model weights in git). The fetch
script is idempotent and caches the tar under
`.workbench_data/datasets/` so re-runs are no-ops.

Runtime needs an NVIDIA GPU with CUDA. CPU fallback is supported but slow.

## Usage

From Medical AI Skills repo root, run all steps in a single command so the
skill is self-bootstrapping against a fresh Python 3.12 venv:

```bash
pip install -r skills/nv-segment-ct/requirements.txt && \
huggingface-cli download nvidia/NV-Segment-CT \
  --local-dir skills/nv-segment-ct/bundle/ && \
python skills/nv-segment-ct/scripts/run_vista3d.py PATH_TO_CT.nii.gz \
  --label-prompts "1,3,5,14" \
  --output-dir vista3d_outputs
```

When the user names anatomies, translate them to VISTA3D class IDs before
running. For the common abdominal CT request:

| Anatomy | VISTA3D class ID |
|---|---:|
| liver | 1 |
| spleen | 3 |
| right kidney | 5 |
| left kidney | 14 |

For "segment the spleen, liver, right kidney, and left kidney", the correct
`--label-prompts` value is exactly `"1,3,5,14"`. Do not substitute kidney
IDs from another label dictionary; the wrapper validates the requested label
set and will mark the run invalid if the emitted mask contains labels outside
the requested set.

The `pip install` step is load-bearing: do not assume monai/torch/etc.
are already in the active environment. The `huggingface-cli download`
step is also part of the contract — it pulls the ~832 MB model bundle
into `skills/nv-segment-ct/bundle/` (cached after first run; subsequent
calls are no-ops).

`label-prompts` are VISTA3D class IDs. The evidence output records input
geometry, output mask path, observed label IDs, unexpected labels,
per-class voxel counts, per-class physical volumes computed from the output
mask header spacing, runtime, model identity, and fixed code-derived artifact
checks such as mask shape, affine match, label set, foreground count, and
class-volume bounds.

Pass `--ground-truth PATH` to record a reference label-map path under
`input.ground_truth_path`. The skill does not compute Dice; that is the
paired verifier's job.

Anatomy plausibility (per-class volume bounds, fragmentation, bilateral
symmetry, liver larger than spleen) and optional per-class Dice/IoU against
the recorded ground truth are checked by
`verifiers/ct_segmentation_quality_v1`.

Not for clinical interpretation, production deployment, or non-CT modalities.
