
# RTVI-CV API Skill

Interactively call any RTVI-CV REST API. The agent discovers the service, collects user inputs via structured prompts, executes the API, formats results, and suggests next steps.

> **API details** (schemas, curl templates, response shapes) are in `api-reference.md`. This file covers the workflow only.

---

## Instructions

Invoke this skill by describing what you want to do with RTVI-CV in plain language. The agent handles host discovery, parameter collection, command construction, and response formatting automatically.

**Trigger phrases:** "add a stream", "remove camera", "list streams", "is rtvi-cv ready", "health check", "get metrics", "what's the FPS", "check GPU usage", "generate text embeddings", "rtvi-cv dashboard", "call rtvi-cv api".

**Argument:** optionally pass the base URL, e.g. `http://10.0.0.5:9000`, if the service is not on localhost. If omitted, the skill auto-discovers via env vars and Docker.

## Examples

```text
# Add a stream
add a stream rtsp://10.0.0.1:8554/cam1 with id cam_entrance

# Health check
is rtvi-cv ready?

# Metrics
what's the FPS on all streams?

# Remove
remove stream cam_entrance

# Dashboard
show me the rtvi-cv dashboard
```

---

## Step 1 — Discover and Verify the RTVI-CV Host

**Print:** `Discovering RTVI-CV service...`

Run these silently to auto-detect:

```bash
echo "${RTVI_CV_URL:-not_set}"
docker ps --format '{{.Names}} {{.Ports}}' 2>/dev/null | grep -i '9000'
curl -s -o /dev/null -w "%{http_code}" --max-time 3 http://localhost:9000/api/v1/live 2>/dev/null
```

| Result | Action |
|--------|--------|
| `$RTVI_CV_URL` is set | Use it |
| Docker container found on 9000 | Extract host:port |
| `localhost:9000` returns `200` | Use `http://localhost:9000` |
| Nothing found | Ask user (see below) |

If auto-detect fails, ask:

> I couldn't auto-detect a running RTVI-CV instance. What is the host and port? (e.g. `http://10.0.0.5:9000`)

**Pre-flight check** — verify connectivity:

```bash
curl -s --max-time 5 "${BASE_URL}/api/v1/live"
```

**Print on success:** `Connected to RTVI-CV at <BASE_URL> — service is alive.`

**Print on failure:**

> Could not reach RTVI-CV at `<BASE_URL>`.
> - Check if it's running: `docker ps | grep -i rtvi`
> - Check the port: `ss -tlnp | grep 9000`
> - Verify network access to the host

**Do NOT proceed until connectivity is confirmed.**

---

## Step 2 — Identify the API Operation

**Parse the user's request aggressively.** Extract everything you can:

| User says... | Already known |
|--------------|---------------|
| "add stream", "add camera" | operation = add |
| "add rtsp://X" or "add file:///Y" | operation = add, camera_url = X/Y |
| "remove stream", "remove cam_001" | operation = remove, maybe camera_id |
| "list streams", "what's running" | operation = stream-info |
| "is it alive", "health check" | operation = health |
| "full health", "check everything" | operation = all-health (3 probes) |
| "metrics", "fps", "latency", "gpu" | operation = metrics |
| "version", "metadata" | operation = metadata |
| "embed text", "text embedding" | operation = embeddings |
| "status", "dashboard", "overview" | operation = dashboard (health + streams + metrics) |

If the intent is ambiguous, use `AskUserQuestion`:

```json
{
  "questions": [
    {
      "id": "operation",
      "prompt": "Which RTVI-CV API operation do you want to perform?",
      "options": [
        {"id": "add", "label": "Add a stream — add a new video source to the pipeline"},
        {"id": "remove", "label": "Remove a stream — stop and remove a video source"},
        {"id": "list", "label": "List streams — see all active video sources"},
        {"id": "health", "label": "Health check — liveness, readiness, and startup probes"},
        {"id": "metrics", "label": "Metrics — FPS, latency, GPU/CPU/RAM usage"},
        {"id": "metadata", "label": "Metadata — version and license info"},
        {"id": "embed", "label": "Generate text embeddings"},
        {"id": "dashboard", "label": "Full dashboard — health + streams + metrics"}
      ]
    }
  ]
}
```

**Print:** `Selected operation: <operation name>`

---

## Step 3 — Collect Required Parameters

**Use `AskQuestion` for structured choices.** Ask the user in chat for free-text values. Always collect all unknowns in a **single interaction**.

### For Stream Add

**Print:** `Preparing to add a stream...`

If the user already provided a URL in their query (e.g. "add rtsp://10.0.0.5:554/live"), extract it. Auto-generate a camera_id from the URL if not provided (e.g. `stream_10_0_0_5`).

For any missing required values, ask in chat:

> To add a stream, I need:
> 1. **Camera URL** — the video source
>    - RTSP: `rtsp://192.168.1.100:554/stream1`
>    - File: `file:///opt/videos/sample.mp4`
>    - HTTP: `https://example.com/video.mp4`
> 2. **Camera ID** — a unique identifier (e.g. `cam_001`)
>
> Please provide the URL and ID.

Then use `AskQuestion` for optional settings (with sensible defaults pre-selected):

```json
{
  "questions": [
    {
      "id": "codec",
      "prompt": "Video codec for this stream?",
      "options": [
        {"id": "h264", "label": "H.264 (most common, default)"},
        {"id": "h265", "label": "H.265 / HEVC"},
        {"id": "vp9", "label": "VP9"},
        {"id": "av1", "label": "AV1"}
      ]
    },
    {
      "id": "resolution",
      "prompt": "Video resolution?",
      "options": [
        {"id": "1920x1080", "label": "1920 x 1080 (Full HD, default)"},
        {"id": "1280x720", "label": "1280 x 720 (HD)"},
        {"id": "3840x2160", "label": "3840 x 2160 (4K)"},
        {"id": "custom", "label": "Custom (I'll specify)"}
      ]
    },
    {
      "id": "framerate",
      "prompt": "Video framerate (FPS)?",
      "options": [
        {"id": "30", "label": "30 FPS (default)"},
        {"id": "25", "label": "25 FPS"},
        {"id": "15", "label": "15 FPS"},
        {"id": "60", "label": "60 FPS"}
      ]
    }
  ]
}
```

**Defaults if user skips:** codec=`h264`, resolution=`1920 x1080`, framerate=`30`, camera_name=same as camera_id.

### For Stream Remove

**Print:** `Preparing to remove a stream...`

**Smart flow — always auto-fetch the active stream list first:**

```bash
curl -s "${BASE_URL}/api/v1/stream/get-stream-info" -H "Accept: application/json"
```

**Print:** `Fetching active streams from RTVI-CV...`

If streams exist, present them as a choice using `AskQuestion`:

```json
{
  "questions": [
    {
      "id": "stream_to_remove",
      "prompt": "Which stream do you want to remove?",
      "options": [
        {"id": "cam_001", "label": "cam_001 — rtsp://192.168.1.100:554/stream1 (Front Door)"},
        {"id": "cam_002", "label": "cam_002 — file:///opt/videos/sample.mp4 (Parking Lot)"}
      ]
    }
  ]
}
```

Build the options dynamically from the `stream-list` response. Each option's `id` is the `camera_id` and the `label` shows `camera_id — camera_url (camera_name)`.

If no streams are active, tell the user:

> No active streams to remove. Want to add one instead?

### For Text Embeddings

**Print:** `Preparing to generate text embeddings...`

Ask for text input in chat, then use `AskQuestion` for the model:

> What text do you want to generate embeddings for?

```json
{
  "questions": [
    {
      "id": "embed_model",
      "prompt": "Which embedding model to use?",
      "options": [
        {"id": "cosmos-embed1-448p", "label": "cosmos-embed1-448p (default)"}
      ]
    }
  ]
}
```

### For Metrics with OpenTelemetry

If the user mentions OpenTelemetry or export, ask:

```json
{
  "questions": [
    {
      "id": "otel_action",
      "prompt": "What OpenTelemetry action?",
      "options": [
        {"id": "enable", "label": "Enable — start exporting metrics to a collector"},
        {"id": "disable", "label": "Disable — stop exporting (set refresh period to -1)"},
        {"id": "skip", "label": "Skip — just get metrics without OpenTelemetry"}
      ]
    }
  ]
}
```

If "enable", ask for the collector URL in chat:
> What is your OpenTelemetry collector URL? (e.g. `http://otel-collector:4318`)

### For GET endpoints (health, stream-info, metrics, metadata)

**No user input needed.** Skip to Step 4 immediately.

---

## Step 4 — Confirm and Execute

### For GET requests (safe, read-only) — execute directly

**Print:** `Calling <ENDPOINT_NAME>...`

Execute the curl command from `api-reference.md`. Pipe through `python3 -m json.tool` for formatting.

**Print:** `Response received from <ENDPOINT_NAME>.`

### For POST requests (modifies state) — confirm first

**Print:** `Building request for <ENDPOINT_NAME>...`

Show the exact curl command with all values filled in:

> Here's the API call I'll make:
>
> ```bash
> curl -s -X POST "http://localhost:9000/api/v1/stream/add" \
>   -H "Content-Type: application/json" \
>   -d '{ "key": "sensor", "value": { ... } }'
> ```
>
> Shall I run this?

Use `AskQuestion` for confirmation:

```json
{
  "questions": [
    {
      "id": "confirm_execute",
      "prompt": "Ready to execute this API call?",
      "options": [
        {"id": "yes", "label": "Yes, run it"},
        {"id": "edit", "label": "No, let me change something first"},
        {"id": "show_only", "label": "Just show me the command, don't run it"}
      ]
    }
  ]
}
```

| User picks | Agent does |
|------------|-----------|
| "Yes, run it" | **Print:** `Executing POST <endpoint>...` then run the curl |
| "No, let me change something" | Ask what to change, update, re-confirm |
| "Just show me the command" | Show the curl/Python command, do NOT execute |

After execution: **Print:** `Response received. Parsing results...`

---

## Step 5 — Format and Present Results

**Never dump raw JSON.** Always parse and present formatted output.

### Stream Add — Success

> **Stream added successfully**
>
> | Field | Value |
> |-------|-------|
> | Camera ID | `cam_001` |
> | Camera URL | `rtsp://10.0.0.5:554/live` |
> | Status | `HTTP/1.1 200 OK` |

### Stream Add — Failure

> **Stream add failed**
>
> | Field | Value |
> |-------|-------|
> | Error | `STREAM_ADD_FAIL, Source url empty` |
> | Fix | Include a valid `camera_url` in the request |

### Stream Info

> **Active Streams (2)**
>
> | # | Camera ID | Name | URL | Source ID |
> |---|-----------|------|-----|-----------|
> | 1 | `cam_001` | Front Door | `rtsp://192.168.1.100:554/stream1` | 0 |
> | 2 | `cam_002` | Parking Lot | `file:///opt/videos/sample.mp4` | 1 |

If empty: `No active streams. Want to add one?`

### Health Checks

> **RTVI-CV Health**
>
> | Probe | Status |
> |-------|--------|
> | Liveness | ALIVE |
> | Readiness | READY |
> | Startup | COMPLETE |

If a probe fails, flag it: `| Readiness | NOT READY — service may still be loading models |`

### Metrics

> **Stream Performance**
>
> | Stream | FPS | Frames | Latency |
> |--------|-----|--------|---------|
> | camera_001 (sensor_0) | 29.97 | 1,234 | 45.2 ms |
> | camera_002 (sensor_1) | 30.00 | 5,678 | 38.7 ms |
>
> **System Resources**
>
> | Resource | Value |
> |----------|-------|
> | GPU Memory | 4.5 GB |
> | RAM | 8.2 GB |
> | CPU | 45.3% |
> | GPU | 78.9% |

### Metadata

> **RTVI-CV Service Info**
>
> | Field | Value |
> |-------|-------|
> | Version | `1.0.0` |
> | Build | `a3f5c8d` |
> | License | NVIDIA-Proprietary |

### Text Embeddings

> **Embeddings Generated**
>
> | Field | Value |
> |-------|-------|
> | Model | `cosmos-embed1-448p` |
> | ID | `3fa85f64-5717-4562-b3fc-2c963f66afa6` |
> | Dimensions | 768 |
> | Input | "Hello, world!" |

### Connection Error

> **Connection failed** — could not reach `<BASE_URL>`
>
> Troubleshooting:
> 1. `docker ps | grep -i rtvi` — is the container running?
> 2. `ss -tlnp | grep 9000` — is the port listening?
> 3. Check firewall/network if remote host

---

## Step 6 — Suggest Next Actions

Use `AskQuestion` to offer logical follow-ups:

```json
{
  "questions": [
    {
      "id": "next_action",
      "prompt": "What would you like to do next?",
      "options": [
        {"id": "add", "label": "Add another stream"},
        {"id": "remove", "label": "Remove a stream"},
        {"id": "list", "label": "List active streams"},
        {"id": "metrics", "label": "Check metrics / performance"},
        {"id": "health", "label": "Run health check"},
        {"id": "done", "label": "I'm done"}
      ]
    }
  ]
}
```

**Tailor the options based on context:**

| Just completed | Prioritize these options |
|----------------|------------------------|
| Stream added | Add another, List streams, Metrics |
| Stream removed | List streams, Add stream |
| Stream info (has streams) | Add/Remove stream, Metrics |
| Stream info (empty) | Add stream |
| Health — all OK | Add stream, Metrics |
| Health — not ready | Retry health in 10s |
| Metrics | Refresh metrics, Stream info, OpenTelemetry |
| Embeddings | Embed more text |

If user picks "done", end with: `All done. The RTVI-CV service is at <BASE_URL> if you need it again.`

If user picks another action, loop back to **Step 3** for that operation (skip Steps 1-2 since host and intent are known).

---

## Composite Flows

### "Full health check" / "Check everything"

**Print:** `Running full health check...`

Run all 3 probes sequentially, present combined table.

### "Dashboard" / "Status" / "Overview"

**Print:** `Building RTVI-CV dashboard...`

Run in order: liveness → readiness → stream-info → metrics → metadata. Present all results using the formatting from Step 5, grouped under a single dashboard heading.

### "Add multiple streams"

If user provides multiple URLs or says "add 3 streams":
1. Collect all URLs/IDs
2. Show all curl commands for confirmation
3. Execute sequentially, print status for each: `Adding stream 1/3 (cam_001)... done.`
4. Run stream-info at end to show final state

---

## Error Recovery

| Error | What the agent should do |
|-------|-------------------------|
| Connection refused | Print troubleshooting steps, ask for correct URL |
| 400 — missing field | Print which field is missing, ask user to provide it, retry |
| 500 — server error | Suggest `docker logs <container> --tail 50`, offer to retry |
| Stream remove — ID not found | Auto-run stream-info, show active streams, let user pick |
| Curl not found | Fall back to Python helper from `api-reference.md` |

---

## Status Messages Reference

Use these prints to keep the user informed at every step:

| When | Print |
|------|-------|
| Starting discovery | `Discovering RTVI-CV service...` |
| Host found | `Connected to RTVI-CV at <URL> — service is alive.` |
| Host not found | `Could not reach RTVI-CV at <URL>. <troubleshooting>` |
| Operation selected | `Selected operation: <name>` |
| Collecting params | `Preparing to <add/remove/check>...` |
| Fetching stream list | `Fetching active streams from RTVI-CV...` |
| Building request | `Building request for <endpoint>...` |
| Executing GET | `Calling <endpoint>...` |
| Executing POST | `Executing POST <endpoint>...` |
| Response received | `Response received. Parsing results...` |
| Batch progress | `Adding stream 1/3 (cam_001)... done.` |
| Done | `All done. RTVI-CV is at <URL> if you need it again.` |
