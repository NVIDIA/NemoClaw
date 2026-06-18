---
name: vss-summarize-video
description: Use to summarize a recorded video via the LVS summarization microservice (HITL-gated) with a VLM fallback. Not for report generation or live RTSP captioning.
license: Apache-2.0
metadata:
  version: "3.2.0"
  author: "NVIDIA Video Search and Summarization team"
  github-url: "https://github.com/NVIDIA-AI-Blueprints/video-search-and-summarization"
  tags: "nvidia blueprint operational"
---
## Instructions

Follow the routing tables and step-by-step workflows below. Each section that ends in *workflow*, *quick start*, or *flow* is intended to be executed top-to-bottom. Detailed reference material lives in `references/`.

## Examples

Worked end-to-end examples are kept under `evals/` (each `*.json` manifest contains a runnable scenario) and inline in the per-workflow `curl` blocks below. Run a Tier-3 evaluation with `nv-base validate <this-skill-dir> --agent-eval` to replay them.

Call the VLM NIM or the video summarization microservice **directly**.
Always run `curl` commands yourself; never instruct the user to run them.

Primary video workflow query type: **"Summarize this video."** Direct video summarization API
and service-ops requests are handled by the reference-routed sections below.

## Purpose

Produce a single, polished narrative summary of one recorded video clip, with
timestamped events when the LVS microservice path is reachable.

**Do NOT use this skill for:**
- Live RTSP captioning — use `vss-deploy-dense-captioning`.
- Report generation, including incident or alert-window reports — use `vss-generate-video-report` Mode B.
- Semantic search across the archive — use `vss-search-archive`.

## Prerequisites

- VSS `lvs` profile running on `$HOST_IP` (port 38111) OR a reachable
  VLM/RT-VLM endpoint as a fallback. The `vss-deploy-profile` skill brings
  these up.
- Network reachability from the agent host to both endpoints; clip URLs from
  VIOS must be fetchable by the chosen backend.
- `jq` and `curl` available on the agent host.

## Limitations

- Direct VLM fallback uses a single fixed prompt and cannot target
  scenario/events — output quality is lower than the LVS path.
- Remote VLM endpoints generally cannot reach `localhost`/private clip URLs.
- One backend call per request; no parallel hedging or multi-pass summaries.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `/v1/ready` returns 503 repeatedly | LVS service still warming up | Retry up to ~30 s as shown in *Setup*; if it never returns 200 the service may not be deployed |
| Empty `video_summary` and `events` | Clip does not contain the requested events | Re-run with broader `scenario` or different `events` |
| VLM returns `<think>` block | Cosmos Reason 2 reasoning mode | Strip everything up to `</think>` before rendering |
| Empty stdout from `curl /v1/ready` | Service legitimately returns 200 with empty body | Always check HTTP status with `-o /dev/null -w '%{http_code}'`, never inspect the body |

See [`references/video-summarization-debugging.md`](references/video-summarization-debugging.md) for deeper diagnostics.

## Reference Map

Use these references only when the user asks for the relevant detail, or when
the core workflow below needs deeper video summarization information:

- **video summarization API details**: [`references/video-summarization-api.md`](references/video-summarization-api.md) for
  `/v1/summarize`, `/summarize`, `/v1/generate_captions`,
  `/v1/stream_summarize`, health probes, `/models`, `/recommended_config`,
  `/metrics`, request fields, response shapes, and API gotchas.
- **video summarization service configuration and ops**:
  [`references/video-summarization-deployment.md`](references/video-summarization-deployment.md) for
  the VSS `lvs` profile, ports, required env vars, logs, status, dry-runs,
  teardown, model/backend swaps, Elasticsearch/Neo4j/ArangoDB backend
  selection, and service-level troubleshooting.
- **Extended video summarization ops references**:
  [`references/video-summarization-environment-variables.md`](references/video-summarization-environment-variables.md),
  [`references/video-summarization-debugging.md`](references/video-summarization-debugging.md), and
  `assets/video-summarization.env.example`.

Load `video-summarization-api.md` only when you need a request field, response shape, or
endpoint that is not already covered by the Step 2 LVS or fallback VLM
example below, or when handling a direct video summarization API
request. Load `video-summarization-deployment.md` only for deployment,
configuration, or service operations.

## Video Summarization API And Service Ops Requests

If the user asks to call or debug video summarization endpoints directly, answer from
[`references/video-summarization-api.md`](references/video-summarization-api.md) instead of running the
end-to-end video summarization workflow. Examples: list video summarization models, check
readiness, get recommended chunking config, inspect metrics, explain a 422
response, or build a `/v1/summarize` request body.

If the user asks to configure, deploy, restart, tear down, or troubleshoot the
video summarization service, prefer the `vss-deploy-profile` skill for full VSS profile
deployment and use [`references/video-summarization-deployment.md`](references/video-summarization-deployment.md)
for video summarization-specific service details.

## Routing

Decide purely from video summarization service availability (probed in
*Setup → Availability checks* below). **Duration does not drive routing.**

| `/v1/ready` | Backend | Endpoint |
|---|---|---|
| HTTP 200 | LVS microservice with HITL | `POST ${LVS_BACKEND_URL}/v1/summarize` |
| Anything else | VLM / RT-VLM with the default prompt + fallback note | `POST ${VLM_BASE_URL}/v1/chat/completions` |

Fallback message when the LVS service is unreachable — copy verbatim above the summary:

> ⚠ **Note:** Input video `<name>` is `<N>`s long.
> The video summarization service is not deployed, so this summary was
> produced by the VLM alone with a generic default prompt. Deploy the
> `lvs` profile for higher-quality summaries with scenario/events
> targeting.

## Deployment prerequisite

The VSS **lvs** profile on `$HOST_IP` is the primary backend. If the
`/v1/ready` probe (see *Setup → Availability checks*) returns anything
other than 200 after the warmup retries, ask the user:

> *"The VSS `lvs` profile isn't running on `$HOST_IP`. Shall I deploy it now using the `/vss-deploy-profile` skill with `-p lvs`? Reply `no` to summarize with the VLM-only fallback instead (lower quality, no scenario/events targeting)."*

- **Yes** → hand off to `/vss-deploy-profile`, then re-probe and continue with Step 2 (LVS + HITL).
- **No** → go straight to **Step 2 fallback (VLM with default prompt)** and prepend the Routing fallback note. Do not ask again, and do not run scenario/events HITL.
- **Pre-authorized to deploy autonomously** (caller said so explicitly) → skip the confirmation and invoke `/vss-deploy-profile` directly.
- **Pre-authorized to use VLM fallback** ("skip lvs, just use the VLM") → go straight to Step 2 fallback without prompting.

---

## Setup

**Endpoints (defaults for a local VSS `lvs` deployment):**

- VLM / RT-VLM: `${VLM_BASE_URL}` — default `${RTVI_VLM_BASE_URL:-http://${HOST_IP:-localhost}:8018}`
- LVS service: `${LVS_BACKEND_URL}` — default `http://${HOST_IP:-localhost}:38111`
- VIOS: owned by `vss-manage-video-io-storage`; refer there.

Use env vars when set (strip trailing `/v1` from the VLM base — the skill appends it). Otherwise use the defaults. If neither works, ask the user — do not scan ports or read config files to guess.

**Model name:** read `${VLM_NAME}` (default
`nim_nvidia_cosmos-reason2-8b_hf-1208`). It must match the id RT-VLM
`/v1/models` advertises; do not substitute the friendly
`nvidia/cosmos-reason2-8b`.

For endpoint schemas, optional fields, response envelopes, and error handling, see [`references/video-summarization-api.md`](references/video-summarization-api.md).

**Availability checks** (run both before routing).
**Readiness is determined by the HTTP status code only** — the LVS
`/v1/ready` may legitimately return `200` with an empty body, so do not
inspect the body.

```bash
VLM="${VLM_BASE_URL:-${RTVI_VLM_BASE_URL:-http://${HOST_IP:-localhost}:8018}}"
VLM="${VLM%/v1}"

# VLM / RT-VLM: 200 on /v1/models
vlm_code=$(curl -s -o /dev/null -w '%{http_code}' --connect-timeout 3 --max-time 10 \
  "$VLM/v1/models")
[ "$vlm_code" = "200" ] && echo "VLM OK" || echo "VLM not reachable (HTTP $vlm_code)"

# Video summarization service: 200 on /v1/ready, with retry on 503 (warmup) for up to ~30s
VIDEO_SUMMARIZATION_URL=${LVS_BACKEND_URL:-http://${HOST_IP:-localhost}:38111}
video_sum_code=000
for i in $(seq 1 10); do
  video_sum_code=$(curl -s -o /dev/null -w '%{http_code}' --connect-timeout 3 --max-time 10 "$VIDEO_SUMMARIZATION_URL/v1/ready")
  case "$video_sum_code" in
    200) echo "video summarization OK"; break ;;
    503) sleep 3 ;;                 # warming up; keep polling
    *)   break ;;                   # any other code = not reachable, stop retrying
  esac
done
[ "$video_sum_code" = "200" ] || echo "video summarization service not reachable (HTTP $video_sum_code)"
```

**How to interpret the results:**

- `video_sum_code = 200` → **Step 2 (LVS + HITL)** for every video.
- `video_sum_code != 200`, `vlm_code = 200` → **Step 2 fallback (VLM)**; prepend the Routing fallback note.
- `vlm_code != 200` → fail; at least one backend must be reachable.
- A non-200 LVS code after the retry loop is the ONLY signal of unavailability. Empty stdout or missing JSON fields are NOT "unavailable."

---

## Step 1 - Get the clip URL via `vss-manage-video-io-storage` (sub-task, NOT the final answer)

**Use the `vss-manage-video-io-storage` skill for all VIOS interactions** — it
owns the canonical curl recipes, parameter defaults, and delete/upload flows.
Do not fabricate URLs or hand-roll VIOS calls; they will drift.

This step is a sub-task — do NOT end your turn here; do NOT return the clip
URL as the final answer. From VIOS collect three values:

1. **`streamId`** (via `sensor/list` → `sensor/<id>/streams`, or directly from an upload response).
2. **Timeline** - `{startTime, endTime}` (ISO 8601 UTC). `endTime - startTime` is the duration; needed only for the user-facing header (routing is driven solely by `/v1/ready`).
3. **Temporary MP4 clip URL** — the `/storage/file/<streamId>/url` variant with `container=mp4`. Response field: `.videoUrl`. Both backends need an HTTP(S) URL they can `GET`.

Everything else (auth, upload, `disableAudio`, expiry, etc.) lives in the
`vss-manage-video-io-storage` skill — refer users there if VIOS fails.

---

## Step 2 — Primary: video summarization microservice with HITL

Use this path **whenever** `/v1/ready` returned 200 in Setup. Duration is irrelevant.

For advanced fields (`media_info`, `schema`, structured output, stream captioning, metrics, recommended config) see [`references/video-summarization-api.md`](references/video-summarization-api.md).

### HITL: collect scenario and events first (REQUIRED — do not skip)

Full walk-through is in [`references/hitl-prompts.md`](references/hitl-prompts.md). Always run HITL before calling the LVS service.

**Autonomous-mode defaults.** When the caller has bypassed HITL ("run
autonomously without prompting") AND the original query asks for
`default`/`defaults` (or gives none), use
`scenario="activity monitoring"` and `events=["notable activity"]`
**verbatim** — do not infer from filename or sensor name. Note the
defaults in the final reply and offer a re-run with more specific
parameters. This is the ONLY supported HITL bypass; "the video is
short" or "the user seems in a hurry" are not valid reasons.

Prefer `POST /v1/summarize` (3.2 GA route); `/summarize` is a compatibility alias.

```bash
VIDEO_SUMMARIZATION_URL=${LVS_BACKEND_URL:-http://${HOST_IP:-localhost}:38111}

# From HITL reply:
SCENARIO='warehouse monitoring'
EVENTS_JSON='["notable activity"]'
OBJECTS_JSON=''  # '' to omit, else '["forklifts","pallets","workers"]'

curl -s --max-time 300 -X POST "$VIDEO_SUMMARIZATION_URL/v1/summarize" \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg url "<clip_url_from_vss_manage_video_io_storage>" \
        --arg model "${VLM_NAME:-nim_nvidia_cosmos-reason2-8b_hf-1208}" \
        --arg scenario "$SCENARIO" \
        --argjson events "$EVENTS_JSON" \
        --argjson objects "${OBJECTS_JSON:-null}" '{
    url: $url,
    model: $model,
    scenario: $scenario,
    events: $events,
    chunk_duration: 10,
    num_frames_per_second_or_fixed_frames_chunk: 20,
    use_fps_for_chunking: false,
    seed: 1
  } + (if $objects == null then {} else {objects_of_interest: $objects} end)')" \
  | jq -r '.choices[0].message.content' \
  | jq '{video_summary, events}'
```

If both `video_summary` and `events` are empty, the clip probably doesn't contain the requested events — re-run with broader `scenario`/`events`, don't report "no content".

**Tuning:** `chunk_duration` (default `10`s; `0` = single chunk),
`num_frames_per_second_or_fixed_frames_chunk` (default `20`; meaning depends
on `use_fps_for_chunking`), `seed` (default `1`). `num_frames_per_chunk` is
deprecated.

---

## Step 2 fallback — VLM direct with default prompt

Use this path **only** when `/v1/ready` did not return 200 after warmup. Do NOT run HITL — the user did not opt in; you fell back because the service was missing. Prepend the Routing fallback note to the response.

```bash
VLM="${VLM_BASE_URL:-${RTVI_VLM_BASE_URL:-http://${HOST_IP:-localhost}:8018}}"
VLM="${VLM%/v1}"
PROMPT='Describe in detail what is happening in this video,
including all visible people, vehicles, equipments, objects,
actions, and environmental conditions.
OUTPUT REQUIREMENTS:
[timestamp-timestamp] Description of what is happening.
EXAMPLE:
[0.0s-4.0s] <description of the first event>
[4.0s-12.0s] <description of the second event>'

curl -s --max-time 300 -X POST "$VLM/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d "$(jq -n \
        --arg model "${VLM_NAME:-nim_nvidia_cosmos-reason2-8b_hf-1208}" \
        --arg text "$PROMPT" \
        --arg url "<clip_url_from_vss_manage_video_io_storage>" \
        '{
          model: $model,
          temperature: 0.0,
          max_tokens: 1024,
          messages: [{
            role: "user",
            content: [
              {type: "text", text: $text},
              {type: "video_url", video_url: {url: $url}}
            ]
          }]
        }')" | jq -r '.choices[0].message.content'
```

**Response:** standard OpenAI chat-completion envelope. The summary is in
`choices[0].message.content`.

**Cosmos-model notes:** Cosmos Reason 2 supports reasoning via
`<think>...</think><answer>...</answer>` blocks. Omit the reasoning
instructions if you want a plain summary. Frame sampling and pixel limits
are applied server-side; no client-side prep is required when you pass a
`video_url`.

---

## End-to-end example

See [`references/end-to-end-example.md`](references/end-to-end-example.md) for
the full LVS-or-VLM-fallback script that probes `/v1/ready` and runs the
appropriate path.

---

## Responses

- **VLM** returns an OpenAI chat-completion envelope; summary is
  `choices[0].message.content`.
- **LVS service** returns the same envelope but `content` is a JSON string —
  run `jq -r '.choices[0].message.content' | jq` to reach `{video_summary, events}`.
- **Errors** surface as HTTP non-2xx plus JSON `{error: ...}`. LVS `503` usually
  means warmup — retry `/v1/ready`.

### Presenting the output to the user

Surface backend output with **minimal transformation** — do not paraphrase,
re-voice, add emojis, or reformat. **One backend call → one rendering**: no
parallel hedging, no duplicate headers, never call both LVS and VLM for the
same video.

**Header line.** Start with exactly one:

```
Summary of <video_name> (<duration>)
```

`<duration>` = `Ns` for `< 60 s`, else `Mm Ss` (e.g. `3m 30s`).

**LVS output:** render `video_summary` **verbatim** (polished, tone-controlled
report — rewriting loses fidelity). Render each `events` entry with its
`start_time`, `end_time`, `type`, and full `description` verbatim (table when
the client renders one cleanly, otherwise a per-event list). You MAY add a
one-line header and a closing offer to re-run with different parameters.

**VLM output:** render `choices[0].message.content` verbatim. If the model
produced `<think>…</think><answer>…</answer>` blocks, drop the `<think>`
block and show the answer.

**Fallback warning** (when applicable) goes **above** the summary, never
mixed into it.

## Tips

- **Route by service availability, not by duration.** Probe `/v1/ready` once
  in Setup; HTTP 200 → LVS+HITL for every clip; anything else → VLM fallback.
- **HITL is mandatory on the LVS path.** The `defaults` opt-in is the only
  sanctioned bypass. The VLM fallback path is silent (no HITL).
- **Readiness = HTTP 200 on `/v1/ready`. Nothing else.** Body may be empty.
  Always use `curl -s -o /dev/null -w '%{http_code}'` — never pipe through
  `jq`/`grep`/`head`.
- **Delegate VIOS to `vss-manage-video-io-storage`** — it is a sub-task; the
  final answer is the Step 2 summary, not the clip URL.
- **`jq` twice for LVS output.** First unwraps the OpenAI envelope, second
  parses the JSON string inside `content`.
- **Prefer `/v1/summarize` for 3.2 GA**; `/summarize` is a compatibility alias.
- **Use the exact VLM model id advertised by the endpoint** (default
  `nim_nvidia_cosmos-reason2-8b_hf-1208`).
- **Render output verbatim** — no paraphrasing, no reformatting, no rewriting
  the `video_summary` or `choices[0].message.content`.
- **One call, one render.** No parallel hedging, no double renderings.

## Cross-reference

- **vss-deploy-profile** — bring up the `base` (VLM only) or `lvs` (VLM + video summarization service) profile
- **vss-manage-video-io-storage** (VIOS API) — upload videos, list streams, get clip URLs
- **vss-search-archive** — semantic search across the archive (different profile)
- **vss-query-analytics** — query incidents/events from Elasticsearch
- **video summarization API reference** — [`references/video-summarization-api.md`](references/video-summarization-api.md)
- **video summarization service ops reference** — [`references/video-summarization-deployment.md`](references/video-summarization-deployment.md)

bump:2
