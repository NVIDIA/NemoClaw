# CAD to SimReady Preflight

## When to Use

Use this reference before an `omniverse-cad-to-simready` workflow when the host
should have deterministic local dependencies instead of each downstream
reference discovering upstream checkouts independently. It prepares local
upstream checkouts, validates runtime entrypoints, optionally verifies or
deploys Content Agents, and writes a manifest that downstream references can
consume.

This reference is a setup and readiness contract. It is not a monolithic
CAD-to-SimReady workflow runner and it does not run conversion, property
assignment, conformance, validation, rendering, or packaging on an asset.

## Prerequisites

- Python 3.12.
- `uv` when a repository `pyproject.toml` is available and the project Python
  environment should be synchronized.
- `git`, and `git-lfs` when LFS fixtures or source assets must be materialized.
- Network and repository access for the upstream sources listed below.
- Docker, Docker Compose v2, NVIDIA Container Toolkit, an NVIDIA driver, an
  NVIDIA GPU, and `NVIDIA_API_KEY` when managed local Content Agents deployment
  is requested.

Windows hosts can use the same Python preflight script and PowerShell wrapper
for checkout and Python-runtime preparation. Managed Content Agents deployment
requires a Linux Docker/GPU host; on Windows use WSL2/Linux Docker or provide
healthy service endpoints.

## Upstream Sources

The preflight installs or verifies local checkouts under
`${PHYSICAL_AI_SKILL_HUB_UPSTREAM_ROOT:-$HOME/.physical-ai-skill-hub/upstreams}`
unless a per-upstream override is set.

| Area | Upstream | Default checkout / override |
|---|---|---|
| CAD conversion | `https://github.com/NVIDIA-Omniverse/usd-convert-cad` | `usd-convert-cad`, `USD_CONVERT_CAD_ROOT` |
| Gaussian splat conversion | `https://github.com/NVIDIA-Omniverse/usd-convert-gsplat` | `usd-convert-gsplat`, `USD_CONVERT_GSPLAT_ROOT` |
| SimReady validation and FET skills | `https://github.com/NVIDIA/simready-foundation` on branch `main` | `simready-foundation`, `SIMREADY_FOUNDATION_ROOT` |
| Content Agents services | `https://github.com/nvidia-omniverse/content-agents` on branch `main` | `content-agents`, `CONTENT_AGENTS_UPSTREAM_ROOT` |

The upstream URLs remain documented because they are the source of truth for
external NVIDIA technology. Operationally, downstream references should prefer
the preflight manifest when it is present.

## CLI Pattern

Linux/macOS:

```bash
.agents/skills/omniverse-cad-to-simready/references/preflight/scripts/preflight.sh \
  --env-file "$HOME/.physical-ai-skill-hub/state/cad-to-simready-preflight.env" \
  --markdown-report "$HOME/.physical-ai-skill-hub/state/cad-to-simready-preflight.md"

. "$HOME/.physical-ai-skill-hub/state/cad-to-simready-preflight.env"
```

Windows PowerShell:

```powershell
.\.agents\skills\omniverse-cad-to-simready\references\preflight\scripts\preflight.ps1 `
  --powershell-env-file "$HOME\.physical-ai-skill-hub\state\cad-to-simready-preflight.ps1" `
  --markdown-report "$HOME\.physical-ai-skill-hub\state\cad-to-simready-preflight.md"

. "$HOME\.physical-ai-skill-hub\state\cad-to-simready-preflight.ps1"
```

Dependency bootstrap without Content Agents service deployment:

```bash
python3 .agents/skills/omniverse-cad-to-simready/references/preflight/scripts/preflight.py \
  --skip-content-agents \
  --env-file "$HOME/.physical-ai-skill-hub/state/cad-to-simready-preflight.env"
```

Read-only readiness check:

```bash
python3 .agents/skills/omniverse-cad-to-simready/references/preflight/scripts/preflight.py \
  --check-only \
  --skip-deploy
```

## Manifest Contract

The default manifest path is:

```text
${PHYSICAL_AI_SKILL_HUB_STATE:-$HOME/.physical-ai-skill-hub/state}/cad-to-simready-preflight.json
```

Set `PHYSICAL_AI_PREFLIGHT_MANIFEST` to point downstream references at a
specific manifest. Set `PHYSICAL_AI_REQUIRE_PREFLIGHT=1` to make downstream
references block instead of falling back to legacy direct discovery when the
manifest is missing or the required component is not ready.

The generated env file exports:

- `PHYSICAL_AI_PREFLIGHT_MANIFEST`
- `PHYSICAL_AI_REQUIRE_PREFLIGHT=1`
- `PHYSICAL_AI_SKILL_HUB_HOME`
- `PHYSICAL_AI_SKILL_HUB_UPSTREAM_ROOT`
- `PATH` with the repository `.venv/bin` prepended when the project virtual
  environment is present, so direct reference scripts can find bundled CLIs
  such as `urdf_usd_converter`
- per-upstream root variables such as `USD_CONVERT_CAD_ROOT`
- prepared runtime variables such as `PHYSICAL_AI_SIMREADY_VALIDATE_VENV`
- ready service endpoints such as `CONTENT_AGENTS_MATERIAL_AGENT_BASE_URL`,
  `CONTENT_AGENTS_PHYSICS_AGENT_BASE_URL`, and `RENDER_ENDPOINT`

Use `--env-file` for POSIX shells and `--powershell-env-file` for PowerShell.

The manifest never writes API keys, bearer tokens, or file-backed secret
contents. Command output is redacted before it is included in the report.

## Content Agents Policy

Content Agents readiness is included by default. Preflight first reuses healthy
existing `CONTENT_AGENTS_*_BASE_URL` and renderer endpoints. Material,
Physics, and Texture endpoints must also report configured API keys when their
health payload includes `api_keys_configured`; a healthy container without
service credentials is not workflow-ready. If endpoints are not ready and
deployment is enabled, preflight checks Docker/GPU/auth prerequisites with
`nvidia-smi`, the Docker daemon, Docker Compose v2, and `NVIDIA_API_KEY`, then
invokes executable upstream deployment entrypoints only when the
`content-agents` checkout publishes them. The upstream collection helper
starts agent services; when the shared OVRTX endpoint is still unhealthy after
that step, preflight invokes the upstream standalone OVRTX Docker Compose
entrypoint from `apps/ovrtx_rendering_api/docker-compose.yml` and waits for the
host `/health` endpoint.
For managed local deployment, known Content Agents credential environment
variables such as `NVIDIA_API_KEY` are mirrored into the upstream checkout's
private `.env` file with owner-only permissions so Docker Compose can pass them
to containers. Those values are not written to the preflight manifest or
generated downstream env file. When `NGC_API_KEY` is absent, the managed local
deployment mirrors `NVIDIA_API_KEY` into that name inside the upstream `.env`
because the upstream collection's local render endpoint is reached from
containers through a Docker host alias.

For remote or NVCF-style endpoints, preflight records the provided endpoint as
ready without treating generic unauthenticated `/health` failures as blockers.
The selected service wrapper still performs the authenticated service call and
reports any real request failure.

Do not encode service-specific Docker Compose files, image names, ports inside
containers, or deployment runbooks in this repo. If the selected upstream
checkout exposes only documentation-driven deployment skills, preflight reports
Content Agents as blocked and points the user back to the upstream deployment
skills or to provided healthy endpoints.

Use `--skip-content-agents` only when Content Agents are explicitly out of
scope, such as conversion-only, validation-only, or no material/physics
assignment. Use `--skip-deploy` when endpoints should be verified but services
must not be started.

Preflight can reduce dependency checks to the requested workflow target and
source route. Use `--targets conversion`, `--targets validation`, or
`--targets conversion,validation,content-agents` to choose workflow areas. Use
`--source-asset /path/to/input.urdf` or `--source-format urdf` to infer the
conversion route, `--output-root /path/to/output` to verify the output directory
is writable or creatable, or pass `--conversion-tools
repo-python,usd-convert-cad` for an explicit converter set. URDF and MuJoCo/MJCF
routes require only the repo Python conversion tools; CAD and mesh routes
require `usd-convert-cad`; Gaussian splat routes require `usd-convert-gsplat`.
Validation targets also gate OpenUSD Python APIs (`pxr.Usd`, `pxr.UsdGeom`, and
`pxr.UsdPhysics`) and the upstream Asset Validator runtime
(`omni_asset_validate` or `omni.asset_validator`) before SimReady validation.
On Linux aarch64, if the SimReady Foundation requirements cannot resolve
PyPI `usd-core`, preflight retries the SimReady validation runtime with
`usd-exchange>=2.3.0`, `omniverse-asset-validator`,
`omniverse-usd-profiles`, non-`usd-core` Foundation requirements, and
`simready-validate` installed without dependencies.

If `uv` is missing, the `repo_python` runtime entry includes an install hint:
`curl -LsSf https://astral.sh/uv/install.sh | sh`.

## Output Format

The JSON report includes:

- overall `status`: `ready` or `blocked`
- selected `targets`
- selected conversion tools and route-selection reason
- request input readiness for the source asset and output root
- normalized paths for home, state, upstream, venv, project, and output roots
- upstream checkout path, URL, branch, commit, and status
- runtime readiness for repo Python, Git LFS, converters, OpenUSD Python APIs,
  Asset Validator, SimReady validation, and Content Agents
- Content Agents local deployment host diagnostics for `nvidia-smi`, Docker
  daemon access, and Docker Compose v2 when local deployment may be needed
- service readiness for OVRTX, Material, Physics, and optional Texture
- non-secret downstream environment exports
- command steps with redacted output tails
- blocker messages

The Markdown report summarizes the same status for humans.

## Pass/Fail Policy

Return success only when every selected target is ready or explicitly skipped.
Report blocked when a selected runtime, checkout, CLI, service endpoint, or
deployment prerequisite is missing. Do not scan broad developer workspaces or
reuse arbitrary old clones.

## Next Steps

After preflight succeeds, source the generated env file, then run the normal
atomic references in the `omniverse-cad-to-simready` workflow. Downstream
references will consume the manifest and prepared local paths/endpoints before
trying direct legacy discovery.
