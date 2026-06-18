# Deploy Behavior Analytics — Standalone Service

Deploy **just** `vss-behavior-analytics` (no agent, no perception, no UI) — useful when you want to:

- Run a behavior-analytics pipeline against an existing broker (or no broker at all).
- Pick a different entrypoint (analytics 2D / 3D, dev_example, fusion_search) without modifying the image.

Required host runtime: **Docker Engine 28.3.3** with **Docker Compose plugin v2.39.1+**.

---

## What you edit

You only edit the existing service compose:

```
<repo>/deploy/docker/services/analytics/behavior-analytics/compose.yml
```

1. **`command:`** — which app entrypoint to run.
2. **`volumes:`** — what config (required) and what calibration (optional) to mount.
3. The `--config` and optional `--calibration` flags inside the same `command:` line.

Walk steps 1-4 below to decide each one; the bring-it-up command lives in [Deploy + verify](#deploy--verify) at the end.

---

## Step 1 — Pick an entrypoint

Set the first half of `command:` to one of the following:

| Entrypoint | Class | What it does |
|---|---|---|
| `apps/analytics/main_analytics_2d_app.py` | `Analytics2DApp` | 2D spatial pipeline — operates on **(X, Y) world-plane coordinates** lifted from the image plane via per-sensor homography. Two parallel processors: **behavior creation** (object tracking → behavior + ROI / tripwire / proximity events, plus map-matching) and **frame enhancement** (calibration transform → per-frame state → FOV-count / restricted-area / confined-area incidents). **The default.** |
| `apps/analytics/main_analytics_3d_app.py` | `Analytics3DApp` | Operates on **full (X, Y, Z) 3D world coordinates** — fed from upstream multi-view 3D tracking (mv3dt) that produces 3D bounding boxes. Same two processors as 2D (with the 3D calibration class), plus a third **space-analyzer** processor that estimates space utilization per region on a periodic interval. Use this for 3D warehouse / multi-view 3D tracking (mv3dt). |
| `apps/dev_example/main_dev_example_app.py` | `DevExampleApp` | Smaller app that focuses on **FOV-count violation** and **restricted-area violation** detection. No behavior creation, no map-matching. Good starting point for new incident types — also the entrypoint used by `dev-profile-alerts`. |
| `apps/fusion_search/main_fusion_search_analytics_app.py` | `FusionSearchAnalyticsApp` | Two-path app: (a) behavior creation from raw frames, like 2D but without the FOV-count / ROI / tripwire events; (b) **video-embedding downsampling** — reads chunked video embeddings, optionally downsamples them (SDT / fixed-window), writes filtered embeddings. Use this with the VSS search profile. |

**mv3dt** uses `main_analytics_3d_app.py` (the multi-view 3D tracker is a perception-side variant — the analytics pipeline is the same as 3D). There is no separate `main_mv3dt_app.py`.

---

## Step 2 — Choose a config (required)

Every entrypoint requires `--config <path>`. The container has two viable sources:

### Option A — Use a profile's existing config

If you want the behavior/topic/sensor wiring a specific blueprint uses (already tuned to its dataset), point the volume mount at one of the profile-shipped configs and reference the mounted path on the `--config` flag.

Recommended pairings (entrypoint → existing config):

| Entrypoint | Recommended existing config |
|---|---|
| `main_analytics_2d_app.py` | `industry-profiles/warehouse-operations/warehouse-2d-app/vss-behavior-analytics/configs/vss-behavior-analytics-config.json` |
| `main_analytics_3d_app.py` | `industry-profiles/warehouse-operations/warehouse-3d-app/vss-behavior-analytics/configs/vss-behavior-analytics-config.json` |
| `main_analytics_3d_app.py` (mv3dt) | `industry-profiles/warehouse-operations/warehouse-mv3dt-app/vss-behavior-analytics/configs/vss-behavior-analytics-config.json` |
| `main_dev_example_app.py` | `developer-profiles/dev-profile-alerts/vss-behavior-analytics/configs/vss-behavior-analytics-config.json` |
| `main_fusion_search_analytics_app.py` | the search profile's own config (lives outside `behavior-analytics/`) |

Compose change:

```yaml
services:
  vss-behavior-analytics-base:
    volumes:
      - $VSS_APPS_DIR/industry-profiles/warehouse-operations/warehouse-3d-app/vss-behavior-analytics/configs/vss-behavior-analytics-config.json:/resources/vss-behavior-analytics-config.json
    command: python3 apps/analytics/main_analytics_3d_app.py --config /resources/vss-behavior-analytics-config.json
```

### Option B — Use your own custom config

Drop in any absolute host path; copy one of the above as a starting point and edit. Compose change is identical to Option A but with `/abs/path/to/my-config.json` as the bind source.

```yaml
volumes:
  - /abs/path/to/my-config.json:/resources/vss-behavior-analytics-config.json
command: python3 apps/analytics/main_analytics_2d_app.py --config /resources/vss-behavior-analytics-config.json
```

### Config — what's in it

Top-level shape (every config has all of these):

| Section | What it controls |
|---|---|
| `kafka` / `redisStream` / `mqtt` | Broker host, topics, consumer/producer tuning. `sourceType` / `sinkType` in the `app[]` section pick which one is actually used. |
| `app[]` | List of `{name, value}` strings. Knobs like `behaviorWatermarkSec`, `numWorkersForBehaviorCreation`, `stateManagementFilter`, `clusterThreshold`, `trajDirectionMode`, plus per-incident-type toggles (`fovCountViolationIncidentEnable`, `restrictedAreaViolationIncidentEnable`, etc.). |
| `sensors[]` | Per-sensor entries with `{id, configs: [{name, value}]}` — per-sensor overrides for things like `tripwireMinPoints`, `proximityDetectionEnable`, `anomalySpeedViolation`. |

Higher-level docs:

- `configuration.md` — config field guide.

---

## Step 3 — Choose a calibration (optional)

Calibration tells the app the sensor map, ROIs, tripwires, geo-locations, homographies, etc. It's **optional** at startup.

### Calibration types

The type is encoded in the calibration JSON itself, on the top-level `calibrationType` field. There are three values:

| `calibrationType` | Class | What it does |
|---|---|---|
| `"cartesian"` | `CalibrationE` | **Typical for warehouse / smart-city.** Maps image-plane coordinates (pixels) to real-world Cartesian metres via the per-sensor homography (`imageCoordinates[]` ↔ `globalCoordinates[]`). All downstream behavior creation, ROI / tripwire / proximity / space-analytics math is in metres. **Recommended starting point.** |
| `"geo"` | `Calibration` | Maps image coordinates to geographic lat/lng. Use when sensors are placed against a real map (OSM, GIS) and you want behaviors / events anchored to GPS. |
| `"image"` | `CalibrationI` | No real-world mapping — keeps coordinates in raw pixel space. The downstream pipeline still runs, but distance / speed / area numbers are in pixels, not metres, and most metric-based incident thresholds become meaningless. |

### What happens if you skip calibration

Don't add a `--calibration` flag and don't mount one. The app starts with a `DynamicCalibration` wrapper that initially behaves as `CalibrationI` (image-plane). It then:

1. **Watches `mdx-notification`** for the first `calibrationType` notification. When one arrives, the wrapper switches itself to the typed subclass (`CalibrationE` / `Calibration` / `CalibrationI`) inferred from the payload's `calibrationType`. After the switch, all subsequent updates go through the typed instance via the same Kafka flow.
2. **Until that first notification arrives**, frames are processed with image-plane coordinates — effectively a no-op for analytics (no real-world distances, no ROI/tripwire firings against a map). If you don't intend to wire a producer for dynamic calibration, supply a static calibration file instead.

### Pick a calibration source

- **Use one of the profile-shipped calibrations.** Same pattern as config Option A:

  | Entrypoint | Recommended existing calibration |
  |---|---|
  | `main_analytics_2d_app.py` | `industry-profiles/warehouse-operations/warehouse-2d-app/calibration/sample-data/<dataset>/calibration.json` |
  | `main_analytics_3d_app.py` | `industry-profiles/warehouse-operations/warehouse-3d-app/calibration/sample-data/<dataset>/calibration.json` |
  | `main_analytics_3d_app.py` (mv3dt) | `industry-profiles/warehouse-operations/warehouse-mv3dt-app/calibration/sample-data/<dataset>/calibration.json` |
  | `main_dev_example_app.py` | the dev profile may not need one. |
- **Bring your own.** Any absolute host path that conforms to the calibration JSON schema. If you're hand-rolling one, start from the `"cartesian"` type — that's the path the rest of the pipeline is tuned for.

  Compose change:

  ```yaml
  volumes:
    - $VSS_APPS_DIR/services/analytics/behavior-analytics/configs/vss-behavior-analytics-config.json:/resources/vss-behavior-analytics-config.json
    - /abs/path/to/calibration.json:/resources/calibration.json   # or a profile sample-data path
  command: >
    python3 apps/analytics/main_analytics_2d_app.py
    --config /resources/vss-behavior-analytics-config.json
    --calibration /resources/calibration.json
  ```

The schema for the calibration JSON is vendored from `video-analytics-api/src/web-api-core/schemas/ajv/calibration.json` and lives at `behavior-analytics/src/mdx/analytics/core/transform/calibration/schemas/calibration.schema.json`.

---

## Step 4 — Broker (not required to launch)

`vss-behavior-analytics` does **not** require a broker to be present at start time:

- The container starts fine without Kafka/Redis/MQTT reachable.
- The Kafka client retries the broker connection a bounded number of times (with backoff). You'll see repeated `Connect to ipv4#…:9092 failed: Connection refused` warnings in `docker logs behavior-analytics-vss-behavior-analytics-base-1` while it tries. (The auto-generated container name comes from Compose's default `<project>-<service>-<index>` pattern; project name defaults to the compose file's parent directory, `behavior-analytics`.)
- Once retries are exhausted, the app process exits and the container's `restart: always` policy brings it back up. The new container starts a fresh retry cycle. This restart loop continues — visible in `docker ps` as the `Status` column counting `Restarting (N)` — until the broker becomes reachable, at which point the consumer thread connects on the next attempt and drains messages normally.

Practical implication: a broker-less analytics container is **not** sitting idle in-process — it's cycling. Fine for "bring up analytics first, broker later" workflows, but expect periodic restarts in the meantime. If you want it to fail-fast instead (e.g. in CI), override `restart:` to `on-failure` or `no`, or wrap with your own healthcheck.

> When a broker **is** reachable, you also get two runtime-update flows — dynamic config and dynamic calibration — that don't require redeploying the container. Those are post-deployment operations and live in the `SKILL.md`'s **Dynamic updates** section, plus `dynamic-config.md` and `dynamic-calibration.md` for full wire contracts.

---

## Deploy + verify

```bash
cd <repo>/deploy/docker
docker --version        # need 28.3.3
docker compose version  # need v2.39.1+

export VSS_APPS_DIR=$(pwd)

# (one-time) edit services/analytics/behavior-analytics/compose.yml — entrypoint, config volume, optional calibration volume.

docker compose -f services/analytics/behavior-analytics/compose.yml up -d vss-behavior-analytics-base

docker ps --filter "name=vss-behavior-analytics" --format '{{.Names}}\t{{.Status}}'
# Compose auto-names the container <project>-<service>-<index>; project defaults to
# the compose file's parent dir, so the full name is:
docker logs -f behavior-analytics-vss-behavior-analytics-base-1
```

Healthy log lines include:

```
[Analytics2DApp] starting with N worker processes
[CalibrationListener] subscribed to mdx-notification (key=calibration)
[ConfigListener] request-config published (bootstrap_ref=behavior-analytics-<uuid>)
```

If you skipped calibration, you'll also see:

```
DynamicCalibration: no --calibration provided; waiting for first calibration notification...
```

## Teardown

```bash
docker compose -f services/analytics/behavior-analytics/compose.yml down
```

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `FileNotFoundError: '/resources/...'` on startup | `--config` flag and the volume bind target don't match. | Make the `--config` path equal the container side of the volume bind (the part after the `:`). |
| `docker ps` shows the container in a `Restarting (N)` loop, logs print `Connect to … failed: Connection refused` then exit | No broker listening on the host. Retries are exhausted, app exits, `restart: always` brings it back, repeat. | Expected if you're intentionally running broker-less; otherwise start your broker — the next restart cycle will connect. To stop the restart loop, override `restart:` to `on-failure` or `no`. |
| `calibration schema violation` after a notification arrives | Producer sent a payload that fails the JSON Schema gate. | Previously-good calibration stays loaded; check the producer's payload against the schema in `src/mdx/analytics/core/transform/calibration/schemas/calibration.schema.json`. |
| `dropping config message: unrecognized reference-id …` | Inbound dynamic-config `upsert` / `upsert-all` carries a reference-id outside the accepted set. | Reference-id must start with `video-analytics-api-` (web-api), `behavior-analytics-` (bootstrap echo), or equal the active source-type literal (`kafka` / `redis` / `mqtt`). |
| `dropping config message: no config to update` | Inbound `upsert` had `config: null` or omitted the field. | An `upsert` with no config is a producer bug; `upsert-all` with `config=null` is allowed (it's the bootstrap-failure signal). |
| Workers fall behind / `Avg processing speed` very low | Worker count too low for the input rate. | Increase `numWorkersForBehaviorCreation` (and `numWorkersForFrameEnhancement` / `numWorkersForSpaceEstimation` for 3D) in the config's `app[]` section. |
