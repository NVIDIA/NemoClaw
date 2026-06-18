# Start the Application (Step 5 detail)

Step 5 is where the skill initializes the deployment log, starts the perception app with output redirected to that log, reports the log path to the user, waits for the REST server, caches the DS-auto-built engine, and (for warehouse-3d) handles calibration-aware stream-add ids.

## THE RULE: Step 5 is ONE Bash call

Scripts refresh + X11 pre-flight + log init + app launch have **no user decisions between them**. They must be a single Bash tool call — not four separate calls. Four calls = four permission prompts for what is logically one action.

```bash
SKILL_DIR="$HOME/.claude/skills/rtvicv-deploy"
CONTAINER="<CONTAINER_NAME>"

# ── Refresh scripts (always overwrite — stale scripts cause silent failures)
# rm first: "docker cp src /tmp/scripts" when /tmp/scripts already exists nests the
# source INSIDE the destination (/tmp/scripts/scripts/), leaving old scripts in place.
# Removing first and copying to /tmp/ ensures /tmp/scripts/ is always a clean copy.
docker exec "$CONTAINER" rm -rf /tmp/scripts && \
docker cp "$SKILL_DIR/scripts" "$CONTAINER:/tmp/" && \
docker exec "$CONTAINER" chmod -R +x /tmp/scripts/

# ── X11 pre-flight (eglsink only — omit this block for fakesink/filedump)
HOST_DISPLAY="${DISPLAY:-:0}"
[[ "$HOST_DISPLAY" != :* ]] && HOST_DISPLAY=":$HOST_DISPLAY"
docker exec "$CONTAINER" sh -c "ls /tmp/.X11-unix/X${HOST_DISPLAY#:} >/dev/null 2>&1" || \
    { echo "✖ X11 socket missing — restart container with -v /tmp/.X11-unix:/tmp/.X11-unix"; exit 1; }
xhost +local:root >/dev/null 2>&1 || true

# ── Write deployment log (LOG captured inline — no extra exec)
LOG=$(docker exec "$CONTAINER" /tmp/scripts/write_deployment_log.sh \
    --usecase "<usecase>" --batch "<N>" --sink "<sink>" \
    --platform "<platform>" --stream-mode "<stream_mode>" --input-type "filesrc" \
    --videos "<container-videos-dir>" --image "<RTVI_CV_IMAGE>" \
    --ngc "<ngc-ref-or-local>" --docker-cmd "" --app-cmd "")
echo "Deployment log: ~/rtvicv-storage/logs/$(basename "$LOG")"

# ── Launch + poll ready + cache engine + add streams + metrics (ONE exec)
docker exec \
    -e DISPLAY="$HOST_DISPLAY" \
    -e XAUTHORITY=/root/.Xauthority \
    "$CONTAINER" \
    /tmp/scripts/run_app_and_wait.sh \
        --usecase  "<usecase>" \
        --batch    "<N>" \
        --sink     "<sink>" \
        --log      "$LOG" \
        --videos   "<container-videos-dir>" \
        --onnx     "<container-onnx-path>" \
        --stream-mode "<dynamic|static>" \
        --delay    "<STREAM_ADD_DELAY>"
```

> **`--onnx`**: warehouse-2d / smartcity-rtdetr only. Omit for warehouse-3d and smartcity-gdino (their setup scripts handle engine caching directly).
>
> **`-e DISPLAY` / `-e XAUTHORITY`**: always pass via `docker exec -e` for eglsink/filedump. A reused container's baked `DISPLAY` env is often malformed (e.g. `1` instead of `:1`). The `-e` flag overrides it cleanly without a container restart. Omit entirely for fakesink.
>
> **`$LOG` inline**: `write_deployment_log.sh` prints the log path to stdout; capturing it with `$()` and immediately passing it to `run_app_and_wait.sh` keeps everything in one bash call.

## Step 5.0 — Refresh scripts in container (ALWAYS — before 5.a)

Covered by the combined call above. For reference: a reused container retains scripts from its previous session. If the skill was updated (new `--videos` flag, USECASE_DIR mapping, etc.), the old scripts will be used silently — causing failures that are hard to diagnose. Overwriting unconditionally costs <1s.

## Step 5.a — Initialize the deployment log FIRST (required)

**MUST call `scripts/write_deployment_log.sh`.** Do NOT inline your own header. The script produces a consistent, structured log with:

1. Header → Settings → Docker Cmd → App Cmd
2. **Dumps of every config file this use case uses** (PGIE, ds-main, calibration, Triton pbtxt, ...)
3. **Tracker config — discovered dynamically.** When the use case's main config has `[tracker] enable=1`, the script reads the `ll-config-file=<path>` value from `[tracker]` and dumps that exact file into the log too — labelled `Tracker Config File (resolved from [tracker] ll-config-file= in main config)`. Works for warehouse-2d, smartcity-rtdetr, smartcity-gdino (warehouse-3d uses Sparse4D, no NvDCF tracker by default). No need to maintain a static tracker-config path per use case — whatever `ll-config-file=` points at is what gets dumped.
4. A "Runtime Log" header — the app's stdout/stderr is appended below it next

Writing an inline header skips the full config dumps and produces an unusable log.

**Do NOT add ad-hoc fields.** Only the script's supported args should appear in the log:

| Allowed arg     | Field in log              |
|-----------------|---------------------------|
| `--usecase`     | Use case                  |
| `--batch`       | Batch size                |
| `--sink`        | Output sink               |
| `--image`       | Docker image              |
| `--ngc`         | NGC resource              |
| `--platform`    | Platform                  |
| `--stream-mode` | Stream mode               |
| `--input-type`  | Input type                |
| `--videos`      | Videos dir                |
| `--docker-cmd`  | Docker Run Command        |
| `--app-cmd`     | App Launch Command        |

If you think a new field is needed, add it to the script — don't shortcut it into an inline header.

```bash
MAIN_CFG=reference-configs/<usecase-path>/<main-config>

# Add --tiledtext for display and file-dump sinks so source names get drawn
# on each tile of the tiled display. Skip for fakesink (no visible output).
APP_FLAGS=""
case "<output_sink>" in
    eglsink|filedump) APP_FLAGS="--tiledtext" ;;
esac
APP_CMD="./metropolis_perception_app -c $MAIN_CFG $APP_FLAGS"

LOG=$(docker exec <CONTAINER_NAME> /tmp/scripts/write_deployment_log.sh \
    --usecase "<usecase>" --batch "<N>" --sink "<output_sink>" \
    --platform "<platform>" --stream-mode "<stream_mode>" --input-type "<input_type>" \
    --videos "<resolved-videos-dir>" --image "$RTVI_CV_IMAGE" \
    --ngc "<NGC_RESOURCE_REF>" --docker-cmd "$DOCKER_RUN_CMD" --app-cmd "$APP_CMD")
```

### App command flags by sink mode

| Sink     | Flags                                                | Why |
|----------|------------------------------------------------------|---|
| fakesink | `-c <config>`                                        | Benchmark mode — no rendering, no overlay needed |
| eglsink  | `-c <config> --tiledtext`                            | Displays source names on each tile of the tiled display |
| filedump | `-c <config> --tiledtext`                            | Same overlay so the dumped file is self-describing |

> `--tiledtext` is a metropolis_perception_app CLI flag that enables source-name overlay on the tiled display. For a rendering or file-write pipeline it makes the output far more readable; for fakesink it's wasted work.

`$LOG` ends up at `/opt/storage/logs/<usecase-and-model>_<timestamp>.txt` and already contains the full settings + every config file content.

> **Never bind-mount `reference-configs/` in a real deployment.** That's a development / skill-authoring pattern only. Production deploys use the configs baked into the container image.

## Step 5.b — Launch with output redirected to the log

### 5.b.1 — Display env pre-flight (eglsink only) — REQUIRED

**If `output_sink=eglsink`, ALWAYS run this pre-flight BEFORE launching the app, even for a freshly-launched container.** The app fails with an opaque `Failed to set pipeline to PAUSED` error if `DISPLAY` inside the container is unset, malformed (e.g. literal `1` instead of `:1`), or `XAUTHORITY` points at a nonexistent file. The failure surfaces ~0.2s after launch with no actionable context in the log.

```bash
# Resolve what DISPLAY *should* be (host value, fallback to :0)
HOST_DISPLAY="${DISPLAY:-:0}"
[[ "$HOST_DISPLAY" != :* ]] && HOST_DISPLAY=":$HOST_DISPLAY"   # normalize "1" -> ":1"

# Validate X11 socket is mounted
docker exec <CONTAINER_NAME> sh -c "ls /tmp/.X11-unix/X${HOST_DISPLAY#:} >/dev/null 2>&1" \
    || { echo "X11 socket missing in container for DISPLAY=$HOST_DISPLAY — container must be restarted with -v /tmp/.X11-unix:/tmp/.X11-unix"; exit 1; }

# Open access on the host (idempotent)
xhost +local:root >/dev/null 2>&1 || true

# Quick sanity probe INSIDE the container (catches DISPLAY/XAUTHORITY mismatches here, not at pipeline build)
docker exec -e DISPLAY="$HOST_DISPLAY" <CONTAINER_NAME> sh -c '
    command -v xdpyinfo >/dev/null 2>&1 || { echo "(xdpyinfo not installed — skipping probe)"; exit 0; }
    xdpyinfo >/dev/null 2>&1 && echo "DISPLAY_OK $DISPLAY" || { echo "DISPLAY_FAIL $DISPLAY"; exit 2; }
'
```

If `DISPLAY_FAIL`: the container's X11 is broken. Choose one: (a) run `xhost +local:root` on the host and retry; (b) `restart` the container with correct `-e DISPLAY=$HOST_DISPLAY -v /tmp/.X11-unix:/tmp/.X11-unix`.

### 5.b.2 — Launch the app + poll + stream add + metrics (ONE exec call)

**Use `run_app_and_wait.sh`** — a single `docker exec` that covers app launch, REST polling with engine-status heartbeats, engine caching, dynamic stream add, and metrics collection. This means **one permission prompt** after the display pre-flight, not five.

```bash
DISPLAY_ARGS=""
case "<output_sink>" in
    eglsink|filedump)
        DISPLAY_ARGS="-e DISPLAY=$HOST_DISPLAY -e XAUTHORITY=/root/.Xauthority"
        ;;
esac

# --videos: pass the already-resolved container-side videos dir so add_streams.sh
# skips re-discovery. Without it, discover_streams.sh scans ALL of $RESOURCES and
# hits RESOLVE_AMBIGUOUS when multiple video dirs coexist (e.g. warehouse NGC data
# + local smartcity videos). Always pass this when Step 1.g resolved VIDEOS.
#
# --onnx: warehouse-2d / smartcity-rtdetr only (for engine caching post-launch).
#         warehouse-3d / smartcity-gdino: omit (setup scripts handle cache).
docker exec $DISPLAY_ARGS <CONTAINER_NAME> /tmp/scripts/run_app_and_wait.sh \
    --usecase  "<usecase>" \
    --batch    "<N>" \
    --sink     "<output_sink>" \
    --log      "$LOG" \
    --videos   "<container-videos-dir>" \
    --onnx     "<ONNX_CONTAINER_PATH>" \
    --stream-mode "<dynamic|static>" \
    --delay    "$STREAM_ADD_DELAY"
```

The script runs all five phases sequentially inside the container and streams output back in real time:

| Phase | What it does |
|---|---|
| 1 — Launch | Starts `metropolis_perception_app` in background (with `LD_PRELOAD` for warehouse-3d) |
| 2 — Poll | Polls `/api/v1/ready` every 30s; greps log for `deserialize`/`serialize`/`kFP16` and prints engine status; heartbeat says "building" or "loading from cache" so user knows what to expect |
| 3 — Cache engine | Runs `cache_nvinfer_engine.sh` after ready (warehouse-2d / smartcity-rtdetr only) |
| 4 — Add streams | Runs `add_streams.sh` (dynamic mode only); first stream at t=0, `--delay` between subsequent adds |
| 5 — Metrics | Runs `collect_metrics.sh` after streams ACTIVE (10s warmup, 3 samples) |

**Output markers to parse** (all printed to stdout, streamed back to the agent):
- `ENGINE_STATUS: cached | built | retrying` — confirmed from log
- `READY_OK elapsed=<N>` — REST ready
- `ENGINE_CACHE: LINKED ...` — engine cached
- `STREAM_ADD_OK <N> stream(s) added`
- `METRICS_OK samples=3 interval=5`
- `LAUNCH_COMPLETE usecase=<uc> batch=<N> sink=<sink>` — all phases done

### Recovery — `Failed to set pipeline to PAUSED` (eglsink)

Root cause 90% of the time: `DISPLAY` inside the container is unset or malformed. Fix without restarting the container:

1. `docker exec <NAME> sh -c 'echo "DISPLAY=$DISPLAY"; ls /tmp/.X11-unix'`
2. Re-run `run_app_and_wait.sh` with explicit `-e DISPLAY=:N` in the `docker exec` call.
3. If `/tmp/.X11-unix/X<N>` missing → X11 socket never mounted → restart container with `-v /tmp/.X11-unix:/tmp/.X11-unix`.

## Step 5.c — Step 5 plan and result boxes

The agent renders **TWO boxes around the `run_app_and_wait.sh` call**:

1. **PLAN box (BEFORE the bash call)** — title `Start application —
   plan`. Shows the command that WILL run, the log path that WILL be
   written, the REST URLs that WILL be polled, the stream-add endpoint
   + planned inter-add delay (or `static — no REST call`), and the
   metrics endpoint + sample plan. Uses `→` glyph (action upcoming).
   The user previews the plan and can interrupt if anything looks wrong.

2. **(bash call)** — `docker exec ... run_app_and_wait.sh ...`.

3. **RESULT box (AFTER the bash call)** — title `Start application —
   result`. Same four sections (Launch, Readiness, Stream addition,
   Metrics) but rows now carry the measured values: pid, ready time
   in seconds, engine status, per-stream add HTTP codes, FPS, GPU /
   CPU / RAM averages. Uses `✔` glyph (action completed).

Both boxes use the universal 128-wide box format from SKILL.md.

### Section content

| Section          | Rows to render                                                                                          |
|------------------|---------------------------------------------------------------------------------------------------------|
| **Launch**       | Full app command incl. all flags (`-c <main-config> [--tiledtext]`); deployment log absolute path; PID. **The command WILL exceed 124 chars on a single line** for warehouse-2d / smartcity use cases — the agent MUST wrap it onto continuation rows aligned at the value column (see template below). Never let the closing `│` overflow column 128. |
| **Readiness**    | The `GET /api/v1/ready` URL polled; ready time in seconds; engine status (`loaded from cache` / `built` / `kFP16 retry then built`). |
| **Stream addition** | Mode (`static` / `dynamic`). For dynamic: the `POST /api/v1/stream/add` URL, inter-add delay, count added. For static: "started together at app launch (no REST call)". Always list the resolved camera ids. |
| **Metrics**      | The `GET /api/v1/metrics` URL polled; sample count and interval; **per-stream FPS only** (`<avg> / stream  (N=<count>)`); GPU util/mem/temp/power; CPU/RAM. Do NOT show an aggregate-fps row — per-stream is the load-bearing value. Skipped for `filedump`. |

### Per-mode flag table (drives the Launch row)

See [App command flags by sink mode](#app-command-flags-by-sink-mode) above for
the canonical sink→flags table; the same mapping drives the Launch row.

### Per-mode REST table (drives the Stream addition row)

| Stream mode | Endpoint                                                | What the agent shows                                      |
|-------------|---------------------------------------------------------|-----------------------------------------------------------|
| `dynamic`   | `POST http://localhost:9000/api/v1/stream/add`          | Per-add delay, total count, ids list (one row).           |
| `static`    | (none — sources baked into `[source-list]` at app start)| "started together at app launch (no REST call)" + ids.    |

### Worked example — warehouse-2d (eglsink + dynamic + cache hit, batch=3)

**PLAN box (BEFORE running run_app_and_wait.sh):**

```
┌────────────────────────────────────────────────── Start application — plan ──────────────────────────────────────────────────┐
│                                                                                                                              │
│  Launch                                                                                                                      │
│     → Command       metropolis_perception_app -c reference-configs/warehouse-2d/ds-main-config.txt --tiledtext               │
│     → Log file      /opt/storage/logs/warehouse2d-rtdetr_<TS>.txt                                                            │
│                                                                                                                              │
│  Readiness probe                                                                                                             │
│     → Endpoint      GET http://localhost:9000/api/v1/ready  (poll every 30 s, timeout 900 s)                                 │
│                                                                                                                              │
│  Stream addition  (dynamic)                                                                                                  │
│     → Endpoint      POST http://localhost:9000/api/v1/stream/add                                                             │
│     → Plan          3 cameras  (Camera, Camera_01, Camera_02)  ·  20 s inter-add delay                                       │
│                                                                                                                              │
│  Metrics                                                                                                                     │
│     → Endpoint      GET http://localhost:9000/api/v1/metrics  (3 samples × 5 s, 10 s warm-up)                                │
│                                                                                                                              │
└──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

**RESULT box (AFTER run_app_and_wait.sh returns LAUNCH_COMPLETE):**

```
┌───────────────────────────────────────────────── Start application — result ─────────────────────────────────────────────────┐
│                                                                                                                              │
│  Launch                                                                                                                      │
│     ✔ Command       metropolis_perception_app -c reference-configs/warehouse-2d/ds-main-config.txt --tiledtext               │
│     ✔ pid           7271                                                                                                     │
│     ✔ Log file      /opt/storage/logs/warehouse2d-rtdetr_20260508_140313.txt                                                 │
│                                                                                                                              │
│  Readiness                                                                                                                   │
│     ✔ Probe         GET http://localhost:9000/api/v1/ready  →  HTTP 200                                                      │
│     ✔ Ready         3 s after launch                                                                                         │
│     ✔ Engine        LINK_EXISTS — /opt/storage/engines/rtdetr_warehouse_v1.0.2.fp16.onnx_b3.engine                           │
│                                                                                                                              │
│  Stream addition  (dynamic)                                                                                                  │
│     ✔ Endpoint      POST http://localhost:9000/api/v1/stream/add                                                             │
│     ✔ [1/3]         id=Camera     file:///opt/storage/.../Camera.mp4     (HTTP 200)                                          │
│     ✔ [2/3]         id=Camera_01  file:///opt/storage/.../Camera_01.mp4  (HTTP 200)                                          │
│     ✔ [3/3]         id=Camera_02  file:///opt/storage/.../Camera_02.mp4  (HTTP 200)                                          │
│                                                                                                                              │
│  Metrics                                                                                                                     │
│     ✔ Endpoint      GET http://localhost:9000/api/v1/metrics  (3 samples × 5 s, 10 s warm-up)                                │
│     ✔ FPS           33.6 / stream  (N=3)                                                                                     │
│     ✔ GPU           96.0 % util  ·  1.8 GB VRAM  ·  69.7 °C  ·  125.4 W                                                      │
│     ✔ CPU / RAM     14.2 % busy  ·  6.4 GB                                                                                   │
│                                                                                                                              │
└──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

**FPS row rule:** show **per-stream FPS only** — `<avg> / stream  (N=<count>)`.
Do NOT include an `aggregate` total in the FPS row of the Results box.
Per-stream is the load-bearing number; total is derivable as `avg × N`.

For `static` stream mode, the Stream addition section is shorter:

```
│  Stream addition                                                                                                             │
│     ✔ Mode       static — sources baked into [source-list]                                                                   │
│     ✔ Started    4 streams launched together at app start (no REST call)                                                     │
│     ✔ IDs        Camera, Camera_01, Camera_02, Camera_03                                                                     │
```

For `filedump` sink, the Metrics section is replaced by:

```
│  Output                                                                                                                      │
│     ✔ File       /opt/storage/output/<usecase>_output.mp4 (MKV muxer)                                                        │
│     ✔ Metrics    skipped (sink=filedump — REST /metrics not surfaced during file write)                                      │
```

After the Step 5 box, also print one informational line:

```
→ Deployment log: ~/rtvicv-storage/logs/<usecase-and-model>_<timestamp>.txt
   tail -f the path to watch build + runtime progress.
```

The "Perception Application — Results" box (this one) is the only
post-launch receipt. It already includes everything a separate deploy
summary would repeat — use case, container, image, batch/sink, FPS,
GPU, log path, REST endpoints. **Do NOT emit a second box** under any
title ("deployment summary", "Deploy summary", etc.).

## Step 5.d — Engine cache status (reported by run_app_and_wait.sh)

`run_app_and_wait.sh` handles polling and reports engine status automatically. Parse its output:

| Marker seen | Print to user |
|---|---|
| `ENGINE_STATUS: cached` | `✔ Engine: loaded from cache — build skipped` |
| `ENGINE_STATUS: built` | `✔ Engine: built from ONNX (will be cached for next deploy)` |
| `ENGINE_STATUS: retrying` | `ℹ Engine: TRT kFP16 retry — expected for FP16 ONNX, waiting...` |
| Heartbeat `⚠ Engine building` | relay as-is — user needs to see this |
| `READY_OK` | `✔ REST ready` |

> **Cache HIT in Step 4.f + `ENGINE_STATUS: built` = TRT version mismatch.** The cached file existed but was rejected by the new TRT version. DS rebuilt it and Step 5.e will re-cache. Normal after a container image upgrade — no user action needed.

### Expected (harmless) TRT warning

`ERROR: [TRT]: IBuilder::buildSerializedNetwork ... kFP16` followed by `Retrying without explicit FP16 flag` — **not a failure**. RT-DETR ships as a strongly-typed FP16 ONNX; the retry succeeds. `run_app_and_wait.sh` recognises this and prints the `ENGINE_STATUS: retrying` heartbeat.

## Step 5.e — Engine caching (handled by run_app_and_wait.sh — use-case aware)

`run_app_and_wait.sh` calls `cache_nvinfer_engine.sh` automatically
after `READY_OK` — but **only for the nvinfer-based use cases**:

| Use case          | Engine cache step in run_app_and_wait.sh                              |
|-------------------|-----------------------------------------------------------------------|
| `warehouse-2d`    | Calls `cache_nvinfer_engine.sh` (symlinks DS-auto-built engine into the cache). |
| `smartcity-rtdetr`| Same.                                                                  |
| `smartcity-gdino` | **Skipped** — engine is a Triton `.plan` managed by `setup_gdino.sh` during Step 4. |
| `warehouse-3d`    | **Skipped** — engine built by `setup_sparse4d.sh` during Step 4.       |

Parse `ENGINE_CACHE: LINKED ...` from the output for the nvinfer use
cases. For the skipped cases the script prints `→ Engine cache:
handled in Step 4 (Triton .plan / Sparse4D), skipping here.` and
proceeds straight to dynamic stream-add.

**Why this matters:** before this fix, calling `cache_nvinfer_engine.sh`
on a smartcity-gdino deploy failed (no nvinfer engine to symlink), and
`set -euo pipefail` aborted the whole script — leaving the app
running with zero streams added. The use-case-aware dispatch fixes
that. If you see "0 active sources" forever after launch, check that
your `run_app_and_wait.sh` includes the case dispatch.

## Step 5.f — Dynamic stream add for warehouse-3d (calibration-aware)

If `stream_mode=dynamic` AND `usecase=warehouse-3d`, BEFORE calling `/api/v1/stream/add` the agent MUST:

1. Discover the calibration sensor ids:

   ```bash
   docker exec <CONTAINER_NAME> python3 -c 'import json; d=json.load(open("/opt/nvidia/deepstream/deepstream/sources/apps/sample_apps/metropolis_perception_app/reference-configs/warehouse-3d/calibration.json")); [print(s["id"]) for s in d["sensors"]]'
   ```

2. Use those exact ids as `camera_id` in each `/stream/add` call. **Never invent `cam1/cam2/cam3/cam4`** for warehouse-3d.
3. Convention: `Camera_01.mp4` → `camera_id=Camera_01` (video stem == calibration id for the default resource).

### Symptom of wrong ids

Log spams:

```
Warning: No projection matrix found for camera <name>. Using identity matrix.
```

Result: BEV projection will be wrong — bounding boxes won't align with the ground plane.

### Recovery

**Stop the perception app and restart it with correct ids** — do NOT live-remove+re-add while traffic is flowing. Sparse4D can crash with `std::logic_error: basic_string: construction from null is not valid` during mid-stream removes.

### `/stream/remove` payload requirements

`/stream/remove` requires BOTH `camera_id` AND `camera_url` in the payload (otherwise returns `STREAM_REMOVE_FAIL, Source url empty`). See `apply-config.md` § 4.e for the full REST add/remove examples.
