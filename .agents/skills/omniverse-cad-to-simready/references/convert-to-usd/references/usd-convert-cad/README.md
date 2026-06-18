# Convert CAD to USD

## When to Use

Use this reference for NVIDIA-backed source conversion. On supported architectures, conversion delegates to upstream `usd-convert-cad`, a headless Omniverse Kit Python wrapper that installs `omniverse-kit`, fetches converter core extensions from the Kit registry, routes supported source formats through its format metadata, and writes its own JSON conversion report.

Guardrail: upstream `usd-convert-cad` is the default converter backend for this reference's NVIDIA-backed source conversion. The only local fallback is Linux arm64, where upstream `usd-convert-cad` is not available yet; that path uses a private NVIDIA Kit App Template application with CAD Converter extensions. Do not fall back to `usd-convert-asset`, hand-authored USD, mesh converters, or other substitute CAD converters.

## Upstream Reference

- NVIDIA Omniverse `usd-convert-cad` repository: `https://github.com/NVIDIA-Omniverse/usd-convert-cad`
- Upstream CAD conversion skill: `https://github.com/NVIDIA-Omniverse/usd-convert-cad/blob/main/.agents/skills/usd-convert-cad/SKILL.md`
- Linux arm64 fallback: NVIDIA Kit App Template repository: `https://github.com/NVIDIA-Omniverse/kit-app-template`
- Linux arm64 fallback docs: `https://docs.omniverse.nvidia.com/kit/docs/kit-app-template/latest/`
- NVIDIA Omniverse CAD Converter extension docs: `https://docs.omniverse.nvidia.com/kit/docs/omni.kit.converter.cad/latest/`
- NVIDIA HOOPS CAD core extension docs: `https://docs.omniverse.nvidia.com/kit/docs/omni.kit.converter.hoops_core/latest/Overview.html`
- NVIDIA DGN CAD core extension docs: `https://docs.omniverse.nvidia.com/kit/docs/omni.kit.converter.dgn_core/latest/Overview.html`
- NVIDIA JT CAD core extension docs: `https://docs.omniverse.nvidia.com/kit/docs/omni.kit.converter.jt_core/latest/Overview.html`
- Linux arm64 optional service mode docs: `https://docs.omniverse.nvidia.com/kit/docs/omni.services.convert.cad/latest/Usage.html`

Browser, raw-file fetches, or unauthenticated GitHub access can fail depending on access level. If that happens, use an authenticated local clone of `https://github.com/NVIDIA-Omniverse/usd-convert-cad` and read the referenced paths from that checkout.

Use `$HOME/.physical-ai-skill-hub/upstreams/usd-convert-cad` as the default stable upstream checkout path. Set `PHYSICAL_AI_SKILL_HUB_UPSTREAM_ROOT` to move the shared upstream root, or set `USD_CONVERT_CAD_ROOT` / `--usd-convert-cad-root` for this converter only. An existing legacy `$HOME/.usd-convert-cad` checkout is still accepted when no shared root is configured, but new setup should use the shared upstream root. Do not use `/tmp` as the runtime checkout location for conversions. A `/tmp` clone is acceptable only for short-lived inspection.

On Linux arm64 only, the wrapper does not require `USD_CONVERT_CAD_ROOT`. Instead it locates Kit App Template from `KIT_APP_TEMPLATE_ROOT` or `$HOME/.kit-app-template`, the build directory from `KIT_APP_TEMPLATE_BUILD_DIR` or `_build/<platform>/release`, and the Kit executable from `KIT_APP_TEMPLATE_KIT_EXECUTABLE`, `KIT_EXECUTABLE`, or `<kit-build-dir>/kit/kit`.

## Inputs

Collect a source file, output directory, and optional `--usd-convert-cad-root`.
Supported source suffixes and converter routing belong to upstream
`SUPPORTED_FORMATS` / format metadata in `src/usd_convert_cad/formats.py` and
`.agents/skills/usd-convert-cad/SKILL.md`.
This reference reads the upstream formats table from the configured checkout
when it is available and keeps only a fallback snapshot for blocked reports when
the checkout is missing. Examples such as `.stp`, `.step`, `.igs`, `.iges`,
`.dgn`, `.ifc`, `.ifczip`, `.jt`, and proprietary CAD files route to
`usd-convert-cad`, never to a substitute converter. Mesh/scene formats also
route here when upstream `usd-convert-cad` lists them as supported; otherwise
they are reported unsupported rather than sent to `usd-convert-asset`.
Do not choose `jt_core`, `dgn_core`, or `hoops_core` in this wrapper; upstream
`usd-convert-cad` selects the converter from its supported-format metadata.
Legacy backend-selection arguments are accepted for compatibility, but the value
is ignored by this wrapper and is never forwarded to upstream `convert.py`.

On Linux arm64, probe support does not use a local source-format allowlist
because the Kit App Template fallback is the scoped architecture workaround.
The fallback reports support and lets the installed Kit CAD Converter runtime
determine whether the input can be converted. The fallback accepts Kit App
Template options such as `--kit-app-template-root`,
`--kit-build-dir`, `--kit-executable`, `--execution-mode`, `--config-path`,
`--fine`, and `--coarse`; these options are ignored by the upstream path on
other architectures.

## Dependency Check

Require:

- `usd-convert-cad` from this repo.
- A local `NVIDIA-Omniverse/usd-convert-cad` checkout from `https://github.com/NVIDIA-Omniverse/usd-convert-cad`, preferably at `$HOME/.physical-ai-skill-hub/upstreams/usd-convert-cad`.
- Python 3.12 available for upstream setup.
- Upstream setup completed with the upstream runtime Python, for example
  `.venv/bin/python install.py` from the upstream checkout after the venv is
  created.
- Upstream environment validated with `python validate.py`.
- Network access to the Kit extension registry on first run.
- Accepted Omniverse terms for non-interactive runs. The wrappers set or expect `OMNI_KIT_ACCEPT_EULA=yes`.

For Linux arm64 fallback, require:

- Local `NVIDIA-Omniverse/kit-app-template` checkout from `https://github.com/NVIDIA-Omniverse/kit-app-template`, preferably at `$HOME/.kit-app-template`.
- A built Kit App Template app whose dependencies include `omni.kit.converter.cad` or the specific CAD core extension required by the input: `omni.kit.converter.hoops_core`, `omni.kit.converter.dgn_core`, or `omni.kit.converter.jt_core`.
- Built Kit executable under `_build/<platform>/release/kit/kit` or an explicit `--kit-executable`.
- For optional `--execution-mode service`, `omni.services.convert.cad-*` in `_build/<platform>/release/extscache`, including `omni/services/convert/cad/services/process/{hoops,dgn,jt}_main.py`.
- Accepted Omniverse terms for non-interactive runs. The fallback sets `ACCEPT_EULA=Y` and `OMNI_KIT_ACCEPT_EULA=yes`.

Do not silently install or build missing dependencies. If the checkout, `.venv`, `omniverse-kit`, converter core extension, platform support, Kit App Template build, or CAD Converter license is unavailable, run the wrapper and preserve its blocked conversion report. This reference may invoke upstream `validate.py` to verify readiness on supported architectures. On Linux arm64 it may start the local Kit App Template runtime because that is the scoped fallback path.

## Conversion Workflow

1. Confirm the source asset exists.
2. On Linux arm64, when this CAD reference is selected by the higher-level router, use the Kit App Template CAD Converter fallback and let the installed Kit runtime determine conversion support.
3. On other architectures, confirm upstream `usd-convert-cad` lists the source suffix as supported.
4. Locate the upstream checkout from `--usd-convert-cad-root`, `USD_CONVERT_CAD_ROOT`, `$PHYSICAL_AI_SKILL_HUB_UPSTREAM_ROOT/usd-convert-cad`, or `$HOME/.physical-ai-skill-hub/upstreams/usd-convert-cad`; on Linux arm64, locate Kit App Template from `KIT_APP_TEMPLATE_ROOT`, `KIT_APP_TEMPLATE_BUILD_DIR`, or `KIT_APP_TEMPLATE_KIT_EXECUTABLE`.
5. If setup state is unknown, follow the selected runtime's install/validate guidance.
6. Run this installed reference's portable script; before upstream conversion it delegates readiness to upstream `validate.py`, then calls upstream `python "$USD_CONVERT_CAD_ROOT/convert.py" ... --quiet --report ...`. On Linux arm64, it starts the built Kit executable with the selected CAD core extension and a generated runner/config sidecar.
7. Preserve both reports on the upstream path: this repo's normalized conversion report and the upstream `*_usd_convert_cad_status.json` sidecar. Preserve generated Kit fallback sidecars on the Linux arm64 path.
8. If USD is generated, hand it to `validate-usd-minimum`.
9. If blocked, report the exact upstream readiness or fallback runtime failure, such as a missing checkout, stale setup, Python 3.12 issue, `omniverse-kit` issue, missing Kit App Template build, required CAD core extension, platform issue, registry download failure, conversion failure, or CAD license dependency.

## CLI Pattern

Default STEP conversion:

```bash
python3 scripts/run.py asset.step output_dir \
  --report output_dir/conversion.json
```

Explicit upstream checkout:

```bash
python3 scripts/run.py asset.jt output_dir \
  --usd-convert-cad-root /path/to/usd-convert-cad \
  --report output_dir/conversion.json
```

Linux arm64 fallback with explicit Kit App Template build:

```bash
python3 scripts/run.py asset.step output_dir \
  --kit-build-dir /path/to/kit-app-template/_build/linux-aarch64/release \
  --report output_dir/conversion.json
```

When running from outside the reference directory, use the installed reference path:

```bash
python3 /path/to/skills/omniverse-cad-to-simready/references/convert-to-usd/references/usd-convert-cad/scripts/run.py asset.step output_dir --report output_dir/conversion.json
```

Check dependencies with:

```bash
python3 scripts/check_dependencies.py --report dependency-check.json
```

The dependency check delegates to upstream `validate.py` when the checkout,
`convert.py`, and `validate.py` are present. It can start the upstream runtime
and access the extension registry; use it as the CAD readiness gate before
batching per-asset conversions. On Linux arm64, the dependency check reports
Kit App Template root, build directory, and Kit executable readiness instead.

## Output Format

This repo normalizes the upstream status into the shared conversion report contract and includes:

- `source_asset_path`
- `source_format: cad`
- `converter_skill: usd-convert-cad`
- `converter_tool: usd-convert-cad` on the upstream path, or `NVIDIA Kit App Template CAD Converter` on Linux arm64 fallback
- `converter_command`, the upstream `convert.py` invocation with explicit output USD and report paths, or the Kit executable command that enables the selected CAD core fallback extension
- `output_directory`
- `output_usd_path`
- `generated_files`
- `sidecar_inputs`, including the upstream checkout, upstream JSON report, and upstream log when available, or the Kit App Template checkout/build/config/runner sidecars for Linux arm64 fallback
- `warnings`, including the selected runtime and converter core
- `errors`
- `next_step: validate-usd-minimum`

The upstream sidecar report includes the selected converter extension, converter module, converter options, elapsed time, pass/fail status, and upstream warnings/errors.

## Known Caveats

- Upstream `usd-convert-cad` is still Omniverse Kit and CAD Converter based; the Linux arm64 fallback uses Kit App Template and CAD Converter directly until upstream supports that architecture.
- Python 3.12 is required by upstream setup.
- The first conversion can take longer because Kit downloads converter extensions from the registry.
- If `validate.py` reports `Result.ERROR_ACCESS_DENIED` while pulling a Kit extension, treat it as an upstream Kit registry/CDN access problem, not a routing problem. The portable scripts report `kind: kit_registry_access_denied` with the extension, URL host, exit code, and a recovery hint. Fix Horde node egress, proxy, or credentials, or pre-populate and reuse the upstream Kit extension cache, then rerun `OMNI_KIT_ACCEPT_EULA=yes python validate.py`.
- Proprietary CAD formats can require CAD Converter licensing.
- Detailed converter option names must come from the upstream skill, Kit App Template docs, or installed extension docs.
- A successful CAD conversion does not imply simulation readiness.
