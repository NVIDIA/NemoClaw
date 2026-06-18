# Generate Asset Textures

## When to Use

Use this optional reference after material assignment when the user wants generated texture maps or a textured USDZ artifact. It is normally selected through the `content-agents` router and calls this reference's `scripts/run.py`, which talks to the Content Agents Texture Agent service API and downloads textured output artifacts.

Texture generation is optional for the current `omniverse-cad-to-simready` path. Do not run it by default unless the user requests textures or the selected workflow profile explicitly needs textured output.

## Upstream Reference

Use the upstream NVIDIA Omniverse Content Agents Texture Agent client skill as the authoritative reference for service API behavior, endpoint semantics, request fields, and client-side troubleshooting:

- Upstream skill: `https://github.com/nvidia-omniverse/content-agents/blob/main/.codex/skills/texture-agent-client/SKILL.md`
- Upstream repository: `https://github.com/nvidia-omniverse/content-agents` on branch `main`
- Upstream service client: `https://github.com/nvidia-omniverse/content-agents/blob/main/apps/texture_agent_service/client/client.py`

Access note: Browser or raw-file fetches of the upstream skill URL can fail. If that happens, use the normalized local clone of `https://github.com/nvidia-omniverse/content-agents` checked out to `main` and read `.codex/skills/texture-agent-client/SKILL.md` from that checkout. Resolve that clone from `CONTENT_AGENTS_UPSTREAM_ROOT`, then `$PHYSICAL_AI_SKILL_HUB_UPSTREAM_ROOT/content-agents`, then `$HOME/.physical-ai-skill-hub/upstreams/content-agents`.

Do not copy or reinterpret upstream Texture Agent API behavior here. Keep this reference limited to this reference's wrapper contract, required environment, report shape, and workflow path selection.

## Dependency Check

Require:

- this reference's portable `scripts/run.py` and `scripts/check_dependencies.py`
- a reachable Texture Agent service URL through `--base-url` or `CONTENT_AGENTS_TEXTURE_AGENT_BASE_URL`
- `CONTENT_AGENTS_TEXTURE_AGENT_TOKEN`, `TEXTURE_AGENT_TOKEN`,
  `CONTENT_AGENTS_TOKEN`, `NGC_API_KEY`, or `NVCF_API_KEY` when the service
  requires bearer auth.

If no Texture Agent base URL is configured, follow the same
first-time Content Agents readiness flow as material and physics: check for
`NVIDIA_API_KEY`, ask the user to provide one and wait if missing, then use
`deploy-content-agents` target `texture`. Do not bypass the service with ad hoc
texture files.

Do not commit API keys, put them in reports, or pass them as command-line
arguments in normal workflows because process listings can expose argv. The
portable wrapper redacts tokens from its report command, but prefer
`CONTENT_AGENTS_TEXTURE_AGENT_TOKEN`, `TEXTURE_AGENT_TOKEN`,
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
| `base_url` | Optional Texture Agent service endpoint; overrides env-based base URL resolution. |
| `token` | Optional bearer token; defaults to env. |
| `prompt` | Optional texture style guidance. |
| `material_textures` | Optional JSON string for per-material texture config. |

## Instructions

1. Confirm the asset exists and is a USD-family file.
2. Confirm the service URL is available.
3. If no endpoint is available, check `NVIDIA_API_KEY`; if missing, ask the user to provide one and wait.
4. Use `deploy-content-agents` target `texture`; when deployment succeeds and the service is healthy, set `CONTENT_AGENTS_TEXTURE_AGENT_BASE_URL` and return to this workflow.
5. Run this reference's portable `scripts/run.py`. The wrapper submits the USD as `usd_file` in one multipart `POST /pipeline` request.
6. Preserve the JSON report, textured USDZ output, materials JSON, textures ZIP, and renders ZIP when available.
7. Continue with the workflow asset path that matches user intent. For simulation validation, prefer the materialized/physics USD unless the user explicitly wants to validate the textured USDZ.

Do not use the upstream `--upload-first` option or the `/pipeline/upload-usd`
submission path for Texture Agent workflows from this repo. Texture requests
must submit the USD in the same `POST /pipeline` call that starts the session.

## CLI Pattern

```bash
python3 /path/to/skills/omniverse-cad-to-simready/references/content-agents/references/texture-agent-client/scripts/run.py asset.usda output_dir/textures \
  --prompt "Clean industrial plastic and rubber textures." \
  --report output_dir/textures/texture-agent-client.json
```

With per-material texture config:

```bash
python3 /path/to/skills/omniverse-cad-to-simready/references/content-agents/references/texture-agent-client/scripts/run.py asset.usda output_dir/textures \
  --material-textures '{"Steel": {"prompt": "brushed steel", "opacity": 1.0}}' \
  --report output_dir/textures/texture-agent-client.json
```

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
- the service URL is missing
- the service session fails or times out
- the required textured USDZ artifact cannot be downloaded
- `--material-textures` is not valid JSON

Warn when optional materials, textures, or renders artifacts are unavailable.

## Next Steps

Use this handoff:

| Result | Next step |
|---|---|
| Textured USDZ downloaded | Use it for visual review or packaging when requested. |
| Simulation validation needed | Continue with materialized/physics USD unless the profile accepts the textured USDZ path. |
| Service blocked | Configure the service base URL and usage token, or deploy with `deploy-content-agents`, then rerun. |
