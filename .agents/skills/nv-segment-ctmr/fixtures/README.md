# Fixtures

This skill intentionally does not commit NIfTI volumes, model weights, or
patient-derived data.

For a quick CT-body smoke run, bootstrap the public Decathlon spleen fixture
used by `skills/nv-segment-ct`:

```bash
python skills/nv-segment-ct/fixtures/fetch_spleen_fixture.py
NV_SEGMENT_CTMR_ROOT=$HOME/NV-Segment-CTMR/NV-Segment-CTMR \
python skills/nv-segment-ctmr/scripts/run_ctmr.py \
  skills/nv-segment-ct/fixtures/spleen_03.nii.gz \
  --modality CT_BODY \
  --output-dir runs/nv_segment_ctmr_demo
```

The fixture fetcher keeps downloaded data out of git.
