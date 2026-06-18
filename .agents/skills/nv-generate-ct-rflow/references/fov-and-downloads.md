# FOV And Downloads

Use this reference when choosing CT paired generation dimensions or preparing
NV-Generate-CTMR assets.

## Field Of View

FOV is `output_size * spacing` in millimeters. Stay close to training-like FOVs
when possible; valid shapes can still produce poor samples if the FOV is out of
distribution.

Recommended CT paired targets:

| Target | `output_size` | `spacing` |
|---|---:|---:|
| Chest, single-slice axial coverage | `[512, 512, 128]` | `[0.78, 0.78, 4.0]` |
| Abdomen | `[512, 512, 256]` | `[1.0, 1.0, 1.5]` |
| Whole body | `[512, 512, 512]` | `[1.5, 1.5, 1.5]` |
| Long-axis whole body | `[512, 512, 768]` | `[1.5, 1.5, 1.5]` |
| Smoke/debug on 24 GB GPU | `[256, 256, 256]` | `[1.5, 1.5, 1.5]` or `[1.5, 1.5, 2.0]` |

Hard CT constraints from upstream:

- `output_size[0] == output_size[1]`
- `output_size[0]` is one of `256`, `384`, `512`
- `output_size[2]` is one of `128`, `256`, `384`, `512`, `640`, `768`
- `spacing[0] == spacing[1]`
- `spacing[0]` is in `[0.5, 3.0]`
- `spacing[2]` is in `[0.5, 5.0]`
- FOV in x/y must be at least 256 mm for head-only requests and at least
  384 mm for any non-head body-region/anatomy request

For controllable mask generation, the mask model is native to
`256x256x256` at `1.5 mm` isotropic. Requests far from that native grid force
nearest-neighbor resampling and can remove small labels such as tumors.

## Downloads

For paired CT generation, run the full CT download from `$NV_GENERATE_ROOT`:

```bash
python -m scripts.download_model_data --version rflow-ct --root_dir "./"
```

Do not use `--model_only` for paired CT runs. The full download provides:

- CT image autoencoder and diffusion weights
- ControlNet weights
- mask-generation autoencoder and diffusion weights
- `datasets/all_anatomy_size_conditions.json` for controllable mask generation
- mask candidate database and index for real-mask retrieval

Cached model weights do not imply Python packages are installed. Fresh
benchmark environments should still run:

```bash
python -m pip install -r "$NV_GENERATE_ROOT/requirements.txt"
```
