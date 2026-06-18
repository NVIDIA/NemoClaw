# Video Summarization Deployment Reference

Use `vss-deploy-profile` for full deployment. This file is the video summarization-specific
service reference for the VSS 3.2.0 `lvs` profile.

## Current VSS Docker Compose Shape

Source files:

- `deploy/docker/developer-profiles/dev-profile-lvs/.env`
- `deploy/docker/services/video-summarization/compose.yml`
- `deploy/docker/services/video-summarization/configs/config.yaml`
- `deploy/docker/services/rtvi/rtvi-vlm/rtvi-vlm-docker-compose.yml`
- `deploy/docker/services/infra/compose.yml`

Key service signals in the current develop branch:

| Item | Value |
|---|---|
| Compose profile | `bp_developer_lvs_2d` |
| video summarization service | `lvs-server` |
| video summarization container | `vss-lvs` |
| video summarization image | `${LVS_IMAGE:-nvcr.io/nvidia/vss-core/vss-video-summarization}:${LVS_TAG:-3.2.0}` |
| REST API | `http://<HOST_IP>:38111` |
| Readiness | `GET /v1/ready` |
| MCP port | `38112`, disabled by default in the developer profile |
| RT-VLM | `http://<HOST_IP>:8018` |
| Kafka captions topic | `mdx-vlm-captions` |
| Kafka structured summary topic | `mdx-structured-events-summary` |

## Verify Running Service

```bash
curl -sf --max-time 15 "${LVS_BACKEND_URL:-http://localhost:38111}/v1/ready" >/dev/null
curl -sf --max-time 15 "${LVS_BACKEND_URL:-http://localhost:38111}/models" | jq '.data[0].id'
```

Non-destructive Docker checks:

```bash
docker ps --filter name=vss-lvs --format '{{.Names}} {{.Status}}'
docker logs --tail 100 vss-lvs
```

## Deploy Or Recreate

Prefer the profile deploy skill:

```text
/vss-deploy-profile -p lvs
```

If you are already operating the resolved Docker Compose stack, include the
profile that owns the video summarization service:

```bash
docker compose --profile bp_developer_lvs_2d ps lvs-server
docker compose --profile bp_developer_lvs_2d logs -f lvs-server
```

## Required Inputs

The checked-in profile env file,
`deploy/docker/developer-profiles/dev-profile-lvs/.env`, is the defaults file.
For a deployment, follow `vss-deploy-profile` and apply overrides to
`deploy/docker/developer-profiles/dev-profile-lvs/generated.env`, then resolve
`deploy/docker/resolved.yml`. Do not edit the service compose directly.
Password values should come from the profile env or deployment overrides; do
not add password defaults to the service compose file.

Core required values:

| Var | Purpose |
|---|---|
| `VSS_APPS_DIR` | Absolute path to `deploy/docker`. |
| `VSS_DATA_DIR` | Data root for models, videos, and logs. |
| `HOST_IP` | Host-reachable IP used by services and clients. |
| `NGC_CLI_API_KEY` | Required for local image/model pulls. |
| `NVIDIA_API_KEY` or `OPENAI_API_KEY` | Required when selected remote endpoints enforce auth. |
| `LLM_MODE`, `VLM_MODE` | `local_shared`, `local`, or `remote`. |
| `LLM_NAME`, `LLM_NAME_SLUG` | LLM model and deployment slug. |
| `VLM_NAME` | Must match the id returned by RT-VLM `/v1/models`. |

Video summarization service values:

| Var | Default / Example | Purpose |
|---|---|---|
| `LVS_BACKEND_URL` | `http://${HOST_IP}:38111` | Agent-facing video summarization URL. |
| `LVS_IMAGE` | `nvcr.io/nvidia/vss-core/vss-video-summarization` | video summarization image repository. |
| `LVS_TAG` | `3.2.0` | video summarization image tag in current develop. |
| `LVS_ENABLE_MCP` | `false` | Enable MCP/SSE endpoint only when needed. |
| `LVS_DATABASE_BACKEND` | `elasticsearch_db` | Default event database backend. |
| `KAFKA_ENABLED` | `true` in dev-profile-lvs | Enables RTVI -> Kafka -> Logstash -> ES integration. |
| `KAFKA_BOOTSTRAP_SERVERS` | `${HOST_IP}:9092` | Broker address from the video summarization container. |
| `KAFKA_STRUCTURED_SUMMARY_TOPIC` | `mdx-structured-events-summary` | Structured summary publish topic. |
| `LVS_ENABLE_LLM_MERGING` | `true` in dev-profile-lvs | Merge duplicate or overlapping events with the LLM. |

## Database Backend Selection

The default backend is Elasticsearch:

```bash
LVS_DATABASE_BACKEND=elasticsearch_db
```

The video summarization config already supports graph backends, but the current
VSS Docker service graph does not define Neo4j or ArangoDB services by default.
Use an external DB endpoint or add one of the open-source containers with a
Compose override.

| Backend | `LVS_DATABASE_BACKEND` | Container | Image | Required video summarization env |
|---|---|---|---|---|
| Neo4j | `graph_db` | `graph-db` | `neo4j:5.26.4` | `GRAPH_DB_HOST`, `GRAPH_DB_BOLT_PORT`, `GRAPH_DB_USERNAME`, `GRAPH_DB_PASSWORD`, `LVS_EMB_ENABLE=true` |
| ArangoDB | `graph_db_arango` | `arango-db` | `arangodb/arangodb:3.12.4` | `ARANGO_DB_HOST`, `ARANGO_DB_PORT`, `ARANGO_DB_USERNAME`, `ARANGO_DB_PASSWORD`, `LVS_EMB_ENABLE=true` |

Do not switch to `graph_db` or `graph_db_arango` unless the embedding tool is
configured. Set `LVS_EMB_ENABLE=true`, `LVS_EMB_MODEL_NAME`, and
`LVS_EMB_BASE_URL` to a reachable OpenAI/NVIDIA-compatible text embedding
endpoint. The current LVS graph-RAG examples use
`nvidia/llama-3.2-nv-embedqa-1b-v2`, but always verify the exact model id from
the embedding endpoint:

```bash
curl -fsS "${LVS_EMB_BASE_URL%/}/models" | jq -r '.data[].id'
```

Copy the selected `id` into `LVS_EMB_MODEL_NAME`. Include `/v1` in
`LVS_EMB_BASE_URL`, for example `https://integrate.api.nvidia.com/v1` or a
local embedding NIM such as `http://127.0.0.1:9232/v1`. The video
summarization config maps embedding auth from `NVIDIA_API_KEY`, so ensure
`NVIDIA_API_KEY` is set if the endpoint requires auth. Otherwise keep
`elasticsearch_db`.

Do not use the VSS Search `rtvi-embed` service as the default graph backend
embedding endpoint. `rtvi-embed` is profile-gated for Search and exposes RTVI
embedding APIs such as `/v1/generate_text_embeddings`; the graph backend
expects the text embedding interface used by the video summarization embedding adapter.

The current VSS Docker `lvs-server` uses host networking. When adding Neo4j or
ArangoDB as open-source sidecar containers, expose their ports on the host and
point the video summarization service at `127.0.0.1` or `${HOST_IP}` via a
compose override. Do not rely on Docker DNS names like `graph-db` or `arango-db`
from inside the host-networked `lvs-server` unless the deployment has explicitly
provided those names.

Example Neo4j override:

```yaml
services:
  graph-db:
    image: neo4j:5.26.4
    container_name: graph-db
    environment:
      NEO4J_AUTH: ${GRAPH_DB_USERNAME:-neo4j}/${GRAPH_DB_PASSWORD:?GRAPH_DB_PASSWORD_required}
      NEO4J_PLUGINS: '["apoc"]'
      NEO4J_server_bolt_listen__address: 0.0.0.0:${GRAPH_DB_BOLT_PORT:-7687}
      NEO4J_server_http_listen__address: 0.0.0.0:${GRAPH_DB_HTTP_PORT:-7474}
    ports:
      - ${GRAPH_DB_HTTP_PORT:-7474}:${GRAPH_DB_HTTP_PORT:-7474}
      - ${GRAPH_DB_BOLT_PORT:-7687}:${GRAPH_DB_BOLT_PORT:-7687}
    restart: unless-stopped

  lvs-server:
    environment:
      LVS_DATABASE_BACKEND: graph_db
      GRAPH_DB_HOST: 127.0.0.1
      GRAPH_DB_USERNAME: ${GRAPH_DB_USERNAME:-neo4j}
      GRAPH_DB_PASSWORD: ${GRAPH_DB_PASSWORD:?GRAPH_DB_PASSWORD_required}
      GRAPH_DB_HTTP_PORT: ${GRAPH_DB_HTTP_PORT:-7474}
      GRAPH_DB_BOLT_PORT: ${GRAPH_DB_BOLT_PORT:-7687}
      LVS_EMB_ENABLE: "true"
      LVS_EMB_MODEL_NAME: ${LVS_EMB_MODEL_NAME}
      LVS_EMB_BASE_URL: ${LVS_EMB_BASE_URL}
      NVIDIA_API_KEY: ${NVIDIA_API_KEY}
```

Example ArangoDB override:

```yaml
services:
  arango-db:
    image: arangodb/arangodb:3.12.4
    container_name: arango-db
    environment:
      ARANGO_ROOT_PASSWORD: ${ARANGO_DB_PASSWORD:?ARANGO_DB_PASSWORD_required}
    ports:
      - ${ARANGO_DB_PORT:-8529}:${ARANGO_DB_PORT:-8529}
    command:
      - arangod
      - --experimental-vector-index
      - --server.endpoint
      - tcp://0.0.0.0:${ARANGO_DB_PORT:-8529}
    restart: unless-stopped

  lvs-server:
    environment:
      LVS_DATABASE_BACKEND: graph_db_arango
      ARANGO_DB_HOST: 127.0.0.1
      ARANGO_DB_USERNAME: ${ARANGO_DB_USERNAME:-root}
      ARANGO_DB_PASSWORD: ${ARANGO_DB_PASSWORD:?ARANGO_DB_PASSWORD_required}
      ARANGO_DB_PORT: ${ARANGO_DB_PORT:-8529}
      LVS_EMB_ENABLE: "true"
      LVS_EMB_MODEL_NAME: ${LVS_EMB_MODEL_NAME}
      LVS_EMB_BASE_URL: ${LVS_EMB_BASE_URL}
      NVIDIA_API_KEY: ${NVIDIA_API_KEY}
```

After adding an override, set the matching values in
`developer-profiles/dev-profile-lvs/generated.env`, then resolve through the
same dry-run path used by `vss-deploy-profile`:

```bash
cd "$REPO/deploy/docker"
docker compose --env-file developer-profiles/dev-profile-lvs/generated.env \
  -f compose.yml -f <db-override.yml> \
  config > resolved.yml
```

Normalize `resolved.yml`, then verify it before recreating the service:

```bash
uv run "$REPO/skills/vss-deploy-profile/scripts/normalize_resolved_yml.py" \
  "$REPO/deploy/docker/resolved.yml"
sed -n '/lvs-server:/,/^[^ ]/p' resolved.yml \
  | grep -E 'LVS_DATABASE_BACKEND|GRAPH_DB_|ARANGO_DB_|LVS_EMB_'
docker compose -f resolved.yml config --quiet
```

Then recreate the database and video summarization service from `resolved.yml`.
Do not add `--force-recreate`; Docker will recreate only services whose config
changed or that are down.

```bash
docker compose -f resolved.yml up -d graph-db lvs-server        # Neo4j

docker compose -f resolved.yml up -d arango-db lvs-server       # ArangoDB
```

Health checks:

```bash
curl -sf http://127.0.0.1:7474 >/dev/null                       # Neo4j HTTP
curl -sf http://127.0.0.1:8529/_admin/server/availability >/dev/null # ArangoDB
curl -sf "${LVS_BACKEND_URL:-http://localhost:38111}/v1/ready" >/dev/null
```

RT-VLM values:

| Var | Default / Example | Purpose |
|---|---|---|
| `RTVI_VLM_BASE_URL` | `http://${HOST_IP}:8018` | Agent-facing RT-VLM URL. |
| `RTVI_VLM_URL` | `http://${HOST_IP}:${RTVI_VLM_PORT}` | video summarization-facing RT-VLM URL. |
| `RTVI_VLM_MODEL_TO_USE` | `cosmos-reason2` | RT-VLM backend selector for default integrated mode. |
| `RTVI_VLM_MODEL_PATH` | `ngc:nim/nvidia/cosmos-reason2-8b:hf-1208` | Default integrated checkpoint. |
| `RTVI_VLM_KAFKA_ENABLED` | `true` | Publish raw captions to Kafka. |
| `RTVI_VLM_KAFKA_TOPIC` | `mdx-vlm-captions` | Raw captions topic. |

## Model Id Rule

For the default integrated RT-VLM path:

```bash
VLM_NAME=nim_nvidia_cosmos-reason2-8b_hf-1208
RTVI_VLM_MODEL_PATH=ngc:nim/nvidia/cosmos-reason2-8b:hf-1208
```

`VLM_NAME` must match the id returned by:

```bash
curl -sf "http://${HOST_IP}:8018/v1/models" | jq -r '.data[].id'
```

Do not replace it with the friendly model name unless the endpoint advertises
that exact id.

## Helm Notes

The Helm service chart lives at `deploy/helm/services/video-summarization`.
Important 3.2 values:

- `image.repository: nvcr.io/nvidia/vss-core/vss-video-summarization`
- `image.tag: "3.2.0"`
- `service.backendPort: 38111`
- `service.mcpPort: 38112`
- `KAFKA_ENABLED: "true"`
- `KAFKA_STRUCTURED_SUMMARY_TOPIC: mdx-structured-events-summary`
- `LVS_ENABLE_MCP: "false"`

The Helm template computes `LVS_LLM_BASE_URL`, `LVS_LLM_MODEL_NAME`,
`VIA_VLM_ENDPOINT`, and `VIA_VLM_OPENAI_MODEL_DEPLOYMENT_NAME` from profile or
global values.

## Common Checks

```bash
# video summarization health
curl -sf "http://${HOST_IP}:38111/v1/ready" >/dev/null

# RT-VLM model id
curl -sf "http://${HOST_IP}:8018/v1/models" | jq -r '.data[].id'

# Kafka topic traffic, when kafka is enabled
docker exec kafka kafka-console-consumer \
  --bootstrap-server localhost:9092 \
  --topic mdx-vlm-captions \
  --max-messages 1

# Shared Logstash pipeline
docker logs --tail 100 logstash
```
