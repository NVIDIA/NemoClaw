# NvStreamer REST API Reference

NvStreamer (`vss-vios-nvstreamer`) is the **file-to-RTSP republisher** that VIOS deployments use to expose on-disk MP4 / MKV / TS files as RTSP streams. It is **always brought up alongside VIOS** by the profiles that need it (`dev-profile-alerts`, `dev-profile-lvs`, `dev-profile-search`'s `video-analytics-2d-app`, and all `industry-profiles/warehouse-operations/warehouse-*-app` variants) — see `integrate-vios-service.md § Two ingestion topologies, Topology B` and `deploy-vios-service.md § Container Image` for the deployment side. **This reference covers NvStreamer's REST API surface only**; if NvStreamer is not running, take the deploy path in SKILL.md `§ Deployment prerequisite` (deploying any VIOS-using profile that includes NvStreamer brings the streamer up automatically).

NvStreamer is the same `launch_vst` binary as VIOS, launched with `ADAPTOR=streamer`. It runs on `network_mode: host` and listens on its own HTTP port (default `${NVSTREAMER_HTTP_PORT:-31000}`) with an RTSP server pool on `31554–31561`. It reports `type: "streamer"` on `/version` (VIOS reports `type: "vst"`) — that's the discriminator if you're unsure which service an endpoint belongs to.

> **When to call NvStreamer vs VIOS.** Use NvStreamer for: serving test/sample videos over RTSP, retrieving the auto-generated RTSP URL for an on-disk file, listing file-backed sensors, capturing frame snapshots from a file, forcing a videos-directory rescan. Use VIOS (`api-reference.md`) for: direct MP4 upload, live cameras, recording, clip download, historical playback, replay-WebRTC, and the recorder service. The two surfaces share the same path prefix (`/vst/api/v1/`) but live on different ports — point your `curl` at the right one.

---

## Base URL

```
http://<NVSTREAMER_ENDPOINT>/vst/api/v1
```

The conventional endpoint is `http://${HOST_IP}:${NVSTREAMER_HTTP_PORT:-31000}`. A deployment may run multiple NvStreamer instances on adjacent ports (`31000`, `31001`, …); always confirm from the deployment context rather than assuming. Each instance has its own sensor list — a file uploaded to `nvstreamer-1` is not visible on `nvstreamer-2`.

---

## Resolving streamId / sensorId on NvStreamer

Identifier source depends on how the sensor was created:

- **Auto-discovered files** (already present in the streamer videos directory at startup, or picked up via `/sensor/scan`): `sensorId == streamId == name == filename-without-extension`. Example: `warehouse_sample.mp4` → sensor `warehouse_sample`.
- **PUT-uploaded files** (Section 3): the server **always assigns a fresh UUID** as `sensorId == streamId`. The `name` field still reflects the filename, but calling `/sensor/<name>/streams` for a PUT-uploaded file returns `CameraNotFoundError` — use the UUID from the PUT response.
- **POST-uploaded files** (Section 3): the server uses the **filename-derived id** as both `sensorId` and `streamId`. The response's `sensorId` field is sometimes returned as an empty string — read `id` / `streamId` instead.

To list / look up sensors regardless of origin:
- `GET /sensor/list` — every sensor's `sensorId` and `name`
- `GET /sensor/streams` — array of `{sensorId: [stream, ...]}` entries
- `GET /live/streams` — same shape as `/sensor/streams` (NvStreamer treats every file as a live RTSP stream)

---

## Operations

### 1. Version / Health Check

```bash
curl -sf --connect-timeout 5 "http://<NVSTREAMER_ENDPOINT>/vst/api/v1/sensor/version" | jq .
```

Response: `{"type": "streamer", "version": "<x.y.z-yy.mm.b>"}`. The `type` field is the unique tell that you are hitting NvStreamer and not the VIOS gateway.

Other version endpoints: `/storage/version` → `{storage_management_version}`, `/live/version` → `{type, version}`.

---

### 2. List Sensors / Streams

**List all file-backed sensors:**
```bash
curl -s "http://<NVSTREAMER_ENDPOINT>/vst/api/v1/sensor/list" | jq .
```
Per-sensor shape on NvStreamer:
- `type`: always `sensor_nvstream`
- `state`: `online` whenever NvStreamer can read the file
- `isTimelinePresent`: **always `false`** — NvStreamer does not record
- `location`: absolute container-side path to the source file (e.g. `${VST_CONTAINER_ROOT}/streamer_videos/warehouse_sample.mp4`)
- `sensorId` / `name`: filename-without-extension for auto-discovered and POST-uploaded files; a UUID `sensorId` paired with the filename `name` for PUT-uploaded files
- `sensorIp`: the host IP — every file sensor on a given instance shares the same address
- `hardware`/`manufacturer`/`serialNumber`/`firmwareVersion`/`hardwareId`: the literal string `"unknown"`
- `remoteDeviceId`: NvStreamer's own UUID (same across every file from a given instance)

**Get single sensor info:**
```bash
curl -s "http://<NVSTREAMER_ENDPOINT>/vst/api/v1/sensor/<sensorId>/info" | jq .
```
Same metadata block as `/sensor/list` minus `state` and `type`. For an unknown `sensorId`, returns `null`.

**Get sensor status:**
```bash
curl -s "http://<NVSTREAMER_ENDPOINT>/vst/api/v1/sensor/status" | jq .
curl -s "http://<NVSTREAMER_ENDPOINT>/vst/api/v1/sensor/<sensorId>/status" | jq .
```
`state` is always `online` for files on disk. `errorCode` is `NoError`, `errorMessage` is `No Error`.

**Get RTSP stream URL for a file** (the most-called endpoint in the NvStreamer → VIOS handoff):
```bash
curl -s "http://<NVSTREAMER_ENDPOINT>/vst/api/v1/sensor/<sensorId>/streams" | jq .
```
Each stream returns:
- `url` — `rtsp://<host>:<rtsp-server-port>/nvstream/<absolute-container-path>`. Example: `rtsp://${HOST_IP}:31561/nvstream/${VST_CONTAINER_ROOT}/streamer_videos/warehouse_sample.mp4`.
- `type` — `"Rtsp"`
- `storageLocation` — `"Local"`
- `metadata.codec` — `"h264"` / `"h265"`; populates asynchronously (~15-30 seconds after upload)
- **No `vodUrl` field** — NvStreamer does not expose a VOD URL even though VIOS does. Do not look for `vodUrl`; treat its absence as expected.

> The RTSP server port for each file (`31554`, `31555`, …) is decided by NvStreamer's internal load balancer at start-up. It is NOT tied to filename or alphabetic order. **Always read the URL from `/sensor/<id>/streams` rather than constructing it.**

**All streams across all sensors:**
```bash
curl -s "http://<NVSTREAMER_ENDPOINT>/vst/api/v1/sensor/streams" | jq .
# To flatten the array-of-single-key-objects into a flat map:
curl -s "http://<NVSTREAMER_ENDPOINT>/vst/api/v1/sensor/streams" | jq 'add'
```
Same shape quirk as VIOS — an array of `{<sensorId>: [stream, ...]}`, not a flat map.

---

### 3. Upload a Video File

> **No `/sensor/add` on NvStreamer.** Although the route accepts requests (the same VST binary serves it), it does NOT belong to the NvStreamer surface — that endpoint is for VIOS where users wire up upstream RTSP cameras. On NvStreamer, the only way to add a new stream is to upload a video file with the API in this section. The file is served back over RTSP from the streamer videos directory; there is no upstream-camera concept.

NvStreamer accepts uploads via three methods: **PUT v2**, **PUT v1**, and **POST multipart**. All three drop the file into the streamer videos directory and auto-register it as a file-backed sensor on the next discovery cycle. **The user must provide a local file path** to upload — `curl` reads bytes from that path; this skill does not generate or fetch video content on its own.

**Filename rule:** the chosen filename must NOT contain whitespace. Whitespace is rejected with HTTP 400 `{"error_code": "InvalidParameterError", "error_message": "Whitespaces not allowed in file name"}` on all three methods. Use snake_case or kebab-case.

**Codec/container rule:** files must be a supported video container (MP4, MKV, TS) carrying H.264 or H.265 video. Other formats are rejected — see Upload errors below.

#### Method 1 — PUT v2 (preferred; raw bytes, single request)

Filename in path; timestamp and sensorId as query params.

```bash
# filename: no whitespace, supported video container
# timestamp: ISO 8601 UTC query param (default convention: see api-reference.md § timestamp)
# sensorId: optional — if omitted, the server generates a UUID
curl -s -X PUT "http://<NVSTREAMER_ENDPOINT>/vst/api/v1/storage/file/<filename>?timestamp=<timestamp>&sensorId=<sensorId>" \
  -H "Content-Type: application/octet-stream" \
  -H "Content-Length: <file_size_in_bytes>" \
  --upload-file /path/to/video.mp4 | jq .
```

Response: `{id, filename, bytes, sensorId, streamId, filePath, timestamp, created_at}`. **PUT-uploaded sensors get a fresh UUID as `sensorId == streamId`** — always read it from the response.

#### Method 2 — PUT v1 (legacy; auto-renames on conflict)

```bash
curl -s -X PUT "http://<NVSTREAMER_ENDPOINT>/vst/api/v1/storage/file/<filename>/<timestamp>" \
  -H "Content-Type: application/octet-stream" \
  -H "Content-Length: <file_size_in_bytes>" \
  --upload-file /path/to/video.mp4 | jq .
```

Same response shape as v2. If `<filename>` already exists in the videos directory, the server appends `_1`, `_2`, … to the basename and uploads under the new name (no HTTP 409). The `sensorId` is always a fresh UUID — any client-supplied sensor info is ignored.

#### Method 3 — POST multipart (single-chunk only)

Use this when the client expects a multipart upload (e.g. browser file picker) or wants to set NvStreamer-specific options (transcode hints) via HTTP headers. **Send the file as a single multipart part — do NOT split into chunks for this skill.** The chunked-upload mode (using `nvstreamer-chunk-number` etc.) exists in the server but is intended for the NvStreamer web UI's resumable upload flow.

```bash
# Single-chunk POST: omit all nvstreamer-chunk-* headers. Provide the file as a single multipart part.
# nvstreamer-file-name: optional — if omitted, the server uses the multipart filename from the form data.
curl -s -X POST "http://<NVSTREAMER_ENDPOINT>/vst/api/v1/storage/file" \
  -H "nvstreamer-file-name: <filename>" \
  -F "file=@/path/to/video.mp4;type=video/mp4" | jq .
```

Response: `{id, filename, bytes, sensorId, streamId, filePath, created_at}`. **POST-uploaded sensors have `sensorId == streamId == filename-without-extension`** (e.g. `warehouse_sample.mp4` → `streamId: "warehouse_sample"`). The response's `sensorId` field may be returned as an empty string; the `id` / `streamId` fields are the reliable identifiers.

**NvStreamer custom POST headers** (all optional, all skipped in single-chunk uploads except where noted):

| Header | Purpose | Notes |
|---|---|---|
| `nvstreamer-file-name` | Override the multipart filename | Optional for single-chunk POST (form's `filename=` is used if omitted). Required for chunked uploads. Whitespace rejected. |
| `nvstreamer-enable-transcode` | `true` / `false` — transcode on ingest | When `true`, the server re-encodes the upload using the framerate / bitrate / keyframe-interval below. |
| `nvstreamer-transcode-framerate` (or `transcode-framerate`) | Target framerate (int) | Only honored when `nvstreamer-enable-transcode: true`. Default 30. |
| `nvstreamer-transcode-bitrate` (or `transcode-bitrate`) | Target bitrate in kbps (int) | Only honored when `nvstreamer-enable-transcode: true`. |
| `nvstreamer-transcode-keyframe-interval` (or `transcode-keyframe-interval`) | Target keyframe (GOP) interval (int) | Only honored when `nvstreamer-enable-transcode: true`. |
| `nvstreamer-chunk-number` | Current chunk index | **Chunked uploads only — do not set for single-chunk POST.** |
| `nvstreamer-total-chunks` | Total chunk count | Chunked uploads only. |
| `nvstreamer-is-last-chunk` | `true` on the final chunk | Chunked uploads only. |
| `nvstreamer-identifier` | Per-upload identifier tying chunks together | Chunked uploads only. |

#### Upload errors (all methods)

| HTTP | `error_code` | When it fires |
|---|---|---|
| 400 | `InvalidParameterError` | Bytes do not look like media (e.g. random data, plain shell input), missing `Content-Length` on PUT, missing filename, malformed timestamp, or `Whitespaces not allowed in file name`. **Also fires as `Failed to get media information` when libav is missing inside the container — see `deploy-vios-service.md § Known Deployment Issues` Finding 9 (the same libav-install env var that gates VIOS uploads also gates NvStreamer uploads).** |
| 409 | `ResourceConflictError` | PUT v2 only — file with the same name already exists. v1 auto-renames instead. |
| 415 | `UnsupportedMediaTypeError` | Bytes parse as a recognized non-video format (e.g. text, image) — message is `Format not supported`. |
| 422 | `UnsupportedMediaTypeError` (variant) | Supported container, unsupported codec (e.g. AV1 on a build without AV1 decode). |
| 507 | `VMSInsufficientStorage` | Disk full / quota exceeded. |

#### After upload

```bash
# 1. Take the sensorId / streamId from the upload response (UUID for PUT, filename for POST).
SID=<sensorId-from-response>

# 2. Give the discovery cycle a few seconds, then confirm and grab the RTSP URL.
sleep 5
curl -s "http://<NVSTREAMER_ENDPOINT>/vst/api/v1/sensor/$SID/streams" | jq '.[0].url'
```

> **Codec/resolution/framerate metadata populates asynchronously.** Immediately after upload, `GET /sensor/<id>/streams` returns the stream entry but its `metadata` fields (`codec`, `resolution`, `framerate`, `bitrate`, `govlength`) are `null` or empty strings. The streamer probes the file in the background and fills them in within ~15-30 seconds. If you need the codec or dimensions right away, call `GET /storage/file/mediainfo?sensorId=<id>` instead — that endpoint reads media info on demand and returns populated values immediately.

> The newly uploaded file lands in the host directory bind-mounted into the streamer videos volume. The file persists across container restarts; the in-memory sensor record is re-built from the file at startup.

---

### 4. Delete a Sensor / File

Which call to use depends on whether you want to remove the in-memory sensor only (it will reappear on next discovery if the file is still on disk) or the underlying video file too.

**Remove just the in-memory sensor record:**
```bash
# Returns the JSON literal `true`.
# WARNING: if the underlying file is still in the streamer videos directory, NvStreamer's
# discovery loop will re-register it as a sensor within seconds.
curl -s -X DELETE "http://<NVSTREAMER_ENDPOINT>/vst/api/v1/sensor/<sensorId>" | jq .
```

**Remove the sensor AND the on-disk file:**
```bash
# Pass NO time range — for NvStreamer file sensors this deletes the physical file and removes the sensor.
# Returns null on success.
curl -s -X DELETE "http://<NVSTREAMER_ENDPOINT>/vst/api/v1/storage/file/<streamId>"
```

- Use the `streamId` from the upload response (UUID for PUT uploads; filename-derived for POST uploads and auto-discovered files).
- Passing `?startTime=*&endTime=*` is NOT a no-op equivalent on NvStreamer — it returns `{"spaceSaved": 0}` without actually deleting the file (the time-bounded path expects real timeline windows, which file sensors do not have). **Omit the time range** for NvStreamer file delete.
- If the streamer cannot find a backing stream for the given id, it returns `{"error_code": "VMSInternalError", "error_message": "Failed find the stream object of the file"}`. This usually means you passed the *filename* for a sensor whose `streamId` is actually a UUID — recheck against `/sensor/list`.

> **Do NOT mix VIOS's two-step RTSP delete with NvStreamer.** On VIOS, RTSP sensors require both `/sensor/<id>` + `/storage/file/<streamId>?startTime=...&endTime=...` (see `api-reference.md § 7-8`). On NvStreamer, every sensor is file-backed — use the single `DELETE /storage/file/<streamId>` form above to fully remove a sensor and its file.

---

### 5. Snapshots

NvStreamer's snapshot semantics differ from VIOS because every file is a finite VOD source — there is no live wall-clock camera. **The two variants take different parameters:**

**Live snapshot — keyed by `frameId`** (0-based frame index into the file):
```bash
# frameId is REQUIRED. frameId=0 returns the first frame.
curl -s -o snapshot.jpg "http://<NVSTREAMER_ENDPOINT>/vst/api/v1/live/stream/<streamId>/picture?frameId=<frameId>"
```
- Calling `/live/stream/<id>/picture` without `frameId` returns HTTP 500 `{"error_code": "VMSInternalError", "error_message": "Wrong time format or frameId provided"}`.
- Optional `width` / `height` query params resize the JPEG.
- The `streamId` HTTP header is not required — the path parameter is sufficient. Sending the header is harmless.

**Storage snapshot — keyed by `startTime`** (NOT `frameId`):
```bash
# startTime is REQUIRED on NvStreamer's storage variant. Pick a timestamp inside the file's effective range
# (uploaded files default to 2025-01-01T00:00:00.000Z + file duration unless a different timestamp was passed at upload).
curl -s -o snapshot.jpg "http://<NVSTREAMER_ENDPOINT>/vst/api/v1/storage/stream/<streamId>/picture?startTime=<isoUTC>"
```
- `?frameId=<anything>` is rejected on the storage variant — every `frameId` value (including 0) returns HTTP 400 `InvalidParameterError`. Use `startTime` instead, or use the live variant if you want frame-indexed access.
- Optional: `width`, `height`. The `streamId` HTTP header is not required.

**Snapshot URLs (no download):** `/live/stream/<id>/picture/url` and `/storage/stream/<id>/picture/url` return `{absolutePath, imageUrl, expiryISO, expiryMinutes, streamId, type}`. **`imageUrl` caveat:** on standalone NvStreamer deployments the host portion is often empty (`http://:30888/...`) because the streamer's `reverseProxyServerAddress` is unset. The file at `absolutePath` is the reliable artifact.

---

### 6. Storage Info & Media Info

NvStreamer exposes the storage microservice for upload + delete, but storage stats reflect the on-disk videos directory (mostly static between uploads).

```bash
# Disk usage of the videos volume (megabytes).
curl -s "http://<NVSTREAMER_ENDPOINT>/vst/api/v1/storage/info" | jq .

# Per-stream + total storage usage (the per-stream block is usually empty on NvStreamer because no recordings).
curl -s "http://<NVSTREAMER_ENDPOINT>/vst/api/v1/storage/size" | jq .

# Media info (codec, container, fps, resolution, bitrate, duration) for a file-backed sensor.
# Pass sensorId — the streamer resolves it to the local file path internally.
curl -s "http://<NVSTREAMER_ENDPOINT>/vst/api/v1/storage/file/mediainfo?sensorId=<sensorId>" | jq .
```

`GET /storage/file/list` and `GET /storage/file/<sensorId>/list` are present but return `{}` (no recorded files).

---

### 7. Filesystem Scan

Forces NvStreamer to re-scan its videos directory and register any newly-present files as sensors. Use this when a file has been dropped into the directory by a path *other* than the upload APIs (e.g. `docker cp`, a host-side `mv` into the bind-mounted volume, or a separate tool) and you want it to appear immediately rather than waiting for the next auto-discovery tick.

```bash
# Async — returns HTTP 200 with body `null` as soon as the scan is queued.
curl -s -X POST "http://<NVSTREAMER_ENDPOINT>/vst/api/v1/sensor/scan" -w "HTTP %{http_code}\n"
```

Behavior on the streamer adaptor:
- Re-connects the adaptor and rebuilds the sensor list from the videos directory.
- Clears the user-removed list — sensors previously deleted via `DELETE /sensor/<id>` whose underlying files are still on disk will **reappear** after the scan. To keep a file off the sensor list you must delete the file too (Section 4).
- Discovers new files with a uniqueified `sensorId` if a name collision would otherwise occur (e.g. dropping `foo.mp4` when a `foo` sensor already exists creates `foo_<N>`).
- Does NOT affect uploaded files (they are already auto-registered by the upload path).

Confirm with `/sensor/list` after a short delay:
```bash
sleep 2
curl -s "http://<NVSTREAMER_ENDPOINT>/vst/api/v1/sensor/list" | jq '.[] | {sensorId, name, location}'
```

---

## Canonical workflow: NvStreamer → VIOS handoff

The reason this reference exists in the VIOS skill: the load-bearing pattern that uses NvStreamer is **upload to NvStreamer, get RTSP URL, register with VIOS**.

> **Precondition for step 4.** The handoff requires the VIOS stream-processor to be part of the active deployment. Most VSS profiles ship both (`dev-profile-alerts`, `dev-profile-lvs`, `dev-profile-search`, all warehouse profiles), but custom or NvStreamer-only setups may not include VIOS. **Probe `curl -sf --max-time 5 http://${HOST_IP}:30888/vst/api/v1/sensor/version` and confirm `type == "vst"` before attempting `POST /sensor/add`.** If VIOS is not present, stop at step 3 — NvStreamer's RTSP URL is already serving and can be consumed directly by any RTSP client (ffmpeg, VLC, mediamtx, custom analytic).

1. Verify NvStreamer is reachable and is a streamer (not a VIOS gateway):
   ```bash
   curl -sf --connect-timeout 5 "http://<NVSTREAMER_ENDPOINT>/vst/api/v1/sensor/version" | jq -e '.type == "streamer"'
   ```
2. Upload the file via PUT v2 — `sensorId` / `streamId` come back as a fresh UUID:
   ```bash
   FILE=/path/to/video.mp4
   SID=$(curl -s -X PUT \
     -H "Content-Type: application/octet-stream" \
     -H "Content-Length: $(stat -c %s "$FILE")" \
     --upload-file "$FILE" \
     "http://<NVSTREAMER_ENDPOINT>/vst/api/v1/storage/file/$(basename "$FILE")?timestamp=2025-01-01T00:00:00.000Z" \
     | jq -r '.sensorId')
   ```
3. NvStreamer now serves the file over RTSP. Read the actual URL after the discovery cycle:
   ```bash
   sleep 5
   URL=$(curl -s "http://<NVSTREAMER_ENDPOINT>/vst/api/v1/sensor/$SID/streams" | jq -r '.[0].url')
   ```
4. **(Only if VIOS stream-processor is part of the deployment — see precondition above.)** Register that RTSP URL with VIOS via VIOS's `POST /vst/api/v1/sensor/add` (see `api-reference.md § 6`):
   ```bash
   # Confirm VIOS is up before attempting registration.
   curl -sf --max-time 5 "http://<VST_ENDPOINT>/vst/api/v1/sensor/version" | jq -e '.type == "vst"' \
     || { echo "VIOS stream-processor not deployed — skipping /sensor/add"; exit 0; }

   curl -s -X POST "http://<VST_ENDPOINT>/vst/api/v1/sensor/add" \
     -H "Content-Type: application/json" \
     -d "{\"sensorUrl\": \"$URL\"}" | jq .
   ```
   VIOS treats the URL as an upstream RTSP camera; from this point on, the file goes through the recorder, WebRTC live/replay, snapshot, and clip-download codepaths exactly like any other RTSP sensor.

This is the canonical pattern for synthetic test streams, regression bring-up, and demos. NvStreamer is the file → RTSP boundary; VIOS owns everything downstream — but step 4 is **conditional** on VIOS being present.
