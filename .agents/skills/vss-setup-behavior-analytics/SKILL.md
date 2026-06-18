---
name: vss-setup-behavior-analytics
description: Use to deploy the vss-behavior-analytics service standalone (entrypoint, config-source, optional calibration). Not for the full warehouse deploy.
license: Apache-2.0

metadata:
  author: "NVIDIA Video Search and Summarization team"
  version: "3.2.0"
  github-url: "https://github.com/NVIDIA-AI-Blueprints/video-search-and-summarization"
  tags: "nvidia blueprint operational deployment behavior-analytics"
---
## Purpose

Deploy the behavior-analytics service standalone with the user's chosen entrypoint, config, and calibration.

## Instructions

Follow the routing tables and step-by-step workflows below. Each section that ends in *workflow*, *quick start*, or *flow* is intended to be executed top-to-bottom. Detailed reference material lives in `references/`.

## Examples

Worked end-to-end examples are kept under `evals/` (each `*.json` manifest
contains a runnable scenario). Run a Tier-3 evaluation to replay them:

```bash
nv-base validate skills/vss-setup-behavior-analytics --agent-eval
```

A minimal standalone bring-up looks like:

```bash
cd $REPO/deploy/docker
export VSS_APPS_DIR=$(pwd)
docker compose -f services/analytics/behavior-analytics/compose.yml up -d vss-behavior-analytics-base
```

Follow `references/deploy-behavior-analytics-service.md` for the full
workflow (entrypoint pick, config source, dynamic updates).

## Limitations

- Requires the matching VSS profile / microservice to be deployed and reachable from the caller.
- NGC-hosted models and NIMs may be subject to rate-limits, GPU memory requirements, and license restrictions.
- Concurrency, GPU memory, and storage limits depend on the host hardware and the profile's compose file.

## Troubleshooting

- **Error**: REST call returns connection refused. **Cause**: target microservice not running. **Solution**: probe `/docs` or `/health`; redeploy via `vss-deploy-profile` or the matching `vss-deploy-*` skill.
- **Error**: HTTP 401/403 from NGC pulls. **Cause**: missing/expired `NGC_CLI_API_KEY`. **Solution**: `docker login nvcr.io` and re-export the key before retrying.
- **Error**: container OOM or model fails to load. **Cause**: insufficient GPU memory for the selected profile. **Solution**: switch to a smaller variant or free GPUs via `docker compose down`.

# VSS Setup Behavior Analytics — Standalone

Deploy **just** the `vss-behavior-analytics` container (the spatial-AI analytics pipeline from the upstream `behavior-analytics` repo), not as part of the full warehouse blueprint stack.

The full operational walkthrough — entrypoint table, config-source options, calibration types, dynamic-update wire contract, troubleshooting — is [`references/deploy-behavior-analytics-service.md`](references/deploy-behavior-analytics-service.md). This SKILL.md only handles routing and prerequisites.

## When to use

- "Deploy behavior analytics" / "run behavior-analytics standalone"
- "I just want to run analytics, not the full stack"
- "Change the entrypoint to fusion_search / dev_example / analytics 3D / mv3dt"
- "Use my own behavior-analytics config / calibration JSON"
- "Point behavior-analytics at the warehouse-3d (or mv3dt) config without spinning up the rest of the warehouse profile"
- "Dynamic config / dynamic calibration into a running behavior-analytics"

## Prerequisites

1. **Repo checkout** with `$VSS_APPS_DIR` pointing at `<repo>/deploy/docker/`. Required by the service compose's volume binds.
2. **NGC credentials** — `$NGC_CLI_API_KEY` set so docker can pull the image. See [`references/ngc-api-key-registry-login.md`](references/ngc-api-key-registry-login.md).
3. **Docker runtime** — Docker Engine **28.3.3** with Docker Compose plugin **v2.39.1+**. Verify with `docker --version` and `docker compose version`.
4. **Optional broker** (Kafka / Redis Streams / MQTT). The container starts fine **without** one — the Kafka client retries a bounded number of times, then the app exits and `restart: always` cycles the container. Status will show `Restarting (N)` in `docker ps` until a broker is reachable. With a broker, dynamic config / dynamic calibration over `mdx-notification` become available.
5. **Optional config / calibration files on disk** if the user is bringing their own.

If any required prerequisite fails, surface the gap before going further.

## Workflow

Hand the user [`references/deploy-behavior-analytics-service.md`](references/deploy-behavior-analytics-service.md) and walk them through its steps in order:

1. Pick an entrypoint (analytics 2D / 3D / mv3dt, dev_example, fusion_search).
2. Choose a config — profile-shipped or custom.
3. Choose a calibration — optional; profile-shipped or custom; otherwise the app waits for a dynamic-calibration notification.
4. Decide whether a broker is reachable; if yes, point them at the dynamic-update flows.

The compose-file edits, YAML diffs, deploy + verify commands, and troubleshooting table all live in that reference — don't duplicate them here.

## Dynamic updates (runtime, no restart)

Once the container is up **and a broker is reachable**, two runtime-update flows are available — neither requires redeploying:

### Dynamic config

Publish an `upsert` (per-key patch) or `upsert-all` (full snapshot) message to the `mdx-notification` topic with Kafka key `behavior-analytics-config` and headers:

- `event.type`: `upsert` | `upsert-all` | `request-config` | `ack`
- `reference-id`: `video-analytics-api-<uuid>` (web-api originated), `behavior-analytics-<uuid>` (bootstrap reply), or the source-type literal (`kafka` / `redis` / `mqtt`) for direct-publisher upserts.

Body: `{"status": ..., "config": <patch>, "error": ...}`.

The listener validates each message at the envelope layer (rejects unknown keys, missing config, malformed status/error) and at the per-payload layer (rejects forbidden sections, bad item shapes). Successful upserts are persisted to disk, applied to every worker, and ACK'd back over the topic.

Full wire contract + ack semantics: [`references/dynamic-config.md`](references/dynamic-config.md).

### Dynamic calibration

Publish to the same topic with Kafka key `calibration` and headers:

- `event.type`: `upsert-all` (full snapshot) | `upsert` (per-sensor merge) | `delete` (per-sensor removal)
- `timestamp`: ISO-8601 UTC (`YYYY-MM-DDTHH:MM:SS.fffZ`).

Body: JSON sensor list (and ROIs / tripwires / homographies for `upsert-all`).

The listener validates against the vendored AJV schema before persisting. Schema violations log a `calibration schema violation` warning and are dropped — the previously-good calibration stays loaded.

Full wire contract + per-action validation policy: [`references/dynamic-calibration.md`](references/dynamic-calibration.md).

Both flows live entirely on the broker — the producer can be `video-analytics-api`, your own script, or any Kafka client that mirrors the wire shape. They're the recommended way to change configuration after the container is running, so the operator doesn't have to redeploy.

## Routing rules

- If the user wants "the full stack" (UI / agent / perception): hand off to [`vss-deploy-profile`](../vss-deploy-profile/SKILL.md) with profile `warehouse` (or `alerts`). Don't run this skill in parallel.
- If the user wants to publish a runtime config / calibration update to an already-running container: walk the [Dynamic updates](#dynamic-updates-runtime-no-restart) section. Both flows need a reachable broker.
- If the user describes a behavior-analytics behavior change they want to validate (new incident type, new ROI rule, new sensor): point them at [`references/configuration.md`](references/configuration.md), [`references/dynamic-config.md`](references/dynamic-config.md), or [`references/dynamic-calibration.md`](references/dynamic-calibration.md) before editing the JSON.

bump:1
