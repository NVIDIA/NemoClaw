---
name: vss-deploy-dense-captioning
description: Use this skill when deploying standalone RT-VLM dense captioning or calling its REST API (uploads, captions, streams, chat-completions, Kafka). Not for VSS profile deploy or video-search ingestion.
license: Apache-2.0
metadata:
  version: "3.2.0"
  github-url: "https://github.com/NVIDIA-AI-Blueprints/video-search-and-summarization"
  tags: "nvidia blueprint operational deployment"
---
## Purpose

Stand up the RT-VLM dense-captioning microservice on its own and exercise every endpoint it exposes (file upload, generate_captions, stream add/delete, chat-completions, Kafka topics).

## Prerequisites

For standalone RT-VLM deployment:
- Docker, Docker Compose, NVIDIA Container Toolkit, and a visible GPU.
- NGC registry credentials in `$NGC_CLI_API_KEY` for `docker login nvcr.io`,
  image pulls, and local NGC model/artifact downloads.
- `curl`, `jq`, and any writable working directory for the standalone compose copy.

For API calls against an existing service:
- Running RT-VLM service reachable at `$BASE_URL`.
- Bearer token in `$RTVI_VLM_API_KEY` or `$NGC_CLI_API_KEY`, depending on how the
  service was configured.

For full VSS profile deployment:
- Use `../vss-deploy-profile/SKILL.md`; this skill does not deploy full VSS profiles.

## Instructions

Follow the routing tables and step-by-step workflows below. Each section that ends in *workflow*, *quick start*, or *flow* is intended to be executed top-to-bottom. Detailed reference material lives in `references/`; execute the documented workflows directly unless a future revision names a concrete helper.

## Examples

Worked end-to-end examples are kept under `evals/` (each `*.json` manifest contains a runnable scenario) and inline in the per-workflow `curl` blocks below. Run a Tier-3 evaluation with `nv-base validate <this-skill-dir> --agent-eval` to replay them.

## Limitations

- Requires either a standalone RT-VLM service deployed via this skill or an
  existing RT-VLM service reachable from the caller.
- NGC-hosted models and NIMs may be subject to rate-limits, GPU memory requirements, and license restrictions.
- Concurrency, GPU memory, and storage limits depend on the host hardware and the profile's compose file.
- Keep `NGC_CLI_API_KEY`, `RTVI_VLM_API_KEY`, and `.env` files out of git and out of logs; do not echo credential values or include them in final responses.
- Docker group access and `sudo` are effectively root-level privileges. Use the non-interactive `sudo -n` guard in the deploy reference and stop for host-owner action when passwordless sudo is unavailable.

## Troubleshooting

- **Error**: REST call returns connection refused. **Cause**: target microservice not running. **Solution**: probe `/docs` or `/health`; redeploy via `vss-deploy-profile` or the matching `vss-deploy-*` skill.
- **Error**: HTTP 401/403 from NGC pulls. **Cause**: missing/expired `NGC_CLI_API_KEY`. **Solution**: `docker login nvcr.io` and re-export the key before retrying.
- **Error**: container OOM or model fails to load. **Cause**: insufficient GPU memory for the selected profile. **Solution**: switch to a smaller variant or free GPUs via `docker compose down`.

# Deploy and Use RT-VLM Dense Captioning (VSS 3.2)

RT-VLM is NVIDIA's real-time vision-language microservice: decode video (file or
RTSP), segment it into chunks, run a VLM (`cosmos-reason1`, `cosmos-reason2`, or any
OpenAI-compatible model), stream dense captions back over SSE/HTTP, and publish
captions, incident alerts, and errors to Kafka. Use this skill to deploy the
standalone RT-VLM service when a full VSS profile is not already running, then call
its `/v1/...` API for caption generation, file upload, live-stream management, health
checks, NIM-compatible chat completions, or Prometheus metrics. API reference:
<https://docs.nvidia.com/vss/latest/real-time-vlm-api.html>.

## Deployment Routing

If the user asks to deploy a full VSS profile, use
[`../vss-deploy-profile/SKILL.md`](../vss-deploy-profile/SKILL.md). That skill
owns profile routing, `generated.env`, `resolved.yml`, multi-service sizing, and
full-stack deploy/teardown.

If the user asks for standalone RT-VLM dense captioning, or no VSS profile is
already running, use the standalone RT-VLM flow in
[`references/deploy-rt-vlm-service.md`](references/deploy-rt-vlm-service.md)
before calling the API. This follows the same compose-centric pattern as
`vss-deploy-profile`: gather context, run preflights, work from a local copy,
dry-run with `docker compose config`, review, deploy, then wait for health.

## Standalone Deployment Flow

Always follow this sequence. Never skip the dry-run.

```bash
# 1. Copy deploy/docker/services/rtvi/rtvi-vlm/rtvi-vlm-docker-compose.yml
#    into any writable standalone working directory.
# 2. Derive RTVI_VLM_IMAGE_TAG from that compose copy.
# 3. Strip the standalone-only dangling depends_on block from the copy.
# 4. Create a gitignored .env with the required RT-VLM values.
# 5. Prepare host bind paths such as $VSS_DATA_DIR/data_log/vst/clip_storage.
#    Use `sudo -n` for ownership fixes; if passwordless sudo is unavailable,
#    stop and ask the host owner to run the printed command manually.
# 6. docker compose --env-file .env -f rtvi-vlm-docker-compose.yml config --quiet
# 7. docker pull the exact RT-VLM image tag.
# 8. docker compose ... up -d rtvi-vlm, wait for ready, then smoke test.
```

Run preflights before any pull or `up`; stop and fix failures here before
debugging RT-VLM itself:

```bash
nvidia-smi --query-gpu=index,name --format=csv,noheader
nvidia-container-cli info
docker compose version
docker run --rm --gpus all nvidia/cuda:12.4.0-base-ubuntu22.04 nvidia-smi
```

For standalone single-file deployments, do not run the raw
`deploy/docker/services/rtvi/rtvi-vlm/rtvi-vlm-docker-compose.yml` directly: it
contains `depends_on` references to sibling VLM/NIM services that are only
defined in the full VSS/met-blueprints compose project. The standalone reference
shows how to copy the compose file, derive the current image tag from it, strip
the `depends_on` block, and validate the result before `up`.

For agent-driven validation, never let `sudo` prompt interactively. Before any
privileged ownership or Docker operation, use the non-interactive guard in
[`references/deploy-rt-vlm-service.md`](references/deploy-rt-vlm-service.md):
prefer plain `docker`; otherwise use `sudo -n docker`; if `sudo -n` fails, stop
with the exact manual command for the host owner instead of retrying with
interactive sudo or weakening permissions.

If `docker pull` fails with a containerd snapshotter/unpack error on Docker 28+,
apply the `/etc/docker/daemon.json` `containerd-snapshotter=false` fix in the
standalone reference before retrying.

Minimum standalone `.env` values:

| Host env var | Required when | Purpose |
|---|---|---|
| `NGC_CLI_API_KEY` | Standalone deploy path | NGC registry image pull and NGC model/artifact download |
| `RTVI_VLM_API_KEY` or `NGC_CLI_API_KEY` | Authenticated API calls | RT-VLM bearer auth after the service is running |
| `RTVI_VLM_PORT` | Always | Host API port mapped to container `8000` |
| `HOST_IP` | Always | Kafka bootstrap host (`${HOST_IP}:9092`) |
| `VSS_DATA_DIR` | Always | Required clip-storage bind mount |
| `RTVI_VLM_MODEL_TO_USE` | Always for standalone | Backend selector; use `cosmos-reason2` for the default local model or `openai-compat` for a remote/sibling endpoint |
| `RTVI_VLM_MODEL_PATH` | Local self-hosted model | Source-backed Cosmos Reason 2 path: `ngc:nim/nvidia/cosmos-reason2-8b:hf-1208` |
| `RTVI_VLM_ENDPOINT` | `RTVI_VLM_MODEL_TO_USE=openai-compat` | Remote/sibling OpenAI-compatible VLM endpoint |
| `VLM_NAME` | `RTVI_VLM_MODEL_TO_USE=openai-compat` | Model/deployment name exposed by that endpoint |

## Setup

```bash
export BASE_URL="http://localhost:${RTVI_VLM_PORT:-8018}"  # host-side RT-VLM port
export API_KEY="${NGC_CLI_API_KEY:-${RTVI_VLM_API_KEY:-}}" # bearer token used by host-side curl commands
: "${API_KEY:?Set NGC_CLI_API_KEY or RTVI_VLM_API_KEY before calling authenticated endpoints}"
```

Every request below uses `Authorization: Bearer $API_KEY`. Health endpoints
(`/v1/health/*`, `/v1/ready`, `/v1/live`, `/v1/startup`) typically work without auth.

**Smoke test before use:**
```bash
curl -fsS "$BASE_URL/v1/health/ready"
MODEL_ID="$(curl -fsS "$BASE_URL/v1/models" -H "Authorization: Bearer $API_KEY" | jq -r '.data[0].id // .id')"
curl -fsS "$BASE_URL/openapi.json" | jq -r '.paths | keys[]' | sort
```

## RTSP Sample Stream Guard

When a task or eval names `RTSP_SAMPLE_URL`, treat that exact environment
variable as a required input. Verify it is set and non-empty before probing or
registering any stream; if it is missing, stop with a clear failure message. Do
not derive a substitute from NvStreamer, VIOS, sample-data bundles, or any other
fallback, because that validates a different stream than the caller requested.

```bash
: "${RTSP_SAMPLE_URL:?Set RTSP_SAMPLE_URL to a reachable RTSP sample stream before RTSP validation}"
case "$RTSP_SAMPLE_URL" in
  rtsp://*) ;;
  *) echo "RTSP_SAMPLE_URL must be an rtsp:// URL, got: $RTSP_SAMPLE_URL" >&2; exit 1 ;;
esac

if command -v ffprobe >/dev/null 2>&1; then
  ffprobe -v error -rtsp_transport tcp \
    -select_streams v:0 -show_entries stream=codec_type \
    -of csv=p=0 "$RTSP_SAMPLE_URL" | grep -qx video
elif command -v gst-discoverer-1.0 >/dev/null 2>&1; then
  gst-discoverer-1.0 "$RTSP_SAMPLE_URL" | grep -qi 'video'
else
  echo "Install ffprobe or gst-discoverer-1.0 before RTSP validation." >&2
  exit 1
fi
```

## Quick Start — dense captions from a local video

```bash
# 1. Upload the video, capture its file id
FILE_ID=$(curl -fsS -X POST "$BASE_URL/v1/files" \
  -H "Authorization: Bearer $API_KEY" \
  -F "file=@/path/to/warehouse.mp4" \
  -F "purpose=vision" \
  -F "media_type=video" | jq -r '.id')

# 2. Generate captions + alerts (SSE stream of chunked responses)
curl -N -X POST "$BASE_URL/v1/generate_captions" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"id\": \"$FILE_ID\",
    \"prompt\": \"Write a concise dense caption for each 10-second segment of this warehouse video.\",
    \"model\": \"$MODEL_ID\",
    \"chunk_duration\": 10,
    \"stream\": true
  }"
```

## API Surface

Use the live OpenAPI as the source of truth before calling optional endpoints:

```bash
curl -fsS "$BASE_URL/openapi.json" | jq -r '.paths | keys[]' | sort
```

Core paths for VSS 3.2 are:

- `POST /v1/files` for multipart media upload; pass the returned file `id` into
  caption generation and delete the file when finished.
- `POST /v1/generate_captions` for file or stream captioning. Use the exact
  model id returned by `GET /v1/models`; aliases such as `cosmos-reason2` are
  backend selectors, not request model ids.
- `POST /v1/streams/add`, `GET /v1/streams/get-stream-info`, and
  `DELETE /v1/streams/delete/{stream_id}` for RTSP lifecycle. Parse stream ids
  from `results[0].id`.
- `POST /v1/chat/completions` for OpenAI-compatible text and multimodal calls.
  Current 26.05 builds return HTTP 400 for text-only `/v1/completions`; treat
  that as expected when validating legacy behavior.
- `GET /v1/health/ready`, `/v1/models`, `/v1/assets/stats`, and `/v1/metrics`
  for service probes. Do not assume `/v1/license` exists unless OpenAPI lists it.

Detailed endpoint schemas, response shapes, CV-style singular stream endpoints,
and 26.05 compatibility notes live in
[`references/api-surface-26.05.md`](references/api-surface-26.05.md).

## Common Workflows

- Stored file captioning: upload with `POST /v1/files`, call
  `/v1/generate_captions` with the returned file id, use `stream=true` for SSE,
  then delete the file to release storage.
- RTSP live captioning: when the caller provides `RTSP_SAMPLE_URL`, use that
  exact URL and run the **RTSP Sample Stream Guard** before registration. Do not
  derive a replacement stream from NvStreamer or VIOS when `RTSP_SAMPLE_URL` is
  empty; fail fast instead. Require an actual video stream/caps entry before
  registration; add the stream, caption it, then unregister it.
- Alert prompts: include a deterministic `Anomaly Detected: Yes/No` line.
  Kafka publication is server-side config, additive to HTTP responses, and
  documented in [`references/kafka-workflows.md`](references/kafka-workflows.md).
- Kafka validation: trust the live `vss-rtvi-vlm` environment for topic names.
  In a full VSS alerts real-time profile, use the existing VSS Kafka container
  `mdx-kafka` for CLI checks and final incident-consumer commands. For
  standalone validation, use a broker that advertises `${HOST_IP}:9092`; never
  stop or replace a pre-existing broker without user confirmation.

## Error Reference

Common causes: 400 for invalid request shape or model id, 401/403 for missing
or wrong bearer token, 404 for deleted files/streams or unsupported endpoints,
413 for oversized uploads, 422 for schema validation, 429 for too much
concurrency, 500 for inference/runtime failures, and 503 while startup is still
in progress. Inspect `docker logs vss-rtvi-vlm` for service-side failures.
