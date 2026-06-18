# Calibration workflow (chain into AMC)

Parent: [`../SKILL.md`](../SKILL.md). Load this reference **only when** the user picked `videos` or `rtsp` in Q1 AND the calibration check in Q2 found `calibration.json` + `camInfo/` missing or incomplete.

**Skip when:** Q1 = `sample` (calibration ships with the repo and is already normalized) — go straight to [`deploy-rtvi-cv-3d-stack.md`](deploy-rtvi-cv-3d-stack.md). If the user supplied a calibration path, go to [`configure-cameras.md`](configure-cameras.md) first so camera names and `NUM_STREAMS` are validated before deploy.

This reference drives AMC end-to-end via its REST API — the user does **not** open the AMC UI. Hand-back to SKILL.md happens once calibration files are landed at the MV3DT mount path.

## Where calibration must end up

For perception and BEV fusion to read them, calibration files must live at:

```
${VSS_APPS_DIR}/industry-profiles/warehouse-operations/warehouse-mv3dt-app/calibration/sample-data/${SAMPLE_VIDEO_DATASET}/
├── calibration.json                        # consumed by vss-behavior-analytics-mv3dt (warehouse-mv3dt-app.yml:25)
├── camInfo/cam_*.yaml                      # consumed by vss-rtvi-cv-mv3dt (warehouse-mv3dt-app.yml:283)
└── images/                                 # optional reference frames, matches sample layout
```

The user's Q3 slug becomes the `${SAMPLE_VIDEO_DATASET}` directory name.

## Step 1 — Hand off to the AMC skill for setup

**Do not reinvent AMC setup here.** Walk the full deploy flow in [`../../vss-generate-video-calibration/references/deploy-auto-calibration-service.md`](../../vss-generate-video-calibration/references/deploy-auto-calibration-service.md) end-to-end. The AMC skill owns its deploy profile, VIOS prerequisites, RTSP capture flow, and API contract; this MV3DT skill only adds the MV3DT export and final-deploy handoff.

The MV3DT chain has two skill-specific requirements on top of the AMC skill's defaults:

### 1a. Stage VGGT before the calibration run (recommended for MV3DT)

The AMC skill marks VGGT as **optional Step 2** ("Skip unless the user explicitly asks for VGGT-refined output"). For the MV3DT use case, **stage it anyway** — the MV3DT export endpoint (`GET /v1/result/<id>/mv3dt_result?result_type=vggt`) returns VGGT-refined calibration which yields better BEV Fusion accuracy than the bare AMC output. The wall-clock cost is one-time (model download ~4.7 GB + a separate VGGT calibration pass after the main calibration completes).

Follow `deploy-auto-calibration-service.md` **Step 2** verbatim — HuggingFace license-accept, `HF_TOKEN`, `hf download facebook/VGGT-1B-Commercial`, place at `${VSS_DATA_DIR}/auto-calib/vggt/vggt_1B_commercial.pt`, `chmod a+r`. Skip only if the user explicitly opts out of VGGT (small accuracy hit, but still works).

### 1b. RTSP preflight (rtsp mode only)

If Q1 was `rtsp`, follow [`../../vss-generate-video-calibration/references/rtsp.md`](../../vss-generate-video-calibration/references/rtsp.md) for the VIOS probe, capture request, polling, ingest, and alignment/layout upload flow. For `videos` mode, use the AMC `videos.md` reference instead.

### 1c. Deploy AMC

Use [`../../vss-generate-video-calibration/references/deploy-auto-calibration-service.md`](../../vss-generate-video-calibration/references/deploy-auto-calibration-service.md) as the source of truth for bringing up AMC. Do not hardcode an RTSP-specific compose profile in this MV3DT reference; use whatever deployment/profile that AMC skill selects for the user's calibration mode.

### 1d. Verify

Per `deploy-auto-calibration-service.md` **Step 4**:

```bash
curl -sf "http://localhost:${VSS_AUTO_CALIBRATION_PORT:-8010}/v1/ready"
# Expected: {"code":0,"message":"VSS Auto Calibration Microservice is ready"}
```

AMC readiness, VIOS configuration, and RTSP capture prerequisites are owned by the AMC skill. Confirm AMC is ready here, then continue with the mode-specific AMC reference in Step 2.

Even though this flow drives AMC via the API, **tell the user they can watch live calibration progress in the AMC UI** at `http://${HOST_IP}:${VSS_AUTO_CALIBRATION_UI_PORT:-5000}` (open the project created in Step 2).

### 1e. Open perms on the project-state bind-mount (pre-empt UID-1000 gotcha)

The AMC microservice writes project state to `${VSS_APPS_DIR}/services/auto-calibration/projects/` as UID 1000. On a fresh checkout this directory either doesn't exist yet, or compose's bind-mount created it as `root:root 0755` at `up` time — either way, the first `POST /v1/create_project` (Step 2) fails with `HTTP 500 {"detail":"Failed to Create Project ...: [Errno 13] Permission denied: 'projects/project_<timestamp>'"}`. Open it before driving the API.

These commands need `sudo`. Detect the sudo mode first — same pattern as [`../../vss-deploy-profile/SKILL.md#pre-flight-check`](../../vss-deploy-profile/SKILL.md) — so this step works on hosts where sudo is passwordless **and** on hosts where it prompts for a password:

```bash
if sudo -n true 2>/dev/null; then
  sudo mkdir -p "${VSS_APPS_DIR}/services/auto-calibration/projects"
  # Grant the AMC container user (UID 1000) write access — scoped ACL, not 777, not chown.
  sudo setfacl -m u:1000:rwx "${VSS_APPS_DIR}/services/auto-calibration/projects"
  echo "AMC projects directory ready."
else
  echo "Sudo requires a password on this host. Please run the two commands below in your shell, then confirm to continue:"
  echo "  sudo mkdir -p \"${VSS_APPS_DIR}/services/auto-calibration/projects\""
  echo "  sudo setfacl -m u:1000:rwx \"${VSS_APPS_DIR}/services/auto-calibration/projects\""
fi
```

When sudo prompts for a password, hand the block above to the user with a *"run this once and confirm"* note and resume Step 2 only after they confirm. Do not retry the `sudo -n` check in a loop — it will not change without user action.

Scoped ACL for UID 1000 — not world-writable and not chown. This matches how the AMC skill itself handles this directory (see [`../../vss-generate-video-calibration/references/deploy-auto-calibration-service.md`](../../vss-generate-video-calibration/references/deploy-auto-calibration-service.md) Step 5) and the convention in [`../../vss-deploy-profile/references/data-directory.md`](../../vss-deploy-profile/references/data-directory.md). Idempotent and safe to re-run.

## Step 2 — Drive AMC end-to-end

**Do not reinvent the API flow here.** Walk the AMC skill's mode-specific reference for the input portion, then the shared tail in its `SKILL.md` for verify → calibrate → poll → results. The AMC skill owns the canonical API contract.

| Q1 mode | AMC reference to walk |
|---|---|
| `videos` | [`../../vss-generate-video-calibration/references/videos.md`](../../vss-generate-video-calibration/references/videos.md) (input handling) → [`../../vss-generate-video-calibration/SKILL.md#shared-calibration-tail`](../../vss-generate-video-calibration/SKILL.md) (verify / calibrate / poll) |
| `rtsp` | [`../../vss-generate-video-calibration/references/rtsp.md`](../../vss-generate-video-calibration/references/rtsp.md) (VIOS-mediated ingest) → same shared tail |

Inputs the AMC flow needs from the parent SKILL.md's Q3:

- `project_name` — short slug
- `detector_type` — `resnet` or `transformer`, passed at the AMC shared-tail Step B (`POST /v1/calibrate/<id>`)
- `VIDEO_DIR` (videos mode) or RTSP URLs (rtsp mode)

For `rtsp`, keep the ordered RTSP URL list from the AMC capture request. After calibration export and camera-name normalization, final MV3DT deployment needs the same URLs in `camera_info.json`, with camera names matching the normalized `calibration.json` sensor IDs (`Camera`, `Camera_01`, ...).

Capture the `project_id` from the AMC flow's project-creation step — you'll need it in Step 3 to fetch the MV3DT export. Wait until `project_state == COMPLETED` before proceeding.

### 2a. Alignment + layout gate — do not skip

The gate here is that **`alignment_data.json` + `layout.png` are actually present** before `/verify_project` — *not* that the user opened the UI. Two paths:

- **Files on disk (common):** if `alignment_data.json` and `layout.png` exist (the AMC `videos` flow auto-detects them in the videos dir / its parent), they're uploaded via `/upload_alignment` + `/upload_layout` — **no UI step needed.** Skip straight to the on-disk verification below.
- **Files missing:** **pause and direct the user to the AMC UI** ([`../../vss-generate-video-calibration/SKILL.md#ui-fallback-pattern`](../../vss-generate-video-calibration/SKILL.md)) to provide them:
  - **Step 3 — Parameters**: tune or review settings, then **Save**. Also confirm the detector you'll pass to `/calibrate` — Step 3 does not cover it.
  - **Step 4 — Alignment**: upload `alignment_data.json` or mark correspondence points on `layout.png`, then **Save**.

Either way, verify on disk before continuing:

```bash
MANUAL_DIR="${VSS_APPS_DIR}/services/auto-calibration/projects/project_${project_id}/manual_adjustment"
test -f "${MANUAL_DIR}/alignment_data.json" && test -f "${MANUAL_DIR}/layout.png" \
  || { echo "ERROR: alignment/layout missing — upload via API, or have the user Save them in AMC UI Step 4"; exit 1; }
```

**Do not treat `verify_project` returning `READY` as sufficient** — some microservice versions return READY without alignment, but calibration will produce unusable poses. The on-disk check above is the gate.

## Step 3 — Run VGGT refinement, then fetch the MV3DT export

The AMC microservice exposes a dedicated MV3DT export endpoint (documented in [`../../vss-generate-video-calibration/SKILL.md:176-196`](../../vss-generate-video-calibration/SKILL.md)), with two `result_type` variants: `amc` (base) and `vggt` (refined). MV3DT chaining should prefer `vggt` when available.

### 3a. Run VGGT (if staged in Step 1a)

After Step 2's `project_state == COMPLETED`, check `vggt_state` in `/v1/get_project_info/<id>`. If `READY` (model staged + base calibration done), fire VGGT and poll:

```bash
curl -sf -X POST "http://localhost:8010/v1/vggt/calibrate/${project_id}"

while true; do
  vggt_state=$(curl -s "http://localhost:8010/v1/get_project_info/${project_id}" \
    | jq -r '.project_info.vggt_state')
  case "${vggt_state}" in
    COMPLETED) echo "VGGT done"; break ;;
    ERROR)     echo "VGGT failed — falling back to AMC result"; break ;;
    *)         sleep 10 ;;
  esac
done
```

If VGGT wasn't staged (user opted out in Step 1a) or hit `ERROR`, skip 3a and use `result_type=amc` in 3b.

### 3b. Pick the best available result type

```bash
# Prefer VGGT when available; fall back to AMC
if [ "${vggt_state}" = "COMPLETED" ]; then
  RESULT_TYPE=vggt
else
  RESULT_TYPE=amc
fi
```

### 3c. Fetch the MV3DT export (camInfo + transforms.yml)

```bash
curl -sfL "http://localhost:8010/v1/result/${project_id}/mv3dt_result?result_type=${RESULT_TYPE}" \
  -o /tmp/mv3dt_output.zip

# Inspect — ZIP contains transforms.yml and per-cam camInfo files
unzip -l /tmp/mv3dt_output.zip
```

### 3d. Trigger + fetch `calibration.json` (BEV grid + sensor world coords)

The MV3DT ZIP gives you per-camera intrinsics/extrinsics (`camInfo/`), which is what perception needs. `vss-behavior-analytics-mv3dt` needs a different file — the Metropolis-format `calibration.json` with `scaleFactor`, sensor world coordinates, and any ROIs/tripwires defined in the AMC UI. AMC's `export_calibration` endpoints produce this directly:

```bash
# Generate (server writes the export to disk inside the project)
curl -sf -X POST \
  "http://localhost:8010/v1/result/${project_id}/export_calibration?result_type=${RESULT_TYPE}&calibration_type=cartesian"

# Verify the export was written
curl -sf "http://localhost:8010/v1/result/${project_id}/export_exists" | jq -r '.export_file // empty'

# Download to /tmp; Step 4 places it under ${CAL_DIR}
curl -sfL \
  "http://localhost:8010/v1/result/${project_id}/export_calibration?result_type=${RESULT_TYPE}&calibration_type=cartesian" \
  -o /tmp/calibration.json
```

`calibration_type=cartesian` produces the full schema (BA results — same shape as the shipped sample). Use `calibration_type=image` only as a fallback for projects that didn't complete the full BA pass — it produces a pixel-ROI-only file behavior-analytics can still load.

ROI / tripwire arrays defined via the AMC UI Parameters dialog are included in the export; empty arrays don't block deploy (behavior-analytics just runs without those rules). **But** `group`, `region`, and `place` per sensor are a different story — when the API-only AMC/VGGT path leaves them blank, `vss-behavior-analytics-mv3dt`'s schema validator rejects the file at startup with `calibration 'upsert-all' payload failed schema validation: sensors/0/group/alias: '' should be non-empty; sensors/0/group/dimensions: [] is too short; ...` and the container enters a restart loop. Step 4 below patches these fields with placeholder values when they're empty so deploy can proceed; for metrically meaningful values, populate them in the AMC UI Parameters step before export.

## Step 4 — Land everything at the MV3DT mount path

```bash
DATASET="${SAMPLE_VIDEO_DATASET:?slug from Q3}"
CAL_DIR="${VSS_APPS_DIR}/industry-profiles/warehouse-operations/warehouse-mv3dt-app/calibration/sample-data/${DATASET}"

mkdir -p "${CAL_DIR}/camInfo" "${CAL_DIR}/images"

# camInfo/*.yaml — perception mounts this directory at /tmp/camInfo/
unzip -j -o /tmp/mv3dt_output.zip 'camInfo/*' -d "${CAL_DIR}/camInfo/" 2>/dev/null \
  || unzip -j -o /tmp/mv3dt_output.zip '*.yaml' -d "${CAL_DIR}/camInfo/"

# calibration.json — fetched in Step 3d
cp /tmp/calibration.json "${CAL_DIR}/calibration.json"

# Optional: reference images for the dataset layout (skip if unavailable)
PROJECT_OUTPUT="${VSS_APPS_DIR}/services/auto-calibration/projects/project_${project_id}/output"
ls "${PROJECT_OUTPUT}"/*.png 2>/dev/null | head -4 | xargs -I{} cp {} "${CAL_DIR}/images/" || true

# Permissions — perception mount must be readable inside the container.
# Auto-proceed when sudo is passwordless; otherwise surface the command for the user.
if sudo -n true 2>/dev/null; then
  sudo chmod -R a+rX "${CAL_DIR}"
else
  echo "Sudo requires a password on this host. Please run the command below in your shell, then confirm to continue:"
  echo "  sudo chmod -R a+rX \"${CAL_DIR}\""
fi
```

> **Permission rule:** always `chmod`, never `chown`. Containers run as varied UIDs; world-readable is the safe baseline. This matches the convention in `vss-deploy-profile/references/data-directory.md`.

### 4a — Patch empty `group` / `region` / `place` (custom-data exports)

`vss-behavior-analytics-mv3dt` validates `sensors[].group`, `sensors[].region`, and `sensors[].place` at startup. API-only AMC or VGGT exports can leave one of these sections empty, so inject placeholder values that pass the validator and let deploy proceed.

> These placeholders only satisfy the schema so the stack starts — they are **not** geometrically meaningful. The square `dimensions` will make the BEV top-view floor map look squished/stretched and any region-scoped analytics use the wrong bounds. Getting accurate values is a **post-deploy tuning step**, not a blocker: leave the placeholders here and point the user to [`verify-and-view.md` § "Tune BEV `group`/`region` for better overlays"](verify-and-view.md) after the stack is up. (The BEV `origin`/`dimensions` are normally derived from camera FOV coverage by the VSS Configurator / `spatial-ai-data-utils`'s `calculate_origin.py`, or set per the NVIDIA 3D-profile customization docs.)

Idempotent — re-running this block is safe and does nothing once values are populated.

```bash
# `//` makes this null-safe. VGGT can populate group while leaving region
# empty, so test every schema-required group/region/place field before deploy.
if jq -e '
  any(.sensors[]?;
    ((.group.name // "") == "")
    or ((.group.alias // "") == "")
    or ((.group.dimensions // []) | length < 4)
    or ((.region.placeLevel // "") == "")
    or ((.region.origin // []) | length < 2)
    or (((.region.dimensions.length // 0) | tonumber? // 0) <= 0)
    or (((.region.dimensions.width // 0) | tonumber? // 0) <= 0)
    or ((.place // []) | length < 3)
  )
' "${CAL_DIR}/calibration.json" >/dev/null 2>&1; then
  jq '
    .sensors |= map(
        .group = {
          name: "bev-sensor-1",
          alias: "area-1",
          type: "bev",
          origin: [0.0, 0.0],
          dimensions: [-25.0, -25.0, 25.0, 25.0]
        }
      | .region = {
          placeLevel: "region",
          origin: [-25.0, -25.0],
          dimensions: { length: 50.0, width: 50.0 }
        }
      | .place = [
          { name: "building", value: "Warehouse" },
          { name: "room",     value: "Room-1"    },
          { name: "region",   value: "Region-1"  }
        ]
    )
  ' "${CAL_DIR}/calibration.json" > "${CAL_DIR}/calibration.json.patched" \
    && mv "${CAL_DIR}/calibration.json.patched" "${CAL_DIR}/calibration.json"
  echo "patched group/region/place placeholders into ${CAL_DIR}/calibration.json"
fi
```

### 4b — Synthesize `images/Top.png` + `imageMetadata.json` (extended profile only)

`vss-import-calibration-output-mv3dt` (deployed under `MINIMAL_PROFILE=""`) requires both files; it exits 1 with `imageMetadata.json not found at /opt/vss/images/imageMetadata.json` otherwise, leaving the overlay index unpopulated in Elasticsearch. The AMC export doesn't produce them — synthesize from the user-supplied layout (or any AMC project output PNG as a fallback). Place hierarchy is derived from the patched `calibration.json` so the two stay in sync.

```bash
mkdir -p "${CAL_DIR}/images"

if [ ! -f "${CAL_DIR}/images/Top.png" ]; then
  # Priority order: user-supplied layout > AMC manual_adjustment layout > any AMC project output PNG
  for cand in \
      "${LAYOUT_PNG:-/dev/null}" \
      "${VSS_APPS_DIR}/services/auto-calibration/projects/project_${project_id}/manual_adjustment/layout.png" \
      "${VSS_APPS_DIR}/services/auto-calibration/projects/project_${project_id}/output"/*.png; do
    if [ -f "${cand}" ]; then
      cp "${cand}" "${CAL_DIR}/images/Top.png"
      echo "Top.png sourced from ${cand}"
      break
    fi
  done
fi

if [ -f "${CAL_DIR}/images/Top.png" ] && [ ! -f "${CAL_DIR}/images/imageMetadata.json" ]; then
  # Build place= string from sensors[0].place (Step 4a guarantees this is populated)
  PLACE_PATH=$(jq -r '
    (.sensors[0].place // [])
    | map("\(.name)=\(.value)")
    | join("/")
    | if . == "" then "building=Warehouse/room=Room-1/region=Region-1" else . end
  ' "${CAL_DIR}/calibration.json")
  cat > "${CAL_DIR}/images/imageMetadata.json" <<JSON
{
  "images": [
    { "place": "${PLACE_PATH}", "view": "plan-view", "fileName": "Top.png" }
  ]
}
JSON
  echo "synthesized imageMetadata.json with place=${PLACE_PATH}"
fi

if sudo -n true 2>/dev/null; then
  sudo chmod -R a+rX "${CAL_DIR}/images"
else
  echo "Sudo requires a password on this host. Please run the command below in your shell, then confirm to continue:"
  echo "  sudo chmod -R a+rX \"${CAL_DIR}/images\""
fi
```

If no candidate PNG is available (rare — most users have a layout for the AMC alignment step), the import container will still exit 1, but the rest of the stack runs without overlays. Either re-deploy with `MINIMAL_PROFILE="true"` or source a plan-view PNG manually.

**Sanity check** before moving on:

```bash
ls "${CAL_DIR}/camInfo/"*.{yml,yaml} 2>/dev/null | wc -l   # must equal user's camera count
test -f "${CAL_DIR}/calibration.json" && jq -e '.sensors | length' "${CAL_DIR}/calibration.json" >/dev/null && echo "calibration.json OK"
jq -e '(.sensors[0].group.name // "") != ""' "${CAL_DIR}/calibration.json" >/dev/null && echo "group/region/place populated"
# Extended profile only:
test -f "${CAL_DIR}/images/Top.png" && test -f "${CAL_DIR}/images/imageMetadata.json" && echo "overlay assets OK"
```

All checks should pass (or be N/A under `MINIMAL_PROFILE="true"`). If `camInfo/` is empty, the ZIP layout was unexpected — open `/tmp/mv3dt_output.zip` and confirm where the YAML files live. If `calibration.json` is missing or has no `sensors[]` entries, re-check the Step 3d export status via `/v1/result/${project_id}/export_exists` and pull the calibration log: `curl http://localhost:8010/v1/amc/calibrate/${project_id}/log`.

## Step 5 — Tear down AMC

Leave the host clean before MV3DT comes up. Use the stopping/teardown command from [`../../vss-generate-video-calibration/references/deploy-auto-calibration-service.md`](../../vss-generate-video-calibration/references/deploy-auto-calibration-service.md) for the AMC deployment path that was used. Do not tear down the final MV3DT profile here.

Project state under `${VSS_APPS_DIR}/services/auto-calibration/projects/project_<id>/` is bind-mounted, so it survives the down. You can re-run AMC later without losing work.

## Step 6 — Return to SKILL.md

Calibration is now on disk at `${CAL_DIR}`. Hand back to the parent flow:

1. Walk [`configure-cameras.md`](configure-cameras.md) — run Step 0 to normalize AMC/VGGT sensor IDs and video names to `Camera, Camera_01, ...`, then set `NUM_STREAMS` to the `camInfo/*.yaml` count and sync DeepStream batch sizes.
2. For `rtsp`, create or update `${VSS_APPS_DIR}/industry-profiles/warehouse-operations/camera_configs/camera_info.json` before final deploy. Use the ordered RTSP URLs from AMC capture, and use the normalized sensor IDs from `${CAL_DIR}/calibration.json` as each `camera_name`. Set `SENSOR_INFO_SOURCE=file` and `SENSOR_FILE_PATH` in `.env`; [`deploy-rtvi-cv-3d-stack.md`](deploy-rtvi-cv-3d-stack.md) shows the schema and validates it.
3. Walk [`deploy-rtvi-cv-3d-stack.md`](deploy-rtvi-cv-3d-stack.md) — `docker compose up` with `MODE=mv3dt` + `BP_PROFILE=bp_wh_kafka` + `MINIMAL_PROFILE=""` (extended, the Q0 default — overlays enabled). Use `MINIMAL_PROFILE="true"` only if the user explicitly chose minimal in Q0.
4. Walk [`verify-and-view.md`](verify-and-view.md) — confirm perception FPS, BEV ready, VST video wall.

## Failure modes specific to this chain

Generic AMC failures (verify_project not READY, ERROR early, RUNNING > 90 min, etc.) are covered in [`../../vss-generate-video-calibration/SKILL.md#cross-cutting-troubleshooting`](../../vss-generate-video-calibration/SKILL.md) and the per-mode references — defer to those.

Issues specific to the MV3DT chain:

| Symptom | Fix |
|---|---|
| `POST /v1/create_project` returns HTTP 500 with body `{"detail":"Failed to Create Project ...: [Errno 13] Permission denied: 'projects/project_<timestamp>'"}` | First-time deploy on a fresh checkout — the MS writes project state as UID 1000 but `${VSS_APPS_DIR}/services/auto-calibration/projects/` is either missing or owned `root:root 0755` from the compose bind-mount. Run Step 1e above (scoped `sudo setfacl -m u:1000:rwx ...`), then retry. Use the ACL, not chown. |
| MV3DT export ZIP missing `camInfo/*.yaml` after `result_type=amc` | AMC project didn't produce the MV3DT export — verify `project_state == COMPLETED` via `/v1/get_project_info/<id>` before fetching. |
| `result_type=vggt` returns 404 / empty ZIP | VGGT didn't run to completion. Check `vggt_state` — if `INIT` the model wasn't staged (Step 1a); if `ERROR` see VGGT log. Fall back to `result_type=amc`. |
| `POST /export_calibration` returns non-200 | Project hasn't completed the BA pass — re-check `project_state == COMPLETED`. As a fallback, retry with `calibration_type=image` for a pixel-ROI-only export. |
| `GET /export_exists` returns `export_file: null` after a successful POST | The export run failed silently — pull `GET /v1/amc/calibrate/${project_id}/log` for the failure reason. |
| Downloaded `calibration.json` has empty `sensors[]` | Project completed without sensors registered — verify the upload step (`/upload_video_files` succeeded and `/verify_project` returned READY). |
| Downloaded `calibration.json` has empty `roi` / `tripwire` arrays | Expected — these are user-defined via the AMC UI Parameters dialog. behavior-analytics still starts; just no analytics rules until you define some. |
| User has only 1 camera | MV3DT requires multi-view (≥2 cameras). Use the 2D / 3D-per-camera paths in `vss-deploy-profile/references/warehouse.md` instead. |
| User has 1–3 cameras (< sample count) | Set `NUM_STREAMS` in [`configure-cameras.md`](configure-cameras.md) Step 3 to the actual count; confirm any camera-clustering config (`create_camera_clusters.py`) matches. |

For non-MV3DT-chain failures, see [`troubleshooting.md`](troubleshooting.md).
