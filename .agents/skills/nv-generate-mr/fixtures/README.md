# Curated Fixture Catalog - `nv_generate_mr`

Pass one fixture JSON as the positional argument to `scripts/run_mr.py`:

```bash
NV_GENERATE_ROOT=$HOME/NV-Generate-CTMR \
python skills/nv-generate-mr/scripts/run_mr.py \
  skills/nv-generate-mr/fixtures/default_mri_t1.json \
  --output-dir runs/nv_generate_mr_demo
```

Fixtures are config overrides only. They do not contain generated images,
patient data, or model weights.

| File | Modality | Notes |
|---|---|---|
| `default_mri_t1.json` | `mri_t1` | Upstream default rflow-mr geometry |
| `mri_t2.json` | `mri_t2` | Same geometry, T2 contrast code |
| `mri_flair.json` | `mri_flair` | Same geometry, FLAIR contrast code |

The upstream rflow-mr guide lists T1/T2 brain, FLAIR skull-stripped brain,
T2 prostate, T1 breast, and T1/T2 abdomen as supported use cases, with
contrast selected by `modality`. For brain-specific synthesis, prefer
`skills/nv-generate-mr-brain`.
