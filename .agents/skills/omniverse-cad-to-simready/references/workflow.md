# CAD to SimReady Workflow Reference

## Inputs

Collect these inputs before running:

| Input | Requirement |
|---|---|
| `source_asset` | Required path to a source asset or existing USD asset. |
| `output_root` | Required or inferred directory for generated USD, reports, and intermediate outputs. |
| `simready_profile` | Optional formal SimReady Foundation profile. Prefer `Robot-Body-Runnable` for URDF/MJCF robots and `Prop-Robotics-Neutral` for generic CAD or mesh props unless the user names another profile. |
| `profile_version` | Optional SimReady profile version. Default to `1.0.0` unless the user names another version. |
| Asset context intent | Whether to run web-backed asset identification before conversion and property assignment. Default to run when web search is available. |
| Property assignment intent | Whether to run, skip, or block on Content Agents material and physics assignment. Default to `run` for end-to-end SimReady requests; skip only when the user explicitly requests conversion-only, validation-only, or no property assignment. |
| Content Agents endpoints | Optional service URLs for Material, Physics, and Texture agents. Use `CONTENT_AGENTS_*_BASE_URL` env vars for both self-deployed and provided endpoints. |
| Service auth availability | `NVIDIA_API_KEY` is required only before local Content Agents deployment when service endpoints are missing. Existing endpoints should use explicit usage token env vars such as `CONTENT_AGENTS_TOKEN`, service-specific `CONTENT_AGENTS_*_TOKEN`, `NGC_API_KEY`, or `NVCF_API_KEY`; omit `--token` in normal workflows. |
| Conformance inputs | Optional metadata values, grasp target prim, or explicit grasp points for `simready-conform-profile`. |
| Preview intent | Optional visual preview request for `ovrtx-render-service` after conversion, conformance, or successful validation. When the user asks to render final results, this is a required output artifact, not a best-effort diagnostic. |
| Package inputs | Optional package name, version, license, asset name, thumbnail, and backend for `assemble-package-source` plus `nv-core-package-sample`. |
| Package roots | Optional URDF package mappings when mesh references use `package://`. |
| Preflight manifest | Optional existing `PHYSICAL_AI_PREFLIGHT_MANIFEST`. If absent, run the `preflight` reference for the selected workflow targets before downstream stages. |

If a required sidecar path is missing, stop and report the blocked dependency.
Do not move or rewrite source assets unless the user explicitly asks.

## Source Routing

| Input | Conversion route |
|---|---|
| `.urdf` | `urdf-usd-converter` through `convert-to-usd` |
| MuJoCo XML (MJCF) `.xml` | `mujoco-usd-converter` through `convert-to-usd` |
| Mesh/scene `.fbx`, `.obj`, `.gltf`, `.glb`, `.dae`, or `.stl` | `usd-convert-cad` through `convert-to-usd` when upstream `usd-convert-cad` reports support; otherwise unsupported |
| Gaussian splat `.ply` or `.spz` | `usd-convert-gsplat` through `convert-to-usd` |
| Existing `.usd`, `.usda`, `.usdc`, or `.usdz` | Skip conversion and validate directly |

NVIDIA-backed source formats route through the `usd-convert-cad` reference and
must delegate to upstream `usd-convert-cad` only, including the suffixes listed
by upstream `src/usd_convert_cad/formats.py`. If the upstream checkout, setup,
Python 3.12 runtime, `omniverse-kit`, required converter extension, platform
support, licensing, or conversion support is unavailable, mark conversion
blocked rather than substituting another converter.

## Workflow

1. Confirm the source asset path exists. Do not inspect, convert, validate,
   build converter dependencies, or open the asset yet when property assignment
   will run.
2. Resolve `property_assignment_intent` before running any stage. Default to
   `run` for broad CAD/source-asset to SimReady requests. Set it to `skip` only
   when the user explicitly asks for conversion-only, validation-only, or no
   material/physics assignment.
3. Run the `preflight` reference for the selected targets, or verify an
   existing `PHYSICAL_AI_PREFLIGHT_MANIFEST`. For conversion-only or
   validation-only requests, include `--skip-content-agents`. Source the
   generated env file so downstream references use the prepared local roots,
   runtime executables, and service endpoints. If
   `PHYSICAL_AI_REQUIRE_PREFLIGHT=1` is set and the manifest is missing or a
   component is not ready, stop at the preflight guardrail.
4. If `property_assignment_intent=run`, make Content Agents readiness the first
   operational gate. Verify healthy existing OVRTX, Material, and Physics
   endpoints before any asset inspection or conversion work. If endpoints are
   missing or unhealthy, check the required deployment or service API key; if
   missing, ask the user to provide one and wait.
5. Use `deploy-content-agents` to deploy missing Material/Physics
   services before continuing. Require the shared OVRTX plus individual
   service-container topology and healthy `CONTENT_AGENTS_*_BASE_URL` exports.
   Do not run converter probes, source builds, validation, or conformance while
   this deployment gate is unsettled.
6. Run `identify-asset-context` on the original source asset when
   web search is available or when material/physics assignment will run.
   Preserve local inspection and research reports.
7. Detect the input format and choose the concrete conversion route through
   `convert-to-usd`.
8. Run `convert-to-usd` when needed and capture the generated USD
   path from its report. For existing USD input, skip conversion and use the
   source path as the USD path.
9. Run `validate-usd-minimum` on the converted or existing USD
   before expensive downstream work. Use this only as a viability gate before
   service calls. If the report or USD metadata shows `metersPerUnit != 1.0` or
   another repairable profile issue, record it for the post-assignment
   conformance pass instead of running FET001 or any other FET helper now.
10. Run `content-agents` when material, physics, or texture
   assignment is requested or required. Use the context report's material and
   physics prompt when available. The Physics Agent wrapper inspects USD
   topology and automatically enables `--optimize-usd --enable-deinstance
   --enable-split` when it detects composed CAD component structure such as
   `GeomSubset`, instances, or prototypes.
11. Use each assignment report's concrete `output_usd_path` or
    `output_usdz_path` as the next handoff path. Keep the physics-authored USD
    path for simulation validation unless the user explicitly wants to validate
    the textured USDZ.
12. Run `simready-conform-profile` on the latest simulation USD
    path. Preserve each selected FET repair report and use the newest authored
    USD path for the next stage. Always inspect the latest service-authored USD's
    `metersPerUnit` before final profile validation; if it is not `1.0`, route
    through upstream `simready-foundation-conform-fet-001-minimal` in this
    post-assignment conformance pass so `UN.007` is repaired before later
    profile gates. For prop profiles,
    do not defer a detected or expected `GSP.001` failure by default: route it
    through upstream `simready-foundation-conform-fet-005-simulate-grasp-physics` and
    either author a vision-selected grasp line or record an explicit FET005
    blocked report when visual evidence or a vision-capable agent is
    unavailable.
13. Run validation gates on the conformed USD:
    `omni-asset-validate`,
    `omni-asset-validate-geometry`,
    `omni-asset-validate-physics`, and
    `simready-validate`.
14. If `simready-validate` reports a repairable SimReady requirement, rerun the
    relevant upstream conformance skill and then rerun the profile validation on
    the newest authored USD. For `GSP.001`, use upstream
    `simready-foundation-conform-fet-005-simulate-grasp-physics`: generate or collect
    visual evidence, choose explicit grasp points only when a vision-capable
    agent can inspect that evidence, and call the upstream
    `author_grasp_line.py` after the point decision. If the current agent is
    terminal-only or the points are not supplied, record the FET005 step as
    `blocked` with the render/evidence paths and do not author a bounds-only
    placeholder line. For `RB.MB.001`, use upstream
    `simready-foundation-conform-fet-004-simulate-multi-body-physics`: inspect the actual
    `UsdPhysics.RigidBodyAPI` prims, not just visual prim count. If the latest
    Physics Agent output has existing component colliders or part roots that
    represent source parts, FET004 should move or add rigid-body schemas to
    those existing candidates and rerun validation. If the asset has fewer than
    two reusable physical body candidates, rely on the `simready-validate`
    single-component policy to treat `RB.MB.001` as non-blocking when the USD
    has only one mesh component or one `GeomSubset` component; otherwise report
    FET004 as blocked or not applicable instead of inventing geometry.
15. Run `ovrtx-render-service` on the latest USD path when the user requests
    a visual preview, thumbnail, inspection image, or final renders. Final
    renders must come from the `ovrtx-render-service` reference output for the
    final USD being reported. Do not substitute Material Agent or Physics Agent
    HTML report images, generated service thumbnails, screenshots, or earlier
    conversion thumbnails as final render artifacts. For final report renders,
    use the render reference's default no-authored-light mode so the renderer
    keeps a clean black background; only pass `--default-lights` when explicitly
    debugging lighting. If `ovrtx-render-service` returns a blank/uniform image,
    no PNG, or an image of the wrong asset, record render status as
    failed/blocked and troubleshoot or rerun the OVRTX render reference instead
    of silently falling back. Treat render failure as diagnostic unless a render
    artifact is explicitly required.
16. If package inputs are available, run `assemble-package-source` before
    packaging. Use the latest conformed USD as `final_usd`, the final
    `ovrtx-render-service` PNG as `--thumbnail`, and the workflow
    `output_root` as the two-zone root. This stage creates
    `{output_root}/deliverable/simready_usd/sm_{asset_name}_01.usd`, places
    the thumbnail under `.thumbs/256x256/`, localizes referenced files, rewrites
    authored asset paths where OpenUSD exposes them, and verifies the assembled
    USD dependencies resolve within `deliverable/`.
17. Run `nv-core-package-sample` against `{output_root}/deliverable`, never the
    full workflow output root. Pass
    `--root-usd simready_usd/sm_{asset_name}_01.usd`, write package reports
    under `{output_root}/pipeline/07_package/`, and then run
    `nv-core-package-sample-validation` even when earlier validation gates
    produced findings.
18. Write `omniverse-cad-to-simready-report.md` under `output_root` unless
    the user requests a different path. Include asset identity evidence, stage
    status, selected profile, key output USD paths, structure counts when
    useful, grouped validation failures, warnings, render preview paths, and
    recommended next work.

## Validation Policy

The workflow is blocked only by failures that prevent later stages from using a
meaningful USD artifact or required services: failed Content Agents readiness,
unsupported source formats, missing converter dependencies, missing sidecar
assets, invalid minimum USD, property assignment failures, and conformance
authoring failures.

When property assignment will run, deterministic SimReady conformance repairs
are post-assignment work. Do not normalize units, author FET000 metadata, create
grasp lines, or apply FET004 rigid-body fixes before Material/Physics/Texture
Agent calls. This keeps Content Agents operating on the converter-produced USD
shape and avoids service rendering failures caused by pre-assignment
root-layer/unit edits.

Validation failures from Asset Validator, geometry, physics, SimReady profile,
or package validation are not terminal workflow blockers. They mean the asset is
not SimReady-clean yet, but the workflow should continue through remaining
diagnostic gates and put the asset in the rerun/remediation queue. If a
validation command exits non-zero after writing a structured report, parse the
report, record the findings, and continue the workflow.

Packaging can be skipped without failing the asset workflow when the user did
not provide package inputs. If the user asked for a finished package, missing
package inputs are blocked requirements.

## Output Report Fields

The JSON report should include:

| Field | Meaning |
|---|---|
| `source_asset_path` | Original source asset path. |
| `source_format` | Detected format. |
| `asset_context_report_path` | Asset identity/context report path when context research ran. |
| `asset_identity` | Likely identity and confidence from the context report. |
| `output_root` | Directory holding stage reports and generated USD output. |
| `output_usd_path` | Generated or existing USD path, when available. |
| `conformed_usd_path` | Latest USD path after `simready-conform-profile`, when available. |
| `simready_profile` | Selected profile, feature, or capability target. |
| `property_assignment_status` | `passed`, `failed`, `skipped`, or `blocked`. |
| `materialized_usd_path` | USD path after Material Agent, when available. |
| `physics_usd_path` | USD path after Physics Agent, when available. |
| `textured_usdz_path` | USDZ path after Texture Agent, when requested and available. |
| `render_preview_path` | PNG path produced by `ovrtx-render-service` for the final reported USD, when requested and available. Do not populate this with Material Agent/Physics Agent report images or thumbnails from earlier stages. |
| `deliverable_root` | Clean package source prepared by `assemble-package-source`, normally `{output_root}/deliverable`. |
| `assembled_root_usd_path` | Canonical root USD prepared for packaging, normally `deliverable/simready_usd/sm_{asset_name}_01.usd`. |
| `assembly_report_path` | Assembly report path, normally `{output_root}/pipeline/assembly-report.json`. |
| `package_root` | Package root when packaging ran or was prepared; use the deliverable root, not the pipeline workspace. |
| `package_definition_path` | Package definition path when packaging ran. |
| `markdown_report_path` | Final Markdown report path. |
| `passed` | Overall workflow pass/fail result. |
| `needs_rerun` | Whether the asset completed the workflow but has validation findings, transient service failures, or other remediation items. |
| `rerun_reasons` | Validation findings, transient service errors, or blocked diagnostics that require later retry/remediation. |
| `steps` | Ordered conversion, assignment, conformance, validation, and packaging step results. |

## Human Approval Points

Ask for explicit approval before destructive or ambiguous operations such as
overwriting source files, modifying vendored assets, applying repairs, stamping
guessed metadata, choosing a package license, or selecting between multiple
equally plausible source assets. Writing into a user-provided output directory
is allowed.

## Next Steps

- If profile validation fails, use `simready-validate`
  details to identify the first missing SimReady requirement.
- If profile validation reports `GSP.001`, rerun
  `simready-conform-profile` through
  upstream `simready-foundation-conform-fet-005-simulate-grasp-physics`. Complete the
  repair automatically when the agent can inspect visual evidence and select a
  useful grasp region, or with user-provided explicit grasp points. Otherwise
  mark the FET005 handoff blocked so the final report explains why the grasp
  repair did not author USD.
- If packaging is skipped, collect package name, version, license, asset name,
  final thumbnail, and final USD path, then run `assemble-package-source`
  before `nv-core-package-sample`.
