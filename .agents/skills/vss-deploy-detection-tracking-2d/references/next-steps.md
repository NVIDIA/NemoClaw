# Step 6 — Next Steps (post-deploy interaction)

Once the deploy summary is printed, show the user what they can do next.
Always re-query the REST API for live stream state — never use a cached count.

---

## 11.a — Query live state

```bash
STREAM_INFO=$(curl -s http://localhost:9000/api/v1/stream/get-stream-info)
ACTIVE=$(echo "$STREAM_INFO" | python3 -c \
  "import sys,json; print(json.load(sys.stdin).get('stream-info',{}).get('stream-count',0))")
```

---

## 11.b — Print the "what now?" menu block

**Print this BEFORE the AskQuestion** so the user sees all options at a glance.
Build the block from live state: hide lines that don't apply.

```
┌──────────────────────────────────────────────────── what can you do now? ────────────────────────────────────────────────────┐
│ Streams  (<ACTIVE>/<MAX_BATCH> active)                                                                                       │
│   add stream     POST /api/v1/stream/add                                                                                     │
│   remove stream  POST /api/v1/stream/remove                                                                                  │
│   list streams   GET  /api/v1/stream/get-stream-info                                                                         │
│                                                                                                                              │
│ Monitoring                                                                                                                   │
│   metrics        GET  /api/v1/metrics                                                                                        │
│   tail log       tail -f ~/rtvicv-storage/logs/deploy_*.txt                                                                  │
│                                                                                                                              │
│ Control                                                                                                                      │
│   stop app       docker exec rtvicv-perception-docker pkill metropolis_perception_app                                        │
│   stop container docker stop rtvicv-perception-docker                                                                        │
│   full teardown  guided cleanup flow (engines / resources)                                                                   │
│                                                                                                                              │
│ Base URL   http://localhost:9000/api/v1                                                                                      │
│ Full ref   this skill's API USAGE flow (see references/usage-vss-detection-tracking-2d.md)                                                                  │
└──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

**Rules for the block:**
- `add stream` line: show slot count `[<N> slot(s) free]` if `ACTIVE < MAX_BATCH`; replace with `[pipeline full — remove a stream or redeploy with bigger batch]` if `ACTIVE >= MAX_BATCH`
- `remove stream` line: show only if `ACTIVE > 0`; otherwise omit

---

## 11.c — AskUserQuestion (user picks what to do)

`AskUserQuestion` allows max 4 options per question. The 10 historical
actions are grouped into 4 buckets at the top level; pick a bucket and
the action handler issues a follow-up question for the specifics. The
user-typed "Other" path is always available for free-text override.

```json
{
  "questions": [
    {
      "question": "Deployment is live. What would you like to do?",
      "header": "Next action",
      "options": [
        {"label": "Check metrics & FPS",    "description": "Per-stream FPS, GPU/CPU/RAM averages — runs collect_metrics.sh against /api/v1/metrics"},
        {"label": "Manage streams",         "description": "Add a new stream (POST /stream/add) or remove one (POST /stream/remove). Shows the active list first."},
        {"label": "View logs",              "description": "Tail the deployment log (~/rtvicv-storage/logs/<usecase-and-model>_<ts>.txt) or docker logs -f rtvicv-perception-docker"},
        {"label": "Stop the deployment",    "description": "Stop the perception app, the container, or run the full teardown flow (cleanup engines/resources)"}
      ],
      "multiSelect": false
    }
  ]
}
```

Show/hide rules (apply BEFORE issuing the AskUserQuestion):
- **Manage streams** is always shown — the follow-up sub-question
  hides "Add" when `ACTIVE >= MAX_BATCH` and "Remove" when `ACTIVE == 0`.
- **Check metrics & FPS** — show only when `OUTPUT_SINK != filedump`
  (filedump deploys skip metrics by design).

After the user picks one of the four buckets, drive a SECOND
`AskUserQuestion` with the specific action options (each bucket lists
its options in the action handlers below — every sub-question stays
within the 2-4 option limit).

---

## 11.d — Action handlers (each bucket → its own follow-up AskUserQuestion)

> **Universal rule for every API action:** show the exact REST call in a
> `┌─ <api> ─┐` box (same 66-char light-style format as Step 3.2's
> docker-run box) BEFORE issuing it. The user must see literally what's
> about to be `curl`'d — substitute the resolved values, no
> placeholders. Same rule applies whether the skill runs the curl
> itself or shows it for the user to run.

### Bucket: "Manage streams"

```json
{
  "questions": [
    {
      "question": "What stream change?",
      "header": "Streams",
      "options": [
        {"label": "Add a stream",      "description": "POST /api/v1/stream/add — pre-fills payload from container/usecase context"},
        {"label": "Remove a stream",   "description": "POST /api/v1/stream/remove — picks from the live <ACTIVE> active streams"},
        {"label": "List active streams","description": "GET /api/v1/stream/get-stream-info — show camera_id + url for each"}
      ],
      "multiSelect": false
    }
  ]
}
```

Hide options dynamically: drop **Add** when `ACTIVE >= MAX_BATCH`; drop
**Remove** when `ACTIVE == 0`.

- **Add a stream** → print the API box (template below), then route to
  this skill's API USAGE flow (`references/usage-vss-detection-tracking-2d.md`)
  with current `ACTIVE`, `MAX_BATCH`, use case, and container name pre-filled.

  ```
  ┌────────────────────────────────────────────────────── POST /stream/add ──────────────────────────────────────────────────────┐
  │ curl -X POST http://localhost:9000/api/v1/stream/add \                                                                       │
  │   -H 'Content-Type: application/json' \                                                                                      │
  │   -d '{"key":"sensor","value":{                                                                                              │
  │          "camera_id":"<id>",                                                                                                 │
  │          "camera_name":"<name>",                                                                                             │
  │          "camera_url":"file:///opt/storage/.../<file>.mp4",                                                                  │
  │          "change":"camera_add","metadata":{}}}'                                                                              │
  │                                                                                                                              │
  │ Notes                                                                                                                        │
  │   • Slot count: <ACTIVE>/<MAX_BATCH> active before add                                                                       │
  │   • Use file:// for local mp4, rtsp:// for live cameras                                                                      │
  └──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
  ```

- **Remove a stream** → see [remove_streams sub-flow](#remove_streams-sub-flow) below (each curl is shown in a box before it runs).

- **List active streams** → print the API box, then run the curl:

  ```
  ┌───────────────────────────────────────────────── GET /stream/get-stream-info ────────────────────────────────────────────────┐
  │ curl -s http://localhost:9000/api/v1/stream/get-stream-info \                                                                │
  │   | python3 -m json.tool                                                                                                     │
  │                                                                                                                              │
  │ Notes                                                                                                                        │
  │   • Returns stream-info.stream-list[] with camera_id +                                                                       │
  │     camera_url + camera_name per active stream                                                                               │
  │   • stream-count = number currently feeding the pipeline                                                                     │
  └──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
  ```

### Bucket: "Stop the deployment"

```json
{
  "questions": [
    {
      "question": "How do you want to stop?",
      "header": "Stop",
      "options": [
        {"label": "Stop the app, keep container", "description": "docker exec rtvicv-perception-docker pkill -TERM metropolis_perception_app — fast redeploy by re-running Step 5"},
        {"label": "Stop the container",            "description": "docker stop rtvicv-perception-docker — graceful 10s SIGTERM. Engine cache + NGC creds preserved on host."},
        {"label": "Full teardown",                  "description": "Guided cleanup flow — stop, then choose what to delete (engines / resources). NGC creds always preserved."}
      ],
      "multiSelect": false
    }
  ]
}
```

- **Stop the app** → `docker exec rtvicv-perception-docker pkill -TERM metropolis_perception_app` then return to Step 6's top-level menu.
- **Stop the container** → `docker stop rtvicv-perception-docker` and exit the deploy flow with `✔ Container stopped (cache preserved)`.
- **Full teardown** → jump to the Teardown Flow in SKILL.md (`references/teardown-flow.md`).

### Bucket: "Check metrics & FPS"

No follow-up question — but DO show the API box first so the user sees
the underlying REST endpoint `collect_metrics.sh` polls:

```
┌───────────────────────────────────────────────────── GET /api/v1/metrics ────────────────────────────────────────────────────┐
│ curl -s http://localhost:9000/api/v1/metrics                                                                                 │
│   | python3 -m json.tool                                                                                                     │
│                                                                                                                              │
│ Notes                                                                                                                        │
│   • Returns gpu-stats, system-stats, stream-stats[]                                                                          │
│   • collect_metrics.sh polls this 3× (5s apart, 10s warm-up)                                                                 │
│     and emits averaged GPU/CPU/RAM + per-stream FPS                                                                          │
└──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

Then run `collect_metrics.sh` (the script does the 3-sample averaging,
better than a single curl). Pass `--log "$LOG"` so the script can fall
back to PERF-line parsing when `/api/v1/metrics` returns
`stream-count=0` (typical for static-mode deploys):

```bash
docker exec rtvicv-perception-docker /tmp/scripts/collect_metrics.sh \
    --samples 3 --interval 5 --warmup 5 --log "$LOG"
```

### Metrics & FPS box — required layout

Render the script's output as **two sections only** — `System` and
`Per-stream FPS`. **Do NOT** add a separate "Throughput" section or a
"Source video frame rate" comparison row. The Per-stream FPS section
itself ends with `Aggregate` + `Average per stream` rows so the user
sees throughput in the same place they see per-stream values.

```
┌──────────────────────────────────────────────── Metrics & FPS ───────────────────────────────────────────────────────────────┐
│                                                                                                                              │
│  System  (3 samples × 5s)                                                                                                    │
│     ✔ GPU util       95.0 %                                                                                                  │
│     ✔ GPU memory     1.7 GB                                                                                                  │
│     ✔ GPU temp       68.0 °C                                                                                                 │
│     ✔ GPU power      118.8 W                                                                                                 │
│     ✔ CPU busy       12.3 %                                                                                                  │
│     ✔ System RAM     6.3 GB                                                                                                  │
│                                                                                                                              │
│  Per-stream FPS  (source: <STREAM_FPS_SOURCE>)                                                                               │
│     ✔ Camera_00 (source_id=0)   45.2 FPS                                                                                     │
│     ✔ Camera_01 (source_id=1)   45.2 FPS                                                                                     │
│     ✔ Active sources            2 / 2                                                                                        │
│     ✔ Aggregate                 90.4 FPS                                                                                     │
│     ✔ Average per stream        45.2 FPS   (90.4 / 2)                                                                        │
│                                                                                                                              │
└──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

Section content rules:

- **System** — `GPU util / memory / temp / power`, `CPU busy`, `System RAM`. One row per metric. Always 6 rows.
- **Per-stream FPS** — one row per stream (use the `camera_id` from the API or the `stream_name` from the PERF log fallback), then 3 summary rows in this order: `Active sources <K>/<N>`, `Aggregate <total> FPS`, `Average per stream <avg> FPS  (<total> / <N>)`.
- The header annotation `(source: …)` reads `STREAM_FPS_SOURCE` emitted by `collect_metrics.sh` — either `/api/v1/metrics` (dynamic mode) or `deployment log (PERF lines)` (static-mode fallback). Don't editorialize beyond that.

Forbidden:
- ❌ A separate `Throughput` section. Aggregate + Average belong inside `Per-stream FPS`.
- ❌ A "Source video frame rate / pipeline is running ~Nx real-time" comparison row. The user wants the measured numbers, not a derived ratio.
- ❌ Restating GPU/CPU stats in a second section. They live in `System` only.

After printing the box, return to Step 6's top-level menu.

### Bucket: "View logs"

```json
{
  "questions": [
    {
      "question": "Which log?",
      "header": "Logs",
      "options": [
        {"label": "Deployment log (deepstream output)", "description": "tail -f ~/rtvicv-storage/logs/<usecase-and-model>_<ts>.txt — pgie/tracker/sink lifecycle, REST add/remove, error traces"},
        {"label": "Container log (docker stdout)",       "description": "docker logs -f rtvicv-perception-docker — container-level stdout (less detail than the deployment log)"}
      ],
      "multiSelect": false
    }
  ]
}
```

For each, **print the command in a `┌─ <command> ─┐` box** (same
format as the API boxes — even though these aren't REST calls, the
shell command is what matters and the box keeps visual consistency),
then run `tail -n 50` once so the user sees the last 50 lines
immediately. Tell them to run the full `tail -f` / `docker logs -f` in
a separate terminal for live streaming.

```
┌───────────────────────────────────────────────────── tail deployment log ────────────────────────────────────────────────────┐
│ tail -n 50 ~/rtvicv-storage/logs/<usecase-and-model>_<ts>.txt                                                                │
│                                                                                                                              │
│ For live streaming (run in another terminal):                                                                                │
│   tail -f ~/rtvicv-storage/logs/<usecase-and-model>_<ts>.txt                                                                 │
└──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

```
┌───────────────────────────────────────────────────────── docker logs ────────────────────────────────────────────────────────┐
│ docker logs --tail 50 rtvicv-perception-docker                                                                               │
│                                                                                                                              │
│ For live streaming (run in another terminal):                                                                                │
│   docker logs -f rtvicv-perception-docker                                                                                    │
└──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### Bonus quick-checks (liveness / readiness / startup — shown only when explicitly asked)

The deploy summary already includes `REST http://localhost:9000`. If
the user asks about liveness, readiness, or startup directly, show the
boxes and curls.

> **RTVI-CV does NOT expose `/api/v1/health`.** Three probes only:
> `/live`, `/ready`, `/startup`. Any agent attempt to curl `/health`
> will return 404 — drop it from the box.

```
┌────────────────────────────────────────────────────── GET /api/v1/live ──────────────────────────────────────────────────────┐
│ curl -s http://localhost:9000/api/v1/live                                                                                    │
│                                                                                                                              │
│ Returns: 200 OK when the perception process is up. Lightest                                                                  │
│ probe — does not check the pipeline state. Use for k8s                                                                       │
│ livenessProbe / kill-the-zombie heuristics.                                                                                  │
└──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────── GET /api/v1/ready ─────────────────────────────────────────────────────┐
│ curl -s http://localhost:9000/api/v1/ready                                                                                   │
│                                                                                                                              │
│ Returns: {"ds-ready":"YES"} when the pipeline is in PLAYING                                                                  │
│ state (engine loaded, sources attached). Use for boot-time                                                                   │
│ gating before adding more streams or scraping /metrics.                                                                      │
└──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘

┌───────────────────────────────────────────────────── GET /api/v1/startup ────────────────────────────────────────────────────┐
│ curl -s http://localhost:9000/api/v1/startup                                                                                 │
│                                                                                                                              │
│ Returns: 200 OK once first-time init (engine build / config                                                                  │
│ load) finished. Useful right after launch when /ready may                                                                    │
│ flip YES briefly during pipeline reconfigure.                                                                                │
└──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

For static-mode deploys `/ready` flips to `ds-ready=YES` ~3 seconds
after launch (cache hit) or ~3-5 minutes (cache miss / engine build).

### Quick-commands reference (printed alongside the menu)

The "what now?" menu block (11.b) already shows the quick commands the
user can run themselves in another terminal. Don't print a second
expanded REST quick-reference — it duplicates the menu and the
API USAGE flow (`references/usage-vss-detection-tracking-2d.md`) has
full payload details.

For users who want the curl payload templates, switch to this skill's
API USAGE flow (`references/usage-vss-detection-tracking-2d.md`) — it
has the full `/stream/add`, `/stream/remove`, `/metrics`, `/live`,
`/ready`, `/startup` interactive flow.

---

## `remove_streams` sub-flow

### R1 — Re-query live stream info (do NOT reuse cached list)

```bash
STREAM_INFO=$(curl -s http://localhost:9000/api/v1/stream/get-stream-info)
```

Parse `stream-info.stream-list[]` → extract `(camera_id, camera_url, camera_name)` for each entry.
If `stream-count == 0` → print `No active streams to remove.` and return to Step 6's top-level menu.

### R2 — Build option list from live response

```json
{
  "questions": [
    {
      "id": "streams_to_remove",
      "prompt": "Which stream(s) do you want to remove?  (<ACTIVE> active)",
      "options": [
        {"id": "<camera_id_0>", "label": "<camera_id_0>  ·  <camera_url_0>"},
        {"id": "<camera_id_1>", "label": "<camera_id_1>  ·  <camera_url_1>"},
        {"id": "all",           "label": "Remove ALL <ACTIVE> streams  (pipeline goes idle)"}
      ]
    }
  ]
}
```

One option per live stream — built from `stream-list[].camera_id`. Show `all` only when `ACTIVE > 1`.

### R3 — Execute remove (both camera_id AND camera_url required)

Print the API box BEFORE each curl — substitute the resolved
`camera_id` + `camera_url` from R1's live query so the user sees the
literal payload that's about to fire:

```
┌───────────────────────────────────────────────────── POST /stream/remove ────────────────────────────────────────────────────┐
│ curl -X POST http://localhost:9000/api/v1/stream/remove \                                                                    │
│   -H 'Content-Type: application/json' \                                                                                      │
│   -d '{"key":"sensor","value":{                                                                                              │
│          "camera_id":"<ID>",                                                                                                 │
│          "camera_url":"<URL>",                                                                                               │
│          "change":"camera_remove"}}'                                                                                         │
│                                                                                                                              │
│ Notes                                                                                                                        │
│   • Both camera_id AND camera_url are REQUIRED — missing                                                                     │
│     either → STREAM_REMOVE_FAIL, "Source url empty"                                                                          │
│   • Pull both from the live /stream/get-stream-info response                                                                 │
│     (not from a cached list — stream_url paths can drift)                                                                    │
│   • warehouse-3d caveat: mid-stream remove can crash Sparse4D.                                                               │
│     Prefer Stop-app + redeploy for warehouse-3d.                                                                             │
└──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

After each successful curl, print: `✔ Stream <camera_id> removed  (<ACTIVE-1>/<MAX_BATCH> active)`

### R4 — Confirm and loop

Re-query `/stream/get-stream-info`, confirm removal, then return to Step 6's top-level menu with updated live state.
