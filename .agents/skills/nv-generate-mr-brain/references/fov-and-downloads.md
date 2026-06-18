# FOV And Downloads

Use this reference when choosing NV-Generate-CTMR brain MR image-only settings.

## Field Of View

FOV is `dim * spacing` in millimeters. The recommended whole-brain target is:

| Target | `dim` | `spacing` |
|---|---:|---:|
| Whole brain or skull-stripped brain | `[256, 256, 256]` | `[1.0, 1.0, 1.0]` |

Keep dimensions as multiples of 32 and spacing positive. Use the
`nv-generate-mr` skill for non-brain body MR.

## Downloads

For brain MR image-only generation, download only the model weights:

```bash
python -m scripts.download_model_data --version rflow-mr-brain --root_dir ./ --model_only
```

This path does not use ControlNet, mask generation, or the CT mask database.
Cached model weights do not imply Python packages are installed. Fresh
benchmark environments should still run:

```bash
python -m pip install -r "$NV_GENERATE_ROOT/requirements.txt"
```
