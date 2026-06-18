# dicom_metadata_extract - Agent Guide

Smallest end-to-end skill. Use it as the layout template.

Rules:

- Keep output fields aligned with `validators/output_schema.json`.
- Extract only literal DICOM header values.
- Do not infer modality, body part, diagnosis, or clinical meaning.
- Keep the invalid-input example reachable from `examples/`.

Run:

```bash
make run-skill SKILL=dicom_metadata_extract \
  FIXTURE=skills/dicom-metadata-extract/fixtures/sample_ct.dcm \
  OUT=runs/dicom_metadata_demo
```
