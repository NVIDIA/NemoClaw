# Alert Subscriptions

Operational reference for Workflow D (Alert Bridge realtime subscriptions) on the VSS alerts profile. Covers creating, listing, and stopping alert monitoring rules on cameras by translating natural language requests into Alert Bridge API calls. Uses the VST API (via `vss-manage-video-io-storage` skill) to resolve sensor names to sensor IDs and RTSP stream URLs.

## When to Use

This skill is invoked as a **sub-workflow** of the parent `alerts` skill (Workflow D). The parent routes here when the user's message either contains rule-management keywords (`rule`, `subscription`, rule ID) **or** pairs a specific sensor name with a specific detection condition.

**Precondition: VLM real-time mode only.** Parent SKILL gates invocation of this playbook; assume the VLM (`-m real-time` / `MODE=2d_vlm`) profile is deployed and the alert-bridge backend is reachable. CV-mode deployments do not invoke this playbook (parent SKILL refuses with a redeploy hint).

**Create — sensor + detection condition (routed here by parent even without "rule"/"subscription" keywords):**
- "Set up a realtime alert on warehouse-dock-1 — flag anyone without a safety vest"
- "Monitor camera-lobby for unauthorized access after hours"
- "Create an alert on parking-cam-3 for vehicle collisions"
- "Watch sensor entrance-1 for tailgating"
- "Alert me if someone enters restricted zone on cam-floor-2"
- "Send me alerts for fallen boxes in camera warehouse_sample"
- "Notify me about people loitering near the loading dock on warehouse_sample"
- "Vehicle collisions needs an alert on warehouse_sample"

> **Create vs List — a request that names a *new detection condition* to watch for is a CREATE (issue `POST /api/v1/realtime`), even when phrased as "send me alerts for &lt;condition&gt;", "notify me about &lt;condition&gt;", or "&lt;condition&gt; needs an alert on &lt;sensor&gt;".** Such phrasings set up a *new* rule — they are NOT a request to list/show existing rules and NOT a query of past incidents. Only route to **List** when the user asks to see/show/list **existing** rules with **no** new condition to add. When a sensor + condition is present, you MUST `POST` to create the rule; listing (`GET`) alone does not satisfy a create request, and an already-existing similar rule does not excuse skipping the `POST`.

**List — rule inventory (show EXISTING rules; no new condition):**
- "Show me all realtime alert rules that are currently running"
- "What realtime alerts do we have set up right now?"
- "List active rules on warehouse-dock-1"
- "Show me PPE-related realtime rules"

**Stop — rule deletion:**
- "Stop the PPE alert on warehouse-dock-1"
- "Delete the collision rule on parking-cam-3"
- "Turn off the fire detection alert on cam-floor-2"
- "Stop rule 496aebd1-16d0-4123-81cf-10603e047d02"

**Not this skill** (handled by parent Workflow B instead):
- "Start real-time alert for sensor warehouse_sample" — no detection condition specified, generic start

---

## Setup

**1. Alert Bridge endpoint:** `http://${HOST_IP}:9080`
- It is reachable directly from the sandbox at this URL.
- Do NOT prompt the user for the endpoint; use this one.
- All Alert Bridge API calls use this base: `http://${HOST_IP}:9080/api/v1/realtime`

**2. Alert Bridge health check path:** `/health` (NOT `/api/v1/health`)
- The correct probe is:
  ```bash
  curl -sf --connect-timeout 5 "http://${HOST_IP}:9080/health"
  ```
- `/api/v1/health` returns 404 — do not use it.
- If the backend is unavailable (non-zero exit code or connection error), abort and report the connectivity error.

**3. Do NOT route through the VSS Agent `/generate` endpoint under any circumstance. Workflow D MUST call Alert Bridge directly at `http://${HOST_IP}:9080/api/v1/realtime`. If Alert Bridge is unreachable, abort and report the connectivity error — do not fall back to `/generate`.

**4. Payload must include `sensor_id` as the UUID from VIOS:**
- Call `GET http://${HOST_IP}:30888/vst/api/v1/sensor/list`
- Match by name, extract the `sensorId` field (UUID).
- Put that UUID in the Alert Bridge payload's `sensor_id` field — not the name.

**Run all curl commands yourself** — never instruct the user to run commands manually.

**Auth:** Optional. Most deployments run without auth. If a `401` is returned, retry with `-H "Authorization: Bearer <token>"` and ask the user for the token.

**Dependency — vss-manage-video-io-storage skill (VIOS/VST):**
This skill depends on the `vss-manage-video-io-storage` skill for VST endpoint resolution. The VST API at `http://${HOST_IP}:30888/vst/api/v1/` is used to look up sensor IDs, names, and RTSP stream URLs.
- If VST is unreachable, sensor resolution cannot proceed. Surface it as: "Cannot resolve sensor — the camera service (VST) is not responding. Please ensure VST is running and try again."

---

## Create Realtime Alert Rule

Full end-to-end flow: parse user message -> resolve sensor -> derive tag -> POST to Alert Bridge -> confirm.

### Step 1 — Parse the User Message

Extract two pieces from the user's natural language message:

| Field | Description |
|---|---|
| **sensor_name** | The camera/sensor the user wants to monitor |
| **prompt** | The condition or scenario the user wants to detect |

Example: *"Set up a realtime alert on warehouse-dock-1 — flag anyone entering aisle 4, aisle 5, or the rack B3 area without a safety vest."*
- `sensor_name` -> `warehouse-dock-1`
- `prompt` -> `flag anyone entering aisle 4, aisle 5, or the rack B3 area without a safety vest`

**Both fields are required.** If the sensor name is missing or ambiguous in the message, do NOT guess or pick a default sensor. Stop and ask the user: "Which sensor/camera do you want to monitor?" If the monitoring condition is missing, ask: "What condition should I watch for?" Never proceed to Step 2 without an explicit sensor name from the user.

---

### Step 2 — Resolve Sensor ID, Name, and RTSP URL

Resolve the user's sensor name to three values needed for the payload: `sensor_id`, `sensor_name`, and `live_stream_url`. Use the `vss-manage-video-io-storage` skill's VST endpoint.

**2a. Fetch the sensor list:**

```bash
curl -s "http://${HOST_IP}:30888/vst/api/v1/sensor/list" | jq .
```

Example response (each entry has `name` and `sensorId`):

```json
[
  {
    "name": "warehouse-dock-1",
    "sensorId": "2812768c-f21b-450e-a7be-2bbf406aaaa0",
    "state": "online",
    ...
  }
]
```

**2b. Match and extract `sensorId` + `name`:**

Find the entry whose `name` matches the user's sensor name (case-insensitive). From the matched entry, extract **both**:
- **`sensorId`** — e.g. `"2812768c-f21b-450e-a7be-2bbf406aaaa0"` → this becomes `sensor_id` in the payload
- **`name`** — e.g. `"warehouse-dock-1"` → this becomes `sensor_name` in the payload

If **no match** — reply with available sensor names and ask the user to clarify.
If **multiple matches** — list them and ask which one the user meant.

**2c. Fetch RTSP URL using the `sensorId`:**

```bash
curl -s "http://${HOST_IP}:30888/vst/api/v1/sensor/<sensorId>/streams" | jq .
```

Select the main stream (`isMain: true`) and extract the `url` field → this becomes `live_stream_url` in the payload.

If the sensor has no RTSP stream — report that the sensor exists but has no active video stream.

**Summary — three values to carry forward to Step 4:**

| Variable | Value from API | Payload field |
|---|---|---|
| `sensorId` | `GET /sensor/list` → matched entry `.sensorId` | `sensor_id` |
| `name` | `GET /sensor/list` → matched entry `.name` | `sensor_name` |
| RTSP `url` | `GET /sensor/{sensorId}/streams` → main stream `.url` | `live_stream_url` |

---

### Step 3 — Derive alert_type Tag

From the user's prompt, generate a short `snake_case` tag that summarizes the alert condition. This tag is used to identify and group alert rules.

**Derivation rules:**
- Lowercase, words separated by underscores
- 2-4 words maximum
- Descriptive of the specific monitoring condition
- **Derive it from the detection condition in *this* request only.** Map the *condition phrase*, not the sensor name, the sentence subject, or a location: "anyone without a safety vest" → `ppe_vest_violation` (NOT `box_dropped`), "smoke detection" → `smoke_detection` (NOT `camera_02`), "people loitering near the loading dock" → `people_loitering` (NOT `loading_dock`).
- **Never reuse an `alert_type` from an existing rule or a previous request.** If you list existing rules first (e.g. to check for duplicates), ignore their tags when deriving this one — a leftover `fallen_boxes`/`box_dropped` rule from an earlier request must not influence a safety-vest request.

**Examples:**

| User prompt | Derived `alert_type` |
|---|---|
| "flag anyone without a safety vest" | `ppe_vest_violation` |
| "detect vehicle collisions" | `vehicle_collision` |
| "unauthorized access after hours" | `unauthorized_access` |
| "detect fire or smoke" | `fire_smoke_detection` |
| "person falling down" | `fall_detection` |
| "someone entering restricted zone" | `restricted_zone_entry` |
| "ladder safety violations" | `ladder_safety_violation` |

---

### Step 4 — Build and POST to Alert Bridge

Construct the payload using values collected from the previous steps and POST to the Alert Bridge realtime endpoint:

```bash
curl -s -X POST "http://${HOST_IP}:9080/api/v1/realtime" \
  -H "Content-Type: application/json" \
  -d '{
    "live_stream_url": "<RTSP_URL>",
    "sensor_id": "<SENSOR_ID>",
    "sensor_name": "<SENSOR_NAME>",
    "alert_type": "<DERIVED_TAG>",
    "prompt": "<USER_PROMPT>",
    "system_prompt": "Answer yes or no",
    "chunk_duration": 30,
    "chunk_overlap_duration": 5
  }' | jq .
```

**Send this canonical payload consistently.** Use exactly these field names
and the fixed defaults shown (`system_prompt: "Answer yes or no"`,
`chunk_duration: 30`, `chunk_overlap_duration: 5`) on every create — do not
improvise extra fields, rename fields, or vary the defaults between requests.
Only `live_stream_url`, `alert_type`, and `prompt` are strictly required by the
API; the three sensor/`system_prompt`/chunk fields above are skill conventions
that keep created rules uniform and the behavior reproducible. Omit `model` (the
service falls back to its configured default).

**Payload field reference:**

| Field | Source | Default | Description |
|---|---|---|---|
| `live_stream_url` | Step 2c — RTSP `url` from `GET /sensor/{sensorId}/streams` | — | RTSP URL of the target camera stream |
| `sensor_id` | Step 2b — `sensorId` field from `GET /sensor/list` match | — | Unique identifier of the sensor in VIOS (UUID) |
| `sensor_name` | Step 2b — `name` field from `GET /sensor/list` match | — | Human-readable name of the camera/sensor being monitored |
| `alert_type` | Step 3 — auto-derived | — | Short snake_case tag for the alert condition |
| `prompt` | Step 1 — extracted from user message | — | Natural language description of what to detect |
| `system_prompt` | Skill default | `"Answer yes or no"` | Instruction for the vision model evaluating each chunk |
| `chunk_duration` | Skill default | `30` | Duration in seconds of each video chunk analyzed |
| `chunk_overlap_duration` | Skill default | `5` | Overlap in seconds between consecutive chunks |

---

### Step 5 — Handle Response and Confirm

**On 201 Created:**

```json
{
  "status": "success",
  "id": "496aebd1-16d0-4123-81cf-10603e047d02",
  "created_at": "2026-04-21T11:09:40.111515+00:00",
  "message": "Realtime alert rule created"
}
```

Reply to the user (must include the rule UUID from the response `id` field):
> "Done. Realtime alert `<id>` is live on **<sensor_name>** (tag: `<alert_type>`)."

---

## List Active Realtime Alert Rules

Fetch running alert rules from Alert Bridge, reverse-resolve RTSP URLs to sensor names, and display a readable list. Users never see RTSP URLs.

### Step 1 — Detect Filters from the Message

Both filters are optional. Extract if present:

| Filter | Description | Example message |
|---|---|---|
| **sensor_name** | Show rules for a specific sensor only | *"List active rules on warehouse-dock-1"* |
| **alert_type** | Show rules matching a specific tag | *"Show me PPE-related realtime rules"* |

If neither filter is present, return all active rules.

---

### Step 2 — Resolve Sensor Filter (if present)

If the user specified a `sensor_name`, resolve it to RTSP URL(s) via the VST API. Follow the same resolution workflow as in Create Step 2 (fetch `/sensor/list`, match by name, then get streams).

The resolved RTSP URL(s) are used **only for client-side filtering** — to match against `live_stream_url` values returned by Alert Bridge in the next step.

---

### Step 3 — Fetch Rules from Alert Bridge

```bash
curl -s "http://${HOST_IP}:9080/api/v1/realtime" | jq .
```

If the user specified an `alert_type` tag, add it as a query parameter:
```bash
curl -s "http://${HOST_IP}:9080/api/v1/realtime?alert_type=<TAG>" | jq .
```

**Client-side filtering on the response:**
- If **sensor filter** is active: compare each rule's `live_stream_url` against the RTSP URL(s) resolved in Step 2. Remove rules that do not match.
- If **alert_type filter** is active and was not already applied via query parameter: compare each rule's `alert_type` against the filter value. Remove rules that do not match.

---

### Step 4 — Resolve Sensor Names for Display

For each rule remaining after filtering, determine the human-readable sensor name:

1. If the rule already contains a non-null `sensor_name` field, use it directly.
2. Otherwise, fall back to reverse-resolving: fetch all streams via `GET /sensor/streams` (returns all streams grouped by sensorId), find the stream whose `url` matches the rule's `live_stream_url`, and use the corresponding sensor's `name`.
3. If neither approach yields a name, show the rule's `sensor_id` (or the literal `(unresolved sensor)`) — **never** print the raw `live_stream_url` / `rtsp://` URL to the user.

---

### Step 5 — Render the List

Display one line per rule with these fields:

| Field | Source |
|---|---|
| **Sensor** | Reverse-resolved sensor name from Step 4 |
| **Tag** | `alert_type` from the rule |
| **Prompt** | `prompt` from the rule (truncate if longer than ~80 chars) |
| **Created** | `created_at` from the rule |
| **Rule ID** | `id` from the rule |

> **Never expose raw RTSP / `live_stream_url` values in your reply.** The user must see only the reverse-resolved **sensor name** (or the `sensor_id` fallback) — do NOT print `rtsp://...` URLs, and do NOT dump the raw rule JSON. Show only human-readable fields: sensor name, tag, prompt, created time, rule ID. Leaking an `rtsp://` URL is an error.

**Empty list is a success case.** If no rules are returned (or all are filtered out), reply:
> "No realtime alert rules are currently running."

Do not treat an empty list as an error.

---

## Stop Realtime Alert Rule

**How "stop" works — two distinct user intents, two distinct agent behaviors:**

| User says | What it means | Agent does |
|---|---|---|
| "Stop X on Y" / "Delete the rule" / "Remove alert" | **Request to stop** — triggers confirmation | Find the rule -> reply with yes/no question -> do nothing else |
| "yes" (after a confirmation question) | **Confirmation** — triggers deletion | Call DELETE -> report result |

"Stop X" and "yes" are NOT the same intent. "Stop X" always produces a question. Only "yes" produces a deletion. Even if you already know the rule ID from conversation context, "Stop X" still produces only a question.

> **This confirmation is a user-facing safety gate, not a setup/deploy confirmation.** It ALWAYS applies — including under autonomous, pre-authorized, or non-interactive/CI execution. A "run autonomously / do not ask for confirmation" instruction authorizes deploy and setup actions only; it does NOT authorize you to skip this stop/delete confirmation. When there is no interactive user to answer (e.g. an eval harness), reply with the yes/no confirmation question (stating the rule ID and sensor) and STOP — do not issue the `DELETE`.

### On "Stop" Request — Find Rule and Ask Confirmation

**Parse sensor name and alert type from the message:**

| Field | Description |
|---|---|
| **sensor_name** | The camera/sensor the rule is running on |
| **alert_type** | The tag identifying the rule (e.g. `ppe_vest_violation`) |

Example: *"Stop the PPE alert on warehouse-dock-1."*
- `sensor_name` -> `warehouse-dock-1`
- `alert_type` -> `ppe_vest_violation` (or partial: `ppe`)

**Both fields are required.** If either is missing, ask the user to clarify. Do NOT guess or reuse values from conversation context.

**Fetch rules and filter:**

```bash
curl -s "http://${HOST_IP}:9080/api/v1/realtime" | jq .
```

Resolve the user's `sensor_name` to RTSP URL(s) via the VST API (same as Create Step 2), then apply both filters client-side on the response:
- **Sensor filter:** compare each rule's `live_stream_url` against the resolved RTSP URL(s). Remove rules that do not match.
- **Alert type filter:** compare each rule's `alert_type` against the tag from the message. Remove rules that do not match. Use substring/prefix matching (e.g. user says "PPE" -> matches `ppe_vest_violation`).

**Handle match count:**

| Matches | Action |
|---|---|
| **0** | Reply: "No matching rule found for `<alert_type>` on **<sensor_name>**. Would you like to see what's currently running?" |
| **>1** | Reply: "Multiple rules match that description. Please be more specific — for example, include the exact alert type tag." Do NOT show a numbered picker. |
| **1** | Reply with the confirmation question below. |

**Your reply for 1 match — only this, nothing else:**

> "Stop alert `<alert_type>` on **<sensor_name>**? (rule ID: `<id>`) — yes/no"

---

### On "Yes" — Execute Deletion

This section applies only when the user's message is "yes" (or equivalent) in response to the confirmation question above.

- User said **no** -> reply "OK, the rule stays active."
- User said something unclear -> reply with the confirmation question again.
- User said **yes** -> execute:

```bash
curl -s -X DELETE "http://${HOST_IP}:9080/api/v1/realtime/<RULE_ID>" | jq .
```

**Response handling:**

| Status | Meaning | Reply |
|---|---|---|
| **200 OK** | Rule deleted successfully | "Done. Alert `<alert_type>` on **<sensor_name>** has been stopped (rule `<id>`)." |
| **404 `not_found`** | Rule ID does not exist (already stopped or expired) | "That rule is no longer active — nothing to stop." |
| **502 `rtvi_vlm_unavailable`** | RTVI VLM `stop_stream` failed | "The rule was found but the video intelligence service failed to stop the stream. Please try again later." |

---

## Error Handling

All errors must be translated into plain language. Never show raw HTTP responses, status codes, stack traces, or internal identifiers to the user.

| Scenario | User-facing message |
|---|---|
| VST unreachable | "Cannot resolve sensor — the camera service (VST) is not responding. Please ensure VST is running and try again." |
| Sensor name not found | "Sensor '`<name>`' was not found. Available sensors: `<list>`. Did you mean one of these?" |
| Multiple sensor matches | "Multiple sensors match '`<name>`': `<list>`. Which one did you mean?" |
| Sensor has no RTSP stream | "Sensor '`<name>`' exists but does not have an active video stream." |
| Sensor is file-based (not RTSP) | "Sensor '`<name>`' is a file-based sensor, not a live camera. Realtime alerts require a live RTSP stream." |
| Alert Bridge unreachable | "The alert service is not reachable. Please check that the Alert Bridge is running." |
| Alert Bridge 4xx (create) | "Could not create the alert rule — the request was rejected. Please verify the sensor stream is valid and try again." |
| Alert Bridge 4xx (list) | "Could not fetch alert rules — the request was rejected. Please try again." |
| Alert Bridge 404 `not_found` (stop) | "That rule is no longer active — nothing to stop." |
| Alert Bridge 502 `rtvi_vlm_unavailable` (stop) | "The rule was found but the video intelligence service failed to stop the stream. Please try again later." |
| Alert Bridge 5xx (other) | "The alert service is experiencing issues. Please try again later." |
| Reverse-resolve failed | Display the raw RTSP URL as fallback — do not fail the entire list because one sensor name could not be resolved. |

---

## Tips

- **RTSP streams only:** Realtime alerts require a live RTSP stream. When resolving a sensor in Step 2, verify the stream `url` starts with `rtsp://`. If the `url` is a file path (e.g. `"/data/vst/streamer_videos/video.mp4"`), the sensor is a file-based upload and cannot be used for realtime monitoring. Report: "Sensor '`<name>`' is a file-based sensor, not a live camera. Realtime alerts require a live RTSP stream."
- **jq:** All JSON responses are piped through `jq .` for readability.
- **Endpoint resolution:** The host comes from the `$HOST_IP` environment variable — Alert Bridge at `http://${HOST_IP}:9080`, VST at `http://${HOST_IP}:30888`. The ports are fixed; do not prompt the user for the host or ports.
- **Prompt passthrough:** The user's prompt is sent verbatim to the Alert Bridge `prompt` field. Do not rephrase, summarize, or alter it — the vision model needs the user's original intent.

---

## Cross-Reference

- **vss-manage-video-io-storage** — sensor lookup, RTSP stream URL resolution, and VST API access (required dependency)
- **alert-notify** — forward incidents generated by these alert rules to configured notification backends (Slack, Dashboard)
