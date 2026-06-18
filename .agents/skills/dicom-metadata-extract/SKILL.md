---
name: dicom-metadata-extract
description: Used for extracting selected metadata from one DICOM file and flagging standard-tag PHI presence. Not for anonymization or clinical use.
license: Apache-2.0
allowed-tools: Bash
metadata:
  author: NVIDIA MedTech Team
  tags:
    - MedTech
    - DICOM
    - metadata
---

# DICOM Metadata Extract

## Purpose
- Used for extracting selected metadata from one DICOM file and flagging standard-tag PHI presence. Not for anonymization or clinical use.
- Use the wrapper exactly as documented; do not replace the upstream entrypoint with a handwritten implementation.
- Manifest I/O: inputs are `dicom_path`; outputs are `metadata_json`.

## Instructions
- Read `skill_manifest.yaml` before changing arguments, side effects, or validation gates.
- Run `scripts/extract_metadata.py` through the documented command below; keep outputs under a caller-provided run directory.
- If a host agent exposes `run_script`, use `run_script("scripts/extract_metadata.py", args=[...])`; otherwise run the Bash/Python command shown below.
- Check the emitted JSON and run `medagent.verifiers.dicom_metadata_quality_v1` on evidence packs before treating the run as reviewed evidence.

## Available Scripts
| Script | Purpose | Arguments |
|---|---|---|
| `scripts/extract_metadata.py` | Primary entrypoint declared by skill_manifest.yaml. | `PATH_TO_DICOM [--output OUT.json]` |

## Prerequisites
- Runtime requirements: Python packages listed in `runtime.side_effects.pip_packages`.
- Run commands from the repository root unless an existing section below says otherwise.

## Limitations
- Small PS3.15-inspired standard-tag subset only; not a complete Basic Application Confidentiality Profile implementation.
- Private tags not checked
- Burnt-in pixel PHI not detected
- Multi-frame handling minimal
- Not for clinical deployment, regulatory de-identification, autonomous diagnosis, patient-facing use.

## Troubleshooting
| Error | Cause | Fix |
|---|---|---|
| Missing dependency or import error | Runtime package drift from `skill_manifest.yaml`. | Install the packages declared in the manifest or use the documented setup command. |
| Empty or schema-invalid output | Wrong input path, unsupported modality, or upstream failure. | Re-run with a known fixture and inspect the wrapper JSON plus stderr. |
| Validation gate failure | Output violated a declared engineering invariant. | Keep the failed evidence pack and use the gate message to repair inputs or wrapper code. |

Reads one DICOM file with pydicom and emits JSON on stdout.

```bash
python scripts/extract_metadata.py PATH_TO_DICOM
python scripts/extract_metadata.py PATH_TO_DICOM --output result.json
```

Output includes `transfer_syntax`, `modality`, grouped study/series/image
metadata, `phi_present`, and `phi_tags_found`.

Use this as the smallest end-to-end example of a Medical AI Skills skill. Do not use
it for anonymization, private-tag review, pixel PHI detection, or clinical
interpretation.

For second-pass evidence review, generate a trusted run:

```bash
python -m eval_engine.run_trusted skills/dicom-metadata-extract \
  --fixture skills/dicom-metadata-extract/fixtures/sample_ct.dcm \
  --out runs/dicom_metadata_trusted
```
