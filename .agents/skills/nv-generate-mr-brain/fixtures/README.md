# Curated Fixture Catalog - `nv_generate_mr_brain`

Pass one fixture JSON as the positional argument to
`scripts/run_mr_brain.py`:

```bash
NV_GENERATE_ROOT=$HOME/NV-Generate-CTMR \
python skills/nv-generate-mr-brain/scripts/run_mr_brain.py \
  skills/nv-generate-mr-brain/fixtures/default_mri_t1.json \
  --output-dir runs/nv_generate_mr_brain_demo
```

Fixtures are config overrides only. They do not contain generated images,
patient data, or model weights.

| File | Modality | Notes |
|---|---|---|
| `default_mri_t1.json` | `mri_t1` | Whole-brain T1w, 256^3, 1 mm spacing |
| `mri_t2.json` | `mri_t2` | Whole-brain T2w, 256^3, 1 mm spacing |
| `mri_flair_skull_stripped.json` | `mri_flair_skull_stripped` | Skull-stripped FLAIR, 256^3, 1 mm spacing |

Valid modality names follow upstream `configs/modality_mapping.json`: `mri`,
`mri_t1`, `mri_t2`, `mri_flair`, `mri_swi`,
`mri_t1_skull_stripped`, `mri_t2_skull_stripped`,
`mri_flair_skull_stripped`, and `mri_swi_skull_stripped`.
