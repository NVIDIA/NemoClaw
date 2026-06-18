# Curated fixture catalog — `nv_generate_ct_rflow`

Pre-authored `config_infer` override JSONs covering the most common
synthesis use cases. Pick one and pass it as the positional argument to
`scripts/run_rflow_ct.py`:

```bash
python skills/nv-generate-ct-rflow/scripts/run_rflow_ct.py \
  skills/nv-generate-ct-rflow/fixtures/<fixture>.json \
  --output-dir runs/<your-run-name> \
  --random-seed 0
```

All fixtures default to `output_size=[256,256,256]`, `num_inference_steps=30`,
`num_output_samples=1` so a single run completes in ~90 s on a 24 GB
GPU (RTX 6000 Ada, A6000, A5000, L40, etc.). Bump `output_size` /
`num_output_samples` in a copy of the fixture for higher-resolution or
batch runs. The upstream's `configs/config_infer_<vram>g_<dims>.json`
files show the VRAM brackets for larger outputs.

For the full set of anatomy names + region groupings, run:

```bash
python skills/nv-generate-ct-rflow/scripts/list_anatomies.py --region chest
python skills/nv-generate-ct-rflow/scripts/list_anatomies.py --filter tumor
python skills/nv-generate-ct-rflow/scripts/list_anatomies.py --controllable
```

## Fixtures

| File | body_region | Anatomy highlights | controllable | ~runtime |
|---|---|---|---|---|
| `default_config_infer.json` | chest | lung tumor | — | ~90 s |
| `chest_lung_lobes.json` | chest | 5 lung lobes + heart + airway (no tumor) | — | ~90 s |
| `chest_lung_tumor_controllable.json` | chest | lung tumor + lung lobes | lung tumor @ 0.5 | ~90 s |
| `abdomen_liver_spleen.json` | abdomen | liver, spleen, pancreas, kidneys, adrenals, gallbladder, stomach, aorta, IVC | — | ~90 s |
| `abdomen_hepatic_tumor.json` | abdomen | liver + hepatic tumor + hepatic vessel + spleen + kidneys + aorta + IVC | liver @ 0.7, hepatic tumor @ 0.3 | ~90 s |
| `head_brain.json` | head | brain, skull, spinal cord, trachea, thyroid, cervical spine (C1–C7) | — | ~90 s |
| `pelvis.json` | pelvis | bladder, prostate, sacrum, hips, iliac vessels, iliopsoas | — | ~90 s |

## Advanced helper fixtures

These support helper scripts in the same skill directory. They are not separate
catalog skills.

| File | Helper | Purpose |
|---|---|---|
| `ct_mask_lung_tumor.json` | `scripts/run_ct_mask.py` | Standalone raw MAISI mask diagnostic for `lung tumor -> 23` |
| `ct_from_mask_request_example.json` | `scripts/run_ct_from_mask.py` | Request template for CT image generation from an existing MAISI mask |
| `ct_image_only_default.json` | `scripts/run_ct_image.py` | CT image-only smoke config without paired labels |

## `controllable_anatomy_size` conventions

When you pass a non-empty `controllable_anatomy_size` list, the upstream
sampler **ignores `body_region` and `anatomy_list`** and conditions the
mask generator on the controllable spec alone (per
`$NV_GENERATE_ROOT/scripts/sample.py` warning at sampling start). The
list is `[[name, scale], ...]` where:

- `name` must be one of the 10 controllable anatomies — 5 organs
  (`liver, gallbladder, stomach, pancreas, colon`) or 5 tumors
  (`hepatic tumor, bone lesion, lung tumor, colon cancer primaries,
  pancreatic tumor`).
- `scale` is a float in `[0, 1]` indicating size on the population
  quantile scale (from `all_anatomy_size_conditions.json`), or `-1`
  to leave the size unconstrained.
- For `lung tumor`, use a scale around `0.5` or larger for curated
  examples. Local diagnostics found that smaller requests, such as `0.2`,
  can produce absent or extremely small label-23 components for some seeds.
- At most one tumor entry per request.
- Up to 10 entries total; names must be unique.

These constraints are validated by the wrapper's preflight checks
before the diffusion model loads — typos and out-of-range values fail
in milliseconds rather than after the 30 s model warm-up.

## Authoring your own fixture

Allowed keys are listed at the top of `scripts/run_rflow_ct.py` in the
`OVERRIDE_KEYS` tuple. Common ones:

- `num_output_samples` (int ≥ 1)
- `body_region` (list of: head, chest, thorax, abdomen, pelvis, lower)
- `anatomy_list` (list of label_dict names — see `list_anatomies.py`)
- `controllable_anatomy_size` (see conventions above)
- `output_size` (3-tuple, each dim a multiple of 32, ≤ 768)
- `spacing` (3-tuple of positive floats, mm/voxel)
- `num_inference_steps` (30 for rflow-ct, 1000 for ddpm-ct)

Pass any other key and the wrapper rejects it with a list of allowed
keys, so a typo never silently falls through to upstream defaults.
