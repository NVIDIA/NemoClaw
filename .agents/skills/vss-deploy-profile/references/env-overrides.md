# Deploy — env_overrides reference

### Step 2 — Build env_overrides

Build a dictionary of env var overrides based on user intent. Only include vars that differ from the profile's `.env` defaults.

**Always set (non-secret deployment values with placeholder defaults in the template):**

| Var | Value |
|---|---|
| `HARDWARE_PROFILE` | Detected or user-specified |
| `VSS_APPS_DIR` | `<repo>/deploy/docker` |
| `VSS_DATA_DIR` | `${VSS_APPS_DIR}/data-dir` (or user-specified) |
| `HOST_IP` | Detected host IP |

Credential env vars are mode-scoped. Set `NGC_CLI_API_KEY` only when
local/local_shared NIM pulls are selected, `NVIDIA_API_KEY` only when the
selected remote endpoint requires it, and `HF_TOKEN` only for edge recipes that
use gated HF models. Validate them through
[`credentials.md`](credentials.md) before writing them to `generated.env`.

**Placement selection rules.**

- Treat host env vars such as `LLM_ENDPOINT_URL`, `VLM_ENDPOINT_URL`,
  `LLM_BASE_URL`, and `VLM_BASE_URL` as candidate values, not user intent.
  They may be leftovers from a previous deploy.
- Default to local/local_shared placement only when the selected models fit
  the host and the user did not request remote placement.
- Use remote placement only when the user asked for it, supplied an endpoint,
  approved remote placement after a sizing blocker, or the profile reference
  documents a standalone local service that VSS consumes as remote.
- If the user only says "use build.nvidia.com", "use NVIDIA API catalog", or
  provides `https://integrate.api.nvidia.com` without saying which side is
  remote, stop and ask whether to use remote LLM, remote VLM, or both.
- For build.nvidia.com / NVIDIA API catalog remote endpoints, require the
  exact model id for each selected side. The catalog `/v1/models` endpoint can
  return many LLM/VLM models, so never use the first returned model as a
  default.
- Before writing any selected remote endpoint to `generated.env`, run
  `scripts/probe_remote_models.sh` as described in
  [`credentials.md`](credentials.md#remote-endpoint-probes).
- In `dev-profile.sh`, the host input variable is `LLM_ENDPOINT_URL` /
  `VLM_ENDPOINT_URL`; in `generated.env`, the deployed agent keys are
  `LLM_BASE_URL` / `VLM_BASE_URL`.

**Common overrides by user intent:**

| User intent | Env overrides |
|---|---|
| Remote LLM | `LLM_MODE=remote`, `LLM_NAME_SLUG=none`, `LLM_BASE_URL=<host>` (no `/v1`), `LLM_NAME=<model>`, `NVIDIA_API_KEY=<key>` |
| Remote VLM | `VLM_MODE=remote`, `VLM_NAME_SLUG=none`, `VLM_BASE_URL=<host>` (no `/v1`), `VLM_NAME=<model>`, `NVIDIA_API_KEY=<key>` |
| **Remote LLM AND remote VLM** (aka `remote-all`) | **BOTH of the above** — you must set `LLM_MODE=remote`, `VLM_MODE=remote`, `LLM_NAME_SLUG=none`, `VLM_NAME_SLUG=none`, `LLM_BASE_URL`, `VLM_BASE_URL`, `LLM_NAME`, `VLM_NAME`. The presence of a remote VLM endpoint does not imply `VLM_MODE=remote` — you have to write it explicitly. |
| NVIDIA API for remote inference | `LLM_BASE_URL=https://integrate.api.nvidia.com` |
| Dedicated GPUs | `LLM_MODE=local`, `VLM_MODE=local`, `LLM_DEVICE_ID=0`, `VLM_DEVICE_ID=1` |
| Different LLM model | `LLM_NAME=<name>`, `LLM_NAME_SLUG=<slug>` |
| Different VLM model | `VLM_NAME=<name>`, `VLM_NAME_SLUG=<slug>` |

**Extracting remote endpoints from user intent.**

If the user says "remote LLM" or mentions an LLM endpoint URL, you MUST do
all of the following before `docker compose up`:

1. Identify the endpoint URL and model name. If the user gave them in
   their prompt (e.g. *"deploy with remote LLM at
   `http://launchpad:11571` serving `nvidia/nvidia-nemotron-nano-9b-v2`"*),
   use those values directly. Strip any trailing `/v1` (see callout below).
2. If the user said "remote" without providing a URL or model, **stop and
   ask the user** for:
   - The LLM endpoint URL (without `/v1`)
   - The LLM model name served there
   - (same pair for VLM if they also said "remote VLM")
   - An `NVIDIA_API_KEY` if the endpoint requires one
   If the endpoint is `https://integrate.api.nvidia.com`, this is mandatory
   even though `/v1/models` is reachable: that endpoint is an aggregate catalog
   and may list many models.
3. Probe `<endpoint>/v1/models` with
   `scripts/probe_remote_models.sh` as described in
   [`credentials.md`](credentials.md#remote-endpoint-probes). The selected
   model must appear in the response before you mutate `generated.env`.
4. Write `LLM_MODE=remote` + `LLM_NAME_SLUG=none` + `LLM_BASE_URL=<url>` +
   `LLM_NAME=<model>` into
   `deploy/docker/developer-profiles/dev-profile-<profile>/generated.env`
   (the skill's per-deploy working copy — see ``SKILL.md`` (see `../SKILL.md`)
   Step 1c). Do the same set for VLM if the user said remote VLM. Use
   `sed -i "s|^KEY=.*|KEY=VALUE|"` — the source `.env` template ships
   with placeholder rows for these keys, which `cp` to `generated.env`
   so the same `sed` patterns work.
5. After writing, `grep -E '^(HARDWARE_PROFILE|LLM_MODE|VLM_MODE|LLM_NAME_SLUG|VLM_NAME_SLUG|LLM_BASE_URL|VLM_BASE_URL)=' <env-file>`
   and verify every line shows the value you intended. A silent miss on
   `LLM_MODE` / `VLM_MODE` is the #1 cause of deployments coming up with
   wrong compose profiles.

Never leave `LLM_MODE` or `VLM_MODE` at the template default when the user
said "remote". The base `.env` defaults are `LLM_MODE=local_shared` and
`VLM_MODE=local_shared` (same as `dev-profile.sh` derives for same-device
local deployments). Failing to overwrite them keeps local shared NIM
`COMPOSE_PROFILES` active while remote URLs dangle unused.

> **Important — `/v1` suffix on base URLs**
>
> `LLM_BASE_URL` and `VLM_BASE_URL` must **not** include a trailing `/v1`.
> The agent's `config.yml` appends `/v1` automatically (`base_url: ${LLM_BASE_URL}/v1`),
> so including it yourself produces `/v1/v1/chat/completions` and requests will fail
> with connection / 404 errors.
>
> If a user or endpoint documentation gives you a URL ending in `/v1`, strip it
> before writing to `.env`. Examples:
> - User says: "LLM is at `http://10.0.0.5:31081/v1`" → write `LLM_BASE_URL=http://10.0.0.5:31081`
> - User says: "Use `https://integrate.api.nvidia.com/v1`" → write `LLM_BASE_URL=https://integrate.api.nvidia.com`

See the profile reference doc for full env override recipes.

**Do NOT set `COMPOSE_PROFILES` directly** — it is computed from `BP_PROFILE`, `MODE`, `HARDWARE_PROFILE`, `LLM_MODE`, `LLM_NAME_SLUG`, `VLM_MODE`, `VLM_NAME_SLUG`.
