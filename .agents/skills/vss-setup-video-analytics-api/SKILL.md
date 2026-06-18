---
name: vss-setup-video-analytics-api
description: Use to deploy the vss-video-analytics-api REST service standalone (config-source, data-log bind, Elasticsearch, optional Kafka). Not for full warehouse deploy.
license: Apache-2.0
metadata:
  author: "NVIDIA Video Search and Summarization team"
  version: "3.2.0"
  github-url: "https://github.com/NVIDIA-AI-Blueprints/video-search-and-summarization"
  tags: "nvidia blueprint operational deployment video-analytics-api rest-api"
---
## Purpose

Deploy the video-analytics-api REST service standalone with the user's chosen config, data-log bind, and Elasticsearch / Kafka connectivity.

## Instructions

Follow the routing tables and step-by-step workflows below. Each section that ends in *workflow*, *quick start*, or *flow* is intended to be executed top-to-bottom. Detailed reference material lives in `references/`.

## Examples

Worked end-to-end examples are kept under `evals/` (each `*.json` manifest
contains a runnable scenario). Run a Tier-3 evaluation to replay them:

```bash
nv-base validate skills/vss-setup-video-analytics-api --agent-eval
```

A minimal standalone bring-up looks like:

```bash
cd $REPO/deploy/docker
export VSS_APPS_DIR=$(pwd)
export VSS_DATA_DIR=${VSS_DATA_DIR:-/tmp/vss-data}
mkdir -p "$VSS_DATA_DIR/data_log/vss_video_analytics_api"
docker compose -f services/analytics/video-analytics-api/compose.yml up -d vss-video-analytics-api
curl -sf http://localhost:8081/livez
```

Follow [`references/deploy-video-analytics-api-service.md`](references/deploy-video-analytics-api-service.md) for the full
workflow (config source, data-log bind, infrastructure dependencies, REST endpoints).
For the field-by-field JSON config reference, see [`references/configuration.md`](references/configuration.md).

## Limitations

- Requires the matching VSS profile / microservice to be deployed and reachable from the caller.
- NGC-hosted models and NIMs may be subject to rate-limits, GPU memory requirements, and license restrictions.
- Concurrency, GPU memory, and storage limits depend on the host hardware and the profile's compose file.

## Troubleshooting

- **Error**: REST call returns connection refused. **Cause**: target microservice not running. **Solution**: probe `/docs` or `/health`; redeploy via `vss-deploy-profile` or the matching `vss-deploy-*` skill.
- **Error**: HTTP 401/403 from NGC pulls. **Cause**: missing/expired `NGC_CLI_API_KEY`. **Solution**: `docker login nvcr.io` and re-export the key before retrying.
- **Error**: container OOM or model fails to load. **Cause**: insufficient GPU memory for the selected profile. **Solution**: switch to a smaller variant or free GPUs via `docker compose down`.

# VSS Setup Video Analytics API — Standalone

Deploy **just** the `vss-video-analytics-api` container (the Node.js REST API from the upstream `video-analytics-api` repo), not as part of the full warehouse blueprint stack.

The full operational walkthrough — config-source options, data-log volume behavior, infrastructure dependencies, REST API endpoints, deploy + verify, troubleshooting — lives in [`references/deploy-video-analytics-api-service.md`](references/deploy-video-analytics-api-service.md). The field-by-field JSON config reference lives in [`references/configuration.md`](references/configuration.md). This SKILL.md only handles routing and prerequisites.

## When to use

- "Deploy video analytics api" / "run video-analytics-api standalone"
- "I just want to run the REST API, not the full stack"
- "Use my own video-analytics-api config"
- "Point the API at a different Elasticsearch / Kafka"
- "Start the API without Kafka" / "run the API broker-less"
- "Check what REST endpoints are available"

## Prerequisites

1. **Repo checkout** with `$VSS_APPS_DIR` pointing at `<repo>/deploy/docker/`. Required by the service compose's volume binds.
2. **NGC credentials** — `$NGC_CLI_API_KEY` set so docker can pull the image. See [`references/ngc-api-key-registry-login.md`](references/ngc-api-key-registry-login.md).

   > **Secure-handling note for `NGC_CLI_API_KEY`**: this key is a
   > long-lived credential that pulls all NVIDIA private images
   > available to your NGC org. Never commit the key, never paste it
   > into chat, never store it in `/tmp`. Read it interactively
   > (`read -rs NGC_CLI_API_KEY`) or load it from your secret manager
   > (Vault, AWS Secrets Manager, sealed-secrets) at deploy time.
   > Write any derived `.env` files with `umask 077` + `chmod 600`,
   > add them to `.gitignore`, and rotate the key on a defined
   > cadence and after every host decommission. If it has ever been
   > exposed (host snapshot, shared screen, ticket attachment),
   > rotate immediately.
3. **Docker runtime** — Docker Engine **28.3.3** with Docker Compose plugin **v2.39.1+**. Verify with `docker --version` and `docker compose version`.
4. **Elasticsearch** — must be reachable at the URL configured in `elasticsearch.node`. The server pings ES on startup; if unreachable, it exits (and `restart: always` brings it back). If you need to bring up ES too, use the infra compose: `docker compose -f services/infra/compose.yml up -d elasticsearch`.
5. **Optional Kafka broker**. The API can run without Kafka. If you want a quiet broker-less deployment, use the image-baked config or a custom config with `kafka.brokers: []`; the service-shipped compose config points at `localhost:9092`, so Kafka-dependent features (dynamic config, dynamic calibration, RTLS/AMR) will fail until a broker is reachable.
6. **`$VSS_DATA_DIR` for the default compose.** The base compose bind-mounts `$VSS_DATA_DIR/data_log/vss_video_analytics_api` for multipart upload handling and file-backed assets such as calibration images. Set the directory to a writable host path and pre-create it, or remove that mount if image uploads are not needed.

If any required prerequisite fails, surface the gap before going further.

## Workflow

Hand the user [`references/deploy-video-analytics-api-service.md`](references/deploy-video-analytics-api-service.md) and walk them through its steps in order:

1. Choose a config — image-baked default, service-shipped, or custom.
2. Decide whether a data-log volume is needed for file uploads.
3. Confirm infrastructure dependencies — Elasticsearch (required), Kafka (optional).
4. Deploy + verify with `docker compose up` and health check.

The compose-file edits, config options, deploy + verify commands, REST API endpoint table, and troubleshooting table all live in that reference — don't duplicate them here.

## Endpoint Reference

Use [`references/deploy-video-analytics-api-service.md`](references/deploy-video-analytics-api-service.md) for the REST endpoint table and runtime dependency notes.

## Kafka-dependent features (runtime, requires broker)

Once the container is up **and a Kafka broker is reachable**, three additional capabilities are available:

### Dynamic config

The API acts as the **producer** for dynamic config updates. When an operator POSTs to `/config`, the API publishes an `upsert` message to the `mdx-notification` topic with Kafka key `behavior-analytics-config`. The downstream `behavior-analytics` container consumes this and ACKs back. The API also handles the bootstrap flow — when `behavior-analytics` starts, it publishes a `request-config` message, and the API replies with `upsert-all` containing the latest verified config from Elasticsearch.

Consumer-side validation, ACK semantics, and the full wire contract are documented in the `vss-setup-behavior-analytics` dynamic-config reference.

### Dynamic calibration

The API produces calibration update notifications on `mdx-notification` with Kafka key `calibration`. Supports `upsert-all` (full snapshot), `upsert` (per-sensor merge), and `delete` (per-sensor removal). The downstream `behavior-analytics` container consumes these and applies them to the live calibration.

Consumer-side validation and per-action policy are documented in the `vss-setup-behavior-analytics` dynamic-calibration reference.

### RTLS / AMR

The API consumes real-time location (`mdx-rtls`) and AMR (`mdx-amr`) messages from Kafka and exposes them via REST endpoints.

## Routing rules

- If the user wants "the full stack" (UI / agent / perception): hand off to `vss-deploy-profile` with profile `warehouse` (or `alerts`). Don't run this skill in parallel.
- If the user wants to deploy the analytics pipeline (behavior creation, incident detection): hand off to `vss-setup-behavior-analytics`.
- If the user wants to publish a runtime config / calibration update through the REST API: confirm Kafka is reachable, then use the `/config` or calibration endpoints and point them at the behavior-analytics dynamic-update references for the consumer wire contract.
- If the user wants to understand the dynamic config / dynamic calibration wire contract from the **consumer** (behavior-analytics) side: point them at the `vss-setup-behavior-analytics` dynamic-config and dynamic-calibration references.
- If the user wants to query or interact with the REST API endpoints: the deploy reference endpoint table covers what's available. For the full OpenAPI spec, see `src/app/specification/openapi.json` in the `video-analytics-api` repo.


bump:1
