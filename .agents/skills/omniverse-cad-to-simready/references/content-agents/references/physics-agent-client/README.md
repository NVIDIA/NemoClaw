# Assign Physics Properties

## When to Use

Use this reference after visual material assignment when an asset needs simulation physics. It is normally selected through the `content-agents` router and calls this reference's `scripts/run.py`, which talks to the Content Agents Physics Agent service API and downloads the physics-authored USD output.

This reference should be the main bridge between Content Agents property prediction and static SimReady validation. It is expected to author or return USD with physics schemas when the service succeeds.

## Upstream Reference

Use the upstream NVIDIA Omniverse Content Agents Physics Agent client skill as the authoritative reference for service API behavior, endpoint semantics, request fields, and client-side troubleshooting:

- Upstream skill: `https://github.com/nvidia-omniverse/content-agents/blob/main/.codex/skills/physics-agent-client/SKILL.md`
- Upstream repository: `https://github.com/nvidia-omniverse/content-agents` on branch `main`
- Upstream service client: `https://github.com/nvidia-omniverse/content-agents/blob/main/apps/physics_agent_service/client/client.py`

Access note: Browser or raw-file fetches of the upstream skill URL can fail. If that happens, use the normalized local clone of `https://github.com/nvidia-omniverse/content-agents` checked out to `main` and read `.codex/skills/physics-agent-client/SKILL.md` from that checkout. Resolve that clone from `CONTENT_AGENTS_UPSTREAM_ROOT`, then `$PHYSICAL_AI_SKILL_HUB_UPSTREAM_ROOT/content-agents`, then `$HOME/.physical-ai-skill-hub/upstreams/content-agents`.

Do not copy or reinterpret upstream Physics Agent API behavior here. Keep this reference limited to this reference's wrapper contract, required environment, report shape, and downstream handoff.

## Dependency Check

Require:

- this reference's portable `scripts/run.py` and `scripts/check_dependencies.py`
- a reachable Physics Agent service URL through `--base-url` or `CONTENT_AGENTS_PHYSICS_AGENT_BASE_URL`
- `CONTENT_AGENTS_PHYSICS_AGENT_TOKEN`, `PHYSICS_AGENT_TOKEN`,
  `CONTENT_AGENTS_TOKEN`, `NGC_API_KEY`, or `NVCF_API_KEY` when the service
  requires bearer auth.

If no Physics Agent base URL is configured, do not immediately stop at assignment. Use `deploy-content-agents` with target `physics`; that
reference points to the upstream deployment skill and owns deployment details.
After deployment health checks pass, export the resulting host/client URL as
`CONTENT_AGENTS_PHYSICS_AGENT_BASE_URL` and rerun `physics-agent-client`.

First-time users must not run assignment before service readiness is settled.
Check for a reachable endpoint, then check for `NVIDIA_API_KEY`; if the key is
missing, ask the user to create/provide one and wait. When deployment succeeds
and the service is healthy, run this command.

If deployment is unavailable or fails because the upstream checkout, Docker/GPU prerequisites, renderer wiring, or required credentials are missing, preserve those deployment findings and then report the physics assignment as blocked. Do not hand-author substitute rigid bodies, colliders, mass, or friction data when this reference was selected.

Do not commit API keys, put them in reports, or pass them as command-line
arguments in normal workflows because process listings can expose argv. The
portable wrapper redacts tokens from its report command, but prefer
`CONTENT_AGENTS_PHYSICS_AGENT_TOKEN`, `PHYSICS_AGENT_TOKEN`,
`CONTENT_AGENTS_TOKEN`, `NGC_API_KEY`, `NVCF_API_KEY`, or matching `*_FILE`
variables from the environment. `NVIDIA_API_KEY` is deployment auth and is not
used as the default client bearer token. The `--token` option remains available
only for constrained automation that cannot inject environment variables.

## Inputs

Collect:

| Input | Requirement |
|---|---|
| `asset_path` | Required `.usd`, `.usda`, `.usdc`, or `.usdz` asset, preferably after material assignment. |
| `output_directory` | Required directory for downloaded service artifacts. |
| `base_url` | Optional Physics Agent service endpoint; overrides env-based base URL resolution. |
| `token` | Optional bearer token; defaults to env. |
| `prompt` | Optional property assignment guidance; prefer the `material_physics_prompt` from `identify-asset-context` when available. |
| `render_backend` | Optional `warp`, `ovrtx`, or `remote`. |
| `optimize_usd` | Optional Physics Agent USD optimizer preprocessing path. |
| `enable_deinstance` | Optional optimizer setting; enabled by default for Physics Agent parity with upstream. |
| `enable_split` | Optional optimizer setting that splits combined meshes into separate components. |
| `auto_optimize_composed_usd` | Enabled by default. The wrapper inspects USD topology and automatically enables `optimize_usd`, `enable_deinstance`, and `enable_split` when it detects `GeomSubset`, instance, or prototype component topology. If system `python3` cannot import `pxr`, the wrapper tries `uv run --python 3.12` for this inspection before falling back to a skipped inspection. Use `--no-auto-optimize-composed-usd` to disable this behavior. |
| `convert_output_to_usd` | Optional local wrapper workaround. When requested with `--convert-output-to-usd`, ensure the downloaded Physics Agent USD-family artifact is crate-backed `.usd` and report that `.usd` as `output_usd_path`. |

## Optimizer Flags for Composed CAD Assets

The wrapper automatically inspects the input USD before the Physics Agent
request. When it detects instances, prototypes, or a single mesh partitioned by
`GeomSubset` children, it runs Physics Agent with all three optimizer controls:

```bash
--optimize-usd --enable-deinstance --enable-split
```

Use this combination after Material Agent output when the goal is component-level physics authoring. `--optimize-usd` enables the service preprocessing path, `--enable-deinstance` makes instance/prototype geometry writable when present, and `--enable-split` lets the optimizer split combined meshes into separate component prims before rendering, prediction, and physics schema application.

Before uploading USD-layer inputs to Physics Agent, the wrapper stages a
physics-only copy when it finds MDL shader `sourceAsset` attributes such as
`pbr.mdl`. Those MDL source files are not needed for physics authoring, and the
main optimizer can otherwise produce output that still points at missing
MDL sidecars during packaging. The report records this as
`physics_upload_info.staged=true` with `stripped_mdl_source_assets`.

The same upload-prep step clears unresolved service-internal USDZ subasset paths
from Material Agent outputs, for example
`/var/material-agent/sessions/.../scene.usdz[textures/name.png]`. Those paths
refer to files inside the Material Agent service container and are not available
to the local wrapper when it packages the materialized USD for Physics Agent.
The report records this as
`physics_upload_info.cleared_unresolved_service_asset_paths`.

For the GZIO connector test asset, the materialized USD has one combined mesh with six `GeomSubset` partitions. Running Physics Agent with these flags produced six split mesh parts and six corresponding rigid bodies instead of one rigid body on the combined mesh.

This optimizer path is a preprocessing hint, not a guarantee that the Physics
Agent will author one rigid body per component. If the returned USD still fails
`RB.MB.001`, hand the latest Physics Agent output to
`simready-conform-profile` and route the failure to
upstream `simready-foundation-conform-fet-004-simulate-multi-body-physics` when the asset
has at least two reusable component candidates. FET004 may promote existing
component colliders or part roots into separate rigid bodies when the profile
requires multibody physics and no new geometry is needed. For a single mesh
component or single `GeomSubset` component, `simready-validate` treats
`RB.MB.001` as non-blocking and preserves it under `ignored_issues`.

### Local Scene Optimizer Permission Workaround

For local Docker deployments, a known upstream issue can make the optimized
Physics Agent path fail immediately in `optimize_usd` with a service log like:
`Permission denied: '/app/.build-resources/scene_optimizer_core/python'`.
This is a Scene Optimizer bundle permission problem in the service container,
not a signal to disable `--optimize-usd`, `--enable-deinstance`, or
`--enable-split` for instanced/prototype topology.

When the report shows `current_step.name=optimize_usd` and the service failed
with no completed steps, inspect the Physics Agent service logs. If they show
the permission error above on a local container named
`content-physics-agent-service`, repair the running deployment and rerun the
same optimized Physics Agent command:

```bash
docker exec --user root content-physics-agent-service chmod -R a+rX /app/.build-resources/scene_optimizer_core
```

If the container name differs, use the active Physics Agent service container.
If the endpoint is managed or remote and you cannot inspect or repair the
container, report the optimizer failure as blocked and include the optimized
attempt details. Track the upstream issue at
`https://github.com/NVIDIA-dev/world-understanding/issues/303`.

## Instructions

1. Confirm the asset exists and is a USD-family file.
2. Resolve the Physics Agent endpoint from `--base-url` or `CONTENT_AGENTS_PHYSICS_AGENT_BASE_URL`.
3. If no endpoint is available, check `NVIDIA_API_KEY`; if missing, ask the user to provide one and wait.
4. Use `deploy-content-agents` with target `physics`; when deployment succeeds and the service is healthy, set `CONTENT_AGENTS_PHYSICS_AGENT_BASE_URL` and return to this workflow.
5. If an asset context report exists, use its likely identity, evidence, physics hints, and confidence to craft `--prompt`.
6. Run this reference's portable `scripts/run.py`.
7. Preserve the JSON report, physics-authored USD output, predictions JSONL, dataset JSONL, and HTML report when available. The upstream `/output-usd` artifact extension follows the input asset or the service response filename; do not assume it is `.usda`.
8. When ASCII USDA output or universal `.usd` output would block downstream validators that expect crate-backed USD, add `--convert-output-to-usd` so the wrapper exports the downloaded artifact to crate-backed `.usd`. Already crate-backed `.usd` output is accepted as-is.
9. If the optimized path fails at `optimize_usd`, inspect service logs before accepting a no-optimizer retry as diagnostic. For the local Scene Optimizer permission failure above, repair the container permissions and rerun the optimized command.
10. Use `output_usd_path` from the report as the input to `simready-conform-profile`.

## CLI Pattern

```bash
python3 /path/to/skills/omniverse-cad-to-simready/references/content-agents/references/physics-agent-client/scripts/run.py asset.usda output_dir/physics \
  --render-backend remote \
  --convert-output-to-usd \
  --prompt "$ASSET_CONTEXT_PROMPT" \
  --report output_dir/physics/physics-agent-client.json
```

Add `--base-url "$CONTENT_AGENTS_PHYSICS_AGENT_BASE_URL"` only when overriding the URL resolved from the environment.

The wrapper auto-enables `--optimize-usd --enable-deinstance --enable-split`
for composed CAD topology. Pass those flags explicitly when the caller already
knows component-level processing is required, or pass
`--no-auto-optimize-composed-usd` for hand-authored USD where topology changes
are not desired.

Use `--convert-output-to-usd` only as a local post-processing workaround. It does not change the upstream Physics Agent service response; it opens the downloaded USD-family artifact with OpenUSD when conversion is needed, exports the root layer to `.usd`, and verifies the result is crate-backed. If the downloaded artifact is already crate-backed `.usd`, the wrapper reports that path directly.

## Output Format

The report includes:

- `asset_path`
- `skill`
- `agent`
- `tool`
- `passed`
- `status`
- `base_url`
- `session_id`
- `output_directory`
- `output_usd_path`; with `--convert-output-to-usd`, this points to the converted crate-backed `.usd`
- `artifacts`
- `service_status`
- `service_results`
- `usd_topology` and `physics_optimizer` for Physics Agent topology inspection
  and effective optimizer decisions
- `physics_upload_info` when the wrapper stages a physics-safe upload copy
- `checks`
- `warnings`
- `errors`
- `next_step`

## Pass/Fail Policy

Fail or block when:

- the input asset is missing or not USD-family
- the service URL is missing and `deploy-content-agents` cannot deploy a healthy Physics Agent service
- the service session fails or times out
- the required physics-authored USD artifact cannot be downloaded
- `--convert-output-to-usd` is requested and the local OpenUSD conversion to crate-backed `.usd` fails

Warn when optional prediction, dataset, or HTML report artifacts are unavailable.

## Next Steps

Use this handoff:

| Result | Next step |
|---|---|
| Physics-authored USD downloaded | Run `simready-conform-profile` on `output_usd_path`. |
| Service endpoint missing | Check `NVIDIA_API_KEY`, use `deploy-content-agents` target `physics`, export `CONTENT_AGENTS_PHYSICS_AGENT_BASE_URL`, then rerun. |
| Service deployment blocked | Resolve the deployment blocker, or configure a Physics Agent base URL and usage token, then rerun. |
| Service failed | Inspect `service_status`, `service_results`, predictions, and report artifacts. |
