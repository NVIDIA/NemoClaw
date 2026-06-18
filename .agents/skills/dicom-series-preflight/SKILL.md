---
name: dicom-series-preflight
description: Used for header-only preflight of one DICOM series folder before conversion or inference. Not for de-identification or clinical clearance.
license: Apache-2.0
allowed-tools: Bash
metadata:
  author: NVIDIA MedTech Team
  tags:
    - MedTech
    - DICOM
    - preflight
---

# DICOM Series Preflight

## Purpose
- Used for header-only preflight of one DICOM series folder before conversion or inference. Not for de-identification or clinical clearance.
- Use the wrapper exactly as documented; do not replace the upstream entrypoint with a handwritten implementation.
- Manifest I/O: inputs are `dicom_dir`; outputs are `preflight_json`.

## Instructions
- Read `skill_manifest.yaml` before changing arguments, side effects, or validation gates.
- Run `scripts/preflight_series.py` through the documented command below; keep outputs under a caller-provided run directory.
- If a host agent exposes `run_script`, use `run_script("scripts/preflight_series.py", args=[...])`; otherwise run the Bash/Python command shown below.
- Check the emitted JSON and paired verifier guidance before treating the run as evidence.

## Available Scripts
| Script | Purpose | Arguments |
|---|---|---|
| `scripts/preflight_series.py` | Primary entrypoint declared by skill_manifest.yaml. | `PATH_TO_DICOM_DIR` |

## Prerequisites
- Runtime requirements: Python packages listed in `runtime.side_effects.pip_packages`.
- Run commands from the repository root unless an existing section below says otherwise.

## Limitations
- Header-only; does not decode pixel data or detect burnt-in PHI.
- Canonical orientation gate assumes LPS-derived CT axcodes L,P,S.
- Compressed transfer syntax and multi-frame instances are warned, not decoded.
- Single-directory scan; does not reconcile multiple studies in one tree.
- Not for clinical deployment, regulatory de-identification, autonomous diagnosis, production ingestion without a vetted converter.

## Troubleshooting
| Error | Cause | Fix |
|---|---|---|
| Missing dependency or import error | Runtime package drift from `skill_manifest.yaml`. | Install the packages declared in the manifest or use the documented setup command. |
| Empty or schema-invalid output | Wrong input path, unsupported modality, or upstream failure. | Re-run with a known fixture and inspect the wrapper JSON plus stderr. |
| Validation gate failure | Output violated a declared engineering invariant. | Keep the failed evidence pack and use the gate message to repair inputs or wrapper code. |

Scans a DICOM **directory** (one series per folder) without decoding pixels.
Emits JSON with inventory, orientation axcodes, PHI flags, findings, and a
`preflight.verdict` of `pass`, `warn`, or `fail`.

```bash
python scripts/preflight_series.py PATH_TO_DICOM_DIR
```

Pair with `verifiers/dicom_preflight_quality_v1` for a trusted preflight pack:

```bash
make run-trusted SKILL=dicom_series_preflight \
  FIXTURE=skills/dicom-series-preflight/fixtures/clean_no_phi \
  OUT=runs/dicom_preflight_demo
```

Flagship workflow:

```bash
make run-workflow \
  WORKFLOW=examples/workflows/dicom_preflight_gate.yaml \
  WORKFLOW_INPUT=skills/dicom-series-preflight/fixtures/clean_no_phi \
  WORKFLOW_OUT=runs/dicom_preflight_gate
```

Not for de-identification, private-tag review, or clinical clearance.
