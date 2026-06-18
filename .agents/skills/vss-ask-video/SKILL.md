---
name: vss-ask-video
description: Use this skill to ask the VSS agent's video_understanding tool a fresh visual question about a recorded clip. Not for prior tool output, search hits, or metadata-answerable questions.
license: Apache-2.0
metadata:
  version: "3.2.0"
  github-url: "https://github.com/NVIDIA-AI-Blueprints/video-search-and-summarization"
  tags: "nvidia blueprint operational"
---

# Video QnA using VLM through VSS Agent

Use this skill when you need details about the video which requires VLM to look at the video frames — for example the agent has **no** usable prior answer and needs a **fresh look at the pixels** for a specific clip.

---

## When to Use

- The user asks **what happens in the video**, what **objects / people / actions** appear, **colors**, **timing**, **safety**, or other **visual facts** that require watching the clip.
- The user asks for **details** that **cannot be answered** from existing messages, summaries, Elasticsearch/MCP results, or filenames alone—you need **model inference on the video**.
- Follow-up questions about **content details** after a coarse summary or after report generation.

Do **not** use this skill when a **database / MCP / prior tool output** already answers the question, unless the user explicitly wants **verification** against the video.

---

## Deployment prerequisite

This skill requires a VSS profile that serves the `video_understanding` tool — typically **base** (recommended) or **lvs**. Before any request:

1. Probe the VSS agent:
   ```bash
   curl -sf --max-time 5 "http://${HOST_IP}:8000/docs" >/dev/null
   ```

2. **If the probe fails**, ask the user:
   > *"No VSS profile is running on `$HOST_IP`. Shall I deploy `base` (recommended for per-clip VLM QnA) using the `/vss-deploy-profile` skill? If you prefer `lvs`, say so."*

   - If yes → hand off to `/vss-deploy-profile -p base` (or `-p lvs` if the user prefers). Return here once it succeeds.
   - If no → stop.

3. If the probe passes, proceed.

---

## Sensor prerequisite

**You MUST list VST sensors before any `/generate` call.** This is required even when the user names the sensor explicitly, even when the user asserts the video is already uploaded, and even when a previous turn appeared to use the same video. Do not skip this step.

1. List sensors:
   ```bash
   curl -sf --max-time 5 "http://${HOST_IP}:30888/vst/api/v1/sensor/list" | jq '.[].name'
   ```

2. Compare the returned `name` values against the user-supplied `<sensor-id>` (or **filename stem**, e.g. `warehouse_safety_0001`).

3. **If a matching sensor is present** → proceed to the Agent workflow below.

4. **If no matching sensor is present** — upload the video first, then re-list to confirm the new sensor appears:
   ```bash
   # filename: must not contain whitespace
   # timestamp: ISO 8601 UTC — default 2025-01-01T00:00:00.000Z if user did not specify
   curl -s -X PUT "http://${HOST_IP}:30888/vst/api/v1/storage/file/<filename>?timestamp=<timestamp>" \
     -H "Content-Type: application/octet-stream" \
     -H "Content-Length: <file_size_in_bytes>" \
     --upload-file /path/to/<filename> | jq .
   ```
   See `/vss-manage-video-io-storage` for full upload semantics (v1 vs v2, conflict handling, delete flow). In interactive runs, confirm with the user before uploading. **Never** issue an unconditional PUT without first running the sensor-list check above — that is exactly the failure mode this prerequisite exists to prevent.

---

## Agent workflow

The Sensor prerequisite above must have already confirmed (or made) the sensor exist on VST. Then:

1. **Clip** — Identify **sensor id**, **filename**, or **URL** for one video segment. If ambiguous, ask the user.
2. Call vss agent with the sensor id and ask for it to call video_understanding tool to answer the user's question.
3. Return the vss agent's answer back to the user.


## Query VSS agent (`/generate`)

```bash
# Set from deployment (compose / .env / host where vss-agent listens)
export VSS_AGENT_BASE_URL="http://localhost:8000"

curl -s -X POST "${VSS_AGENT_BASE_URL}/generate" \
  -H "Content-Type: application/json" \
  -d '{"input_message": "Call video_understanding tool to answer the following question about <sensor-id>: <user query>"}' | jq .
```

### Response contract and extraction

`/generate` returns a JSON object with the assistant output in `value`, for example:

```json
{"value":"<agent-think><agent-think-step ...>...</agent-think-step></agent-think>\n\n<final answer>\n\n"}
```

There is no separate clean-answer field. The consumable answer is the text in `.value` after removing any `<agent-think>...</agent-think>` block.

Required handling for this skill (and any downstream caller):

1. Read `.value` from the JSON response.
2. Strip `<agent-think>...</agent-think>` sections wherever they appear.
3. Return only the remaining final-answer text to the user.

Example extraction:

```bash
curl -s -X POST "${VSS_AGENT_BASE_URL}/generate" \
  -H "Content-Type: application/json" \
  -d '{"input_message":"Call video_understanding tool to answer the following question about <sensor-id>: <user query>"}' \
| jq -r '.value' \
| python3 -c 'import re,sys; t=sys.stdin.read(); t=re.sub(r"<agent-think>.*?</agent-think>\s*", "", t, flags=re.S); print(t.strip())'
```

---

## Cross-Reference

- **vss-manage-video-io-storage** — VST storage/replay URLs so **`VIDEO_URL`** is valid for the VLM.
- **vss-generate-video-report** — timestamped **reports** via **Mode A (direct VLM)** or **Mode B (video-analytics incidents)**; this skill is **VSS-agent `/generate`** for ad-hoc **video Q&A**.
