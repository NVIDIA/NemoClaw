---
name: vss-generate-video-report
description: Use this skill when producing a VSS analysis report — Mode A per-clip VLM, Mode B incident-range via video-analytics. Not for standalone video summarization, real-time alerts or ad-hoc Q&A.
license: Apache-2.0
metadata:
  version: "3.2.0"
  author: "NVIDIA Video Search and Summarization team"
  github-url: "https://github.com/NVIDIA-AI-Blueprints/video-search-and-summarization"
  tags: "nvidia blueprint operational"
---

# Report

Generate a video analysis report by routing to one of two backends — **never via** `POST /generate` on the VSS agent.

| Mode | Backend |
|---|---|
| **A. Video clip** | `/vss-manage-video-io-storage` → clip URL → **VLM chat/completions** |
| **B. Incident range** | `/vss-query-analytics` → incident list → narrative report |

If the request is ambiguous (e.g. "report on `<sensor>`" with no time range and no incident wording), default to **Mode A**. Ask only if the user mentions both a sensor and a time range. See **Examples** below for the request phrasings that route to each mode.

---

## Instructions

1. **Pick the mode** — Mode A for a single recorded clip/sensor video, Mode B when the request names a time range or incidents/alerts (match against *Examples*).
2. **Verify the deployment profile** for that mode under *Deployment prerequisite*; hand off to `/vss-deploy-profile` if its probe fails.
3. **Run that mode's numbered steps** — *Mode A* or *Mode B* below.
4. **Rewrite every user-facing clip URL** with the `$VSS_PUBLIC_HOST:$VSS_PUBLIC_PORT` one-liner (*Browser-playable clip URL*) before embedding it in the report.
5. **Return the rendered report markdown** to the user.

Output contract for evaluators:
- Mode A top title MUST be exactly `# Video Analysis Report`.
- Mode B top title MUST be exactly `# Incident Range Report` (never `# Incident Report` or sensor-named variants).
- Mode B MUST include `## Basic Information` with the exact required rows from the template (Report Identifier, Range, Scope, Total Incidents, Confirmed / Rejected / Unverified).

---

## Examples

- "Generate a report for this video" / "report on `<sensor-id>`" → **Mode A**
- "Analyze warehouse_01.mp4" / "create an analysis report on the uploaded video" → **Mode A**
- "Report on incidents from 12:31Z to 12:32Z" → **Mode B**
- "Report on alerts today" / "what incidents happened on `<sensor>` last hour" → **Mode B**
- "Summarize alerts on `<sensor>` between `<t1>` and `<t2>`" → **Mode B**

---

## Negative Triggers

Do **not** use this skill when the request is one of the following:

- Ad-hoc visual Q&A on a clip that do not ask explicitly for a report ("what color is the truck?", "what happens at 00:12?") → use `/vss-ask-video`.
- Archive/semantic similarity retrieval ("find forklifts", "search all videos for tailgating") → use `/vss-search-archive`.
- Read-only incident/metrics lookup without report rendering needs → use `/vss-query-analytics`.
- Deploy/teardown/profile changes ("deploy alerts", "switch profile", "bring up base") → use `/vss-deploy-profile`.
- Real-time alert/rule management requests → use `/vss-manage-alerts`.

Never route reports through VSS-agent `POST /generate`.

---

## Deployment prerequisite

**Mode A** needs the VSS **base** profile (VST + VLM NIM).
**Mode B** needs the VSS **alerts** profile (VA-MCP + Elasticsearch).

Probe:

```bash
# Mode A — VST + VLM reachability
curl -sf --max-time 5 "http://${HOST_IP}:30888/vst/api/v1/sensor/version" >/dev/null

# Mode B — VA-MCP
curl -sf --max-time 5 "http://${HOST_IP}:9901/" >/dev/null
```

If the probe fails, hand off to `/vss-deploy-profile` with `-p base` (Mode A) or `-p alerts` (Mode B). **Always** confirm the deploy with the user first.

---

## Clip URLs: VLM input vs browser report link

VST returns clip URLs using the agent-internal `${HOST_IP}:30888` host:port.
Keep that original URL as `VIDEO_URL` for local / in-cluster VLM frame pulls.
Do **not** rewrite the VLM input URL just to make it browser-playable.

Only create `BROWSER_CLIP_URL` for URLs shown in the rendered report. The
deploy layer exports the browser-facing host:port as `$VSS_PUBLIC_HOST` /
`$VSS_PUBLIC_PORT` (and scheme as `$VSS_PUBLIC_HTTP_PROTOCOL`) in every
profile `.env` — Brev or bare-metal — so the report-link rewrite is:

```bash
: "${VSS_PUBLIC_HOST:?Set VSS_PUBLIC_HOST before rewriting clip URLs}"
: "${VSS_PUBLIC_PORT:?Set VSS_PUBLIC_PORT before rewriting clip URLs}"
VSS_PUBLIC_HTTP_PROTOCOL="${VSS_PUBLIC_HTTP_PROTOCOL:-http}"
BROWSER_CLIP_URL=$(echo "$RAW_URL" | sed -E "s|^https?://[^/]+|${VSS_PUBLIC_HTTP_PROTOCOL}://${VSS_PUBLIC_HOST}:${VSS_PUBLIC_PORT}|")
```

If either required public host value is missing, omit the report-facing clip
link and call out that a browser-playable URL could not be produced; do not
block the local VLM analysis path. Apply the rewrite to **every clip URL
surfaced in the rendered report** (Mode A Step 4 Clip URL row; Mode B
per-incident clip sub-bullet). Leave the VLM `video_url` content block in Mode A
Step 3 on the original internal URL when the VLM is local / in-cluster.

---

## Mode A — Report on a recorded video clip

**If the VSS `lvs` profile is deployed** — `curl -sf --max-time 5 "http://${HOST_IP}:38111/v1/ready"` returns HTTP 200 — run `/vss-summarize-video` to produce the summary, then paste its output into the report template in Step 4 and skip Steps 1–3 (the VLM-direct path). Run Steps 1–3 only when `/v1/ready` is non-200.

### Step 1 — Resolve the clip URL

Hand off to `/vss-manage-video-io-storage` to:

1. List sensors and confirm the named `<sensor-id>` exists (upload first if not).
2. Fetch `/storage/<streamId>/timelines` for the recorded range when the user did not supply `startTime` / `endTime`.
3. Request a clip URL:

   ```bash
   curl -s "http://${HOST_IP}:30888/vst/api/v1/storage/file/<streamId>/url?startTime=<startTime>&endTime=<endTime>&container=mp4&disableAudio=true" | jq -r .videoUrl
   ```

   That gives a direct `mp4` URL that the local / in-cluster VLM can pull frames from. Bind it to `VIDEO_URL` (used by the VLM in Step 3) and set `RAW_URL="$VIDEO_URL"` before applying the report-link rewrite to produce `BROWSER_CLIP_URL` for Step 4 — the user's browser cannot reach `$VIDEO_URL` directly.
   Mode A requires the selected VLM endpoint to be able to fetch `VIDEO_URL`.
   Local NIM/RT-VLM deployments normally can; remote endpoints generally cannot
   fetch `localhost`, private `HOST_IP`, or VST-internal URLs. If the live
   `VLM_ENDPOINT` is remote, surface that reachability requirement instead of
   making a chat request that will fail after `/v1/models` succeeds.

### Step 2 — Resolve VLM endpoint and model

The deploy may serve the VLM through either of two stacks. Both expose an OpenAI-compatible `chat/completions` API — pick whichever is live:

| Backend | Env vars | Typical host endpoint | Picked when |
|---|---|---|---|
| **NIM Cosmos** | `VLM_BASE_URL`, `VLM_NAME`, `VLM_MODE`, `VLM_MODEL_TYPE` | `${VLM_BASE_URL}/v1` (no trailing `/v1` on the env var; the agent appends it) | `VLM_MODEL_TYPE != rtvi` **and** `VLM_MODE` ∈ {`local`, `local_shared`, `remote`} **and** `VLM_BASE_URL` is non-empty |
| **RT-VLM Cosmos** | `RTVI_VLM_BASE_URL`, `RTVI_VLM_MODEL_TO_USE`, `VLM_MODEL_TYPE` | `${RTVI_VLM_BASE_URL}/v1` — if unset, derive from `${HOST_IP}` (`http://${HOST_IP}:8018/v1` for alerts, `http://${HOST_IP}:30082/v1` for base) | `VLM_MODEL_TYPE = rtvi`, or `VLM_MODE=none`, or `VLM_BASE_URL` empty; also the only path for `warehouse` |

Read the live values off the running agent container — do not guess:

```bash
docker exec vss-agent sh -lc '
for k in HOST_IP VLM_MODE VLM_MODEL_TYPE VLM_BASE_URL VLM_NAME RTVI_VLM_BASE_URL RTVI_VLM_MODEL_TO_USE; do
  v="$(printenv "$k")"
  [ -n "$v" ] && printf "%s=%s\n" "$k" "$v"
done
'
```

Do not require `RTVI_VLM_ENDPOINT` from `vss-agent` env; several profiles do not inject it.

Selection rule:

```bash
if [ "${VLM_MODEL_TYPE:-}" = "rtvi" ]; then
  VLM_BACKEND="rtvlm"
  VLM_ENDPOINT="${RTVI_VLM_BASE_URL:+${RTVI_VLM_BASE_URL%/}/v1}"
  [ -z "${VLM_ENDPOINT}" ] && VLM_ENDPOINT="http://${HOST_IP}:8018/v1"   # alerts default
  VLM_MODEL="${RTVI_VLM_MODEL_TO_USE}"
elif [ -n "${VLM_BASE_URL}" ] && [ "${VLM_MODE}" != "none" ]; then
  VLM_BACKEND="nim_cosmos"
  VLM_ENDPOINT="${VLM_BASE_URL%/}/v1"
  VLM_MODEL="${VLM_NAME}"
else
  VLM_BACKEND="rtvlm"
  VLM_ENDPOINT="${RTVI_VLM_BASE_URL:+${RTVI_VLM_BASE_URL%/}/v1}"
  [ -z "${VLM_ENDPOINT}" ] && VLM_ENDPOINT="http://${HOST_IP}:30082/v1"  # base default
  VLM_MODEL="${RTVI_VLM_MODEL_TO_USE}"
fi
```

Probe `/v1/models` before sending a chat request to confirm the chosen endpoint is alive and the model is loaded:

```bash
curl -sf --max-time 5 "${VLM_ENDPOINT}/models" | jq -r '.data[].id'
```

If the probe fails or the listed ids don't include `${VLM_MODEL}`, fall back to the other backend (or surface the error — never silently pick a model that isn't on the server).

### Step 3 — Call the VLM directly

Use the OpenAI-compatible `chat/completions` endpoint with a `video_url` content block — the same payload shape **and multimodal settings** `video_understanding` builds in `src/vss_agents/tools/video_understanding.py` (`_build_vlm_messages` + the Cosmos `base_vlm.bind(...)` call).

The frame sampling and visual-token (pixel) budget must mirror the **live** `video_understanding` settings for the active profile. **Send `mm_processor_kwargs` and `media_io_kwargs`** so the direct call uses the same frame sampling and pixel budget as the in-agent `video_understanding` tool — omitting them lets the VLM apply its own defaults, so the output diverges from the agent path.

```bash
PROMPT='Describe in detail what happens in the video, with timestamps (start–end in seconds from clip start) for each segment or event. Cover scenes, objects, people, vehicles, and notable actions.'

# Reasoning is OFF by default — matches the base-profile video_understanding config (`reasoning: false`).
# video_understanding.py uses config.reasoning unless the caller overrides it, so default to non-reasoning.
# Append the Cosmos Reason 2 reasoning suffix ONLY when the user explicitly asks for reasoning
# (drop it for non-cosmos-reason2 VLMs). With reasoning off, the response has no <think> block.
if [ "${REASONING:-false}" = "true" ]; then
PROMPT="${PROMPT}

Answer the question using the following format:

<think>
Your reasoning.
</think>

Write your final answer immediately after the </think> tag."
fi

# If Step 3 is run standalone, derive missing backend from current env/model.
[ -z "${VLM_BACKEND:-}" ] && {
  if [ "${VLM_MODEL_TYPE:-}" = "rtvi" ]; then
    VLM_BACKEND="rtvlm"
  elif [[ "${VLM_MODEL:-}" == nvidia/cosmos* ]]; then
    VLM_BACKEND="nim_cosmos"
  else
    VLM_BACKEND="rtvlm"
  fi
}

# Multimodal settings — resolve from the live agent config file path, not hardcoded candidates.
CFG_JSON=$(
docker exec vss-agent python3 -c '
import json, os, yaml
p = os.getenv("VSS_AGENT_CONFIG_FILE")
if not p:
    raise SystemExit("VSS_AGENT_CONFIG_FILE is not set in vss-agent")
if not os.path.isabs(p):
    p = os.path.join("/vss-agent", p.lstrip("./"))
with open(p, encoding="utf-8") as f:
    cfg = yaml.safe_load(f) or {}
vu = (cfg.get("functions", {}) or {}).get("video_understanding", {}) or {}
print(json.dumps({
    "max_fps": int(vu.get("max_fps", 2)),
    "max_frames": int(vu.get("max_frames", 30)),
    "min_pixels": int(vu.get("min_pixels", 3136)),
    "max_pixels": int(vu.get("max_pixels", 8388608)),
}))
')
)
[ -n "${CFG_JSON}" ] || { echo "Failed to read video_understanding config from vss-agent"; exit 1; }
jq -e . >/dev/null <<< "${CFG_JSON}" || { echo "Invalid config JSON from vss-agent"; exit 1; }
MAX_FPS="$(jq -r '.max_fps' <<< "${CFG_JSON}")"
MAX_FRAMES="$(jq -r '.max_frames' <<< "${CFG_JSON}")"
MIN_PIXELS="$(jq -r '.min_pixels' <<< "${CFG_JSON}")"
MAX_PIXELS="$(jq -r '.max_pixels' <<< "${CFG_JSON}")"

# num_frames = min(int(clip_seconds) * max_fps, max_frames), min 1 — matches video_understanding.py.
# clip_seconds (Step 1 endTime-startTime) may be fractional; truncate to integer seconds — bash $((...))
# is integer-only and errors on "15.0"/"1.5". Default 15s -> caps at MAX_FRAMES.
CLIP_SECONDS=$(awk -v s="${CLIP_SECONDS:-15}" 'BEGIN{printf "%d", s}')
NUM_FRAMES=$(( CLIP_SECONDS * MAX_FPS ))
[ "$NUM_FRAMES" -gt "$MAX_FRAMES" ] && NUM_FRAMES=$MAX_FRAMES
[ "$NUM_FRAMES" -lt 1 ] && NUM_FRAMES=1

# Only apply Cosmos mm/media kwargs on the NIM Cosmos path.
# RT-VLM mode uses its own server-side preprocessing and should not receive these kwargs.
MM_KWARGS=""
if [ "${VLM_BACKEND}" = "nim_cosmos" ]; then
  case "$VLM_MODEL" in
    *cosmos-reason2*) MM_KWARGS=", \"mm_processor_kwargs\": {\"size\": {\"shortest_edge\": ${MIN_PIXELS}, \"longest_edge\": ${MAX_PIXELS}}}, \"media_io_kwargs\": {\"video\": {\"num_frames\": ${NUM_FRAMES}}}" ;;
    *cosmos*)         MM_KWARGS=", \"mm_processor_kwargs\": {\"videos_kwargs\": {\"min_pixels\": ${MIN_PIXELS}, \"max_pixels\": ${MAX_PIXELS}}}, \"media_io_kwargs\": {\"video\": {\"num_frames\": ${NUM_FRAMES}}}" ;;
    *)                      MM_KWARGS="" ;;
  esac
fi

curl -s --connect-timeout 5 --max-time 120 -X POST "${VLM_ENDPOINT}/chat/completions" \
  -H "Content-Type: application/json" \
  -d @- <<EOF | jq -r '.choices[0].message.content'
{
  "model": $(jq -Rs . <<< "${VLM_MODEL}"),
  "messages": [
    {
      "role": "user",
      "content": [
        {"type": "text", "text": $(jq -Rs . <<< "${PROMPT}")},
        {"type": "video_url", "video_url": {"url": $(jq -Rs . <<< "${VIDEO_URL}")}}
      ]
    }
  ],
  "max_tokens": 1024,
  "temperature": 0.0${MM_KWARGS}
}
EOF
```

> The kwargs block is backend-aware: on `nim_cosmos`, Reason2 variants (`nvidia/cosmos-reason2*`) use `mm_processor_kwargs.size{shortest_edge,longest_edge}` and other NIM Cosmos variants (`nvidia/cosmos*`) use `mm_processor_kwargs.videos_kwargs{min_pixels,max_pixels}`; both also send `media_io_kwargs.video.num_frames`. On `rtvlm`, no Cosmos kwargs are sent.

If the VLM returns a `<think>…</think>` block (Cosmos Reason reasoning mode), keep only the text after `</think>` as the report body.

### Step 4 — Fill the Video Analysis Report template

Copy [`assets/video-analysis-report.md`](assets/video-analysis-report.md), fill every placeholder, and return the rendered markdown to the user. Keep the source asset unchanged. Before rendering, verify `BROWSER_CLIP_URL` is set and non-empty, then replace `<BROWSER_CLIP_URL>` with that exact value in the `Clip URL` row. Never leave the placeholder in the output, never include template instructions in a filled cell, and never use the raw `HOST_IP:30888` URL.

---

## Mode B — Report on incidents in a time range

### Step 1 — Resolve the time range and (optionally) sensor

- `start_time` / `end_time` must be ISO 8601 UTC (`YYYY-MM-DDTHH:MM:SS.sssZ`). Resolve relative phrases ("last hour", "today") against the current host clock.
- If the user names a sensor, capture it as `source` + `source_type=sensor`. Otherwise leave both unset for an all-sensors query.

### Step 2 — Fetch incidents via `/vss-query-analytics`

Hand off to `/vss-query-analytics` (initialize → `tools/call`) with:

```json
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "video_analytics__get_incidents",
    "arguments": {
      "source": "<sensor-id-or-omit>",
      "source_type": "sensor",
      "start_time": "<ISO>",
      "end_time": "<ISO>",
      "max_count": 100,
      "includes": ["objectIds", "info"]
    }
  },
  "id": 1
}
```

Read-only boundary (mandatory):
- Mode B is strictly read-only analytics retrieval. Never write, seed, backfill, or mutate Elasticsearch/VA data.
- Forbidden examples: indexing synthetic incidents, replaying fixture payloads into ES, calling write/update/delete APIs to "make data available" for the report.
- If no incidents exist for the requested range/scope, handle as empty results (see below); do not fabricate data.

For each incident keep: `id`, `sensorId`, `timestamp`, `end`, `category`, `place.name`, `info.verdict`, `info.reasoning`, `objectIds`, and the clip URL (commonly `info.clip_url`, `clip_url`, or whichever clip-pointer field the response carries). **Apply the `$VSS_PUBLIC_HOST:$VSS_PUBLIC_PORT` rewrite (see *Browser-playable clip URL* above) to every clip URL before pasting it into the report** — the raw value is a `HOST_IP:30888` URL the user's browser cannot reach.

### Step 3 — Fill the Incident Range Report template

Copy [`assets/incident-range-report.md`](assets/incident-range-report.md), then group by sensor (or by category if no sensor scope), tally verdicts, and list each incident with timestamp / category / verdict / reasoning. Keep the source asset unchanged. Every incident clip value must be a rewritten browser-playable URL; omit the clip line when the incident carries no clip URL. Never include template instructions in a filled cell.

If `get_incidents` returns zero results, STOP and return exactly a one-line empty-range statement naming the requested range and scope. Do not render the full Incident Range template, do not invent incidents, do not seed test data, and do not fall back to Mode A.

---

## Error Handling

- If a probe, `curl`, VLM call, or `/vss-query-analytics` request fails, stop the workflow and report the failing endpoint, HTTP status or command error, and the next useful recovery step. Do not fabricate a report from partial or missing data.
- If the VLM response is empty, malformed, or contains only a reasoning block, surface that response problem and suggest checking model readiness/logs before retrying.
- If a clip URL cannot be rewritten to the public host/port, omit it from the rendered report and call out that the browser-playable URL could not be produced.
- For Mode B, treat missing optional incident fields (`info.reasoning`, `objectIds`, clip URL) as omissions in the report, but treat missing `id`, `timestamp`, or `category` as a data-quality error that should be reported.

---

## Cross-Reference

- **`/vss-manage-video-io-storage`** — sensor list, timelines, and clip URL for Mode A Step 1.
- **`/vss-query-analytics`** — incident retrieval (and verdict / reasoning enrichment) for Mode B Step 2.
- **`/vss-ask-video`** — ad-hoc VLM Q&A on a single clip (not a structured report).
- **`/vss-summarize-video`** — used by Mode A to produce the summary body when the `lvs` profile is deployed; the report template (Step 4) is still filled here.

