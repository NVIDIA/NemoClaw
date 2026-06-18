---
name: vss-deploy-profile
description: Use to select, configure, deploy, verify, debug, or tear down a VSS profile (base, search, lvs, warehouse, edge). Not for standalone microservices — use the vss-deploy-* skill.
license: Apache-2.0
metadata:
  version: "3.2.0"
  github-url: "https://github.com/NVIDIA-AI-Blueprints/video-search-and-summarization"
  tags: "nvidia blueprint deployment"
---
# VSS Deploy

## Available Scripts

| Script | Purpose | Arguments |
|---|---|---|
| `scripts/normalize_resolved_yml.py` | Strip optional `depends_on` entries for services filtered out of `resolved.yml` before deploy. | Path to `resolved.yml` |
| `scripts/probe_remote_models.sh` | Probe an OpenAI-compatible remote LLM/VLM endpoint and verify the selected model id. | Base URL, optional expected model id |

## Profile Routing

Match the user's request to a profile, then load that profile's reference for sizing, services, env recipes, and debugging.

| User says | Profile | Reference |
|---|---|---|
| "deploy vss" / "deploy base" | `base` | [`references/base.md`](references/base.md) |
| "deploy alerts" / "alert verification" / "real-time alerts" / "deploy for incident report" | `alerts` | [`references/alerts.md`](references/alerts.md) |
| "deploy lvs" / "video summarization" | `lvs` | [`references/lvs-profile.md`](references/lvs-profile.md) |
| "deploy search" / "video search" | `search` | [`references/search.md`](references/search.md) |
| "deploy warehouse" / "warehouse blueprint" / "vss warehouse" | `warehouse` | [`references/warehouse.md`](references/warehouse.md) |
| "debug warehouse" / "warehouse not working" / "warehouse FPS low" / "warehouse BEV out of sync" | `warehouse` (debug) | [`references/warehouse-debug.md`](references/warehouse-debug.md) |

**Edge hardware routing** (DGX Spark, AGX/IGX Thor): see [`references/edge.md`](references/edge.md). DGX Spark uses the Spark Nano 9B standalone local LLM on port `30081`; AGX/IGX Thor uses the Edge 4B standalone vLLM fallback.

**Each profile's reference owns its sizing table.** Don't pick a deployment shape from this file — open the profile reference and check minimum GPU count for the host's hardware against the (mode × platform) matrix there.

## Instructions

The deployment flow is always: copy `.env` to `generated.env`, apply overrides, dry-run compose into `resolved.yml`, review, normalize, deploy, then wait for readiness.

```bash
# 1. cp dev-profile-<profile>/.env dev-profile-<profile>/generated.env  (clean copy)
# 2. Apply env overrides to generated.env  (source .env stays untouched)
# 3. docker compose --env-file generated.env config > resolved.yml      (dry-run)
# 4. Review resolved.yml
# 5. docker compose --env-file generated.env -f resolved.yml up -d
```

`.env` is read-only checked-in defaults; `generated.env` is the per-deploy working copy. Step 1c covers this in full.

## Prerequisites

1. **Repo path** — auto-detect `video-search-and-summarization/` before
   asking the user. Use the detected path as `$REPO` for all subsequent
   commands.
2. **Credential gates** — see [`references/credentials.md`](references/credentials.md): `NGC_CLI_API_KEY` for local/local_shared NIM pulls, `NVIDIA_API_KEY` for remote NIM endpoints, and `HF_TOKEN` for edge recipes that use gated HF models.
3. **System prerequisites (GPU driver, Docker, NVIDIA Container Toolkit, kernel sysctls, and — if `ufw` is active — the [Docker-bridge→host firewall allow](references/prerequisites.md#firewall) so bridge NIMs can fetch clips from host-mode VST)** — full checks in [`references/prerequisites.md`](references/prerequisites.md). Canonical hardware/driver matrix is the [VSS prerequisites page](https://docs.nvidia.com/vss/3.2.0/prerequisites.html).

The auto-detect snippet (git-root, then a common-path probe gated on
`deploy/docker/compose.yml` + `dev-profile.sh` + `skills/vss-deploy-profile`)
lives in [`references/prerequisites.md`](references/prerequisites.md#repo-detect).
Export the resolved `$REPO`; if detection fails, ask the user for the checkout path.

### Pre-flight check

Run before every deploy. The full system checklist and remediation steps live
in [`references/prerequisites.md`](references/prerequisites.md#preflight).
For DGX Spark / IGX Thor / AGX Thor, also run the cache-cleaner check in
[`references/edge.md`](references/edge.md#cache-cleaner-every-edge-deploy).

**Detect sudo mode first.** Several pre-flight remediations and the
edge cache-cleaner installer call `sudo`. If the host requires a
sudo password, those steps will silently no-op under `sudo -n` and
leave the deploy in a half-prepared state.

```bash
if sudo -n true 2>/dev/null; then
  echo "passwordless sudo — pre-flight will auto-install missing pieces"
else
  echo "sudo requires password — pre-flight will NOT auto-install; hand commands to the user"
fi
```

When sudo needs a password, the skill **must not** run privileged
installers itself. Surface the copy-pasteable command block from
`references/prerequisites.md` to the user with a *"run this once and
confirm"* handoff, then resume after the user replies.

Minimum smoke test (must succeed):

```bash
nvidia-smi --query-gpu=index,name --format=csv,noheader
docker info 2>/dev/null | grep -qi runtimes \
  && docker run --rm --gpus all ubuntu:22.04 nvidia-smi >/dev/null 2>&1 \
  && echo "nvidia runtime OK"
```

If the smoke test fails, do not proceed; open
[`references/prerequisites.md`](references/prerequisites.md#preflight)
for the remediation tree.

## Model Selection

- `$LLM_REMOTE_URL` / `$VLM_REMOTE_URL` if the user asks for remote
- `$NGC_CLI_API_KEY` (local NIMs) or `$NVIDIA_API_KEY` (remote)

**Endpoint intent gate.** Don't infer remote placement from stray env vars
(`LLM_ENDPOINT_URL`, `VLM_ENDPOINT_URL`, `LLM_BASE_URL`, `VLM_BASE_URL` may be
leftovers). Use remote LLM/VLM only when (1) the user asked for / supplied a
remote endpoint, (2) local sizing can't fit the selected models and the user
agrees, or (3) an edge recipe needs a standalone local service VSS treats as
`remote` (e.g. DGX Spark Nano 9B on `localhost:30081`). If an endpoint var is
set but the user didn't ask for remote, surface it in Step 1 and ask — never
silently deploy remote because a var happened to exist.

If no combination on this host satisfies the profile's sizing requirements, **stop and report the blocker** — don't silently pick another shape.

> **Edge shared mode is platform-specific.** Full recipes are in [`references/edge.md`](references/edge.md).

## Deployment Flow

Always follow this sequence. Never skip the dry-run.

### Step 0 — Tear down any existing deployment + clear data volumes

If a deployment already exists, tear it down AND clear stale data volumes before redeploying. 

Full procedure lives in [`references/teardown.md`](references/teardown.md).

### Step 0a — Credentials gate (run before any env mutation)

Validate every credential and selected remote endpoint the chosen profile
needs **before** Step 1c copies `.env` to `generated.env`. A 401 here is a
30-second failure; the same 401 inside a NIM cold-start is a 10–20 min
failure. Run the discovery and probe flow in
[`references/credentials.md`](references/credentials.md), including
`scripts/probe_remote_models.sh` for any LLM/VLM endpoint you plan to write
into `generated.env`. Map the result against the chosen mode: missing
or invalid required credentials/endpoints are blockers, optional credentials
are not.

### Step 1 — Gather context

Before building env overrides, confirm:

| Value | How to determine |
|---|---|
| **Profile** | Match user intent to the routing table above. Default: `base` |
| **Repo path** | Use the `$REPO` value auto-detected in prerequisites. If auto-detect failed, ask the user for the checkout path before continuing. |
| **Hardware** | `nvidia-smi --query-gpu=name,memory.total --format=csv,noheader` |
| **LLM/VLM placement** | Explicitly decide local / local_shared / remote. Cross-reference available GPUs against the chosen profile's **Minimum GPU count** table. If endpoint env vars are present but the user did not request remote, ask whether to use or ignore them. |
| **API keys** | `NGC_CLI_API_KEY` for local NIMs, `NVIDIA_API_KEY` for remote |
| **`HOST_IP`** | In-cluster dial address: `ip route get 1.1.1.1` src (like `dev-profile.sh`; correct on LAN + cloud). If that interface is a VPN/tunnel, fall back to the LAN IP and **prompt the user** — [Network addressing](references/prerequisites.md#addressing). |
| **`EXTERNAL_IP`** | Browser-facing address; defaults to `${HOST_IP}`. Override when the browser path differs — cloud public IP, Brev secure-link (Step 1d), or tunnel; **ask the user where they browse from if unsure**. [Network addressing](references/prerequisites.md#addressing). |
| **`HAPROXY_PORT`** | Browser-facing ingress port. Default `7777`; ensure it is free. |

Before `docker compose up`, verify `EXTERNAL_IP`, `HAPROXY_PORT`, `VSS_PUBLIC_HOST`, and `VSS_PUBLIC_PORT` are populated with browser-reachable values. Otherwise the stack may appear healthy while UI/API/VST links 404 or loop through Cloudflare Access.

### Step 1b — Prepare the data directory

Layout (asset paths, ownership, mount points, profile-specific subdirs) is documented in [`references/data-directory.md`](references/data-directory.md). Read that file before deploying for the first time on a host or when changing profiles.


### Step 1c — Initialize `generated.env`

The skill's per-deploy working copy. Always start from a fresh copy of the source `.env` , never mutate the source.

```bash
PROFILE=base
ENV_SRC=$REPO/deploy/docker/developer-profiles/dev-profile-$PROFILE/.env
ENV_GEN=$REPO/deploy/docker/developer-profiles/dev-profile-$PROFILE/generated.env

cp "$ENV_SRC" "$ENV_GEN"
```

All subsequent writes (Brev `EXTERNAL_IP`, the env_overrides dict from Step 2) go to `$ENV_GEN`. `$ENV_SRC` is read-only from here on.

### Step 1d — Brev only: detect first, then set `EXTERNAL_IP` to the secure-link domain

**Detect Brev before anything else** — a Brev-provisioned instance sets `BREV_ENV_ID` in `/etc/environment`; nothing else does:

```bash
grep -qE '^BREV_ENV_ID=' /etc/environment && echo "on Brev" || echo "not Brev"
```

- **not Brev** → skip the rest of this step and **do not read [`references/brev.md`](references/brev.md)**; keep the normal `${HOST_IP}`-based `EXTERNAL_IP`.
- **on Brev** → apply the Brev secure-link overrides from [`references/brev.md` § Setup flow](references/brev.md#setup-flow) to `generated.env` (NOT `.env`). Those set `EXTERNAL_IP` / `VSS_PUBLIC_HOST` to the secure-link domain **and** `VSS_PUBLIC_HTTP_PROTOCOL=https` / `VSS_PUBLIC_WS_PROTOCOL=wss` / `VSS_PUBLIC_PORT=443` — setting `EXTERNAL_IP` alone leaves `http://…:7777` UI/API/WS links that the browser blocks as mixed content.

### Step 2 — Build env_overrides

Produce an `env_overrides` dict from the user request and the gathered
context: explicitly choose remote/local LLM/VLM, set credentials, point at
endpoints, set platform-specific flags. Do not let existing shell env vars
silently pick placement; write the selected `LLM_MODE` / `VLM_MODE` and
matching endpoint/model fields into `generated.env`. The full mapping (every
override key, when it applies, defaults, profile-specific differences) lives
in [`references/env-overrides.md`](references/env-overrides.md). Each profile
reference has worked examples for that profile's common scenarios.


### Step 3 — Apply overrides + dry-run

**Working env file:** `<repo>/deploy/docker/developer-profiles/dev-profile-<profile>/generated.env` (created in Step 1c).

> **Reminder (see Step 1c):** apply all overrides (Step 2 dict + Brev `EXTERNAL_IP`) to `generated.env`; `--env-file` always points at it, and post-deploy verifiers read it for the actually-deployed values.

```bash
# (Step 1c already ran: cp $ENV_SRC $ENV_GEN)

# Apply the env_overrides dict from Step 2 to generated.env
# (read lines, update matching keys, append new keys, write)
# Example:
#   sed -i "s|^LLM_MODE=.*|LLM_MODE=remote|" "$ENV_GEN"
#   sed -i "s|^LLM_BASE_URL=.*|LLM_BASE_URL=http://localhost:30081|" "$ENV_GEN"

# Resolve compose
cd $REPO/deploy/docker
docker compose --env-file $ENV_GEN config > resolved.yml
```

The resolved YAML is saved to `<repo>/deploy/docker/resolved.yml`.

### Step 3b — Verify resolved.yml has no unexpanded ${...} tokens

Unexpanded `${VAR}` tokens in `resolved.yml` mean compose did not see those env values. Diagnostic procedure and common culprits live in [`references/troubleshooting.md`](references/troubleshooting.md).


### Step 3c — Verify access to selected NGC artifacts

Do this after `resolved.yml` exists and before `docker compose up`. The NGC
token probe in Step 0a proves only that the key authenticates; it does not
prove the key's org/team can access the selected image or model repositories.

Build the artifact list from the actual selected deployment:

- `resolved.yml`: every `image:` under `nvcr.io/...` that Compose will pull.
- `$ENV_GEN`: NGC-backed model/resource paths such as
  `RTVI_VLM_MODEL_PATH=ngc:nim/nvidia/cosmos-reason2-8b:hf-1208`. Skip
  `none`, `git:...`, local paths, and remote endpoint URLs.
- Profile staging steps: any NGC model/resource downloads documented in the
  profile reference, such as alerts/search perception model staging.

Probe each selected artifact with the normalized NGC key before continuing:

- Container images: `docker manifest inspect <nvcr.io/...>` after `docker
  login nvcr.io` — for gated `nvcr.io` repos a `401`/`403` here is a definitive
  no-entitlement signal (manifest read requires the same org/team grant as the
  layer pull); or the matching `ngc registry image info ...` when the artifact
  maps cleanly to an NGC image path.
- NGC model/resource paths (e.g. the Cosmos checkpoint RT-VLM downloads at
  runtime): run the matching `ngc registry model info ...` or `ngc registry
  resource info ...` for the exact repo/tag the profile will load or download;
  these use NGC's scoped auth. Do NOT probe a model with `docker manifest
  inspect` (returns "no such manifest" because a model is not an OCI image) or a
  raw `Authorization: Bearer <key>` REST call (returns `403` because that is not
  NGC's auth flow); both are expected false negatives, not entitlement failures.
  If the `ngc` CLI is unavailable, treat the container-image probe above as the
  entitlement signal, since NGC grants org/team access across images and models
  together.
- Profile-staged TAO/perception models: run the corresponding `ngc registry
  model info ...` / `resource info ...` for each repo/tag before the staging
  block downloads files.

If any probe returns `401`, `403`, `permission`, `not being a member of the
organization that owns the repo`, missing org/repo, or a similar access error,
stop and prompt the user for an NGC key from an org/team entitled to those
artifacts. Do not start Compose and discover the failure during NIM cold start.

### Step 3d — Strip dangling optional `depends_on` from resolved.yml


**MUST run after Step 3, before Step 5.** Skipping this aborts the deploy:

Normalize - drop optional dependencies for services filtered out from resolved.yml

```bash
# From the repo root
uv run skills/vss-deploy-profile/scripts/normalize_resolved_yml.py "$REPO/deploy/docker/resolved.yml"
```
If `uv` isn't on the host, install it once with `curl -LsSf https://astral.sh/uv/install.sh | sh` (no root needed).
**Re-validate** before `up -d`:

```bash
docker compose -f "$REPO/deploy/docker/resolved.yml" config --quiet && echo "resolved.yml OK"
```

If validation still fails after the normalizer runs, capture the error and inspect — that's a different bug (a dependency that's not optional, or another schema violation), not the dangling-depends_on case.

### Step 4 — Review

Show the user a summary of what will be deployed:

- Profile name and hardware
- LLM/VLM models and mode (local/remote/local_shared)
- Services that will start
- GPU device assignment
- Key endpoints (UI port, agent port)

Ask: **"Looks good — deploy now?"** and wait for confirmation before Step 5.

**Exception — autonomous mode.** If the user's request already asks you to run autonomously (e.g. "deploy X autonomously", "run without confirmation", "non-interactive"), skip the confirmation prompt and proceed straight to Step 5. This path exists so automated eval / CI invocations don't hang waiting for a human reply they'll never get. In all other cases, a human must approve.

### Step 5 — Deploy

```bash
cd $REPO/deploy/docker
docker compose --env-file $ENV_GEN -f resolved.yml up -d
```

> **`--env-file` is mandatory.** Without the same `generated.env` used in Step 3, `COMPOSE_PROFILES` may be unset and `up -d` can exit 0 with zero selected services.

> **Avoid broad `--force-recreate` on ordinary retries** — it destroys warm
> NIM containers (another 3–5 min torch.compile + CUDA-graph capture each).
> Fix the root cause (usually perms or an env typo) and just re-run `up -d`;
> use targeted `--force-recreate --no-deps <service...>` only when a profile
> reference documents it as the recovery path.

`docker compose up -d` only creates containers; it does not wait for internal services to finish warming. Never declare deploy success until the readiness gates pass.

### Step 5b — Wait until the stack is actually healthy

**Gate 0 — container count must be > 0.** Refuse to proceed past `up -d` until the started count (`docker compose -f resolved.yml ps -q | wc -l`) is non-zero and ≥ the expected count (`config --services | wc -l`); a zero/short count almost always means a missing `--env-file` in Step 5. The exact gate plus the full readiness procedure live in [`references/readiness.md`](references/readiness.md).

Cold deploys can take 10–20 min, and each profile reference lists the required endpoints. **Never declare deploy done after `up -d`; only after every documented endpoint succeeds.**

## Tear Down

To tear down a deployment — full host reclaim or cache-preserving redeploy / profile
switch — follow [`references/teardown.md`](references/teardown.md). Always tear down
by the `mdx` project with `-v --remove-orphans`; a plain `docker compose down` leaves
volumes and networks behind.

## Debugging a Deployment

Use this workflow when the user asks to "debug the deploy", "verify it's working", "why is the agent not responding", or similar. The goal is to confirm the full video-ingestion-to-agent-answer path, not just that containers are "Up".

Each profile reference has a **Debugging** section listing the exact commands and failure-mode table for that profile.

### Quick checks (all profiles)

```bash
# 1. All expected containers Up
docker ps --format 'table {{.Names}}\t{{.Status}}'

# 2. Agent API + UI responding
curl -sf http://localhost:8000/health >/dev/null && echo "agent OK"
curl -sf http://localhost:3000/ >/dev/null && echo "ui OK"
```

The LLM/VLM NIM probes — including the `*_MODE=remote` handling that skips
`localhost:3008x` (where a connection refused is expected) and probes the
selected `*_BASE_URL/v1/models` via `scripts/probe_remote_models.sh` — are in
[`references/troubleshooting.md`](references/troubleshooting.md#nim-probes).

## Limitations

- This skill deploys compose-based VSS profiles only; standalone microservice deployment belongs to the matching `vss-deploy-*` skill.
- Hardware sizing, model placement, and profile-specific readiness are owned by profile references; do not infer them from memory.
- Privileged host remediation requires user approval when passwordless sudo is unavailable.

## Troubleshooting

The common-error quick reference, the full symptom → cause → fix table, the
unexpanded-`${...}` diagnostic, and the NIM endpoint probes are consolidated in
[`references/troubleshooting.md`](references/troubleshooting.md) — start there
for any deploy, runtime, or probe failure, then continue in the matching
per-profile reference's Debugging section.
