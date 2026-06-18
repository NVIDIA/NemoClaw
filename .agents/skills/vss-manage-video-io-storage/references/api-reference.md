# VIOS REST API Reference

## Sample data bootstrap

VIOS stores videos uploaded by the user. For requests that reference a
**"sample"** video by friendly name (e.g. *"the sample warehouse
video"*, *"sample-warehouse-ladder"*, *"warehouse_safety_0001"*) the
expected file is one of the 8 mp4s shipped in NGC bundle
`nvidia/vss-developer/dev-profile-sample-data:3.2.0`. Before any
upload-style request, ensure the bundle is extracted locally:

```bash
SAMPLE_DIR="/tmp/vss-sample-data/dev-profile-sample-data"

if [ ! -d "$SAMPLE_DIR" ]; then
  mkdir -p /tmp/vss-sample-data
  cd /tmp/vss-sample-data

  # NGC CLI required (export NGC_CLI_API_KEY first if not already set).
  ngc registry resource download-version \
    nvidia/vss-developer/dev-profile-sample-data:3.2.0 \
    --org nvidia --team vss-developer

  # Bundle ships as a single tar.gz inside dev-profile-sample-data_v3.2.0/.
  tar -xzf dev-profile-sample-data_v3.2.0/dev-profile-sample-data.tar.gz
fi

ls "$SAMPLE_DIR"/  # verify expected mp4s present
```

Bundle contents (use these filenames verbatim when asked for *"the
&lt;name&gt; video"*):

| Friendly name in user query | Local filename |
|---|---|
| sample warehouse video | `warehouse_sample.mp4` |
| sample-warehouse-ladder | `sample-warehouse-ladder.mp4` |
| warehouse safety 1 / 2 | `warehouse_safety_0001.mp4` / `warehouse_safety_0002.mp4` |
| sample-sim-traffic | `sample-sim-traffic.mp4` |
| sample-sim-jaywalking | `sample-sim-jaywalking.mp4` |
| sample-sim-box-conveyor | `sample-sim-box-conveyor.mp4` |
| sample-drone-bridge | `sample-drone-bridge.mp4` |

If the user names a video that isn't in this list (e.g. *"airport
video"*, *"neon-pink monster truck"*), do **not** substitute a
similar-sounding bundle file — list the available names back to the
user and ask which one they meant. Don't invent paths or fabricate
upload responses.

`NGC_CLI_API_KEY` must be set in the environment for `ngc registry`
calls to authenticate. The variable is provided by the deploy/eval
harness; if it's missing, fail with the actionable error rather than
trying to proceed.

---


## Operations

### 1. Version / Health Check

Lightweight endpoint to verify the VST backend is reachable. Used as the availability check before any other API call.

```bash
curl -sf --connect-timeout 5 "http://<VST_ENDPOINT>/vst/api/v1/sensor/version" | jq .
```
Response: version metadata for the running VST service.

---

### 2. Sensor List

**List all sensors:**
```bash
curl -s "http://<VST_ENDPOINT>/vst/api/v1/sensor/list" | jq .
```
Response: array of sensor objects. Key fields: `sensorId`, `name`, `location`, `state` (online/offline/removed), `sensorIp`, `hardwareId`, `tags`, `type`, `isTimelinePresent`, `isRemoteSensor`.

**Get single sensor info:**
```bash
curl -s "http://<VST_ENDPOINT>/vst/api/v1/sensor/<sensorId>/info" | jq .
```
Response: hardware metadata — `sensorId`, `name`, `sensorIp`, `location`, `manufacturer`, `hardware`, `hardwareId`, `firmwareVersion`, `serialNumber`, `tags`, `isRemoteSensor`, `position`. Does **not** include `state` or `type` — use `GET /sensor/status` for state, `GET /sensor/list` for type.

**Get sensor status (all):**
```bash
curl -s "http://<VST_ENDPOINT>/vst/api/v1/sensor/status" | jq .
```
Response: object keyed by `sensorId`, each with `{name, state, errorCode, errorMessage}`.

**Get status of a single sensor:**
```bash
curl -s "http://<VST_ENDPOINT>/vst/api/v1/sensor/<sensorId>/status" | jq .
```
Response: `{name, state, errorCode, errorMessage}`.

**Get streams for a sensor** (returns `streamId` values needed for clip/snapshot calls):
```bash
curl -s "http://<VST_ENDPOINT>/vst/api/v1/sensor/<sensorId>/streams" | jq .
```
Response fields per stream: `streamId`, `isMain`, `url`, `vodUrl`, `name`, metadata with `bitrate`, `codec`, `framerate`, `resolution`.

**Get all streams across all sensors** (grouped by sensorId):
```bash
curl -s "http://<VST_ENDPOINT>/vst/api/v1/sensor/streams" | jq .
```

**Get all active live streams:**
```bash
curl -s "http://<VST_ENDPOINT>/vst/api/v1/live/streams" | jq .
```

**Get all streams available for replay:**
```bash
curl -s "http://<VST_ENDPOINT>/vst/api/v1/replay/streams" | jq .
```

---

### 3. Timelines & Storage Size

Always use the `/storage` service for timelines.

**Get timeline for a specific stream:**
```bash
curl -s "http://<VST_ENDPOINT>/vst/api/v1/storage/<streamId>/timelines" | jq .
```

**Get timelines for all streams:**
```bash
curl -s "http://<VST_ENDPOINT>/vst/api/v1/storage/timelines" | jq .
```

**Get timelines filtered to specific streams:**
```bash
curl -s "http://<VST_ENDPOINT>/vst/api/v1/storage/timelines?streams=<streamId1>&streams=<streamId2>" | jq .
```

Response: object mapping `streamId` -> array of `{startTime, endTime}` (ISO 8601).

**Get storage usage (per-stream and totals):**
```bash
curl -s "http://<VST_ENDPOINT>/vst/api/v1/storage/size" | jq .
```
Response: object keyed by `streamId`, each with `{sizeInMegabytes, state}`, plus a `total` key with `{sizeInMegabytes, totalDiskCapacity, totalAvailableStorageSize, remainingStorageDays}`.

---

### 4. Video Clip Extraction

> **startTime / endTime:** Use values provided by the user. If not provided, first run:
> ```bash
> curl -s "http://<VST_ENDPOINT>/vst/api/v1/storage/<streamId>/timelines" | jq .
> ```
> Pick `startTime` and `endTime` from within a valid recorded range returned by that response.

**Download clip as binary (TS container by default):**
```bash
curl -s "http://<VST_ENDPOINT>/vst/api/v1/storage/file/<streamId>?startTime=<startTime>&endTime=<endTime>&disableAudio=true" \
  -o clip.ts
```

**Download clip as MP4:**
```bash
curl -s "http://<VST_ENDPOINT>/vst/api/v1/storage/file/<streamId>?startTime=<startTime>&endTime=<endTime>&container=mp4&disableAudio=true" \
  -o clip.mp4
```

**Get a temporary URL for the clip** (returns a URL instead of streaming bytes — preferred for large clips):
```bash
# expiryMinutes is optional; default is 10080 (7 days)
curl -s "http://<VST_ENDPOINT>/vst/api/v1/storage/file/<streamId>/url?startTime=<startTime>&endTime=<endTime>&container=mp4&disableAudio=true&expiryMinutes=<expiryMinutes>" | jq .
```
Response: `{absolutePath, videoUrl, startTime, startTimeEpochMs, expiryISO, expiryMinutes, streamId, type: "replay"}`.
Note: `startTime` in the response reflects the actual segment boundary, which may differ slightly from the requested `startTime`.

**Query parameters for clip download/URL:**

| Parameter | Required | Description |
|---|---|---|
| `startTime` | Yes | ISO 8601 UTC. Use user-provided value, or fetch timelines first to get a valid range. |
| `endTime` | Yes | ISO 8601 UTC. Must fall within the same recorded segment as `startTime`. |
| `container` | No | `mp4` (default: `mp2t`/TS) |
| `disableAudio` | No | Always pass `true` — VIOS does not support audio for files with B-frames; disabled by default to avoid failures |
| `transcode` | No | `none` (default, fastest), `full` (re-encode), or `gop` (re-encode only at GOP boundaries — incompatible with overlay) |
| `fullLength` | No | boolean; if true, snaps to full segment boundaries |
| `uselibav` | No | boolean (default `false`); when `true`, uses libav-based mux path instead of GStreamer |
| `fileName` | No | override the output download filename (default is auto-generated) |
| `expiryMinutes` | No (URL only) | minutes until URL expires, default 10080 (7 days) |
| `blocking` | No (URL only) | boolean (default `true`); when `false`, returns a task URL whose body becomes available asynchronously |
| `configuration` | No | JSON string with extra encode options (resolution, etc.) — only honored when `transcode=full` |

---

### 5. Snapshot / Picture

#### Live snapshot (most recent frame from sensor)
```bash
# width and height are optional; omit to use native sensor resolution (max 8000x4000)
curl -s "http://<VST_ENDPOINT>/vst/api/v1/live/stream/<streamId>/picture?width=<width>&height=<height>" \
  -H "streamId: <streamId>" \
  -o snapshot.jpg
```

**Get temporary URL for live snapshot** (no download, returns URL):
```bash
curl -s "http://<VST_ENDPOINT>/vst/api/v1/live/stream/<streamId>/picture/url" \
  -H "streamId: <streamId>" | jq .
```
Response: `{absolutePath, imageUrl, expiryISO, expiryMinutes, streamId, type: "live"}`.

#### Historical snapshot (frame at a specific timestamp from recordings)

> **startTime:** Use the value provided by the user. If not provided, first fetch timelines to find a valid range:
> ```bash
> curl -s "http://<VST_ENDPOINT>/vst/api/v1/storage/<streamId>/timelines" | jq .
> ```
> Pick any timestamp within a returned `{startTime, endTime}` range.

```bash
# startTime is ISO 8601 UTC — the frame closest to this timestamp is returned
curl -s "http://<VST_ENDPOINT>/vst/api/v1/replay/stream/<streamId>/picture?startTime=<startTime>" \
  -H "streamId: <streamId>" \
  -o snapshot_recorded.jpg
```

Optional: `width`, `height` query parameters (string format, e.g. `width=<width>`).

**Get temporary URL for historical snapshot:**
```bash
curl -s "http://<VST_ENDPOINT>/vst/api/v1/replay/stream/<streamId>/picture/url?startTime=<startTime>" \
  -H "streamId: <streamId>" | jq .
```

#### Storage snapshot variant

A second historical-snapshot variant exists under `/storage/...` that mirrors the replay variant.

```bash
# startTime is ISO 8601 UTC — the frame closest to this timestamp is returned
curl -s "http://<VST_ENDPOINT>/vst/api/v1/storage/stream/<streamId>/picture?startTime=<startTime>" \
  -H "streamId: <streamId>" \
  -o snapshot_storage.jpg
```

Optional query params: `width`, `height`, `frameId` (NvStreamer only), `overlay` (JSON), `debug` (boolean — enables overlay/bbox debug rendering). The same params are honored on the `/picture/url` variant.

**Get temporary URL for storage snapshot:**
```bash
curl -s "http://<VST_ENDPOINT>/vst/api/v1/storage/stream/<streamId>/picture/url?startTime=<startTime>" | jq .
```
Response: `{absolutePath, imageUrl, expiryISO, expiryMinutes, streamId, type: "replay"}` — same shape as the replay `/picture/url` response.

> **streamId header rule:** required for `/live/stream/{streamId}/picture[/url]` and `/replay/stream/{streamId}/picture[/url]`. NOT required for `/storage/stream/{streamId}/picture[/url]` — the storage variant accepts streamId from the path alone. Pattern for all: `^[a-zA-Z0-9_-]+$`, max 100 chars.

---

### 6. Add Sensor / Stream

**Add sensor by IP (ONVIF):**
```bash
# sensorIp: camera IP address; name/location are optional labels
curl -s -X POST "http://<VST_ENDPOINT>/vst/api/v1/sensor/add" \
  -H "Content-Type: application/json" \
  -d '{
    "sensorIp": "<sensorIp>",
    "username": "<username>",
    "password": "<password>",
    "name": "<name>",
    "location": "<location>"
  }' | jq .
```
Response: `{"sensorId": "<uuid>"}`.

**Add sensor by RTSP URL:**
```bash
# sensorUrl: full RTSP URL with credentials embedded, e.g. rtsp://<username>:<password>@<ip>:<port>/<path>
# username/password are part of the URL — do not include them separately in the body
# name: use the last segment of the RTSP URL path as the default (e.g. for rtsp://.../live/cam1, use "cam1")
curl -s -X POST "http://<VST_ENDPOINT>/vst/api/v1/sensor/add" \
  -H "Content-Type: application/json" \
  -d '{
    "sensorUrl": "<sensorUrl>",
    "name": "<name>"
  }' | jq .
```

Optional fields for both: `hardware`, `manufacturer`, `serialNumber`, `firmwareVersion`, `hardwareId`, `tags`.

**Trigger network scan for sensors:**
```bash
curl -s -X POST "http://<VST_ENDPOINT>/vst/api/v1/sensor/scan" | jq .
```

---

### 7. Delete Sensor (RTSP / non-file sensors)

Use this to delete sensors that are **not** uploaded files (e.g. RTSP streams added to VIOS):
```bash
# Returns true on success
curl -s -X DELETE "http://<VST_ENDPOINT>/vst/api/v1/sensor/<sensorId>" | jq .
```
This removes the sensor from all VIOS APIs but does **not** delete recordings from disk.

> **RTSP full cleanup:** Calling only `DELETE /sensor/<sensorId>` leaves orphaned recordings on disk. See the delete guidance in Section 8 for the complete two-step RTSP removal flow.

---

### 8. File Upload / Delete

There are two PUT upload APIs. Use the new API (v2) for most cases.

#### PUT Upload — New API (v2): `PUT /storage/file/{filename}`

Filename in path, timestamp and sensorId as query params.

```bash
# filename: must not contain whitespace
# timestamp: ISO 8601 UTC, e.g. 2025-01-01T00:00:00.000Z — default when user has not specified: 2025-01-01T00:00:00.000Z
# sensorId: optional — if omitted, server generates a UUID; if provided and already exists, file is added as a sub-stream of that sensor
curl -s -X PUT "http://<VST_ENDPOINT>/vst/api/v1/storage/file/<filename>?timestamp=<timestamp>&sensorId=<sensorId>" \
  -H "Content-Type: application/octet-stream" \
  -H "Content-Length: <file_size_in_bytes>" \
  --upload-file /path/to/video.mp4 | jq .
```

Key behavior:
- Returns **409 Conflict** if a file with the same name already exists — does NOT auto-rename
- `sensorId` query param: if provided, used as the sensorId (allows grouping under an existing sensor as a sub-stream); if omitted, a new random UUID is generated
- `Content-Length` header is required

---

#### PUT Upload — Legacy API (v1): `PUT /storage/file/{filename}/{timestamp}`

Both filename and timestamp in the path. No query params.

```bash
# filename: must not contain whitespace
# timestamp: ISO 8601 UTC, e.g. 2025-01-01T00:00:00.000Z — default when user has not specified: 2025-01-01T00:00:00.000Z
curl -s -X PUT "http://<VST_ENDPOINT>/vst/api/v1/storage/file/<filename>/<timestamp>" \
  -H "Content-Type: application/octet-stream" \
  -H "Content-Length: <file_size_in_bytes>" \
  --upload-file /path/to/video.mp4 | jq .
```

Key behavior:
- If a file with the same name already exists, **auto-generates a unique filename** (no 409)
- sensorId is **always a newly generated random UUID** — there is no way to specify or reuse an existing sensorId; the `sensorId` query param is ignored even if passed

---

**Response (both APIs):** `{id, filename, bytes, sensorId, streamId, filePath, timestamp, created_at}`.
- `id` — unique file identifier
- `sensorId` / `streamId` — assigned sensor and stream (auto-generated UUID if not provided)
- `filePath` — absolute path on disk where the file is stored
- `created_at` — epoch ms when file was uploaded
- 413 if payload too large; 422 if codec unsupported; 507 if disk full

**Delete an uploaded file** (removes physical file from disk AND removes sensor from all APIs):
```bash
# streamId: use the streamId returned in the upload response (or from sensor/{sensorId}/streams)
# startTime / endTime: use the timeline range for this streamId (fetch from /storage/<streamId>/timelines)
# Returns {spaceSaved: <MB>}
curl -s -X DELETE "http://<VST_ENDPOINT>/vst/api/v1/storage/file/<streamId>?startTime=<startTime>&endTime=<endTime>" | jq .
```

> **Identify sensor type before deleting:** call `GET /sensor/<sensorId>/streams` and check the `url` field.
> - If `url` starts with `rtsp://` → RTSP/IP sensor
> - If `url` is a file path (e.g. `${VST_CONTAINER_ROOT}/.../video.mp4`) → uploaded file sensor
>
> **Which delete to use:**
> - **Uploaded file sensor** — use ONLY `DELETE /storage/file/<streamId>?startTime=...&endTime=...`. This deletes the physical file and removes the sensor from all APIs. Do NOT use `DELETE /sensor/<sensorId>` alone — it removes the sensor from APIs but leaves the physical file on disk.
> - **RTSP sensor** — use BOTH in order: first `DELETE /sensor/<sensorId>` (stops recording, removes from APIs), then `DELETE /storage/file/<streamId>?startTime=...&endTime=...` (deletes recordings from disk). Using only the storage delete on an RTSP sensor erases existing recordings but the sensor stays active and keeps recording.

> **File sensor timeline times:** Uploaded file sensors report timelines relative to the timestamp provided at upload time, not the upload wall-clock time. If the default was used, timelines start at `2025-01-01T00:00:00.000Z`. Always fetch the timeline first before building the delete command — never assume times based on upload time.

---

## Extended Service Map

The microservices below all sit behind the same `<VST_ENDPOINT>/vst/api/v1/...` gateway. Each microservice exposes its own `/version`, `/help`, and `/configuration` family of endpoints.

| Microservice | URL prefix | Covered in sections |
|---|---|---|
| Sensor management | `/vst/api/v1/sensor/` | 2, 6, 7, 9, 10 |
| Storage management | `/vst/api/v1/storage/` | 3, 4, 5, 8, 15 |
| Live stream (WebRTC) | `/vst/api/v1/live/` | 2, 5, 12 |
| Replay stream (WebRTC) | `/vst/api/v1/replay/` | 2, 5, 13 |
| Recorder | `/vst/api/v1/record/` | 11 |
| RTSP proxy | `/vst/api/v1/proxy/` | 14 |

All endpoints return JSON unless they stream binary (clips, snapshots). Time values are ISO 8601 UTC (e.g. `2026-05-13T04:42:53.620Z`). `sensorId` / `streamId` patterns: `^[a-zA-Z0-9_-]+$`, max 100 chars. Error shape: `{error_code, error_message}`.

---

### 9. Sensor Settings & Lifecycle

Per-sensor operations beyond add/delete.

> **ONVIF-only:** `credentials`, `network`, `reboot`, `replace`, and `settings` only work on ONVIF cameras. On file-uploaded sensors and RTSP-URL sensors, `network`/`reboot`/`replace`/`credentials` typically return `{error_code: "VMSInternalError"}` and `settings` returns `null`. Verify sensor type with `GET /sensor/<sensorId>/streams` (`url` starts with `rtsp://` → RTSP; `url` is a file path → file; otherwise ONVIF) before calling these endpoints — do NOT retry on the error.

**Set sensor credentials** — credentials cannot be read; POST overwrites:
```bash
curl -s -X POST "http://<VST_ENDPOINT>/vst/api/v1/sensor/<sensorId>/credentials" \
  -H "Content-Type: application/json" \
  -d '{"username": "<username>", "password": "<password>"}' | jq .
```
- **Response on success**: the JSON literal `true`.
- **Errors**: `CameraNotFoundError` (`Invalid Sensor ID <id>` — note capital S) for unknown sensor; `InvalidParameterError` (`setSensorCredentials: invalid username or password`) on auth failure.
- **Side effects**: when credentials change, the server updates in-memory state, resets sensor http error status to `NoError`, refetches sensor info, and (if `remote_vst_address` is configured) pushes the update to the remote VST.
- **Short-circuit**: if the submitted credentials match what is already stored, the server returns `true` without re-validating against the camera.

Use this before any ONVIF operation if the sensor was added without credentials.

**Get sensor network info:**
```bash
curl -s "http://<VST_ENDPOINT>/vst/api/v1/sensor/<sensorId>/network" | jq .
```
Response: `{ipAddressV4, ipAddressV6, subnetMaskV4, subnetMaskV6, dhcpV4, dhcpV6, isIpv4Enabled, isIpv6Enabled}`.
- `dhcpV4`/`dhcpV6` are strings (e.g. `"false"`, `"Off"`), not booleans.
- `subnetMaskV4` is a dotted-quad string (for example, `"<ipv4-subnet-mask>"`).
- `subnetMaskV6` is a numeric prefix-length **string** (e.g. `"64"`), NOT a dotted netmask — asymmetric with IPv4.

**Set sensor network info** (POST, not PUT):
```bash
curl -s -X POST "http://<VST_ENDPOINT>/vst/api/v1/sensor/<sensorId>/network" \
  -H "Content-Type: application/json" \
  -d '{
    "ipAddressV4": "<ip>",
    "subnetMaskV4": "<mask>",
    "dhcpV4": "false",
    "isIpv4Enabled": true
  }' | jq .
```
Response: `{rebootNeeded: <bool>}`. If `true`, follow up with `/reboot`.

**Reboot sensor remotely:**
```bash
curl -s -X POST "http://<VST_ENDPOINT>/vst/api/v1/sensor/<sensorId>/reboot"
```
Response: empty on success. Sensor is unreachable for some time after.

**Replace an inactive sensor with an active one** (transfers data/identity):
```bash
# inactiveSensorId is the sensor being replaced; the body holds the active replacement
curl -s -X POST "http://<VST_ENDPOINT>/vst/api/v1/sensor/<inactiveSensorId>/replace" \
  -H "Content-Type: application/json" \
  -d '{"sensorId": "<activeSensorId>"}'
```
Response: empty on success.

- The body field name is `sensorId`. The server also accepts `deviceid` as a legacy alias when `sensorId` is absent.
- **Pre-conditions** (any failure → `InvalidParameterError`):
  - Old sensor must exist (`Old Sensor does not exists, cannot replace`).
  - New sensor must exist (`New Sensor does not exists, cannot replace`).
  - Old sensor must be inactive — if its status is `online` or `streaming`, returns `Old Sensor still active, cannot replace`.
  - Neither sensor may be a CSI sensor (`Old/new sensor is a CSI sensor, cannot replace`).
- If both `sensorId` and `deviceid` are missing from the body, the response may have an empty body — treat any non-NoError return as failure.
- **Side effects**: heavy operation. Renames streams, persists DB rows, and triggers recorder add/remove. Allow several seconds.

**Get sensor encode/image settings** (ONVIF only):
```bash
curl -s "http://<VST_ENDPOINT>/vst/api/v1/sensor/<sensorId>/settings" | jq .
```
Response: object keyed by **`streamId`** (not profile name). Each value has `Encode` (`Encoding`, `Options[]` with H264/H265 `Bitrate`/`FrameRate`/`GovLength`/`Quality` (all PascalCase), `Profiles`, `Resolution{AllowedValues, Value}`) and `Image` (`Brightness`, `Contrast`, `ColorSaturation`, `Sharpness`, exposure, white-balance, WDR). Returns `null` for non-ONVIF sensors.

> The GET response may also include extended image fields (`TemporalNoiseReductionModes`, `AutoExposureAntibandingMode`, `EdgeEnhancementMode`, `EdgeEnhancementStrength`, `ExposureCompensation`) that are NOT accepted by the POST schema validator. Read-only on the GET side; don't include them in a subsequent POST.

**Set sensor encode/image settings:**
```bash
curl -s -X POST "http://<VST_ENDPOINT>/vst/api/v1/sensor/<sensorId>/settings" \
  -H "Content-Type: application/json" \
  -d '{
    "Encode": {
      "Bitrate": "<kbps>",
      "Encoding": "H264",
      "FrameRate": "<fps>",
      "Resolution": {"Width": "<w>", "Height": "<h>"}
    },
    "Image": {
      "Brightness": "<value>",
      "Contrast": "<value>"
    }
  }'
```
All `Encode`/`Image` field values are strings, even numeric ones. POST accepts only the classic 20 image fields — extended fields returned by GET are rejected here.

---

### 10. Sensor Timelines

These hit the **sensor** microservice and return recording windows known to that service. Functionally similar to `/storage/{streamId}/timelines` (Section 3) but scoped per sensor at the sensor MS layer; useful when storage MS is not deployed.

**Timeline for a single sensor:**
```bash
# startTime / endTime are optional ISO 8601 UTC filters (VST/STREAMER adaptors only — MMS ignores them)
curl -s "http://<VST_ENDPOINT>/vst/api/v1/sensor/<sensorId>/timelines?startTime=<startTime>&endTime=<endTime>" | jq .
```
Response: array of `{startTime, endTime}`.

**Timelines for all sensors:**
```bash
curl -s "http://<VST_ENDPOINT>/vst/api/v1/sensor/timelines" | jq .
```
Response: object keyed by `sensorId`, each an array of `{startTime, endTime}`. No time-range filter is supported at this aggregate endpoint. **Sensors with no recorded timelines are omitted entirely** — they do NOT appear with `[]`. If a sensorId is missing from the response, treat it as having no recordings.

---

### 11. Recording Control

Recorder microservice — controls per-stream recording state (off/schedule/user/event/alwaysOn) and exposes recorder-specific timelines. Independent of any WebRTC live/replay sessions.

> **`streamId` header is NOT required for any recorder endpoint.** Source-verified: the recorder reads `streamId` from the path only and does not look at HTTP headers. Send the path parameter alone; do not waste a header.

**Get recorder status (all streams):**
```bash
curl -s "http://<VST_ENDPOINT>/vst/api/v1/record/status" | jq .
```
Response: object keyed by `streamId`, each `{id, recording_status}`. `recording_status` enum: `off | schedule | user | event | alwaysOn | error | statusUnknown`.

**Get recorder status for a single stream:**
```bash
curl -s "http://<VST_ENDPOINT>/vst/api/v1/record/<streamId>/status" | jq .
```
Response: `{recordingStatus}` (camelCase, NO `id` field). This shape differs from the aggregate `/record/status` endpoint, which uses `recording_status` (snake_case) and includes `id`. Same enum values: `off | schedule | user | event | alwaysOn | error | statusUnknown`.

**List streams known to the recorder:**
```bash
curl -s "http://<VST_ENDPOINT>/vst/api/v1/record/streams" | jq .
```
Response: array of single-key objects `{<streamId>: [StreamInfo, ...]}` where each `StreamInfo` carries `streamId`, `isMain`, `storageLocation` (`Local|Cloud|Unknown`), `url`, `name`, `metadata{bitrate, codec, framerate, govlength, resolution}`. Do NOT assume `type` is present — current source does not emit it despite the swagger schema.

**Register a stream with the recorder:**
```bash
# Both id and url are REQUIRED in the body. url MUST start with rtsp:// or rtsps://.
curl -s -X POST "http://<VST_ENDPOINT>/vst/api/v1/record/stream/add" \
  -H "Content-Type: application/json" \
  -d '{"id": "<streamId>", "url": "<rtsp-or-rtsps-url>"}'
```
- **`url` scheme**: must be `rtsp://` or `rtsps://`. Non-RTSP URLs return `VMSNotSupportedError`.
- **Both `id` and `url` are required** (server returns `InvalidParameterError` if either is empty). Optional `codec` field also accepted.
- Response: `null` on success.

**Remove a stream from the recorder:**
```bash
curl -s -X DELETE "http://<VST_ENDPOINT>/vst/api/v1/record/<streamId>"
```
Idempotent — DELETE on an unknown streamId still returns `null` / HTTP 200.

**Start user-initiated recording** (status becomes `user`):
```bash
curl -s -X POST "http://<VST_ENDPOINT>/vst/api/v1/record/<streamId>/start"
```
- If the stream is not registered with the recorder, this returns `VMSInternalError` (`Failed to start recording`). Register it first via `/record/stream/add` or rely on the auto-registration from sensor management.

**Stop user-initiated recording:**
```bash
curl -s -X POST "http://<VST_ENDPOINT>/vst/api/v1/record/<streamId>/stop"
```
- Behavior depends on the deployment-level `event_recording` flag:
  - `event_recording = true`: stop transitions `user`/`alwaysOn` to `event` state — the recording pipeline stays alive and continues capturing event clips.
  - `event_recording = false`: recording is fully torn down.
- Possible errors: `VMSInternalError` (stop failed), `MethodNotAllowedError` with message `Stopping event based recording is disabled` (you tried to stop while in `event` state and the flag forbids it).

**Trigger an event-based recording clip** (length = `eventRecordLengthSecs` + `recordBufferLengthSecs` pre-roll from `/record/configuration`, default 10s + 2s):
```bash
curl -s -X POST "http://<VST_ENDPOINT>/vst/api/v1/record/<streamId>/event"
```
Status transitions to `event` for the duration.

**Preconditions and errors:**
- The stream must already be recording (started or always-on). Otherwise returns `VMSInternalError` (`Recorder onEvent failed`).
- If the response is `{error_code: "InvalidParameterError", error_message: "Event Recoding config is disabled"}` (note: server source contains the typo "Recoding"), event recording is turned off at the recorder service level (deployment-wide). Do NOT retry — the flag cannot be changed via API.

**Get the recording schedule for a stream:**
```bash
curl -s "http://<VST_ENDPOINT>/vst/api/v1/record/<streamId>/schedule" | jq .
```
Response: array of `{startTime, endTime}` where both are **5-field CRON strings** (`minute hour day month day_of_week`), e.g. `"0 13 * * 2"` = Tue 13:00. Returns `null` (not an empty array) when no schedule has been configured for the stream.

**Set / replace the recording schedule:**
```bash
curl -s -X POST "http://<VST_ENDPOINT>/vst/api/v1/record/<streamId>/schedule" \
  -H "Content-Type: application/json" \
  -d '[
    {"startTime": "0 13 * * 2", "endTime": "0 14 * * 2"}
  ]'
```

**Delete a specific scheduled window** (matched by exact startTime+endTime pair, passed as query):
```bash
# URL-encode spaces and * — use --data-urlencode via curl -G. No streamId header.
curl -sG -X DELETE "http://<VST_ENDPOINT>/vst/api/v1/record/<streamId>/schedule" \
  --data-urlencode "startTime=0 13 * * 2" \
  --data-urlencode "endTime=0 14 * * 2"
```

**Timelines for all recorded streams** (recorder's view):
```bash
# Optional: repeat ?streams= to filter
curl -s "http://<VST_ENDPOINT>/vst/api/v1/record/timelines?streams=<streamId1>&streams=<streamId2>" | jq .
```
Response: object keyed by `streamId`, each an array of `{startTime, endTime}`.

**Timelines for a single recorded stream:**
```bash
# Optional: startTime, endTime ISO 8601 UTC query params filter the range
curl -s "http://<VST_ENDPOINT>/vst/api/v1/record/<streamId>/timelines" | jq .
```

**List recorded files for a stream** (undocumented in swagger but exposed by the recorder):
```bash
# Note: query params here are snake_case (start_time, end_time) — unlike /timelines which is camelCase
curl -s "http://<VST_ENDPOINT>/vst/api/v1/record/<streamId>/files?start_time=<iso>&end_time=<iso>" | jq .
```
Response: array of `{file_path, start_time, file_duration}` where `start_time` is epoch ms and `file_duration` is ms. Useful for inspecting on-disk recording segments directly. Query params are optional; omit to list all.

---

### 12. WebRTC Live Streaming Session

These manage the actual WebRTC peer-connection lifecycle for **live** streams. They are the runtime control plane behind the `/live/stream/<streamId>/picture` snapshot endpoints. Most users will call these from a browser WebRTC client, not from curl — but the API surface is reachable for automation and debugging.

**WebRTC ordering:** `iceServers` → `stream/start` (POST offer, receive answer + `mediaSessionId`) → trickle ICE via `iceCandidate` POST/GET → `status`/`stats` while playing → `pause`/`resume` as needed → `stop`.

**Get STUN/TURN servers the client should use:**
```bash
# peerId is optional; server returns configured servers regardless
curl -s "http://<VST_ENDPOINT>/vst/api/v1/live/iceServers" | jq .
```
Response: `{iceServers: [{urls: "stun:..."}, ...]}`.

**Start a WebRTC live stream** (client posts SDP offer, gets answer + `mediaSessionId`). **Browser-only:** the SDP offer must come from a real WebRTC peer (a browser `RTCPeerConnection.createOffer()` or equivalent native WebRTC stack). It cannot be hand-crafted or replayed in curl — the server validates and answers against a live peer. The curl example below is shown for reference only:
```bash
curl -s -X POST "http://<VST_ENDPOINT>/vst/api/v1/live/stream/start" \
  -H "Content-Type: application/json" \
  -d '{
    "streamId": "<streamId>",
    "peerId": "<uuid>",
    "sessionDescription": {"type": "offer", "sdp": "<sdp>"},
    "options": {
      "quality": "auto",
      "rtptransport": "udp",
      "timeout": 60
    }
  }' | jq .
```
Response: `{sdp, type: "answer", mediaSessionId}`. **Persist `mediaSessionId`** — every subsequent call needs it.

Composite/video-wall mode: add a root-level `composite` object to the body — `{doComposite: true, streamIds: [...], includeFloorPlan, quality, showSensorName{enable, position}, gridLayout{rows, cols}}`. Root `composite` wins over `options.composite`.

**Client posts an ICE candidate.** **Browser-only:** ICE candidates are produced by the local WebRTC peer's ICE agent (typically a browser). They cannot be synthesized in curl and only have meaning inside an active peer connection paired with `stream/start`. The curl example is shown for reference only:
```bash
curl -s -X POST "http://<VST_ENDPOINT>/vst/api/v1/live/iceCandidate" \
  -H "Content-Type: application/json" \
  -H "streamId: <streamId>" \
  -d '{
    "peerId": "<uuid>",
    "candidate": {
      "candidate": "<candidate-string>",
      "sdpMLineIndex": 0,
      "sdpMid": "<sdpMid>"
    }
  }'
```

**Client polls for server-side ICE candidates** (call repeatedly during connection setup). **Browser-only:** the returned candidates are only useful when fed into a real WebRTC peer's `addIceCandidate()`. Calling this from curl with no live peer connection serves only to inspect server-side ICE — the candidates cannot be acted on outside a browser/native WebRTC stack:
```bash
curl -s "http://<VST_ENDPOINT>/vst/api/v1/live/iceCandidate?peerId=<uuid>" \
  -H "streamId: <streamId>" | jq .
```
Response: array of `{candidate, sdpMLineIndex, sdpMid}`.

**setAnswer** (only used when the server initiated the offer over a websocket — most clients skip this). **Browser-only:** the SDP answer must be generated by a real WebRTC peer that just consumed the server's offer; it cannot be hand-crafted. `sessionDescription` is an **object**, not a string:
```bash
curl -s -X POST "http://<VST_ENDPOINT>/vst/api/v1/live/setAnswer?peerId=<uuid>" \
  -H "Content-Type: application/json" \
  -H "streamId: <streamId>" \
  -d '{
    "sessionDescription": {"type": "answer", "sdp": "<sdp>"},
    "mediaSessionId": "<mediaSessionId>"
  }'
```

**Stop a live stream session:**
```bash
curl -s -X POST "http://<VST_ENDPOINT>/vst/api/v1/live/stream/stop" \
  -H "Content-Type: application/json" \
  -H "streamId: <streamId>" \
  -d '{"peerId": "<uuid>", "mediaSessionId": "<mediaSessionId>"}'
```

**Pause / resume a playing stream:**
```bash
curl -s -X POST "http://<VST_ENDPOINT>/vst/api/v1/live/stream/pause" \
  -H "Content-Type: application/json" \
  -H "streamId: <streamId>" \
  -d '{"peerId": "<uuid>", "mediaSessionId": "<mediaSessionId>"}'

curl -s -X POST "http://<VST_ENDPOINT>/vst/api/v1/live/stream/resume" \
  -H "Content-Type: application/json" \
  -H "streamId: <streamId>" \
  -d '{"peerId": "<uuid>", "mediaSessionId": "<mediaSessionId>"}'
```

**Query last-played timestamp + metadata** (GET despite a "/query" path):
```bash
# IMPORTANT: query parameter is "peerid" all lowercase. Sending "peerId" returns no match.
curl -s "http://<VST_ENDPOINT>/vst/api/v1/live/stream/query?peerid=<uuid>&metadata=true" \
  -H "streamId: <streamId>" | jq .
```
Response shape: `{ts: <int64>, metadata: {epocTime, id, objects: [{bbox{topY,bottomY,leftX,rightX}, confidence, type, id, pose, gaze, ...}]}}`.
- `ts`: opaque int64 from the pipeline. Use it only for equality/ordering — do NOT convert to seconds, ms, or a percentage.
- `metadata` is only present when `metadata=true`.
- If a key you need is missing from the response, the deployment did not emit it — do not assume a default; either skip the field or surface the absence to the user.

**Swap an existing peer from one stream to another** (no peer-connection teardown):
```bash
curl -s -X POST "http://<VST_ENDPOINT>/vst/api/v1/live/stream/swap" \
  -H "Content-Type: application/json" \
  -d '{"peerId": "<uuid>", "streamId": "<new-streamId>"}'
```

**Set per-stream rendering / overlay settings:**
```bash
# All body fields optional. Resolution is "WxH" string, framerate int.
curl -s -X POST "http://<VST_ENDPOINT>/vst/api/v1/live/stream/settings" \
  -H "Content-Type: application/json" \
  -H "streamId: <streamId>" \
  -d '{
    "framerate": 30,
    "resolution": "1920x1080",
    "peerId": "<uuid>",
    "overlay": {
      "bbox": {"showAll": true, "showObjId": true},
      "color": "0xff0000",
      "thickness": 2,
      "opacity": 200
    }
  }'
```

**Get streaming stats for a peer** (`mediaSessionId` is accepted but ignored by the handler — omit it):
```bash
curl -s "http://<VST_ENDPOINT>/vst/api/v1/live/stream/stats?peerId=<uuid>" \
  -H "streamId: <streamId>" | jq .
```
Requires `enable_perf_logging=true` in the live service configuration — otherwise returns `MethodNotAllowedError` ("Stream stats not enabled"). Response shape: `{streamSettings{Encoding, Resolution{width,height}, streamId, encodingProfile, framerate}, streamStats{currentFrameRate, decode, encode, inboundAudio, inboundVideo}, networkBandwidth, frameRetrievalAccuracy, timestamp}`.

**Get stream playback state** (`peerId` optional — omit to list all active peers; `mediaSessionId` is ignored):
```bash
curl -s "http://<VST_ENDPOINT>/vst/api/v1/live/stream/status?peerId=<uuid>" \
  -H "streamId: <streamId>" | jq .
```
- With `peerId`: returns a single `{error, state}` object for that peer.
- Without `peerId`: returns an array with the status of every active peer.
- `state` enum: `PLAYING` | `NOT PLAYING` (literal space) | `PAUSED` | `ERROR`.

---

### 13. WebRTC Replay Streaming Session

Replay (VOD) version of Section 12. Same WebRTC lifecycle plus two replay-specific operations: `seek` (trick-mode) and a `swap` that hot-switches live → VOD on the same peer connection.

All control endpoints require `mediaSessionId` in addition to `peerId` (live endpoints do not always require it). `streamId` is sent as a header on every per-stream call.

**Get ICE servers:**
```bash
curl -s "http://<VST_ENDPOINT>/vst/api/v1/replay/iceServers" | jq .
```

**Start a VOD WebRTC stream** (window defined by `startTime`/`endTime`). **Browser-only:** as with the live variant, the SDP offer must be produced by a real WebRTC peer (browser `RTCPeerConnection` or native WebRTC stack) — it cannot be hand-crafted in curl. The curl example is shown for reference only:
```bash
curl -s -X POST "http://<VST_ENDPOINT>/vst/api/v1/replay/stream/start" \
  -H "Content-Type: application/json" \
  -d '{
    "streamId": "<streamId>",
    "peerId": "<uuid>",
    "startTime": "2026-04-10T10:00:00.000Z",
    "endTime":   "2026-04-10T10:30:00.000Z",
    "sessionDescription": {"type": "offer", "sdp": "<sdp>"},
    "options": {
      "quality": "auto",
      "rtptransport": "udp",
      "timeout": 60
    }
  }' | jq .
```
Response: `{sdp, type: "answer", mediaSessionId}`.
- **`startTime` is effectively required.** Omitting it bypasses the `recorded_playback` codepath, and the stream falls through to live behavior — likely not what you want. Always send `startTime`.
- `endTime` is optional; omit to play to the end of available recording.

**Post / poll ICE candidates** (same shape as live — see Section 12). **Browser-only:** ICE candidates are produced and consumed by the WebRTC peer's ICE agent; they have no meaning outside a live browser/native WebRTC peer connection. Replace `/live/` with `/replay/` in the URL.

**setAnswer / stop / pause / resume:**
```bash
# Body shape identical to live; mediaSessionId is mandatory on every replay control call
curl -s -X POST "http://<VST_ENDPOINT>/vst/api/v1/replay/stream/stop" \
  -H "Content-Type: application/json" \
  -H "streamId: <streamId>" \
  -d '{"peerId": "<uuid>", "mediaSessionId": "<mediaSessionId>"}'

# Replace "stop" with "pause" or "resume" for those actions — same body
```

**Trick-mode seek** (replay-only). Action selector + `value` field (string). Pick the matching case:

| Goal | `action` | `value` (string) |
|---|---|---|
| Jump forward by N seconds (relative) | `seekForward` | seconds as a string, e.g. `"10"` |
| Jump backward by N seconds (relative) | `seekBackward` | seconds as a string, e.g. `"10"` |
| Jump to an exact timestamp (absolute) | `seekForward` | ISO 8601 UTC string, e.g. `"2026-04-10T10:15:00.000Z"` |
| Fast-forward playback | `fastForward` | not used (omit or `""`) — passed through verbatim by the server |
| Rewind playback | `rewind` | not used (omit or `""`) — passed through verbatim by the server |

Server reads `value` as a string in all cases. If you have a number, send it quoted (e.g. `"10"`, not `10`).

```bash
# Relative seek forward by 10 seconds
curl -s -X POST "http://<VST_ENDPOINT>/vst/api/v1/replay/stream/seek" \
  -H "Content-Type: application/json" \
  -H "streamId: <streamId>" \
  -d '{
    "peerId": "<uuid>",
    "mediaSessionId": "<mediaSessionId>",
    "action": "seekForward",
    "value": "10"
  }'
```

```bash
# Absolute jump to an ISO timestamp
curl -s -X POST "http://<VST_ENDPOINT>/vst/api/v1/replay/stream/seek" \
  -H "Content-Type: application/json" \
  -H "streamId: <streamId>" \
  -d '{
    "peerId": "<uuid>",
    "mediaSessionId": "<mediaSessionId>",
    "action": "seekForward",
    "value": "2026-04-10T10:15:00.000Z"
  }'
```

**Get current seek position:**
```bash
curl -s "http://<VST_ENDPOINT>/vst/api/v1/replay/stream/seek?peerId=<uuid>&mediaSessionId=<mediaSessionId>" \
  -H "streamId: <streamId>" | jq .
```
Response: `{position: <int64>}` — opaque pipeline position. Use it only for equality/ordering between successive polls. Do NOT interpret as seconds, milliseconds, or percent. If you need a wall-clock or correlatable timestamp, call `/replay/stream/query` (returns `ts`) instead.

**Query last-played timestamp + overlay metadata** (query parameter is `peerid` all lowercase — same as live):
```bash
curl -s "http://<VST_ENDPOINT>/vst/api/v1/replay/stream/query?peerid=<uuid>&metadata=true" \
  -H "streamId: <streamId>" | jq .
```

**Swap a live session to VOD on the same peer connection** (replay-only, faster than stop-live + start-replay):
```bash
curl -s -X POST "http://<VST_ENDPOINT>/vst/api/v1/replay/stream/swap" \
  -H "Content-Type: application/json" \
  -d '{
    "peerId": "<uuid>",
    "streamId": "<streamId>",
    "startTime": "2026-04-10T10:00:00.000Z",
    "endTime":   "2026-04-10T10:30:00.000Z"
  }'
```
Response: bare boolean `true`/`false`.

**Stats / status** (`mediaSessionId` is accepted but ignored by the handler):
```bash
curl -s "http://<VST_ENDPOINT>/vst/api/v1/replay/stream/stats?peerId=<uuid>" \
  -H "streamId: <streamId>" | jq .

curl -s "http://<VST_ENDPOINT>/vst/api/v1/replay/stream/status?peerId=<uuid>" \
  -H "streamId: <streamId>" | jq .
```
- `stats` requires `enable_perf_logging=true` in the replay configuration.
- `status` without `peerId` returns an array of states for all active replay peers.
- Response shapes otherwise identical to live (see Section 12).

---

### 14. RTSP Proxy

The proxy microservice fans incoming RTSP streams across multiple internal RTSP server instances and republishes them on different ports (typically `30554`+ for live, `30562` for VOD on this deployment). Use these endpoints to discover the actual RTSP URLs, register new upstream streams, and inspect aggregate stats.

> The proxy service does NOT read the `streamId` HTTP header on any endpoint. Path/body alone are sufficient.

**Get RTSP server URL prefixes and aggregate stats:**
```bash
curl -s "http://<VST_ENDPOINT>/vst/api/v1/proxy/info" | jq .
```
Response: dynamic object — one `serverN` key per RTSP instance (`{rtspServerDomainPrefix, urlPrefix}`), plus a single `stats` key `{activeClientSessions: <int>, rtspServerTxBitrate: <string-kbps>}`. Number of `serverN` entries equals `rtsp_server_instances_count` from `/proxy/configuration` (default 8). `rtspServerTxBitrate` is the sum of bitrates of streams with active sessions, reported as a decimal string in **kbps** (field name is misleading — it is not bytes).

**List proxied streams** (with both live and VOD RTSP URLs):
```bash
curl -s "http://<VST_ENDPOINT>/vst/api/v1/proxy/streams" | jq .
```
Response: array of `{sensorId, name, proxyUrl, vodUrl}`. Different streams may live on different `proxyUrl` ports; all VOD URLs share the single VOD server port.

**Add an upstream RTSP URL to the proxy** (returns the proxied live + VOD URLs):
```bash
# Required body fields: id, url. name is optional and falls back to id.
curl -s -X POST "http://<VST_ENDPOINT>/vst/api/v1/proxy/stream/add" \
  -H "Content-Type: application/json" \
  -d '{"id": "<streamId>", "url": "<upstream-rtsp-url>"}'
```
Response: `{url: "<proxy-rtsp-live-url>", vodUrl: "<proxy-rtsp-vod-url>"}`.
- The server does NOT enforce `id` against `^[a-zA-Z0-9_-]+$` despite the swagger pattern — any non-empty string is accepted. Prefer the swagger pattern for forward compatibility.
- Errors: `VMSInternalError` (no RTSP server instances available, or load-balancer could not allocate); `InvalidParameterError` (event-mode form with missing `camera_id` / `camera_url` / wrong `change` type).

**Remove a proxied stream:**
```bash
curl -s -X DELETE "http://<VST_ENDPOINT>/vst/api/v1/proxy/stream/<streamId>"
```
- **Idempotent**: returns `null` / HTTP 200 even for unknown streamIds (no `VMSNotFound`).
- Side effects: removes the stream from the device manager, frees the load-balancer slot, emits a `STREAM_STATUS_REMOVED` event. Does NOT delete on-disk recordings — use the storage delete flow (Section 8) for that.

**`DELETE /proxy/session/<streamId>` is an alias of `DELETE /proxy/stream/<streamId>`** — both dispatch to the same handler with identical side effects (full stream unregister, sessions terminated, LB slot freed). There is no "kick clients but keep the stream" variant. Prefer `/proxy/stream/<id>` for clarity:
```bash
curl -s -X DELETE "http://<VST_ENDPOINT>/vst/api/v1/proxy/session/<streamId>"
```

---

### 15. Storage File Management

Beyond clip download (Section 4) and upload/delete (Section 8), the storage microservice exposes file-list, media-info, path-resolution, and a protect/unprotect mechanism that exempts files from aging and from `DELETE /storage/file`.

**Get disk usage for the recordings volume:**
```bash
curl -s "http://<VST_ENDPOINT>/vst/api/v1/storage/info" | jq .
```
Response: `{total, used, available}` in **megabytes**.

**Get storage size for a single stream:**
```bash
curl -s "http://<VST_ENDPOINT>/vst/api/v1/storage/<streamId>" | jq .
```
Response: `{size_in_mb: <int>}`. Note the snake_case field name — this endpoint is intentionally different from `GET /storage/size`, which uses `sizeInMegabytes`.

**List all media files across every sensor:**
```bash
curl -s "http://<VST_ENDPOINT>/vst/api/v1/storage/file/list" | jq .
```
Response: object keyed by `sensorId`, each value an array of `{mediaFilePath, metadataFilePath, metadata}`. Note `metadataFilePath` is lowercase-d on this endpoint (the `/storage/file/<sensorId>/path` endpoint uses capital D — see below).

The shape of the inner `metadata` object **depends on the sensor type**:

- **File-uploaded sensor** — single entry per sensor, with `metadata: {id, mediaFilePath, sensorId, timestamp}` (timestamp is int64 ms). `id` is the file's unique identifier from the upload response.
- **RTSP / live-recorded sensor** — one entry per recording segment file (the on-disk `.mkv` chunks under `vst_video/<sensor>/<resolution>/<YYYY>/<MM>/<DD>/<HH>/<epoch_ms>.mkv`). `metadata` is minimal — typically `{id: ""}` only. The recorder does not write per-segment user metadata for live captures (and `/storage/file/<sensorId>/path?metadata=true` returns an empty `metadata` string for these as well). For codec / resolution / framerate / bitrate, call `/storage/file/mediainfo` instead.

`metadataFilePath` is empty (`""`) unless a sidecar metadata file was written alongside the media; do not assume it is populated.

**List media files for a single sensor:**
```bash
curl -s "http://<VST_ENDPOINT>/vst/api/v1/storage/file/<sensorId>/list" | jq .
```
Response: same shape as `/storage/file/list` but limited to a single sensorId key. Same per-sensor-type metadata variation applies.

**Get media file paths for a sensor** (optionally filtered by time):
```bash
# metadata=true also returns per-file metadata
curl -s "http://<VST_ENDPOINT>/vst/api/v1/storage/file/<sensorId>/path?startTime=<startTime>&endTime=<endTime>&metadata=true" | jq .
```
Response: array of `{id, mediaFilePath, metaDataFilePath, metadata}`. **Note `metaDataFilePath` has a capital D on this endpoint** — different casing from `/file/list` (lowercase d).

`metadata` is a **JSON-encoded string** (NOT a nested object) — pipe it through `fromjson` / `json.loads` before reading fields. Contents depend on sensor type:

- **File-uploaded sensor**: parsed `metadata` contains `{mediaFilePath, sensorId, timestamp}` (no `streamName`, no `eventInfo`).
- **RTSP / live-recorded sensor**: `metadata` is an empty string `""` (the recorder does not write per-segment metadata for live captures). `id` is also `""` on these entries.

If you need rich audio/video info (codec, fps, resolution, bitrate, etc.), use `/storage/file/mediainfo` instead — it works on both sensor types when called with `?id=<fileId>` (for RTSP, get the id by listing `/storage/file/<sensorId>/path` is not enough since id is empty — use `/file/list` or the segment path directly).

- Time semantics: if both `startTime` and `endTime` are omitted, returns all files. Supplying `endTime` alone is rejected with `InvalidParameterError` (`"Only end time is provided"`). Supplying `startTime` alone creates a 1 ms window starting at that time.

**Resolve a file by its id** (returns mediaFilePath + optional metadata):
```bash
curl -s "http://<VST_ENDPOINT>/vst/api/v1/storage/file/path?id=<fileId>&metadata=true" | jq .
```

**Get audio/video metadata for a file** (codec, fps, resolution, bitrate, depth, etc.):
```bash
curl -s "http://<VST_ENDPOINT>/vst/api/v1/storage/file/mediainfo?id=<fileId>" | jq .
# or by sensorId:
curl -s "http://<VST_ENDPOINT>/vst/api/v1/storage/file/mediainfo?sensorId=<sensorId>" | jq .
```
- **At least one of `id` or `sensorId` is required** — calling with neither returns `InvalidParameterError`.
- Response: `{Duration, Container, Codec, AudioCodec, Height, Width, Framerate, FrameCount, FramerateNum, FramerateDenom, ScanType, Bitrate, SampleRate, Channels, Depth, mediaFilePath, storageLocation}`.
- **Field types are mixed** — do not assume everything is a string:
  - **String** fields: `Codec`, `Container`, `AudioCodec`, `ScanType`, `mediaFilePath`, `storageLocation` (`"local"` or `"cloud"`).
  - **Number** fields (JSON int/float): `Width`, `Height`, `Framerate`, `FrameCount`, `FramerateNum`, `FramerateDenom`, `Duration` (seconds, float), `Bitrate` (bps), `SampleRate`, `Channels`, `Depth`.

> Caveat: `?sensorId=` only resolves when the sensor's primary stream backs onto a **local file** (uploaded file sensor, or STREAMER-served file). For RTSP-proxied sensors the URL is remote and the server returns `InvalidParameterError: "File not present"`. If `?sensorId=` fails this way, retry with `?id=<fileId>` instead (obtain the file id from `GET /storage/file/list` or `GET /storage/file/<sensorId>/path?metadata=true`).

**Download a file by id (full file or time-bounded clip):**
```bash
curl -s "http://<VST_ENDPOINT>/vst/api/v1/storage/file?id=<fileId>&startTime=<startTime>&endTime=<endTime>" \
  -o file.mp4
```
`startTime`/`endTime` accept ISO 8601 UTC or 0-based PTS strings. Omit both for the whole file.

**Download a clip from a sensor with a strict full-coverage check:**
```bash
# fullLength=true rejects the request if the time range has gaps
curl -s "http://<VST_ENDPOINT>/vst/api/v1/storage/file/<sensorId>?startTime=<startTime>&endTime=<endTime>&fullLength=true" \
  -o clip.mp4
```

**Delete files by path or by id** (protected files are skipped, not deleted):
```bash
# By file path (one or more — repeat the filePath= param)
curl -s -X DELETE "http://<VST_ENDPOINT>/vst/api/v1/storage/file?filePath=<path1>&filePath=<path2>" | jq .

# OR by file id (uniqueId from upload / file/list response)
curl -s -X DELETE "http://<VST_ENDPOINT>/vst/api/v1/storage/file?id=<fileId>" | jq .
```
Response: `{spaceSaved, invalidFiles, protectedFiles}`.

**Protect or unprotect files** (protected files are exempt from aging policy and bulk delete):
```bash
# protect=true to protect, protect=false to unprotect
curl -s -X POST "http://<VST_ENDPOINT>/vst/api/v1/storage/file/protect" \
  -H "Content-Type: application/json" \
  -d '{
    "filePath": ["<path1>", "<path2>"],
    "protect": true
  }' | jq .
```
Response: `{invalidFiles: [...]}`.

**List currently protected files:**
```bash
curl -s "http://<VST_ENDPOINT>/vst/api/v1/storage/file/protected" | jq .
```
Response: array of absolute file paths.

---

### 16. Service Configuration

Each microservice exposes a `GET /<service>/configuration` (read full config) and most expose a `POST /<service>/configuration` to update a writable subset (typically STUN/TURN/reverse-proxy/Twilio fields, and discovery interfaces / NTP for sensor MS). The configuration objects are large — query specific fields with `jq`.

**Read configuration for any service:**
```bash
curl -s "http://<VST_ENDPOINT>/vst/api/v1/sensor/configuration"  | jq .
curl -s "http://<VST_ENDPOINT>/vst/api/v1/storage/configuration" | jq .
curl -s "http://<VST_ENDPOINT>/vst/api/v1/live/configuration"    | jq .
curl -s "http://<VST_ENDPOINT>/vst/api/v1/replay/configuration"  | jq .
curl -s "http://<VST_ENDPOINT>/vst/api/v1/record/configuration"  | jq .
curl -s "http://<VST_ENDPOINT>/vst/api/v1/proxy/configuration"   | jq .
```

Common writable subset across the WebRTC services (live, replay):
- `coturnTurnUrlListWithSecret` (string[])
- `stunUrlList` (string[])
- `staticTurnUrlList` (string[])
- `useTwilioStunTurn` (bool), `twilioAccountSid`, `twilioAuthToken`
- `useReverseProxy` (bool), `reverseProxyServerAddress`
- `useCoturnAuthSecret` (bool)

**Update STUN/TURN config on a WebRTC service:**
```bash
curl -s -X POST "http://<VST_ENDPOINT>/vst/api/v1/live/configuration" \
  -H "Content-Type: application/json" \
  -d '{
    "stunUrlList": ["stun:stun.l.google.com:19302"],
    "useReverseProxy": false
  }'
```
(Replace `/live/` with `/replay/` as needed.)

**Sensor MS writable fields** are different:
- `deviceDiscoveryInterfaces` (string[], e.g. `["eth0"]`)
- `ntpServers` (string[])

```bash
curl -s -X POST "http://<VST_ENDPOINT>/vst/api/v1/sensor/configuration" \
  -H "Content-Type: application/json" \
  -d '{
    "deviceDiscoveryInterfaces": ["eth0"],
    "ntpServers": ["pool.ntp.org"]
  }'
```

**Storage, proxy, and recorder:** configuration is read-only via API — no POST `/configuration` is supported on these services.

> **Sensor MS POST quirks:**
> - Posting an empty body (or non-object) returns `MethodNotAllowedError` with message `Requested API is not allowed` — despite the name, this is a payload-shape issue, not an HTTP-method issue. Always send a JSON object body.
> - Changing `deviceDiscoveryInterfaces` restarts the ONVIF discovery service — there will be a brief gap before newly-plugged sensors are discovered.
> - Empty-string entries in the `deviceDiscoveryInterfaces` / `ntpServers` arrays are filtered out server-side.
> - Other keys present in the body (anything outside `deviceDiscoveryInterfaces` / `ntpServers`) are silently ignored — do not assume they took effect.

---

### 17. Service Discovery

Most microservices expose `/version` and `/help`. Use `/help` for runtime endpoint discovery (it can include routes that are not in the swagger):
```bash
curl -s "http://<VST_ENDPOINT>/vst/api/v1/<service>/version" | jq .
curl -s "http://<VST_ENDPOINT>/vst/api/v1/<service>/help"    | jq .
```
where `<service>` is one of `sensor`, `storage`, `live`, `replay`, `record`.

> Version response key varies by service:
> - `GET /sensor/version`, `/live/version`, `/replay/version` → `{type, version}` (e.g. `{"type": "vst", "version": "2.1.0-26.05.1"}`)
> - `GET /storage/version` → `{storage_management_version}` (e.g. `{"storage_management_version": "0.0.1"}`)
> - `GET /record/version` → `{recorder_version}` (e.g. `{"recorder_version": "0.0.1"}`)
> - The proxy microservice does NOT expose `/proxy/version` — use `/proxy/info` to verify proxy reachability instead.

---

## Cross-Service Notes (rules the agent must follow)

- **`streamId` header convention:** Required by per-stream **WebRTC** endpoints only (`/live/...`, `/replay/...`). The **recorder** (`/record/...`) and **RTSP proxy** (`/proxy/...`) per-stream endpoints do NOT read the header — path parameter alone is sufficient. Do not waste a header on those services. When a WebRTC endpoint also has `{streamId}` in the path, the header value must equal the path value.
- **`mediaSessionId` lifecycle:** Returned only by `POST /<service>/stream/start`. Persist it as soon as start succeeds. Every subsequent control call (`stop`, `pause`, `resume`, `seek`, `stats`, `status`, `setAnswer`) requires it. Do NOT generate or guess this value — if you don't have one, you must call `/stream/start` first.
- **Bearer auth:** Mutating endpoints (POST/PUT/DELETE) declare `bearerAuth` in swagger. Default deployments run without auth — try the call without a token first. On a `401`, retry with `-H "Authorization: Bearer <token>"` and ask the user for the token only if it is not in the deployment context.
- **CRON schedule format:** `/record/<streamId>/schedule` uses 5-field CRON (`minute hour day month day_of_week`). When deleting a window, you MUST pass the exact same `startTime` and `endTime` strings used at creation time as query parameters. Use `curl -G --data-urlencode` to handle spaces and `*` correctly.
- **WebRTC SDP / ICE payload sizes:** Swagger declares `maxLength: 128` on `sdp`, `candidate`, and similar fields. The live server accepts much larger payloads (real SDPs are several KB). Do not truncate WebRTC payloads to fit the documented limit — send them verbatim.
- **VOD vs live RTSP ports:** From `/proxy/info`, multiple live RTSP servers may run on consecutive ports starting from `rtspServerPort` (30554+). VOD streams are served on a separate port (`30562` on the live deployment). Always discover URLs via `/proxy/streams` rather than constructing them.
- **Opaque numeric fields:** `position` (replay seek GET), `ts` (live/replay query GET) are pipeline-defined int64 values. Use them only for equality/ordering between calls. Do NOT convert them to seconds, milliseconds, or percent.
- **404 vs error JSON:** A 404 with no JSON body means the route is not implemented on this gateway. An error JSON body `{error_code, error_message}` means the service is up but the call was invalid — read `error_code` (e.g. `VMSNotFound`, `InvalidParameterError`, `MethodNotAllowedError`) and act accordingly. Do NOT retry on `InvalidParameterError` without fixing the request.
