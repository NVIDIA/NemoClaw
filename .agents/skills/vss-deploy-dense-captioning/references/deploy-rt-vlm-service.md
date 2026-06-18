# Deploy RT-VLM Service

## 1. Overview

**Service**: `rtvi-vlm` (container name `vss-rtvi-vlm`)
**Image (default multiarch: x86 / Jetson-Tegra / non-Spark non-SBSA)**: `nvcr.io/nvidia/vss-core/vss-rt-vlm:3.2.0`
**Image (Spark / GB10 / SBSA / Grace)**: `nvcr.io/nvidia/vss-core/vss-rt-vlm:3.2.0-sbsa`
**Primary port**: `${RTVI_VLM_PORT}` → container `8000` (FastAPI REST, `/v1`)
**Validated GPUs**: H100 · RTX PRO 6000 Blackwell · L40S · DGX SPARK · IGX Thor · AGX Thor

Derive `<compose-default>` from the checked-out
`deploy/docker/services/rtvi/rtvi-vlm/rtvi-vlm-docker-compose.yml` instead of
hardcoding it in commands. The current `develop` compose default is
`3.2.0`; Spark, GB10, and SBSA-class platforms append `-sbsa`. All other
platforms use the normal multiarch tag.

Real-Time VLM is VSS's streaming vision-language inference service: RTSP decode →
segmentation → VLM inference (vLLM) → Kafka publication (NvSchema protobuf).
In this compose, rtvi-vlm is wired by default to call a **sibling NIM**
(`cosmos-reason1-7b`, `cosmos-reason2-8b`, or `qwen3-vl-8b-instruct`) over
OpenAI-compat HTTP (`RTVI_VLM_MODEL_TO_USE=openai-compat`). **Kafka lives on the
host**, not in-compose (`KAFKA_BOOTSTRAP_SERVERS=${HOST_IP}:9092`).

## 2. Related Skill

The top-level `skills/vss-deploy-dense-captioning/SKILL.md` file covers the VSS 3.2 API
(`/v1/generate_captions`, `/v1/files`, `/v1/streams/add`,
`/v1/chat/completions`, Kafka topics, and the four standard workflows). This
reference answers "how do I deploy / debug rtvi-vlm?"; the top-level skill
answers "how do I call rtvi-vlm?". Hit `http://localhost:${RTVI_VLM_PORT}/docs`
(FastAPI auto-docs) or `GET /openapi.json` on the running service for the
live-authoritative schema — see §16.

## 3. Prerequisites

- **Docker Engine 28.2+** + Compose plugin **2.36+** (this compose uses
  `${VAR:+:path}` conditional-bind syntax that older Compose rejects)
- **NVIDIA Driver 580+** + NVIDIA Container Toolkit
  (`docker run --rm --gpus all nvidia/cuda:12.4.0-base-ubuntu22.04 nvidia-smi` must succeed)
- **Git LFS** (HF-backed models)
- **≥ 50 GB disk** for image + 20–80 GB for model weights on first run
- **Kafka on host** reachable at `${HOST_IP}:9092` (compose does NOT bundle Kafka)
- **Sibling NIM compose** providing the VLM backend: rtvi-vlm `depends_on`
  `cosmos-reason1-7b` / `cosmos-reason2-8b` / `qwen3-vl-8b-instruct`, all
  `required: false`. Launch one of those first.
- **`VSS_DATA_DIR`** host path — compose bind-mounts
  `${VSS_DATA_DIR}/data_log/vst/clip_storage` with no default → mount breaks if unset
- **Free port**: `${RTVI_VLM_PORT}` (whatever you pick)
- **Outbound**: `nvcr.io`, `huggingface.co`, any remote NIM/OpenAI endpoints

> ⚠ **Profiles are mandatory.** Service declares **6 blueprint profiles**
> (§12). Plain `docker compose up` starts **nothing** — pass `--profile <name>`.

For standalone Kafka setup, use
[`kafka-workflows.md`](kafka-workflows.md#standalone-kafka-listener-setup). This
reference is self-contained; do not depend on access-gated internal documents
for required deploy behavior because they may redirect to sign-in during
validation.

Run these preflights before any pull or `up`; fix failures here before debugging
RT-VLM itself:

```bash
nvidia-smi
nvidia-container-cli info
docker compose version
docker run --rm --gpus all nvidia/cuda:12.4.0-base-ubuntu22.04 nvidia-smi
```

## 4. NGC / Registry Preflight

```bash
# Obtain an NGC key: https://ngc.nvidia.com/setup/api-key
export NGC_CLI_API_KEY="<YOUR_NGC_KEY>"
echo "$NGC_CLI_API_KEY" | docker login nvcr.io -u '$oauthtoken' --password-stdin

# Run the Step 0a tag-selection snippet in the standalone copy flow below, then
# verify pull access for the exact image this compose will use.
: "${RTVI_VLM_IMAGE_TAG:?Run Step 0a below to set RTVI_VLM_IMAGE_TAG first}"
docker pull "nvcr.io/nvidia/vss-core/vss-rt-vlm:${RTVI_VLM_IMAGE_TAG}"
```

> ⚠ **`docker compose pull` fails on standalone deployments** (recent Docker
> Compose): the compose file's `depends_on` references sibling NIM services
> that are not defined in this single-file project. Compose rejects this as
> `invalid compose project` at project-load time even when every reference is
> `required: false`. On Compose 2.38, `pull --no-deps` is not a valid command,
> and plain `pull rtvi-vlm` still validates the whole project first. Use
> `docker pull` directly (above) to warm the image cache instead.

If `docker pull` fails with a containerd snapshotter/unpack error on Docker 28+,
merge this feature setting into `/etc/docker/daemon.json`, then restart Docker
(this stops running containers):

```json
{
  "features": {
    "containerd-snapshotter": false
  }
}
```

```bash
sudo -n systemctl restart docker || {
  echo "Passwordless sudo is unavailable; ask the host owner to run: sudo systemctl restart docker" >&2
  exit 1
}
```

## 5. Security / Credential Handling

All values are `${VAR:-}` placeholders; keep secrets in a gitignored `.env`.
Host-side vars in this compose use the `RTVI_VLM_*` / `RTVI_VLLM_*` prefix and
rewrite to canonical container-side names at the compose boundary. See §7 for
the authoritative variable table and required/conditional fields.

For agent-driven validation, provision `NGC_CLI_API_KEY` through the agent
process environment, a secret manager, or the local `.env` file with mode
`0600`. Do not paste the key into chat or command history. Before pulling,
verify the agent can see the key with `test -n "$NGC_CLI_API_KEY"` and perform
`docker login nvcr.io`; if the key only exists in `.env`, load that file into
the shell before the login step.

Use the `.env` block in §12 as the starting point.

## 6. Required Volume Mounts

| Compose line | Spec | Stateful? | `down -v` destroys? |
|---|---|---|---|
| 108 | `${ASSET_STORAGE_DIR:-/dummy}${ASSET_STORAGE_DIR:+:/tmp/assets}` (optional bind over tmpfs) | yes (if set) | yes (host bind) |
| 109 | `${RTVI_VLM_HF_CACHE:-rtvi-hf-cache}:/tmp/huggingface` (named by default, multi-GB) | **yes** | **YES — multi-GB re-download** |
| 110 | `${VSS_DATA_DIR}/data_log/vst/clip_storage:<container VST streamer video dir>` — **no default → required** | yes | yes (host bind) |
| 111 | `${NGC_MODEL_CACHE:-rtvi-ngc-model-cache}:/opt/nvidia/rtvi/.rtvi/ngc_model_cache` (named) | **yes** | **YES — re-download weights** |
| 112 | `${RTVI_VLM_LOG_DIR:-/dummy}${RTVI_VLM_LOG_DIR:+:/opt/nvidia/rtvi/log/rtvi/}` (optional bind) | no | no |

**Required host-path setup** — `VSS_DATA_DIR` is not optional. See the
host-path setup step in the Quick-Start section below for the exact commands to
prepare the VST clip-storage host directory.

Optional host-path overrides:

```bash
mkdir -p ./rtvi-assets
sudo -n chown 1001:1001 ./rtvi-assets || {
  echo "Ask the host owner to run: sudo chown 1001:1001 $(pwd)/rtvi-assets" >&2
  exit 1
}
# .env: ASSET_STORAGE_DIR=$(pwd)/rtvi-assets

mkdir -p ./rtvi-logs
sudo -n chown 1001:1001 ./rtvi-logs || {
  echo "Ask the host owner to run: sudo chown 1001:1001 $(pwd)/rtvi-logs" >&2
  exit 1
}
# .env: RTVI_VLM_LOG_DIR=$(pwd)/rtvi-logs
```

> ⚠ `docker compose down -v` wipes `rtvi-hf-cache` + `rtvi-ngc-model-cache` →
> **20–80 GB re-download** on next up.

## 7. Required Environment Variables

| Host var | Required | Compose default | Notes |
|---|---|---|---|
| `RTVI_VLM_PORT` | **YES** (`${RTVI_VLM_PORT?}` strict) | — | Host REST API port |
| `HOST_IP` | **YES (effectively)** | — | Interpolated into `KAFKA_BOOTSTRAP_SERVERS=${HOST_IP}:9092`; no fallback |
| `VSS_DATA_DIR` | **YES (effectively)** | — | Interpolated into VST clip-storage bind mount; no fallback |
| `NGC_CLI_API_KEY` | **YES for documented pull / local NGC model path** | — | `docker login nvcr.io`, image pull, and NGC model/artifact download |
| `RTVI_VLM_API_KEY` | optional / backend-dependent | `${NGC_CLI_API_KEY}` fallback in compose | RT-VLM bearer auth or non-NGC backend auth; does not replace `NGC_CLI_API_KEY` for registry pulls |
| `RTVI_VLM_MODEL_TO_USE` | effectively required | `openai-compat` | `cosmos-reason1` / `cosmos-reason2` / `openai-compat` / `custom` |
| `RTVI_VLM_ENDPOINT` | if `openai-compat` | — | Remote/sibling OpenAI-compatible VLM endpoint |
| `VLM_NAME` | if `openai-compat` | — | Model name exposed by the remote/sibling VLM endpoint |
| `RTVI_VLM_MODEL_PATH` | conditional | `ngc:nim/nvidia/cosmos-reason2-8b:hf-1208` | Needed when not `openai-compat`. Keep the source-backed `:hf-1208` default unless the deployment source explicitly overrides it. |
| `HF_TOKEN` | only for gated HF models | — | Hugging Face token for gated Qwen3-VL or other HF downloads |
| `NVIDIA_API_KEY` | backend-dependent | `NOAPIKEYSET` | Generic NVIDIA API token for non-NGC backends |
| `OPENAI_API_KEY` | backend-dependent | `NOAPIKEYSET` | OpenAI-compatible backend token |
| `OPENAI_API_VERSION` | Azure only | — | Azure OpenAI version pin |
| `REDIS_PASSWORD` | only with Redis error messages | — | Required when `ENABLE_REDIS_ERROR_MESSAGES=true` |

The most important host-side variables use the `RTVI_VLM_*` or `RTVI_VLLM_*`
prefix and are rewritten to canonical container-side names by compose.

Minimum standalone openai-compatible deployment using the documented image pull:
`NGC_CLI_API_KEY`, `RTVI_VLM_PORT`, `HOST_IP`, `VSS_DATA_DIR`,
`RTVI_VLM_ENDPOINT`, and `VLM_NAME`. Add `RTVI_VLM_API_KEY` when the remote
backend or RT-VLM bearer policy requires a token different from the NGC key.

Minimum standalone self-hosted Cosmos deployment:
`NGC_CLI_API_KEY`, `RTVI_VLM_PORT`, `HOST_IP`, `VSS_DATA_DIR`,
`RTVI_VLM_MODEL_TO_USE`, and `RTVI_VLM_MODEL_PATH`.

## 8. Optional / Feature-Flag Environment Variables

- **vLLM tuning** (compose defaults): `VLLM_MAX_NUM_SEQS=256`,
  `VLLM_MAX_NUM_BATCHED_TOKENS=5120`, `VLM_MAX_MODEL_LEN=32768`,
  `VLLM_NUM_SCHEDULER_STEPS=8`, `VLLM_ENABLE_PREFIX_CACHING=false`,
  `VLLM_GPU_MEMORY_UTILIZATION=""` (auto-tuned)
- **Feature toggles**: `ENABLE_OTEL_MONITORING=false`,
  `INSTALL_PROPRIETARY_CODECS=false`, `FORCE_SW_AV1_DECODER=""`,
  `VSS_SKIP_INPUT_MEDIA_VERIFICATION=""`, `ENABLE_REDIS_ERROR_MESSAGES=false`,
  `RTVI_ADD_TIMESTAMP_TO_VLM_PROMPT=""`
- **Auto-tuned by entrypoint** (override only when needed):
  `VLM_BATCH_SIZE`, `NUM_GPUS`, `VLLM_GPU_MEMORY_UTILIZATION`
  (auto-set to `0.7` when VRAM ≤ 50 GB)

## 9. GPU Selection & Hardware

```yaml
# compose line 40
device_ids: ["${RT_VLM_DEVICE_ID:-0}"]
```

> **Note:** `RT_VLM_DEVICE_ID` breaks the `RTVI_VLM_*` pattern because this name
> is fixed by the upstream `met-blueprints` compose — don't rename locally.

Plus `NVIDIA_VISIBLE_DEVICES=${RTVI_VLM_NVIDIA_VISIBLE_DEVICES:-all}`.

```bash
RT_VLM_DEVICE_ID=0                   # by index
RT_VLM_DEVICE_ID=GPU-abc123...       # by UUID (from `nvidia-smi -L`)
```

**Jetson Thor / DGX Spark caveat**: docs note instability at 8+ vision tokens
concurrent — cap at ≤2 streams or drop input resolution.

## 10. Port Conflict Map

| Container port | Host port | Collision risk |
|---|---|---|
| `8000` | `${RTVI_VLM_PORT}` | Many NVIDIA NIMs also bind 8000 — pick an unused port in `.env` |

Kafka and Redis are **not bundled** — expected on host or in a sibling compose.

## 11. Models Used & Swap Guide

Set `RTVI_VLM_MODEL_TO_USE` in `.env` to select the backend. After any change:

```bash
docker compose --env-file .env -f rtvi-vlm-docker-compose.yml \
  --profile bp_developer_alerts_2d_vlm up -d --force-recreate rtvi-vlm
```

If Docker requires elevated privileges, use `sudo -n docker compose ...` and
fail fast if `sudo -n` reports that a password is required.

Verify what loaded:
```bash
curl -s -H "Authorization: Bearer ${NGC_CLI_API_KEY:-${RTVI_VLM_API_KEY:-}}" \
  "http://localhost:${RTVI_VLM_PORT}/v1/models" | jq
```

---

### Option A — Remote NIM endpoint (openai-compat)

Point rtvi-vlm at an already-running NIM (sibling container, remote host, or
NVIDIA API Catalog):

```bash
# .env:
RTVI_VLM_MODEL_TO_USE=openai-compat
RTVI_VLM_ENDPOINT=http://nim-host.example.com:8000/v1
VLM_NAME=cosmos-reason2-8b   # model name the NIM exposes
RTVI_VLM_API_KEY=${RTVI_VLM_API_KEY}
```

---

### Option B — OpenAI / Azure OpenAI

```bash
# .env:
RTVI_VLM_MODEL_TO_USE=openai-compat
RTVI_VLM_ENDPOINT=https://api.openai.com/v1           # or Azure endpoint
VLM_NAME=gpt-4o          # or Azure deployment name
RTVI_VLM_API_KEY=sk-...                               # OpenAI key
OPENAI_API_KEY=sk-...                                 # some code paths read this directly
# Azure only:
# OPENAI_API_VERSION=2024-02-01
```

---

### Option C — Self-hosted NGC NIM (cosmos-reason1 or cosmos-reason2)

Model is downloaded and served by vLLM inside the container. Requires ~16–20 GB
VRAM for the 8B models.

```bash
# .env for cosmos-reason2 (source-backed default used by VSS alerts/LVS):
RTVI_VLM_MODEL_TO_USE=cosmos-reason2
RTVI_VLM_MODEL_PATH=ngc:nim/nvidia/cosmos-reason2-8b:hf-1208
NGC_CLI_API_KEY=${NGC_CLI_API_KEY}

# .env for cosmos-reason1:
# Confirm the release-supported reason1 tag from VSS release notes or
# deploy/docker/services/nim/cosmos-reason1-7b/compose.yml before use; do not
# reuse the cosmos-reason2 hf-1208 tag.
RTVI_VLM_MODEL_TO_USE=cosmos-reason1
RTVI_VLM_MODEL_PATH=ngc:nim/nvidia/cosmos-reason1-7b:release-supported-tag
NGC_CLI_API_KEY=${NGC_CLI_API_KEY}
```

---

### Option D — HuggingFace model (vLLM-compatible)

`VLM_MODEL_TO_USE=vllm-compatible` is the correct value for any HF-hosted or
locally-served vLLM-compatible model. Reference:
https://docs.nvidia.com/vss/latest/real-time-vlm.html#hugging-face-models-locally

```bash
# .env — authenticate via HF_TOKEN env var:
RTVI_VLM_MODEL_TO_USE=vllm-compatible
RTVI_VLM_MODEL_PATH=git:https://huggingface.co/Qwen/Qwen3-VL-30B-A3B-Instruct
HF_TOKEN=hf_...
```

Avoid embedding HF tokens directly in model URLs; keep them in `HF_TOKEN` so
resolved config and logs do not contain credentials.

Validated model: `Qwen/Qwen3-VL-30B-A3B-Instruct`. Other Qwen3-VL sizes work
but are not officially validated.

---

### Option E — Custom NGC artifact or local vLLM-compatible model

For a custom NGC artifact, use `cosmos-reason2` (same NGC NIM loader):

```bash
RTVI_VLM_MODEL_TO_USE=cosmos-reason2
RTVI_VLM_MODEL_PATH=ngc:org/team/model:version
NGC_CLI_API_KEY=${NGC_CLI_API_KEY}
```

For a local directory containing a vLLM-compatible model, use `vllm-compatible`
and mount the host path into the container:

```bash
# .env:
RTVI_VLM_MODEL_TO_USE=vllm-compatible
RTVI_VLM_MODEL_PATH=/opt/models/my-vlm          # path inside the container
```

> Note: `RTVI_VLM_MODEL_IMPLEMENTATION_PATH` (`MODEL_IMPLEMENTATION_PATH` inside
> the container) is present in the compose env mapping but its behavior for
> custom local models is not documented — omit it unless you have confirmed it
> works for your use case.

Add the bind mount to the compose `volumes:` section:
```yaml
volumes:
  - /host/path/to/models:/opt/models:ro
```

## 12. Deployment Flow

This mirrors the compose-centric workflow used by the VSS deploy-profile skill:
work from a local copy, build a deploy-specific `.env`, dry-run, review, deploy, and
wait for health. Always follow this sequence. Never skip the dry-run.

This compose declares **6 blueprint profiles**. Service will NOT start under
plain `docker compose up` — `--profile <name>` is required.

| Profile | Intended use |
|---|---|
| `bp_wh_2d` | Warehouse/base 2D profile |
| `bp_developer_alerts_2d_vlm` | Alerts blueprint (2D, VLM-only) |
| `bp_developer_alerts_2d_cv` | Alerts (2D + CV) |
| `bp_developer_base_2d_IGX-THOR` | Base 2D on IGX Thor |
| `bp_developer_base_2d_AGX-THOR` | Base 2D on AGX Thor |
| `bp_developer_lvs_2d` | LVS 2D profile |

Generic VLM workflow → `bp_developer_alerts_2d_vlm`.

```bash
# Step 0. Get compose (copy from checkout, or fetch the same path from VSS_REF)
# Keep the checked-in compose read-only; mutate only this standalone copy.
: "${RTVI_DEPLOY_DIR:?Set RTVI_DEPLOY_DIR to any writable standalone working directory, e.g. /tmp/rtvi_deploy}"
mkdir -p "$RTVI_DEPLOY_DIR" && cd "$RTVI_DEPLOY_DIR"
VSS_CHECKOUT="${VSS_CHECKOUT:-}"
if [ -n "$VSS_CHECKOUT" ] && [ -f "$VSS_CHECKOUT/deploy/docker/services/rtvi/rtvi-vlm/rtvi-vlm-docker-compose.yml" ]; then
  cp "$VSS_CHECKOUT/deploy/docker/services/rtvi/rtvi-vlm/rtvi-vlm-docker-compose.yml" .
else
  VSS_REF="${VSS_REF:-e9caf1593ffcd4964426c3e481c2f05f880d2d58}" # validated 26.05.4 compose
  wget -q -O rtvi-vlm-docker-compose.yml \
    "https://raw.githubusercontent.com/NVIDIA-AI-Blueprints/video-search-and-summarization/${VSS_REF}/deploy/docker/services/rtvi/rtvi-vlm/rtvi-vlm-docker-compose.yml"
fi

# Step 0a. Derive the compose default tag, then select the platform variant.
#          Spark/GB10/SBSA requires the -sbsa tag.
#          x86_64 and Tegra-based Jetson/AGX/IGX Thor use the normal multiarch tag.
COMPOSE_DEFAULT_TAG=$(sed -nE 's/.*RTVI_VLM_IMAGE_TAG:-([^}]+).*/\1/p' rtvi-vlm-docker-compose.yml | head -n1)
: "${COMPOSE_DEFAULT_TAG:?Could not derive RTVI_VLM_IMAGE_TAG default}"
RTVI_VLM_IMAGE_TAG="${RTVI_VLM_IMAGE_TAG:-$COMPOSE_DEFAULT_TAG}"
RTVI_VLM_BASE_TAG="${RTVI_VLM_IMAGE_TAG%-sbsa}"
ARCH=$(uname -m)
PROFILE=$(printf '%s' "${HARDWARE_PROFILE:-}" | tr '[:lower:]' '[:upper:]')
if printf '%s' "$PROFILE" | grep -Eq 'DGX-SPARK|SPARK|GB10|SBSA'; then
  VLM_TAG="${RTVI_VLM_BASE_TAG}-sbsa" # Spark / GB10 / SBSA
elif [ "$ARCH" = "x86_64" ]; then
  VLM_TAG="$RTVI_VLM_BASE_TAG"
elif [ "$ARCH" = "aarch64" ]; then
  if grep -qi tegra /proc/cpuinfo 2>/dev/null || [ -f /etc/nv_tegra_release ]; then
    VLM_TAG="$RTVI_VLM_BASE_TAG"        # Jetson / AGX Thor / IGX Thor (Tegra)
  else
    VLM_TAG="${RTVI_VLM_BASE_TAG}-sbsa" # SBSA server-ARM, including DGX Spark / GB10 / Grace
  fi
else
  echo "Unsupported architecture: $ARCH" && exit 1
fi
echo "Platform: $ARCH → image tag: $VLM_TAG"
export VSS_DATA_DIR="${VSS_DATA_DIR:-$RTVI_DEPLOY_DIR/vss-data}"

# Step 0b. Standalone fix — recent Docker Compose rejects `depends_on`
#          references to sibling NIMs that aren't defined in this single-file
#          project, even with `required: false`. Strip the depends_on block for
#          standalone deploys. Use yq if available (handles YAML correctly),
#          otherwise fall back to a small stdlib-only Python edit of this known
#          compose file:
if command -v yq >/dev/null; then
  yq -i 'del(.services.rtvi-vlm.depends_on)' rtvi-vlm-docker-compose.yml
else
  python3 - <<'PY'
from pathlib import Path

p = Path("rtvi-vlm-docker-compose.yml")
out = []
skip = False
base_indent = 4
for line in p.read_text().splitlines():
    stripped = line.lstrip()
    indent = len(line) - len(stripped)
    if not skip and line.startswith("    depends_on:"):
        skip = True
        continue
    if skip:
        if stripped and indent <= base_indent:
            skip = False
            out.append(line)
        continue
    out.append(line)
p.write_text("\n".join(out) + "\n")
PY
fi
#     Verify it's gone before Compose validates the project:
if grep -q 'depends_on' rtvi-vlm-docker-compose.yml; then
  echo "standalone compose still contains depends_on; remove it before up" >&2
  exit 1
fi

# Step 1. Config — set model vars per §11 (Options A–E)
#
# SECURITY NOTE: Writing API keys to `.env` via the shell (`cat > .env`)
# puts the secret into the shell process for the duration of the heredoc.
# To minimise exposure, prefer ONE of:
#
#   (a) `printf` from an already-set env var that you exported with
#       `read -rs NGC_CLI_API_KEY`, so the key is never on the
#       command-line and never echoed.
#   (b) Render the file from a templated source with an external secret
#       manager (HashiCorp Vault, AWS Secrets Manager, sealed-secrets).
#   (c) Manage `.env` with `chmod 600` and `chown $(id -u):$(id -g)`
#       immediately after writing it. If this working directory is inside a
#       git repo, add `.env` to `.gitignore`; otherwise keep it outside any repo
#       and do not commit or archive it.
#
# In all cases, NEVER commit `.env` to a repository, NEVER leave it in
# `/tmp`, NEVER paste the value into chat history, and clear the shell
# history for the writing shell (`history -c && history -w`) before
# leaving the host. Rotate `NGC_CLI_API_KEY` if it ever leaves this
# host's trust boundary.
umask 077  # ensure the file is created mode 0600
: "${NGC_CLI_API_KEY:?Set NGC_CLI_API_KEY before writing .env}"
: "${HOST_IP:?Set HOST_IP to an address reachable from the RT-VLM container}"
cat > .env <<EOF
NGC_CLI_API_KEY=${NGC_CLI_API_KEY}
RTVI_VLM_PORT=8018
HOST_IP=${HOST_IP}
VSS_DATA_DIR=${VSS_DATA_DIR}
RTVI_VLM_IMAGE_TAG=${VLM_TAG}
RT_VLM_DEVICE_ID=0
# Model config (choose one option from §11):
RTVI_VLM_MODEL_TO_USE=cosmos-reason2
RTVI_VLM_MODEL_PATH=ngc:nim/nvidia/cosmos-reason2-8b:hf-1208
EOF
chmod 600 .env
grep -qxF .env .gitignore 2>/dev/null || printf '.env\n' >> .gitignore

# Step 1b. Select Docker command without interactive sudo.
# Prefer direct Docker access. If the host requires sudo, use `sudo -n` so
# agent sessions fail fast instead of hanging on a password prompt.
if docker ps >/dev/null 2>&1; then
  docker_cmd() { docker "$@"; }
elif sudo -n docker ps >/dev/null 2>&1; then
  docker_cmd() { sudo -n docker "$@"; }
else
  echo "ERROR: Docker is not accessible as this user and passwordless sudo is unavailable." >&2
  echo "Ask the host owner to add this user to the docker group, enable passwordless sudo for Docker, or run the Docker commands manually." >&2
  exit 1
fi

# Step 2. Prepare VST clip-storage host dir (required per §6 above).
# Compose `config` validates schema/interpolation, but it does not prove this
# host bind path exists or is writable by the container user.
CLIP_STORAGE_DIR="$VSS_DATA_DIR/data_log/vst/clip_storage"
mkdir -p "$CLIP_STORAGE_DIR"
if ! sudo -n chown -R 1001:1001 "$CLIP_STORAGE_DIR"; then
  echo "ERROR: passwordless sudo is unavailable for host-path ownership." >&2
  echo "Ask the host owner to run: sudo chown -R 1001:1001 \"$CLIP_STORAGE_DIR\"" >&2
  echo "Do not work around this with chmod 777 or world-writable permissions." >&2
  exit 1
fi

# Step 3. Validate the standalone compose before creating containers.
docker_cmd compose --env-file .env -f rtvi-vlm-docker-compose.yml \
  --profile bp_developer_alerts_2d_vlm config --quiet

# Step 4. NGC auth. Pipe the key from the user shell; do not rely on sudo
# preserving environment variables.
: "${NGC_CLI_API_KEY:?Set NGC_CLI_API_KEY before docker login}"
printf '%s' "$NGC_CLI_API_KEY" | docker_cmd login nvcr.io -u '$oauthtoken' --password-stdin

# Step 5. Pull image directly (docker compose pull fails on standalone — see §4)
docker_cmd pull "nvcr.io/nvidia/vss-core/vss-rt-vlm:${VLM_TAG}"

# Step 6. Bring up — plain `up` (no profile) starts nothing
docker_cmd compose --env-file .env -f rtvi-vlm-docker-compose.yml \
  --profile bp_developer_alerts_2d_vlm up -d

# Step 7. Wait for healthy — start_period is 1200s (20 MIN) on first boot.
#         Model weight download + vLLM warmup can take the full window.
#         Do NOT kill as "stuck" before 20 minutes have elapsed.
until [ "$(docker_cmd compose --env-file .env -f rtvi-vlm-docker-compose.yml ps --format json rtvi-vlm \
  | jq -r 'if length > 0 then ([.[].Health] | all(. == "healthy")) else false end')" = "true" ]; do
  echo "waiting for rtvi-vlm… (up to 20 minutes on first run)"
  sleep 15
done

# Step 8. Verify
curl -f "http://localhost:${RTVI_VLM_PORT}/v1/health/ready"
```

## 13. Dry Run

Run dry-runs from the standalone working directory after §12 Step 0b has stripped
the dangling `depends_on` block. The raw checked-in compose is valid only inside
the full VSS/met-blueprints multi-file project where sibling services exist.

```bash
cd "${RTVI_DEPLOY_DIR:?Set RTVI_DEPLOY_DIR to your standalone working directory}"

# Resolved compose (audit; --no-interpolate keeps ${VAR} literal — no secrets leaked)
docker compose --env-file .env -f rtvi-vlm-docker-compose.yml \
  --profile bp_developer_alerts_2d_vlm config --no-interpolate

# Validation only
docker compose --env-file .env -f rtvi-vlm-docker-compose.yml \
  --profile bp_developer_alerts_2d_vlm config --quiet && echo "compose valid"

# Create containers + pull + volumes, but don't start
docker compose --env-file .env -f rtvi-vlm-docker-compose.yml \
  --profile bp_developer_alerts_2d_vlm up --no-start

# Cleanup
docker compose --env-file .env -f rtvi-vlm-docker-compose.yml down
```

> Note: compose uses `${VAR:+:path}` conditional-bind on `ASSET_STORAGE_DIR` and
> `RTVI_VLM_LOG_DIR`. Older Compose (<2.36) rejects `config` with "too many
> colons". `up` works regardless; only `config` fails. Upgrade Compose.

## 14. Verify Deployment

```bash
# Health
curl -f "http://localhost:${RTVI_VLM_PORT}/v1/health/ready"

# Loaded model
curl -s -H "Authorization: Bearer ${NGC_CLI_API_KEY:-${RTVI_VLM_API_KEY:-}}" \
  "http://localhost:${RTVI_VLM_PORT}/v1/models" | jq

# OpenAPI spec (FastAPI auto-docs)
curl -s "http://localhost:${RTVI_VLM_PORT}/openapi.json" | jq '.paths | keys'
```

Healthy log signatures (`docker logs vss-rtvi-vlm`):
- `Auto-selecting VLM Batch Size to <N>`
- `Free GPU memory is <N> MiB`
- `Using <VLM_MODEL_TO_USE>`
- `RTVI Server loaded`
- `Backend is running at http://0.0.0.0:<port>`

## 15. Logs & Status

```bash
docker compose --env-file .env -f rtvi-vlm-docker-compose.yml ps

# By container name (compose sets container_name: vss-rtvi-vlm)
docker logs -f vss-rtvi-vlm

# Or by service via compose
docker compose --env-file .env -f rtvi-vlm-docker-compose.yml logs -f rtvi-vlm
docker compose --env-file .env -f rtvi-vlm-docker-compose.yml logs --tail 200 --since 10m rtvi-vlm

docker stats vss-rtvi-vlm
nvidia-smi dmon -s u
```

Verbosity: set `RTVI_VLM_LOG_LEVEL=DEBUG` (DEBUG/INFO/WARNING/ERROR) and
`up -d --force-recreate rtvi-vlm`. Host-persisted logs at `${RTVI_VLM_LOG_DIR}`
when set.

## 16. API Usage (from real-time-vlm-api.html)

**Base URL**: `http://<host>:${RTVI_VLM_PORT}/v1`
**Auth**: `Authorization: Bearer <token>` (when token gating is enabled)

Documented endpoint categories (full schemas via `/openapi.json` or `/docs`
once the service is up):

| Category | Purpose |
|---|---|
| Health Check | `/v1/health/ready` — readiness probe; used by Docker healthcheck |
| Captions | Generate VLM captions and alerts for videos and live streams |
| Files | Upload and manage video/image files |
| Live Stream | Add, list, and manage RTSP live streams |
| Models | `/v1/models` — list available VLM models |
| Metrics | Prometheus metrics endpoint |
| Metadata | Service metadata and version info |
| NIM Compatible | OpenAI-compatible endpoints for interop |

> ⚠ **Docs API page is a landing page only** — concrete paths, request/response
> schemas, and error codes were not retrievable from the upstream HTML.
> `GET /openapi.json` on the running service is authoritative for specifics.

## 17. Debugging Common Failures

| Symptom | Root cause | Fix |
|---|---|---|
| `docker compose up` starts nothing | `--profile` not specified | Add `--profile bp_developer_alerts_2d_vlm` (§12) |
| `Exited (1)` immediately, logs mention `RTVI_VLM_PORT` | Strict sentinel fired | Set `RTVI_VLM_PORT` in `.env` |
| Container starts but Kafka errors `:9092 connection refused` or offsets stay at 0 | `HOST_IP` unset, or no broker is reachable at `${HOST_IP}:9092` when RT-VLM starts | Set `HOST_IP` to an address reachable from the container, start Kafka with that advertised listener, then restart/recreate `rtvi-vlm`. Non-fatal for API/inference, but Kafka publishing is broken until fixed. |
| Volume mount error mentioning `data_log/vst/clip_storage` | `VSS_DATA_DIR` unset → malformed mount | Set `VSS_DATA_DIR`; pre-create the `data_log/vst/clip_storage` subtree |
| `sudo -n chown` reports that a password is required or fails in an agent session | Host path ownership requires user privileges and passwordless sudo is unavailable | Ask the host owner to run `sudo chown -R 1001:1001 "$VSS_DATA_DIR/data_log/vst/clip_storage"`; do not use `chmod 777` |
| `sudo -n docker ...` reports that a password is required | Docker requires elevated privileges, but the agent cannot satisfy an interactive sudo prompt | Prefer adding the user to the docker group, enable passwordless sudo for Docker, or have the host owner run the printed Docker command manually. Do not retry with interactive sudo. |
| `service "X" depends on undefined service "Y": invalid compose project` | Recent Docker Compose rejects `depends_on` refs to sibling NIM services not defined in this single-file project — even with `required: false`. | Remove the `depends_on` block from the local compose copy (§12 step 0b). Only needed for standalone deploys without the full met-blueprints project. |
| `docker compose pull` → `invalid compose project` | Same `depends_on` validation runs before pull | Use `docker pull nvcr.io/nvidia/vss-core/vss-rt-vlm:<tag>` directly (§4) |
| `docker compose pull --no-deps` → `unknown flag: --no-deps` | Compose 2.38 does not support `--no-deps` on `pull` | Use direct `docker pull` (§4), or strip `depends_on` and validate before `up` (§12 step 0b). |
| `password is empty` on Docker login | `$NGC_CLI_API_KEY` is not set in the invoking shell, or a previous sudo shell dropped the environment | Export `NGC_CLI_API_KEY` in the user shell and pipe it through the §12 Docker wrapper: `printf '%s' "$NGC_CLI_API_KEY" \| docker_cmd login nvcr.io -u '$oauthtoken' --password-stdin` |
| `unauthorized` on `docker compose pull` | Missing NGC auth or no org access | `docker login nvcr.io` with a key that has `nvidia/vss-core` access |
| `Exited (1)` "Error: No GPUs were found" | Container can't see GPUs | Install NVIDIA Container Toolkit; `docker run --rm --gpus all nvidia/cuda:12.4.0-base-ubuntu22.04 nvidia-smi` must work |
| `Exited (137)` OOM | VRAM pressure | Lower `RTVI_VLLM_GPU_MEMORY_UTILIZATION`; drop `RTVI_VLLM_MAX_NUM_SEQS` below 256; bigger GPU via `RT_VLM_DEVICE_ID`; drop `RTVI_VLM_MAX_MODEL_LEN` |
| First `up` hangs 10+ min | Model weight download + vLLM warmup | Expected: `start_period: 1200s`. Watch `docker logs` for NIM progress; don't kill before 20 min. |
| Device reboot on Jetson Thor / DGX Spark at 8+ vision tokens | Known issue (docs) | Cap at ≤2 concurrent streams or drop resolution |
| Stream deletion lags under heavy load | VLM inference exceeds chunk duration (docs — expected) | Reduce concurrent streams |

## 18. Upgrade & Rollback

**Forward**:
```bash
# .env: RTVI_VLM_IMAGE_TAG=<new-tag>
docker compose --env-file .env -f rtvi-vlm-docker-compose.yml --profile <p> pull rtvi-vlm
docker compose --env-file .env -f rtvi-vlm-docker-compose.yml --profile <p> up -d --force-recreate rtvi-vlm
```

**Rollback**:
```bash
# Record current tag first: `docker compose --env-file .env -f ... images rtvi-vlm`
# .env: RTVI_VLM_IMAGE_TAG=<prior-tag>
docker compose --env-file .env -f rtvi-vlm-docker-compose.yml --profile <p> pull rtvi-vlm
docker compose --env-file .env -f rtvi-vlm-docker-compose.yml --profile <p> up -d --force-recreate rtvi-vlm
```

Named volumes survive both. Re-download only if `MODEL_PATH` changes.

## 19. Tear Down

```bash
cd "${RTVI_DEPLOY_DIR:?Set RTVI_DEPLOY_DIR to your standalone working directory}"

# Keep named volumes (model caches preserved)
docker compose --env-file .env -f rtvi-vlm-docker-compose.yml --profile bp_developer_alerts_2d_vlm down

# WIPES model caches (20–80 GB re-download)
docker compose --env-file .env -f rtvi-vlm-docker-compose.yml --profile bp_developer_alerts_2d_vlm down -v

# Remove locally-pulled image
docker compose --env-file .env -f rtvi-vlm-docker-compose.yml down --rmi local

# Optional host-side (do NOT rm $VSS_DATA_DIR — shared with other services)
# rm -rf ./rtvi-assets ./rtvi-logs
```

## 20. Gotchas & Known Issues

- **🟢 Docs list `/v1/ready` for health, but the real endpoint is `/v1/health/ready`** — which is what the compose healthcheck already uses. Trust the compose, not the docs.
- **🟢 Healthcheck tuning divergence**: docs show `start_period: 300s`,
  `retries: 3`; compose sets `1200s` / `5`. The compose values are
  deliberately more lenient for model-download-on-first-boot. Not a bug.
- **🟢 Source-backed MODEL_PATH default**: compose, `vss-deploy-profile`, and
  the default alerts/LVS paths use
  `ngc:nim/nvidia/cosmos-reason2-8b:hf-1208`. Keep that default for standalone
  local Cosmos Reason 2 validation unless the source profile explicitly changes
  it. RTX PRO 4500 Blackwell uses the same default with tighter sizing
  caps for the smaller VRAM target. Model tags are not interchangeable; swapping tags on a live
  cache volume can trigger a `torch_aot_compile` / `_Missing has no attribute
  _modules` warning and force a full vLLM recompile on first boot.
- **Profiles are mandatory**: `docker compose up` without `--profile` starts
  nothing. 6 profiles available — §12.
- **`container_name: vss-rtvi-vlm` hardcoded** (line 22) — can't run two instances
  on the same host without editing. Second `up` fails with
  `Conflict. The container name "/vss-rtvi-vlm" is already in use`.
- **Long `start_period` (1200s = 20 min)**: first boot downloads model weights
  and warms vLLM. Pre-warn operators not to kill as stuck.
- **`depends_on.required: false` is NOT enough on recent Docker Compose**: Compose
  validates all `depends_on` service references at project load time and rejects
  them with `invalid compose project` if the services aren't defined — regardless
  of `required: false`. For standalone deployments (no full met-blueprints
  project), strip the `depends_on` block from the local compose copy (§12 step
  0b). The `required: false` behavior works correctly only when running under
  the full met-blueprints multi-file project where all sibling services are
  defined.
- **`sudo docker` drops environment variables**: `NGC_CLI_API_KEY` and other
  vars set in the user shell are invisible to `sudo docker`. Prefer the §12
  `docker_cmd` wrapper and pipe secrets through
  stdin (`printf '%s' "$NGC_CLI_API_KEY" | docker_cmd login ...`). Never let
  `sudo` prompt interactively in an agent session.
- **External Kafka required**: `KAFKA_BOOTSTRAP_SERVERS=${HOST_IP}:9092` — if
  `HOST_IP` isn't set, the container tries `:9092` and fails.
  `host.docker.internal` is wired via `extra_hosts` as an alternative value.
- **`VSS_DATA_DIR` required**: no default on the bind mount. Without it the
  mount spec expands to garbage.
- **Kafka startup order matters for validation**: when `RTVI_VLM_KAFKA_ENABLED=true`,
  start Kafka with an advertised `${HOST_IP}:9092` listener before RT-VLM. If the
  broker was missing or its listener changed after RT-VLM started, run
  `docker compose --env-file .env -f rtvi-vlm-docker-compose.yml --profile bp_developer_alerts_2d_vlm up -d --force-recreate rtvi-vlm`.
- **Host-var rewrite convention**: most host-side vars use `RTVI_VLM_*` or
  `RTVI_VLLM_*` and rewrite to canonical names inside the container.
- **`VLM_MODEL_TO_USE=openai-compat` by default**: this stack expects a sibling
  NIM on the same network, not a self-hosted vLLM. Standalone operation
  requires `RTVI_VLM_ENDPOINT` or switching to `cosmos-reason2` + `MODEL_PATH`.
- **Parser volume-split warnings**: the compose's `${VAR:-default}:path` mount
  syntax trips the pyyaml-fallback parser's colon-splitting heuristic. Re-read
  the raw compose (§6 cites the raw text). `up` is unaffected.
- **Docs gaps**: VSS docs cover Deploy + Troubleshoot but NOT tear-down,
  rollback, or backup/restore. §18–19 derive from Compose conventions.

## 21. References

- **Deploy docs**: <https://docs.nvidia.com/vss/latest/real-time-vlm.html>
- **API docs**: <https://docs.nvidia.com/vss/latest/real-time-vlm-api.html>
  (landing page only — see `/openapi.json` on the running service for specifics)
- **Compose (met-blueprints checkout)**: `deploy/docker/services/rtvi/rtvi-vlm/rtvi-vlm-docker-compose.yml`
- **Compose (raw, VSS 3.2 release SHA)**: `https://raw.githubusercontent.com/NVIDIA-AI-Blueprints/video-search-and-summarization/d64e6c5b96c56f1d11809905fe6463ffbffd9b42/deploy/docker/services/rtvi/rtvi-vlm/rtvi-vlm-docker-compose.yml`
