# Assign Visual Materials

## When to Use

Use this reference after USD conversion and minimum USD validation when an asset needs visual material assignment. It is normally selected through the `content-agents` router and calls this reference's `scripts/run.py`, which talks to the Content Agents Material Agent service API and downloads the materialized USD output.

This reference does not assign rigid bodies, colliders, mass, friction, or texture maps. Run `physics-agent-client` after this step when simulation physics are required. Run `texture-agent-client` only when textured output is desired.

## Upstream Reference

Use the upstream NVIDIA Omniverse Content Agents Material Agent client skill as the authoritative reference for service API behavior, endpoint semantics, request fields, and client-side troubleshooting:

- Upstream skill: `https://github.com/nvidia-omniverse/content-agents/blob/main/.codex/skills/material-agent-client/SKILL.md`
- Upstream repository: `https://github.com/nvidia-omniverse/content-agents` on branch `main`
- Upstream service client: `https://github.com/nvidia-omniverse/content-agents/blob/main/apps/material_agent_service/client/client.py`

Access note: Browser or raw-file fetches of the upstream skill URL can fail. If that happens, use the normalized local clone of `https://github.com/nvidia-omniverse/content-agents` checked out to `main` and read `.codex/skills/material-agent-client/SKILL.md` from that checkout. Resolve that clone from `CONTENT_AGENTS_UPSTREAM_ROOT`, then `$PHYSICAL_AI_SKILL_HUB_UPSTREAM_ROOT/content-agents`, then `$HOME/.physical-ai-skill-hub/upstreams/content-agents`.

Do not copy or reinterpret upstream Material Agent API behavior here. Keep this reference limited to this reference's wrapper contract, required environment, report shape, and downstream handoff.

## Dependency Check

Require:

- this reference's portable `scripts/run.py` and `scripts/check_dependencies.py`
- a reachable Material Agent service URL through `--base-url` or `CONTENT_AGENTS_MATERIAL_AGENT_BASE_URL`
- `CONTENT_AGENTS_MATERIAL_AGENT_TOKEN`, `MATERIAL_AGENT_TOKEN`,
  `CONTENT_AGENTS_TOKEN`, `NGC_API_KEY`, or `NVCF_API_KEY` when the service
  requires bearer auth.

If no Material Agent base URL is configured, do not immediately stop at assignment. Use `deploy-content-agents` with target `material`; that
reference points to the upstream deployment skill and owns deployment details.
After deployment health checks pass, export the resulting host/client URL as
`CONTENT_AGENTS_MATERIAL_AGENT_BASE_URL` and rerun `material-agent-client`.

First-time users must not run assignment before service readiness is settled.
Check for a reachable endpoint, then check for `NVIDIA_API_KEY`; if the key is
missing, ask the user to create/provide one and wait. When deployment succeeds
and the service is healthy, run this command.

If deployment is unavailable or fails because the upstream checkout, Docker/GPU prerequisites, renderer wiring, or required credentials are missing, preserve those deployment findings and then report the material assignment as blocked. Do not hand-author substitute material bindings or bypass the Content Agents service when this reference was selected.

Do not commit API keys, put them in reports, or pass them as command-line
arguments in normal workflows because process listings can expose argv. The
portable wrapper redacts tokens from its report command, but prefer
`CONTENT_AGENTS_MATERIAL_AGENT_TOKEN`, `MATERIAL_AGENT_TOKEN`,
`CONTENT_AGENTS_TOKEN`, `NGC_API_KEY`, `NVCF_API_KEY`, or matching `*_FILE`
variables from the environment. `NVIDIA_API_KEY` is deployment auth and is not
used as the default client bearer token. The `--token` option remains available
only for constrained automation that cannot inject environment variables.

## Inputs

Collect:

| Input | Requirement |
|---|---|
| `asset_path` | Required `.usd`, `.usda`, `.usdc`, or `.usdz` asset. |
| `output_directory` | Required directory for downloaded service artifacts. |
| `base_url` | Optional Material Agent service endpoint; overrides env-based base URL resolution. |
| `token` | Optional bearer token; defaults to env. |
| `email` | Optional user email metadata. |
| `prompt` | Optional material assignment guidance; prefer the `material_physics_prompt` from `identify-asset-context` when available. |
| `optimize_usd` | Optional; enabled by default. The wrapper inspects USD topology first and disables it only for instance/prototype-only assets that would otherwise lose all renderable prims if the main service falls back to original topology. If system `python3` cannot import `pxr`, the wrapper tries `uv run --python 3.12` for topology inspection before falling back to the service default. |
| `skip_instances` | Optional; normally left to the service default when `optimize_usd` remains enabled. The wrapper sends `skip_instances=false` only when it selects the instance/prototype-only traversal path. |

## Upload Prep

Before uploading USD-layer inputs, the wrapper stages a material-safe copy when
it finds MDL shader `sourceAsset` attributes such as `gltf/pbr.mdl`. Converted
glTF or CAD assets can reference these MDL sidecars even when the sidecar files
are absent from the converted asset directory. Those missing shader-source
files are not needed for Material Agent prediction, and they can block USDZ
upload packaging. The report records this as `material_upload_info.staged=true`
with `stripped_mdl_source_assets`.

## Output Cleanup

After the required materialized USD artifact is downloaded, the wrapper runs a
narrow material hygiene pass on USD-layer outputs. It finds actually bound
materials, then removes unbound `UsdShade.Material` subtrees whose shader
children use `implementationSource = "sourceAsset"` without a valid authored or
packaged MDL `sourceAsset`. If a bound material still has that broken shader
shape, the wrapper preserves the binding and rewrites only the broken shader
prim to a neutral `UsdPreviewSurface` fallback. This preserves the Material
Agent's usable material assignment while pruning or repairing stale converted
material networks that can trigger SimReady material validation failures. The
report records the result in `material_output_cleanup`.

Pass `--no-material-output-cleanup` only for debugging when the unmodified
service artifact must be preserved.

## Rate Limits

This wrapper retries transient status polling and delayed artifact downloads,
including HTTP 429 responses returned by those wrapper-visible endpoints. It
cannot retry per-prim VLM predictions that the Material Agent has already marked
failed inside a completed session. If the service report shows VLM rate limits,
preserve the partial predictions, rerun later or with a smaller asset/workload
when possible, and use a service key with sufficient quota for large assemblies.

## Local Scene Optimizer Permission Workaround

For local Docker deployments, a known upstream issue can make the optimized
Material Agent path fail inside the service with a log like:
`Scene Optimizer failed — continuing pipeline without optimization (using
original USD): [Errno 13] Permission denied:
'/app/.build-resources/scene_optimizer_core/python'`. This is a Scene
Optimizer bundle permission problem in the service container, not a signal to
permanently disable Material Agent `optimize_usd`.

When `optimize_usd=true` was intended and local service logs show the
permission error above on a container named `content-material-agent-service`,
repair the running deployment and rerun the same Material Agent command:

```bash
docker exec --user root content-material-agent-service chmod -R a+rX /app/.build-resources/scene_optimizer_core
```

If the container name differs, use the active Material Agent service container.
If the endpoint is managed or remote and you cannot inspect or repair the
container, preserve the report and include the optimizer-bypass evidence in the
blocked or failed handoff. Track the upstream issue at
`https://github.com/NVIDIA-dev/world-understanding/issues/303`.

## Instructions

1. Confirm the asset exists and is a USD-family file.
2. Resolve the Material Agent endpoint from `--base-url` or `CONTENT_AGENTS_MATERIAL_AGENT_BASE_URL`.
3. If no endpoint is available, check `NVIDIA_API_KEY`; if missing, ask the user to provide one and wait.
4. Use `deploy-content-agents` with target `material`; when deployment succeeds and the service is healthy, set `CONTENT_AGENTS_MATERIAL_AGENT_BASE_URL` and return to this workflow.
5. If an asset context report exists, use its likely identity, evidence, and material hints to craft `--prompt`.
6. Run this reference's portable `scripts/run.py`. It inspects the USD first, strips missing MDL shader-source upload references when needed, keeps `optimize_usd=true` by default, and switches to `optimize_usd=false` with `skip_instances=false` only for instance/prototype-only topology where the main service would otherwise skip all renderable prims. If the optimized path still fails with the known `Rendering produced 0 images` symptom, the wrapper retries once with `optimize_usd=false` and `skip_instances=false` and records both attempts. After downloading the materialized USD, it removes unbound stale material subtrees and repairs bound stale shaders with broken `sourceAsset` references.
7. If the optimized path was intended but service logs show the local Scene Optimizer permission failure above, repair the container permissions and rerun the optimized command before accepting a direct-traversal result as diagnostic.
8. Preserve the JSON report, materialized USD output, predictions JSONL, and report HTML when available.
9. Use `output_usd_path` from the report as the input to `physics-agent-client`.

## CLI Pattern

```bash
python3 /path/to/skills/omniverse-cad-to-simready/references/content-agents/references/material-agent-client/scripts/run.py asset.usda output_dir/materials \
  --prompt "$ASSET_CONTEXT_PROMPT" \
  --report output_dir/materials/material-agent-client.json
```

Add `--base-url "$CONTENT_AGENTS_MATERIAL_AGENT_BASE_URL"` only when overriding the URL resolved from the environment.

Use `--layer-only` only when the user wants a bindings layer and the downstream workflow knows how to compose it.

`--optimize-usd` is the default effective path. Pass `--no-optimize-usd` only to force direct Material Agent traversal. For converted CAD assets that contain only instanced/prototype renderable geometry, the wrapper chooses that direct traversal path automatically and sends `skip_instances=false`; this avoids main Material Agent sessions that produce a zero-image dataset after skipping every instance/proxy prim.

When topology inspection is unavailable but the service returns `Rendering
produced 0 images` from `build_dataset_usd`, the wrapper treats that as the
same recoverable zero-render symptom and retries once through direct traversal.
The JSON report includes `attempts` when this fallback runs.

Use `--no-material-output-cleanup` only when preserving the raw downloaded
Material Agent artifact is more important than downstream SimReady validation
hygiene.

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
- `output_usd_path`
- `material_upload_info`
- `material_output_cleanup`
- `artifacts`
- `service_status`
- `service_results`
- `checks`
- `warnings`
- `errors`
- `next_step`

## Pass/Fail Policy

Fail or block when:

- the input asset is missing or not USD-family
- the service URL is missing and `deploy-content-agents` cannot deploy a healthy Material Agent service
- the service session fails or times out
- the required materialized USD artifact cannot be downloaded

Warn when optional prediction or HTML report artifacts are unavailable.

## Next Steps

Use this handoff:

| Result | Next step |
|---|---|
| Materialized USD downloaded | Run `physics-agent-client` on `output_usd_path`. |
| Service endpoint missing | Check `NVIDIA_API_KEY`, use `deploy-content-agents` target `material`, export `CONTENT_AGENTS_MATERIAL_AGENT_BASE_URL`, then rerun. |
| Service deployment blocked | Resolve the deployment blocker, or configure a Material Agent base URL and usage token, then rerun. |
| Service failed | Inspect `service_status`, `service_results`, and optional report artifacts. |
