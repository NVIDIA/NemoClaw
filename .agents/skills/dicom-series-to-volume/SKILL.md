---
name: dicom-series-to-volume
description: Used for converting one CT DICOM series folder to a HU NIfTI volume with affine evidence. Not for multi-frame DICOM or clinical use.
license: Apache-2.0
allowed-tools: Bash
metadata:
  author: NVIDIA MedTech Team
  tags:
    - MedTech
    - DICOM
    - NIfTI
---

# dicom_series_to_volume

## Purpose
- Used for converting one CT DICOM series folder to a HU NIfTI volume with affine evidence. Not for multi-frame DICOM or clinical use.
- Use the wrapper exactly as documented; do not replace the upstream entrypoint with a handwritten implementation.
- Manifest I/O: inputs are `dicom_dir`; outputs are `nifti_volume` and `result_json`.

## Instructions
- Read `skill_manifest.yaml` before changing arguments, side effects, or validation gates.
- Run `scripts/series_to_volume.py` through the documented command below; keep outputs under a caller-provided run directory.
- If a host agent exposes `run_script`, use `run_script("scripts/series_to_volume.py", args=[...])`; otherwise run the Bash/Python command shown below.
- Check the emitted JSON and the paired `dicom_volume_quality_v1` verifier before treating the run as evidence.

## Available Scripts
| Script | Purpose | Arguments |
|---|---|---|
| `scripts/series_to_volume.py` | Primary entrypoint declared by skill_manifest.yaml. | `PATH_TO_DICOM_DIR [--output OUT.nii.gz]` |

## Prerequisites
- Runtime requirements: Python packages listed in `runtime.side_effects.pip_packages`.
- Run commands from the repository root unless an existing section below says otherwise.

## Limitations
- Single-series only; multi-series input is rejected at preflight.
- Multi-frame DICOM (NumberOfFrames > 1 per file) not supported.
- Compressed transfer syntaxes (JPEG / JPEG2000 / RLE) not supported.
- No voxel reorientation. The affine is derived from DICOM headers and represented in NIfTI/RAS coordinates; a downstream gate (e.g. expected_axcodes) is expected to assert orientation before this volume is fed to a segmentation model.
- Not for clinical deployment, autonomous diagnosis, regulatory submission, production inference (use a vetted converter such as dcm2niix for that).

## Troubleshooting
| Error | Cause | Fix |
|---|---|---|
| Missing dependency or import error | Runtime package drift from `skill_manifest.yaml`. | Install the packages declared in the manifest or use the documented setup command. |
| Empty or schema-invalid output | Wrong input path, unsupported modality, or upstream failure. | Re-run with a known fixture and inspect the wrapper JSON plus stderr. |
| Validation gate failure | Output violated a declared engineering invariant. | Keep the failed evidence pack and use the gate message to repair inputs or wrapper code. |

Reads one DICOM series, sorts slices by `ImagePositionPatient`, applies
`RescaleSlope` and `RescaleIntercept`, builds an affine from orientation and
spacing tags, and writes a `.nii.gz` plus JSON summary.

```bash
python scripts/series_to_volume.py PATH_TO_DICOM_DIR --output PATH_TO_OUT.nii.gz
```

For a trusted run with the paired verifier:

```bash
python -m eval_engine.run_trusted skills/dicom-series-to-volume \
  --fixture PATH_TO_DICOM_DIR \
  --out runs/dicom_series_to_volume_trusted
```

Key output fields: `n_slices`, `series_instance_uid`, `output.path`,
`output.shape`, `output.spacing`, `output.axcodes`, `output.affine`,
`hu_range`, and `runtime.conversion_seconds`.

Scope limits: single-series CT only; no multi-frame DICOM, compressed transfer
syntax handling, RT structure sets, auto-reorientation, or clinical use.
