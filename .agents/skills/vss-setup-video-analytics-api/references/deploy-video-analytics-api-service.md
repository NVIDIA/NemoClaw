# Deploy Video Analytics API — Standalone Service

Deploy **just** `vss-video-analytics-api` (no perception, no behavior-analytics, no UI) — useful when you want to:

- Run the REST API against an existing Elasticsearch cluster (and optionally Kafka), or bring up only the minimum infra it needs.
- Serve calibration, sensor, behavior, alerts, events, tracking, incident, and metrics endpoints.

Required host runtime: **Docker Engine 28.3.3** with **Docker Compose plugin v2.39.1+**.

---

## What you edit

You only edit the existing service compose:

```
<repo>/deploy/docker/services/analytics/video-analytics-api/compose.yml
```

1. **`command:`** — which config file the Node server loads at startup.
2. **`volumes:`** — what config (required) and what data-log directory (optional) to mount.

Walk steps 1-3 below to decide each one; the bring-it-up command lives in [Deploy + verify](#deploy--verify) at the end. For a field-by-field JSON config reference, see the [Configuration Guide](configuration.md).

---

## Step 1 — Choose a config (required)

Every startup requires `--config <path>`. The container has three viable sources:

### Option A — Use the image-baked default

Cheapest path. The image ships a default config at `/configs/default-configs/config.json`. To use it, change the `command:` and drop the config volume mount:

```yaml
command: node index.js --config /configs/default-configs/config.json
```

The defaults assume:
- Elasticsearch at `http://localhost:9200`
- Index prefix `mdx-`
- Kafka **disabled** (empty brokers list)
- Server port **8081**

### Option B — Use the service-shipped config (default in compose)

The base compose already mounts the config from the services directory:

```
services/analytics/video-analytics-api/configs/vss-video-analytics-api-config.json
```

This config is identical to the image-baked default except Kafka is **enabled** (`brokers: ["localhost:9092"]`). This is the right choice when you have a local Kafka broker running. If Kafka is absent, the server can still start once Elasticsearch is healthy, but Kafka-dependent endpoints will fail until a broker becomes reachable. Use Option A or a custom config with `kafka.brokers: []` for a quiet broker-less deployment.

No compose change needed — this is the default:

```yaml
services:
  vss-video-analytics-api:
    volumes:
      - $VSS_APPS_DIR/services/analytics/video-analytics-api/configs/vss-video-analytics-api-config.json:/opt/mdx/vss-video-analytics-api/configs/vss-video-analytics-api-config.json
    command: node index.js --config /opt/mdx/vss-video-analytics-api/configs/vss-video-analytics-api-config.json
```

### Option C — Use your own custom config

Drop in any absolute host path; copy one of the above as a starting point and edit. Compose change:

```yaml
volumes:
  - /abs/path/to/my-config.json:/opt/mdx/vss-video-analytics-api/configs/vss-video-analytics-api-config.json
command: node index.js --config /opt/mdx/vss-video-analytics-api/configs/vss-video-analytics-api-config.json
```

### Config — what's in it

Top-level shape:

| Section | What it controls |
|---|---|
| `server.port` | HTTP port the API listens on. Default **8081**. |
| `server.configs[]` | List of `{name, value}` pairs. Knobs like `postBodySizeLimit` (max POST body, default `50mb`), `amrRetentionInSec` (AMR data retention, default `3`s), `inSimulationMode` (default `false`), `configStatusTimeoutMs` (config update ACK timeout, default `30000`ms), `configStatusTimeoutCheckFrequencyMs` (how often to check for timed-out config updates, default `900000`ms). |
| `elasticsearch` | `node` (ES URL), `indexPrefix` (default `mdx-`), `rawIndex` (default `mdx-raw-*`), `retries` (default `15`). |
| `kafka` | `brokers` (array of `"host:port"` strings; empty = Kafka disabled), `retries` (KafkaJS retry count; `null` = KafkaJS default). |

---

## Step 2 — Data log volume

The compose mounts a data-log directory for multipart upload handling and file-backed assets such as calibration images:

```yaml
volumes:
  - $VSS_DATA_DIR/data_log/vss_video_analytics_api:/web-api-app/files
```

If you keep this mount, set `$VSS_DATA_DIR` to a writable host path and pre-create the subdirectory before `docker compose up`:

```bash
export VSS_DATA_DIR=<path-to-data-directory>  # e.g. /tmp/vss-data
mkdir -p "$VSS_DATA_DIR/data_log/vss_video_analytics_api"
```

If you don't need image upload endpoints, you can drop this mount — the container will still start, but uploaded images will write to the container's ephemeral filesystem.

---

## Step 3 — Infrastructure dependencies

### Elasticsearch (required)

The server pings Elasticsearch on startup. If ES is unreachable, the server logs `[APP ERROR] Server initialization failed` and exits. The `restart: always` policy in the base compose brings it back, so `docker ps` may show a `Restarting (N)` loop until ES is reachable.

Make sure the `elasticsearch.node` in your config matches the running ES instance. With `network_mode: "host"`, ES must also be on the host network.

If you need to bring up Elasticsearch too, use the infra compose:

```bash
docker compose -f services/infra/compose.yml up -d elasticsearch
```

Wait for ES to be healthy before starting the API:

```bash
curl -sf http://localhost:9200/_cluster/health
```

### Kafka (optional)

Kafka is **optional**. If `kafka.brokers` is empty or null in the config, the server skips Kafka entirely — no error, no retry loop.

When brokers are configured and reachable, the API gains:
- **Dynamic config** — produces/consumes config update notifications on `mdx-notification` (Kafka key `behavior-analytics-config`). This is how the UI pushes config changes to `behavior-analytics` through the API.
- **Dynamic calibration** — produces calibration update notifications on `mdx-notification` (Kafka key `calibration`).
- **RTLS / AMR** — consumes real-time location and AMR messages from `mdx-rtls` / `mdx-amr` topics and exposes them via REST.

If brokers are configured but unreachable, the server still starts (ES must be up), but Kafka-dependent endpoints will fail. If you want the API to run broker-less without Kafka connection errors, set `kafka.brokers` to an empty array (`[]`) or `null`.

---

## How profiles use this service

Every profile extends the same base service and adds its own `depends_on` and `profiles` constraints. The config is always the same service-shipped config — no profile overrides it:

| Profile compose | Service name | Container name | `depends_on` |
|---|---|---|---|
| `warehouse-2d-app/warehouse-2d-app.yml` | `vss-video-analytics-api-2d` | `vss-video-analytics-api` | `broker-health-check`, `elasticsearch-init-container` |
| `warehouse-3d-app/warehouse-3d-app.yml` | `vss-video-analytics-api-3d` | `vss-video-analytics-api` | `broker-health-check`, `elasticsearch-init-container` |
| `warehouse-mv3dt-app/warehouse-mv3dt-app.yml` | `vss-video-analytics-api-mv3dt` | `vss-video-analytics-api-mv3dt` | `broker-health-check`, `elasticsearch-init-container` |
| `dev-profile-alerts/compose.yml` | `vss-video-analytics-api-alerts` | `vss-video-analytics-api` | `broker-health-check`, `elasticsearch-init-container` |
| `dev-profile-search/video-analytics-2d-app/compose.yml` | `vss-video-analytics-api-fusion` | `vss-video-analytics-api` | `broker-health-check`, `elasticsearch-init-container` |

The `import-calibration-output-container` in warehouse profiles depends on the video-analytics-api service — it POSTs calibration data to the API after startup.

---

## REST API endpoints

The server auto-discovers controllers from `src/app/controllers/rest-apis/` and mounts them as routes. Available endpoints:

| Endpoint | What it does |
|---|---|
| `/livez` | Responds with `{ "isAlive": true }` if the API server has started successfully and routes are registered. |
| `/sensor` | Lists sensors overlooking a coordinate in the floorplan of a place (`/sensor/lookup`). |
| `/config` | Config management: upload config files such as `calibration.json`, `roadNetwork.json`, and `usdAssets.json` (`/config/upload-file/{docType}`); dynamically update microservice configurations (`/config/update/{docType}`); poll update status (`/config/update/status/{docType}/{referenceId}`); retrieve road-network and USD-assets configs. |
| `/config/calibration` | Retrieves the current calibration document (`GET /config/calibration`, optionally filtered by `sensorId`; `emptyIfNotFound` controls the empty response behavior). Also supports calibration upsert (`/upsert`), delete-sensor (`/delete-sensor`), image upload/retrieval/delete/metadata (`/images`, `/image`, `/image-metadata`, `/delete-images`), and last-modified-timestamp. Update operations publish calibration notifications to Kafka. |
| `/behavior` | Retrieves behavior metadata from Elasticsearch (`/behavior`); gets behavior start and end PTS milliseconds for nvstreamer-based sensors (`/behavior/pts`). |
| `/alerts` | Retrieves behavior-based alerts with time-range and sensor filters (`/alerts`); indicates whether a place or sensor has severe alerts (`/alerts/severe`). |
| `/events` | Retrieves tripwire cross-line events (`/events/tripwire`), ROI entry/exit events (`/events/roi`), and AMR mission-control events for a place and time range (`/events/amr`). |
| `/incidents` | Retrieves incident records from Elasticsearch (`/incidents`); indicates whether a place or sensor has severe incidents (`/incidents/severe`). |
| `/frames` | Retrieves raw, enhanced, and BEV frame metadata; frame-level alerts; high-confidence object detections for reference embeddings and object search; latest proximity-detection clusters for a sensor and time range; and PTS calculation for nvstreamer sensors. |
| `/metrics` | KPI queries: average speed, flowrate, travel time, tripwire counts and histograms, FOV / ROI / tracker / tripwire occupancy and histograms, ROI space-utilization histograms, last-processed timestamp, and road-network segment speed. |
| `/tracker` | Cross-sensor tracking: unique object counts and locations, full unique-object records with constituent behaviors, behavior locations matched to a global object, and last RTLS / AMR source record. |
| `/clustering` | Retrieves sampled behavior clusters for a sensor and time range (`/clustering/behavior`); adds a label to a behavior cluster (`/clustering/add-label`). |

The server must initialize against Elasticsearch before `/livez` can return healthy. Data-query endpoints also need matching Elasticsearch indices and data. Endpoints that publish notifications (config, calibration) or expose RTLS / AMR streams also require Kafka.

---

## Deploy + verify

```bash
cd <repo>/deploy/docker
docker --version        # need 28.3.3
docker compose version  # need v2.39.1+

export VSS_APPS_DIR=$(pwd)
export VSS_DATA_DIR=<path-to-data-directory>  # e.g. /tmp/vss-data
mkdir -p "$VSS_DATA_DIR/data_log/vss_video_analytics_api"

# (one-time) edit services/analytics/video-analytics-api/configs/vss-video-analytics-api-config.json if needed.

docker compose -f services/analytics/video-analytics-api/compose.yml up -d vss-video-analytics-api

docker ps --filter "name=vss-video-analytics-api" --format '{{.Names}}\t{{.Status}}'
# Compose auto-names the standalone container <project>-<service>-<index>; project defaults to
# the compose file's parent dir, so the full name is:
docker logs -f video-analytics-api-vss-video-analytics-api-1
```

Healthy log lines include:

```
{"timestamp":"...","level":"info","message":"[SERVER] Listening on port: 8081"}
```

Verify the health endpoint:

```bash
curl -sf http://localhost:8081/livez && echo "OK" || echo "DOWN"
```

If Elasticsearch is not yet up, you'll see:

```
{"timestamp":"...","level":"error","message":"[ELASTICSEARCH RETRY] attempt=1"}
```

The process retries until ES is reachable, up to the configured `elasticsearch.retries` count. If retries are exhausted, the app exits and `restart: always` starts a fresh cycle. This is expected when you bring up the API before ES; otherwise start ES and the next restart cycle will connect.

## Teardown

```bash
docker compose -f services/analytics/video-analytics-api/compose.yml down
```

For a multi-service teardown (broker, ES, etc.), use the `vss-deploy-profile` teardown workflow.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `[APP ERROR] Server initialization failed` on startup | Elasticsearch unreachable. The server pings ES during bootstrap; if it fails, the server exits. | Check `elasticsearch.node` in your config matches the running ES instance. Verify with `curl -sf http://localhost:9200/_cluster/health`. |
| `[INPUT ERROR] Invalid path for bootstrap config file.` | The `--config` path doesn't exist inside the container. | Verify the volume mount target matches the `--config` flag path. Use an absolute path. |
| Compose tries to mount `/data_log/vss_video_analytics_api` from the filesystem root | `$VSS_DATA_DIR` is unset while the default data-log bind mount is still present. | Export `VSS_DATA_DIR` to a writable host path and create `$VSS_DATA_DIR/data_log/vss_video_analytics_api`, or remove the `/web-api-app/files` mount if image uploads are not needed. |
| `EADDRINUSE` | Port 8081 (or your configured port) is already in use. | Check with `ss -tlnp | grep :8081`. Stop the conflicting process or change `server.port` in the config. |
| Container alive but Kafka-dependent endpoints return errors | Kafka brokers configured but unreachable. | Verify brokers are reachable: `nc -zv <broker-host> <broker-port>`. Check `kafka.brokers` is a proper array of `"host:port"` strings. |
| `/livez` returns 200 but data endpoints return empty results | Elasticsearch indices don't exist or have no data. | Check indices: `curl -s http://localhost:9200/_cat/indices?v \| grep mdx`. If empty, the upstream pipeline (behavior-analytics, perception) hasn't produced data yet. |
| Config update via POST `/config` times out | The ACK from behavior-analytics didn't arrive within `configStatusTimeoutMs`. | Check that behavior-analytics is running and consuming from `mdx-notification`. Check the `configStatusTimeoutMs` value (default `30000`ms). |
| Image won't run `docker exec -it ... sh` | Runtime is a **Node** image (`nvcr.io/nvidia/distroless/node:22-v4.0.7`) — no shell, but the `node` binary is present. | Use `docker logs <container>` for runtime output. To print a bind-mounted file (e.g. bootstrap config), use `docker exec <container> node -e '...'` — see below. Prefer reading the host-side mount path when the file is volume-bound. |

**Inspect a mounted config inside the container** (same path as `command: node index.js --config …`):

```bash
docker exec video-analytics-api-vss-video-analytics-api-1 node -e \
  "const fs=require('fs'); const p='/opt/mdx/vss-video-analytics-api/configs/vss-video-analytics-api-config.json'; console.log(JSON.stringify(JSON.parse(fs.readFileSync(p,'utf8')), null, 2))"
```

With compose (standalone deploy):

```bash
docker compose -f services/analytics/video-analytics-api/compose.yml \
  exec vss-video-analytics-api node -e \
  "const fs=require('fs'); const p='/opt/mdx/vss-video-analytics-api/configs/vss-video-analytics-api-config.json'; console.log(JSON.stringify(JSON.parse(fs.readFileSync(p,'utf8')), null, 2))"
```

