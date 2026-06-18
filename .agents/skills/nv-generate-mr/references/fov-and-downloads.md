# FOV And Downloads

Use this reference when choosing NV-Generate-CTMR body MR image-only settings.

## Field Of View

FOV is `dim * spacing` in millimeters. The upstream model validates broad
shape/spacing bounds, but quality is best near training-like FOVs.

Recommended body MR target:

| Target | `dim` | `spacing` |
|---|---:|---:|
| Body MR smoke/default | `[128, 256, 256]` | `[1.25, 1.0, 1.0]` |

Wrapper validation additionally keeps total voxels at or below
`512 * 512 * 128`, requires each dimension to be a multiple of 32, and requires
positive spacing.

## Downloads

For body MR image-only generation, download only the model weights:

```bash
python -m scripts.download_model_data --version rflow-mr --root_dir ./ --model_only
```

This path does not use ControlNet, mask generation, or the CT mask database.
Cached model weights do not imply Python packages are installed. Fresh
benchmark environments should still run:

```bash
python -m pip install -r "$NV_GENERATE_ROOT/requirements.txt"
```
