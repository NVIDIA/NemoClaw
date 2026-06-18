# Convert Gaussian Splat to USD

## When to Use

Use this reference for installed Gaussian splat routing, command execution, conversion reports, and validation handoff. It is for Gaussian splat source assets, not general polygon mesh assets.

The generated USD should be handed to `validate-usd-minimum` before any deeper validation.

## Upstream Reference

Use the upstream NVIDIA Omniverse `usd-convert-gsplat` skill as the authoritative reference for converter behavior, supported Gaussian splat fields, schema mapping, and converter-specific CLI/API options:

- Upstream skill: `https://github.com/NVIDIA-Omniverse/usd-convert-gsplat/blob/main/.agents/skills/usd-convert-gsplat/SKILL.md`
- Upstream repository: `https://github.com/NVIDIA-Omniverse/usd-convert-gsplat`
- NVIDIA Omniverse gsplat-converter docs: `https://docs.omniverse.nvidia.com/kit/docs/gsplat-converter`

Access note: Browser or raw-file fetches of the upstream skill URL can fail when the repo requires GitHub credentials. If that happens, use an authenticated local clone of `https://github.com/NVIDIA-Omniverse/usd-convert-gsplat` and read `.agents/skills/usd-convert-gsplat/SKILL.md` from that checkout. Prefer `$PHYSICAL_AI_SKILL_HUB_UPSTREAM_ROOT/usd-convert-gsplat` or `$HOME/.physical-ai-skill-hub/upstreams/usd-convert-gsplat`.

Do not copy or reinterpret upstream conversion internals here. Keep this reference limited to this repo's wrapper contract, dependency check, report shape, and `validate-usd-minimum` handoff.

## Inputs

Supported source inputs are Gaussian splat `.ply` and `.spz` files. Supported outputs are `.usd`, `.usda`, `.usdc`, and `.usdz`; the repo wrapper defaults to `.usda`.

Do not route arbitrary mesh PLY files here unless the user says it is a Gaussian splat asset or the file carries Gaussian splat properties.

## Dependency Check

Require:

- external `gsplat2USD` CLI from `https://github.com/NVIDIA-Omniverse/gsplat-converter.git`
- Python module `gsplat2USD`

The dependency is declared in this repo as a direct Git source for `gsplat2usd`. If the upstream repo is not accessible, `uv sync` will fail and the skill should report a blocked dependency.

## Conversion Workflow

1. Confirm the source file exists.
2. Confirm the source suffix is `.ply` or `.spz` and the user intent is Gaussian splat conversion.
3. Choose an output directory and output extension. Default to `.usda`.
4. Run this installed reference's portable script.
5. Preserve the conversion report.
6. Confirm the expected USD file exists.
7. Hand off the output USD to `validate-usd-minimum`.

## CLI Pattern

Default conversion:

```bash
python3 scripts/run.py scene.ply output_dir --report output_dir/conversion.json
```

Useful options:

```bash
python3 scripts/run.py scene.spz output_dir \
  --output-extension .usdz \
  --name MyScene \
  --up-axis Z \
  --rotate-x 180 \
  --report output_dir/conversion.json
```

For converter-specific flag semantics such as generated spherical harmonics or generated scales, defer to the upstream skill. This repo wrapper exposes `--generate-sh` and `--generate-scales` only as pass-throughs to the installed converter.

When running from outside the reference directory, use the installed reference path:

```bash
python3 /path/to/skills/omniverse-cad-to-simready/references/convert-to-usd/references/usd-convert-gsplat/scripts/run.py scene.ply output_dir --report output_dir/conversion.json
```

Check dependencies with:

```bash
python3 scripts/check_dependencies.py --report dependency-check.json
```

## Output Format

Reports follow the shared conversion report contract and include:

- `source_asset_path`
- `source_format: gsplat`
- `converter_skill: usd-convert-gsplat`
- `converter_tool: gsplat2USD`
- `converter_command`
- `output_directory`
- `output_usd_path`
- `generated_files`
- `warnings`
- `errors`
- `next_step: validate-usd-minimum`

## Known Caveats

- `.ply` is also used by polygon mesh workflows; require Gaussian splat intent or 3DGS property evidence before selecting this reference.
- `ParticleField3DGaussianSplat` schema support depends on the installed USD/OpenUSD schema environment.
- The output is visual/splat USD data; simulation readiness still requires separate profile decisions and validation.
