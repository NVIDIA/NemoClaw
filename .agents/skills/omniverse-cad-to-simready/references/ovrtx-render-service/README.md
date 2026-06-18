# Render USD

## When to Use

Use this reference to create a visual preview of a USD asset after conversion, validation, material assignment, or SimReady packaging. The reference's `scripts/run.py` inspects the stage with OpenUSD mesh traversal when the local Python environment provides `pxr`, then sends the USD to an OVRTX renderer.

Do not use VTK or other local triangle preview renderers. This reference always
sends the stage to an OVRTX rendering service. The service endpoint can be:

- a preflight-managed local OVRTX service through `OVRTX_RENDER_ENDPOINT`,
  `OVRTX_RENDER_BASE_URL`, `RENDER_ENDPOINT`, or the preflight manifest
- a provided OVRTX service through `--endpoint`, `RENDER_ENDPOINT`, or
  `CONTENT_AGENTS_RENDER_BASE_URL`
- an NVCF invocation endpoint through `NVCF_RENDER_ENDPOINT`, or a constructed
  invocation URL from `NVCF_RENDER_FUNCTION_ID` / `RENDER_FUNCTION_ID`

Use `--token` only when environment or file-backed token injection is
impossible. The wrapper sends available renderer tokens automatically and only
requires a token before the request for known protected NVCF endpoints.

If neither renderer path is configured or the renderer cannot produce a PNG, stop with the command report. Do not silently substitute a non-OVRTX preview. Material Agent or Physics Agent HTML report images, generated service thumbnails, viewport screenshots, or earlier conversion thumbnails are useful diagnostics, but they are not valid `ovrtx-render-service` outputs and must not be reported as final renders from this skill.

Prefer a ready `PHYSICAL_AI_PREFLIGHT_MANIFEST` from the `preflight`
reference. The wrapper consumes a prepared OVRTX endpoint from that manifest
before falling back to renderer environment variables. When
`PHYSICAL_AI_REQUIRE_PREFLIGHT=1` is set, missing renderer readiness blocks at
the preflight guardrail.

## Upstream Reference

This reference follows the current `nvidia-omniverse/content-agents` `main` OVRTX rendering API contract: encode local USD as a data URI in the `/render` request `url` field, pass render settings, and decode returned image bytes from the response `images` map. Its stage-preparation behavior mirrors the useful parts of the earlier render-usd proof of concept from `https://github.com/NVIDIA-dev/content-claw/tree/main/.claude/skills/render-usd`: compute render bounds, author a camera from those bounds, preserve the source stage lighting state by default, and bundle local MDL/texture sidecars. The source asset is not modified.

OVRTX service deployment belongs to NVIDIA Omniverse Content Agents: `https://github.com/nvidia-omniverse/content-agents` on branch `main`. When a render task requires provisioning, starting, or troubleshooting a local OVRTX render endpoint, use the installed `deploy-content-agents` skill, which points to `https://github.com/nvidia-omniverse/content-agents/blob/main/.codex/skills/deploy-ovrtx-docker/SKILL.md`. Do not copy Docker Compose or OVRTX deployment instructions into this reference.

## Stage Preparation

Before calling `/render`, `scripts/run.py` prepares a render stage with OpenUSD
when `pxr` is available:

- Preserve the composed source stage by default. This keeps renderer-visible
  MaterialX/OpenPBR material graphs intact; flattened render payloads can cause
  OVRTX to show red fallback/error materials on some Material Agent outputs.
- Use `--flatten` only as an explicit diagnostic or packaging fallback when the
  unflattened source composition cannot be sent to the renderer.
- Compute a world-space bounding sphere from the default prim or first
  xformable root prim.
- Generate a fit-to-bounds camera when `--camera` is not supplied; this avoids
  fixed-camera misses on meter-normalized assets with root scale opinions.
- Do not author default lights by default; this keeps final renders on the
  renderer's clean black background without adding a DomeLight. Use
  `--default-lights` only as an explicit debugging override.
- Export a temporary `main.usda` and bundle referenced local MDL/texture files
  into the data-URI payload, rewriting asset paths to the bundle.
- Inspect the returned PNG for blank/uniform pixels and record the result in the
  JSON report. Use `--fail-on-uniform` when a blank render should fail the
  command rather than produce a warning.

## Camera Handling

Use `--camera` when the asset already has a specific camera prim that should drive the preview. Without `--camera`, `scripts/run.py` authors `/Camera` in the temporary render stage using bounds-derived distance, aperture, clipping range, and elevation. The authored camera path and construction parameters are reported under `stage_construction.camera`.

## Turntable Rendering

Use `scripts/turntable.py` when a single view is blank, ambiguous, or not enough
for visual inspection. It renders multiple OVRTX frames from bounds-fit
turntable stages and writes a frame-by-frame report containing camera placement,
stage bounds, local asset bundling, pixel checks, and per-frame errors. It can
also stitch a GIF when Pillow is available.

## Inputs

Collect:

| Input | Requirement |
|---|---|
| `asset_path` | Required `.usd`, `.usda`, `.usdc`, or `.usdz` asset path. |
| `output_image_path` | Required `.png` output path. |
| `endpoint` | Optional renderer base URL or `/render` URL. Defaults to env and preflight manifest resolution. |
| `token` | Optional bearer token. Renderer-specific token env vars are preferred; NGC/NVCF usage tokens are used for protected remote endpoints. Pass `--token "$API_KEY"` explicitly only when environment/file injection is impossible. |
| `camera` | Optional camera prim path. |
| `width` / `height` | Optional pixel resolution. Default: `1024x1024`. |
| `fit_margin` | Optional camera fit margin metadata sent to the renderer. Default: `1.2`. |
| `focal_length` / `elevation` | Optional auto-camera controls. Defaults: `50mm` and `0.34`. |
| `default_lights` | Optional debugging mode to author Dome/Sphere lights for a lightless prepared stage. Default: disabled. |
| `report` | Optional JSON report path. |
| `markdown_report` | Optional Markdown report path. |

## Dependency Check

Require:

- this reference's portable `scripts/run.py` and `scripts/check_dependencies.py`.
- OpenUSD Python APIs through `pxr.Usd` and `pxr.UsdGeom` when local mesh statistics are required. Missing `pxr` is reported as a warning; the OVRTX render request can still proceed.
- Python stdlib HTTP support for the OVRTX render service call.
- For protected remote rendering, a bearer token from `OVRTX_RENDER_TOKEN`,
  `RENDER_TOKEN`, `CONTENT_AGENTS_RENDER_TOKEN`, `NGC_API_KEY`,
  `NVCF_API_KEY`, matching file-backed variables such as
  `OVRTX_RENDER_TOKEN_FILE` or `NGC_API_KEY_FILE`, or explicit
  `--token "$API_KEY"` when environment/file injection is impossible. Do not
  use `NVIDIA_API_KEY` as the default renderer token; it is deployment auth.
  Avoid `--token` in long-running jobs because argv can expose secrets.

Endpoint resolution order:

1. `--endpoint`
2. `OVRTX_RENDER_ENDPOINT`
3. `OVRTX_RENDER_BASE_URL`
4. a ready OVRTX endpoint from `PHYSICAL_AI_PREFLIGHT_MANIFEST`
5. `RENDER_ENDPOINT`
6. `CONTENT_AGENTS_RENDER_BASE_URL`
7. `NVCF_RENDER_ENDPOINT`
8. Construct `https://<function-id>.invocation.api.nvcf.nvidia.com/render` from `NVCF_RENDER_FUNCTION_ID` or `RENDER_FUNCTION_ID`.

The command appends `/render` when the endpoint is a base URL. Localhost OVRTX
service endpoints are allowed without a bearer token; protected NVCF endpoints
must provide a token through env/file variables or `--token`.

If a local OVRTX endpoint is not already running and the user wants one deployed, use `deploy-content-agents` with the OVRTX deployment target first, then return to this reference with `OVRTX_RENDER_ENDPOINT` or `RENDER_ENDPOINT` set.

## Host-Direct OVRTX Smoke Test

Use this as a diagnostic fallback when the local OVRTX REST container is hard
to debug on a headless host. It verifies that the host Python runtime can import
and initialize OVRTX directly; it does not replace the REST renderer endpoint
required by this reference's normal `scripts/run.py` path.

1. Create an isolated Python 3.12 environment outside the workflow output
   directory.
2. Install `ovrtx==0.2.0.280040`, `numpy`, and `pillow` into that environment.
3. Start Xvfb on an unused display and export that display for the smoke probe.
   On headless hosts, do not assume `:99` is free; use an explicit unused value
   such as `:100` when another process already owns the default display.
4. Run a tiny local probe that imports `ovrtx`, constructs `ovrtx.Renderer`,
   loads a known-simple USD package, and steps `ovrtx_debug_dump_stage`.
5. Save the host-direct renderer log next to the deployment evidence and report
   it as diagnostic evidence only. Continue using `deploy-content-agents` for
   production REST service deployment and render only after a `/render`
   endpoint is healthy.

## Instructions

1. Confirm the source USD exists.
2. Choose a dedicated output directory for render artifacts.
3. Confirm a remote or local OVRTX endpoint is available; if the endpoint must be deployed, use `deploy-content-agents` for the OVRTX service before rendering.
4. Run this reference's portable `scripts/run.py` with the asset path and PNG output path. Keep default composition-preserving stage preparation enabled unless debugging a specific source-stage camera, light setup, or packaging issue. Do not pass `--flatten` for final report renders unless the unflattened render is blocked. Do not pass `--default-lights` for final report renders unless the user explicitly asks for authored lighting.
5. Preserve the JSON and Markdown reports when requested.
6. Confirm the output PNG exists and is non-empty.
7. Check that the output PNG is not blank or a uniform background image. If it is blank/uniform, mark the render as failed or blocked and troubleshoot the OVRTX request, camera, lighting, asset packaging, or endpoint; do not replace it with a Material Agent or Physics Agent report image.
8. If the single image is still blank or poorly framed, run `scripts/turntable.py` and inspect its frame reports before changing service endpoint assumptions.
9. Use the preview as diagnostic context for conversion, material, physics, SimReady, or package reports.

## CLI Pattern

Render using `.env`, shell env, or a ready preflight manifest:

```bash
python3 /path/to/skills/omniverse-cad-to-simready/references/ovrtx-render-service/scripts/run.py asset.usd output/preview.png \
  --report output/ovrtx-render-service.json \
  --markdown-report output/ovrtx-render-service.md
```

Render with an explicit endpoint:

```bash
python3 /path/to/skills/omniverse-cad-to-simready/references/ovrtx-render-service/scripts/run.py asset.usd output/preview.png \
  --endpoint "$RENDER_ENDPOINT" \
  --width 1600 \
  --height 1200 \
  --fit-margin 1.35 \
  --report output/ovrtx-render-service.json
```

Render with an explicit token when env/file injection is not available:

```bash
python3 /path/to/skills/omniverse-cad-to-simready/references/ovrtx-render-service/scripts/run.py asset.usd output/preview.png \
  --endpoint http://127.0.0.1:8000 \
  --token "$RENDER_TOKEN" \
  --report output/ovrtx-render-service.json
```

Turntable diagnostic render:

```bash
python3 /path/to/skills/omniverse-cad-to-simready/references/ovrtx-render-service/scripts/turntable.py asset.usd output/turntable_frames \
  --frames 8 \
  --gif output/turntable.gif \
  --report output/ovrtx-turntable.json \
  --markdown-report output/ovrtx-turntable.md
```

## Output Format

Reports include:

- `asset_path`
- `output_image_path`
- `renderer_skill: ovrtx-render-service`
- `renderer_tool: OVRTX rendering service`
- `renderer_endpoint_kind`
- `renderer_auth_mode`
- `renderer_endpoint`
- `camera_path`
- `width` and `height`
- `fit_margin`
- `stage_construction`
- `pixel_inspection`
- `mesh_count`
- `point_count`
- `triangle_count`
- `generated_files`
- `warnings`
- `errors`
- `passed`
- `next_step: inspect-render-output`

Turntable reports include the same renderer metadata plus `frame_reports`, each
with `angle_degrees`, `stage_construction`, `pixel_inspection`,
`output_image_path`, and per-frame warnings/errors.

## Known Caveats

- The command uses OpenUSD mesh traversal for validation, statistics, bounds-fit camera authoring, optional debugging light overlays, and temporary bundle construction; final pixels come from OVRTX.
- Empty stages or assets with no renderable mesh triangles produce a blocked report rather than a blank image.
- The portable wrapper leaves the source asset untouched; render camera, lights, and bundle rewrites are authored only in temporary render stages.
- `--background` is accepted for backward CLI compatibility but is not used by the OVRTX request.
- A local OVRTX container can report unhealthy through a container-internal
  healthcheck while the externally mapped host `/health` endpoint is usable.
  Record both results and render a PNG before treating the endpoint as ready.
- On headless or nested hosts, Xvfb display conflicts can make the renderer exit
  before it serves `/render`; choose an unused display and keep the renderer log
  with the workflow evidence.
- The host-direct OVRTX smoke test proves only that the host renderer runtime
  can initialize. It is diagnostic evidence, not a substitute final renderer
  service path for `ovrtx-render-service`.

## Next Steps

- Run `validate-usd-minimum` first when the source asset has not already passed minimum USD validation.
- Attach the PNG and JSON report to conversion or SimReady handoff summaries when a visual preview is requested.
- If material fidelity looks wrong, inspect material bindings and authored surface outputs before rerunning the render.
