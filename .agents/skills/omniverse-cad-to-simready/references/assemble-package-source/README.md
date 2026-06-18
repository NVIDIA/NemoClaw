# Assemble Package Source

## When to Use

Use this reference after SimReady conformance and final rendering, before
`nv-core-package-sample`. It builds the clean package source directory described
by the package-output RFC:

```text
pipeline workspace
-> final conformed USD + thumbnail
-> deliverable/simready_usd/
-> nv-core-package-sample
```

This reference does not create package metadata. It prepares the self-contained
`deliverable/` source folder that packaging consumes.

## Inputs

Collect:

| Input | Requirement |
|---|---|
| `final_usd` | Required final conformed `.usd`, `.usda`, or `.usdc` layer. |
| `output_root` | Required workflow output root. The script creates `deliverable/` and writes the default report under `pipeline/`. |
| `asset_name` | Optional package asset name. If omitted, derive it from `final_usd`. Normalize to lowercase underscores. |
| `thumbnail` | Required final render PNG from `ovrtx-render-service`. |

## Instructions

1. Confirm `final_usd` and `thumbnail` exist.
2. Create `{output_root}/deliverable/simready_usd/`.
3. Copy `final_usd` to the canonical root USD path:
   `simready_usd/sm_{asset_name}_01.usd`.
4. Inspect USD layers and authored asset paths with OpenUSD APIs.
5. Copy local USD layer dependencies, textures, MDL files, and sidecar assets
   into `deliverable/simready_usd/`.
6. Rewrite package-local asset paths in copied USD layers.
7. Copy the thumbnail to
   `simready_usd/.thumbs/256x256/{root_usd_filename}.png`.
8. Run a self-containment check over USD composition dependencies and authored
   `Sdf.AssetPath` values.
9. Write a JSON assembly report.

Do not pass the workflow output root to `nv-core-package-sample`. Pass
`{output_root}/deliverable` with root USD
`simready_usd/sm_{asset_name}_01.usd`.

## CLI Pattern

```bash
python3 /path/to/skills/omniverse-cad-to-simready/references/assemble-package-source/scripts/run.py \
  /path/to/output_root/pipeline/04_conform/fet005_grasp/output.usd \
  /path/to/output_root \
  --asset-name coffee_mug \
  --thumbnail /path/to/output_root/pipeline/06_render/thumbnail.png \
  --report /path/to/output_root/pipeline/assembly-report.json
```

Then package the clean source:

```bash
python3 /path/to/skills/omniverse-cad-to-simready/references/nv-core-package-sample/scripts/run.py \
  /path/to/output_root/deliverable \
  --name coffee_mug \
  --version 1.0.0 \
  --license LicenseRef-Proprietary \
  --root-usd simready_usd/sm_coffee_mug_01.usd \
  --report /path/to/output_root/pipeline/07_package/package-create.json
```

## Output Format

The report includes:

- `skill`
- `operation`
- `passed`
- `status`
- `asset_name`
- `output_root`
- `deliverable_root`
- `root_usd_path`
- `root_usd_relative_path`
- `thumbnail_path`
- `copied_files`
- `rewritten_paths`
- `checks`
- `warnings`
- `errors`
- `next_step`

## Pass/Fail Policy

Fail when:

- the final USD or thumbnail is missing
- OpenUSD cannot open the final assembled root USD
- a local authored asset path cannot be resolved
- an authored dependency resolves outside `deliverable/`
- a referenced file is missing after assembly

Warn when:

- a URI-style dependency such as `omniverse://`, `http://`, or `https://` is
  encountered and left for a future resolver-specific workflow
- an existing deliverable is overwritten with `--overwrite`

## Next Steps

Run `nv-core-package-sample` on `{output_root}/deliverable` with
`--root-usd simready_usd/sm_{asset_name}_01.usd`, then run
`nv-core-package-sample-validation` on the generated package definition.
