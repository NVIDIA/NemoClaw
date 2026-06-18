# Content Agents

## When to Use

Use this router reference after USD conversion and minimum USD validation when an asset needs NVIDIA Omniverse Content Agents service calls. Select the right nested call reference, preserve each service report, and hand the newest USD or USDZ artifact to the next workflow stage.

This is not the deployment workflow and not a replacement for the service-specific call references. If an endpoint is missing, hand off to `deploy-content-agents` for the required target, then return to this router and run the selected service call.

This installed router reference ships a narrow `scripts/run.py` control-plane wrapper for deterministic service sequencing and report generation. It still delegates service calls to the portable `scripts/run.py` from each selected service reference; it does not reimplement Material, Physics, or Texture Agent behavior.

## Prerequisites

- Python 3.12 and `uv` (per repo `README.md`).
- Prefer a ready `PHYSICAL_AI_PREFLIGHT_MANIFEST` from the `preflight`
  reference. The client wrappers consume prepared `CONTENT_AGENTS_*_BASE_URL`
  endpoints from that manifest before falling back to direct environment
  variables. When `PHYSICAL_AI_REQUIRE_PREFLIGHT=1` is set, missing or
  unhealthy services block at the preflight guardrail.
- A required `.usd`, `.usda`, `.usdc`, or `.usdz` input asset.
- Reachable Material, Physics, Texture, or OVRTX endpoints through
  `CONTENT_AGENTS_*_BASE_URL`, unless this router hands off to deployment
  first.
- Bearer auth through explicit usage token environment variables when a
  provided endpoint requires auth: `CONTENT_AGENTS_TOKEN`, `NGC_API_KEY`,
  `NVCF_API_KEY`, or selected service-specific variables such as
  `CONTENT_AGENTS_MATERIAL_AGENT_TOKEN`, `MATERIAL_AGENT_TOKEN`,
  `CONTENT_AGENTS_PHYSICS_AGENT_TOKEN`, `PHYSICS_AGENT_TOKEN`,
  `CONTENT_AGENTS_TEXTURE_AGENT_TOKEN`, or `TEXTURE_AGENT_TOKEN`.

## Routing

Choose the smallest route that satisfies the user request and selected workflow profile:

| Request or evidence | Route |
|---|---|
| Visual appearance, material prediction, or material bindings | `material-agent-client` |
| Rigid bodies, colliders, mass, density, friction, restitution, or simulation physics properties | `physics-agent-client` |
| Textured output, texture artifacts, or textured USDZ generation | `texture-agent-client` |
| Broad Content Agents enrichment for SimReady or simulation use | `material-agent-client` then `physics-agent-client`; add `texture-agent-client` only when textured output is requested |
| Missing Material, Physics, Texture, or OVRTX service endpoint | `deploy-content-agents` for the missing target, then rerun the selected call reference |
| Deployment-only request | `deploy-content-agents`; do not treat this router as the deployment workflow |

Prefer explicit user intent over default ordering. For simulation-readiness, run visual material assignment before physics assignment so the Physics Agent can use the materialized USD when available. Run texture generation after material assignment, and do not replace the physics-authored USD path for simulation validation unless the user explicitly wants to validate the textured USDZ.

Run the local router when more than one Content Agents call is selected so path handoff is deterministic:

```bash
python3 /path/to/skills/omniverse-cad-to-simready/references/content-agents/scripts/run.py \
  /path/to/material_input.usd \
  --output-dir /path/to/output/content-agents \
  --call material \
  --call physics \
  --report /path/to/output/content-agents/content-agents.json
```

Add `--call texture` only when textured output or textured packaging is requested. The consolidated `output_usd_path` remains the latest simulation USD when physics ran; `textured_usdz_path` is reported separately.

## Inputs

Collect:

| Input | Requirement |
|---|---|
| `asset_path` | Required `.usd`, `.usda`, `.usdc`, or `.usdz` input. |
| `output_root` | Required directory for service reports and downloaded artifacts. |
| `material_intent` | Whether to run, skip, or require visual material assignment. |
| `physics_intent` | Whether to run, skip, or require physics property assignment. |
| `texture_intent` | Whether to run, skip, or require texture generation. |
| `asset_context_report` | Optional context report from `identify-asset-context`; use its `material_physics_prompt` when present. |
| `service_endpoints` | Optional Material, Physics, Texture, and OVRTX URLs from env or user input. Check `CONTENT_AGENTS_MATERIAL_AGENT_BASE_URL`, `CONTENT_AGENTS_PHYSICS_AGENT_BASE_URL`, and `CONTENT_AGENTS_TEXTURE_AGENT_BASE_URL`. |
| `NVIDIA_API_KEY` availability | Required only before local deployment when service endpoints are missing. Do not use it as the default bearer token for already-running endpoints. |

## Instructions

1. Confirm the asset exists and is USD-family.
2. Determine the requested Content Agents calls from user intent, workflow defaults, and selected SimReady profile.
3. Resolve required service endpoints from explicit inputs or `CONTENT_AGENTS_*_BASE_URL`.
4. For each missing required endpoint, use `deploy-content-agents` with the matching target. Require a healthy service before returning to this router.
5. Do not run `simready-conform-profile`, FET001 unit normalization, or other
   FET repairs before the first Content Agents call. If minimum USD validation
   found `metersPerUnit != 1.0` or another repairable SimReady issue, record it
   for the post-assignment conformance pass and continue with the
   converted/minimum-valid USD as the service input.
6. Use the `material-agent-client` reference first when material assignment is requested or needed. Its wrapper stages USD-layer uploads without MDL shader `sourceAsset` references when those references point at missing converter sidecars such as `gltf/pbr.mdl`; preserve the `material_upload_info` field from its report.
7. Use the `physics-agent-client` reference on the latest materialized USD path when physics assignment is requested or needed. Its wrapper automatically inspects USD topology and enables `--optimize-usd --enable-deinstance --enable-split` for composed CAD assets with `GeomSubset`, instance, or prototype component structure. It also stages Physics Agent uploads without MDL shader `sourceAsset` references and unresolved service-internal USDZ subasset paths from Material Agent outputs when those references would only affect visual material source files and can break main optimizer packaging. If the optimized Physics service path fails because Scene Optimizer is unavailable, the wrapper retries once without the optimizer flags and records both attempts. Preserve the `usd_topology`, `physics_optimizer`, `physics_upload_info`, and `attempts` fields from its report.
8. Use the `texture-agent-client` reference only when texture generation or textured packaging is requested.
9. Preserve each JSON report and report HTML or prediction artifact when available.
10. Summarize the selected route, service readiness decisions, generated artifacts, latest USD-family output, and next handoff.

When an existing service endpoint requires bearer auth, export an explicit
usage token environment variable before running the command. Use
`CONTENT_AGENTS_TOKEN` for a shared Content Agents token, service-specific
`CONTENT_AGENTS_*_TOKEN` / `*_AGENT_TOKEN` variables for one service, or
`NGC_API_KEY` / `NVCF_API_KEY` for provided NVCF endpoints. Do not use
`NVIDIA_API_KEY` as the default client token; it is deployment auth. Do not pass
secrets as command-line arguments in normal workflows because process listings
can expose argv. In normal agent workflows, omit `--token` entirely, including
empty strings or placeholders, and let the wrapper read the credential from env
or a `*_FILE` variable. The wrapper still accepts `--token` for constrained
automation, but that path should be treated as a fallback.

For detached or shared-host runs, prefer file-backed secrets such as
`CONTENT_AGENTS_TOKEN_FILE`, `NGC_API_KEY_FILE`,
`MATERIAL_AGENT_TOKEN_FILE`, `PHYSICS_AGENT_TOKEN_FILE`, or
`TEXTURE_AGENT_TOKEN_FILE`. The wrappers read the token from those files when
the corresponding environment variable is unset, which avoids exposing token
values through shell expansion or process argv.

The service wrappers poll `/pipeline/<session>/status` until the service reaches
a terminal state or the wrapper timeout expires. Transient polling failures such
as SSL or connection timeouts, HTTP 408, HTTP 429, or HTTP 5xx responses are
retried and recorded as warnings when the service later completes.

## Multi-File USD Uploads

The service API accepts a single uploaded USD-family file. When the input USD
uses external layers or asset dependencies, the wrappers inspect dependencies
with OpenUSD and package the asset as USDZ for upload with
`UsdUtils.CreateNewUsdzPackage`. The report records this in `upload_info` and
`upload_packaging`. Prefer this packaging path over flattening because it keeps
the authored layer structure and referenced assets together for the service. If
OpenUSD cannot inspect or package dependencies, the wrapper reports the
unresolved paths instead of silently flattening or dropping references.

## Rate Limits

Wrapper retries cover transient status polling and delayed artifact download
failures, including HTTP 429 responses visible to the wrapper. They do not retry
per-prim VLM prediction failures that the Material Agent records inside a
completed service session. If predictions are partially rate-limited, preserve
the service report, rerun later or with a smaller asset/workload when possible,
and use a higher-quota service key for large assemblies.

## Command Patterns

Material assignment:

```bash
python3 /path/to/skills/omniverse-cad-to-simready/references/content-agents/references/material-agent-client/scripts/run.py asset.usda output_dir/content-agents/materials \
  --prompt "$ASSET_CONTEXT_PROMPT" \
  --report output_dir/content-agents/material-agent-client.json
```

For any existing endpoint that requires a different bearer token, set
`MATERIAL_AGENT_TOKEN`, `PHYSICS_AGENT_TOKEN`, or `TEXTURE_AGENT_TOKEN` in the
environment for the selected service instead of changing wrapper defaults. Use
the matching `*_FILE` variable when the run is long-lived or process listings
are visible to other users.

If the Material Agent optimized path was intended but local service logs show
`Scene Optimizer failed — continuing pipeline without optimization` together
with `Permission denied:
'/app/.build-resources/scene_optimizer_core/python'`, repair the running local
Material Agent container permissions and rerun the same Material Agent command.
This is a local Scene Optimizer bundle permission issue, not an asset-level
reason to disable `optimize_usd`.

Physics assignment:

```bash
python3 /path/to/skills/omniverse-cad-to-simready/references/content-agents/references/physics-agent-client/scripts/run.py output_dir/content-agents/materials/output_material.usd output_dir/content-agents/physics \
  --render-backend remote \
  --convert-output-to-usd \
  --prompt "$ASSET_CONTEXT_PROMPT" \
  --report output_dir/content-agents/physics-agent-client.json
```

The Physics Agent wrapper auto-enables `--optimize-usd --enable-deinstance
--enable-split` when USD inspection detects composed component topology, and it
falls back to a no-optimizer retry when the service reports an optimizer setup
failure. If the optimized attempt fails immediately at `optimize_usd` with no
completed service steps, inspect the Physics Agent service logs before treating
the no-optimizer retry as meaningful. On local Docker deployments, a known
Scene Optimizer bundle permission issue can appear as
`Permission denied: '/app/.build-resources/scene_optimizer_core/python'`; repair
the running service container permissions and rerun the optimized command
instead of disabling deinstance/split for instanced topology. Do not wrap the
call in a shorter external timeout or terminate the wrapper while the service
remains non-terminal and its current step or progress is advancing.
Remote-rendered Physics stages such as `identify_asset`, `build_dataset_usd`,
`predict`, `restore_usd`, and `apply_physics` can take many minutes on CAD or
instanced assets; wait for the wrapper to return its JSON report unless the
service reaches a terminal failure state or the wrapper's own timeout expires.

If the
physics-authored USD still has one rigid body and the selected profile reports
`RB.MB.001`, keep the service output and route that validation failure through
`simready-conform-profile` / upstream
`simready-foundation-conform-fet-004-simulate-multi-body-physics` only when the USD has at
least two reusable component candidates. For a single mesh component or single
`GeomSubset` component, `simready-validate` treats `RB.MB.001` as non-blocking
and records it under `ignored_issues`; do not retry the same Physics Agent call
blindly.

If system `python3` cannot import `pxr`, the Material and Physics wrappers try
`uv run --python 3.12` for OpenUSD topology inspection. The wrappers use the
same fallback when preparing upload copies that strip missing MDL shader sources
or clear unresolved service-internal USDZ subasset paths before packaging.

Texture generation:

```bash
python3 /path/to/skills/omniverse-cad-to-simready/references/content-agents/references/texture-agent-client/scripts/run.py output_dir/content-agents/materials/output_material.usd output_dir/content-agents/textures \
  --report output_dir/content-agents/texture-agent-client.json
```

Use the concrete `output_usd_path`, `output_usdz_path`, or downloaded artifact paths from each report. Do not assume placeholder filenames from examples.

## Output Format

The router summary should include:

| Field | Meaning |
|---|---|
| `input_asset_path` | Original USD-family input path. |
| `selected_calls` | Ordered Content Agents call references selected by this router. |
| `deployment_handoffs` | Any `deploy-content-agents` targets needed before calls. |
| `reports` | JSON report paths for each call reference. |
| `materialized_usd_path` | USD path after visual material assignment, when available. |
| `physics_usd_path` | USD path after physics assignment, when available. |
| `textured_usdz_path` | USDZ path after texture generation, when available. |
| `output_usd_path` | Latest USD-family artifact for downstream validation or conformance. |
| `next_step` | Usually `simready-conform-profile` or validation. |

## Limitations

- This router is not the deployment workflow and not a replacement for the
  service-specific call references.
- Run texture generation only when texture generation or textured packaging is
  requested.
- Do not replace the physics-authored USD path for simulation validation with a
  textured USDZ unless the user explicitly requests that validation target.

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Service call fails because endpoint requires bearer auth and the wrapper's default token is wrong | Endpoint-specific credentials are not the wrapper's default environment token | Export the selected service token environment variable before running the command. Avoid `--token` except when environment injection is impossible. |
| Required service endpoint missing | `CONTENT_AGENTS_*_BASE_URL` is unset | Hand off to `deploy-content-agents` for the missing target, then return to this router and rerun. |
| Material Agent renders `0 images` after a pre-assignment FET repair | The input USD was normalized or otherwise rewritten before Material Agent, which can change layer composition or scene traversal behavior seen by the service | Restart Content Agents from the converted/minimum-valid USD, then run `simready-conform-profile` and FET fixes on the latest service-authored USD. |
| Material Agent local logs show `Scene Optimizer failed — continuing pipeline without optimization` and `Permission denied: '/app/.build-resources/scene_optimizer_core/python'` | Local Docker Scene Optimizer bundle parent directory is not traversable by the non-root `material-agent` user; tracked upstream in `NVIDIA-dev/world-understanding#303` | For the running local container, run `docker exec --user root content-material-agent-service chmod -R a+rX /app/.build-resources/scene_optimizer_core`, then rerun the same optimized Material Agent command. If the service is remote or cannot be repaired, include the optimizer-bypass evidence in the handoff. |
| Physics Agent fails immediately in `optimize_usd` with no completed steps, and local service logs show `Permission denied: '/app/.build-resources/scene_optimizer_core/python'` | Local Docker Scene Optimizer bundle parent directory is not traversable by the non-root `physics-agent` user; tracked upstream in `NVIDIA-dev/world-understanding#303` | For the running local container, run `docker exec --user root content-physics-agent-service chmod -R a+rX /app/.build-resources/scene_optimizer_core`, then rerun the same optimized Physics Agent command. If the service is remote or cannot be repaired, report the optimized attempt as blocked. |
| Selected Content Agents call fails or times out | Service-level failure | Inspect the specific call's JSON report and retry that service reference after fixing the service or input issue. Do not hand-author substitute material/physics bindings. |
| Physics Agent appears slow during `identify_asset`, `build_dataset_usd`, `predict`, `restore_usd`, or `apply_physics` | Remote rendering, VLM inference, or CAD/instanced topology can make valid service steps take many minutes | Keep waiting while the wrapper polls and the service remains non-terminal with changing status/progress. Do not terminate the wrapper and write a substitute report. |

## Pass/Fail Policy

Block when a required service endpoint is missing and `deploy-content-agents` cannot deploy or verify the service.

Fail when a selected Content Agents call fails, times out, or cannot download its required output artifact.

Skip when the user explicitly disables a call, the selected profile does not need that enrichment, or texture generation is not requested.

Warn when optional prediction files, report HTML, or texture artifacts are unavailable but the required USD-family handoff exists.

## Next Steps

Use this handoff:

| Result | Next step |
|---|---|
| Material and physics assignment completed | Run `simready-conform-profile` on the latest physics-authored USD. |
| Texture generation completed for visual packaging | Use the textured artifact for packaging or preview; keep the physics USD for simulation validation unless requested otherwise. |
| Service deployment blocked | Resolve the deployment blocker or configure the missing service base URL and usage token, then rerun this router. |
| Selected call failed | Inspect the specific call report and retry that service reference after fixing the service or input issue. |
