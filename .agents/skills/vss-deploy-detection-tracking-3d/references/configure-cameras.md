# Configure cameras (sync NUM_STREAMS to calibration)

Parent: [`../SKILL.md`](../SKILL.md). Run **after** calibration is on disk (either ship-with-repo for `sample`, or landed by [`calibration-workflow.md`](calibration-workflow.md), or user-supplied) and **before** [`deploy-rtvi-cv-3d-stack.md`](deploy-rtvi-cv-3d-stack.md).

The shipped warehouse `.env` defaults to `NUM_STREAMS=4` and a 4-camera sample. If you're using the sample as-is, this reference is a no-op — skim and continue. It's load-bearing only when the user's actual camera count differs from 4, or when redeploying after AMC trimmed cameras down.

## Why this matters

`NUM_STREAMS` propagates to several places that must agree — when they disagree, perception will either process fewer streams than expected or fail at engine build:

| Consumer | Where | What it does |
|---|---|---|
| `vss-configurator-mv3dt` | `blueprint-configurator/blueprint_config.yml` line 579–586 | Computes `final_stream_count = min(NUM_STREAMS, max_streams_supported[HARDWARE_PROFILE].mv3dt)`. For sample/videos, applies a `keep_count` op against `${VSS_DATA_DIR}/videos/${SAMPLE_VIDEO_DATASET}/`; for RTSP, keep `camera_info.json`, calibration, and `NUM_STREAMS` aligned yourself. |
| `vss-rtvi-cv-bev-fusion` | `services/rtvi/rtvi-cv/rtvi-cv-mv3dt/compose.yaml:53` (`MAX_EXPECTED_SENSORS: ${NUM_STREAMS:-4}`) | BEV Fusion buffers per-camera detections; if `MAX_EXPECTED_SENSORS` < actual streams, late cameras get dropped from fused frames |
| `vss-rtvi-cv-mv3dt` (perception) | `warehouse-mv3dt-app.yml:290-291` (`BATCH_SIZE` and `MAX_BATCH_SIZE` set to `${NUM_STREAMS:-4}`) | DeepStream batch size — wrong value triggers reallocation or OOM at engine build |
| `vss-vios-nvstreamer-mv3dt` / VST sensor-ms | streamcount registration with VST | If configurator registers more sensors than calibration covers, perception will receive frames for un-calibrated cameras and reject them |

The authoritative source for **how many cameras you have** is `calibration.json` — it has an explicit `sensors[]` array. Use that as ground truth; the `camInfo/` directory listing is a fallback.

## Step 0 — Normalize camera names to the perception convention

The perception container ships a hardcoded `pub_sub_info_config.yml` (`warehouse-mv3dt-app/deepstream/configs/pub_sub_info_config.yml`) and tracker config (`warehouse-mv3dt-app/deepstream/configs/ds-mv3dt-tracker-config.yml`) expecting cameras named `Camera` (first), `Camera_01`, `Camera_02`, … When VST registers sensors under any other name — e.g. `cam_00..cam_03` from AMC defaults that follow the user's video filenames, or `Camera_00` with the leading-zero variant — perception fails at MQTT init and the tracker can't submit frames:

```
!![Exception] [MqttCommunicator] Error initializing pub/sub info: invalid node; first invalid key: "cam_01"
ERROR from tracking_tracker: Failed to submit input to tracker
gstnvtracker: Low-level tracker lib returned error 1
```

VST infers sensor names from the video filename, so the rename must touch videos, `camInfo/*.yml`, and the `sensors[].id` field in `calibration.json` together. Run **once** before deploy — once VST has registered sensors with the old names, use Step 5 below to reconcile VST state before redeploy (see [`troubleshooting.md`](troubleshooting.md) "Perception reports `Active sources : 0`").

Skip when:
- Q1 = `sample` (calibration ships with the correct names already).
- The user supplied a calibration that already uses `Camera, Camera_01..N`.

Idempotent and guarded: the block below is a no-op when the first sensor is already named `Camera`. It defaults to **dry-run** and prints the planned changes. For custom AMC/VGGT outputs whose sensor IDs are `cam_00..`, review the plan and re-run with `APPLY_RENAME=1` before deploy; otherwise VST streamprocessing cannot match runtime stream names to calibration IDs. When applied, it writes `calibration.pre-normalize.json` and `camera-normalization-manifest.json` under `CAL_DIR` before changing files in place.

```bash
DATASET="${SAMPLE_VIDEO_DATASET:?}"
CAL_DIR="${VSS_APPS_DIR}/industry-profiles/warehouse-operations/warehouse-mv3dt-app/calibration/sample-data/${DATASET}"
VIDEO_DIR="${VSS_DATA_DIR}/videos/${DATASET}"

APPLY_RENAME="${APPLY_RENAME:-0}" \
VSS_APPS_DIR="${VSS_APPS_DIR}" VSS_DATA_DIR="${VSS_DATA_DIR}" \
  SAMPLE_VIDEO_DATASET="${DATASET}" python3 - <<'PY'
import json, os, shutil
from pathlib import Path

DATASET = os.environ["SAMPLE_VIDEO_DATASET"]
APPLY = os.environ.get("APPLY_RENAME") == "1"
CAL_DIR = Path(os.environ["VSS_APPS_DIR"]) / "industry-profiles/warehouse-operations/warehouse-mv3dt-app/calibration/sample-data" / DATASET
VID_DIR = Path(os.environ["VSS_DATA_DIR"]) / "videos" / DATASET

cal_path = CAL_DIR / "calibration.json"
d = json.loads(cal_path.read_text())

if not d.get("sensors"):
    raise SystemExit("calibration.json has no sensors[] — re-walk calibration-workflow.md Step 3d")

# Idempotent: skip when first sensor is already "Camera"
if d["sensors"][0].get("id") == "Camera":
    print("already normalized — skipping rename")
    raise SystemExit(0)

# Build remap: index 0 -> "Camera"; indices >=1 -> "Camera_NN" (zero-padded width 2).
# Matches the shipped pub_sub_info_config.yml / tracker config naming.
remap = {}
for i, s in enumerate(d["sensors"]):
    new = "Camera" if i == 0 else f"Camera_{i:02d}"
    remap[s["id"]] = new

operations = []

def plan_rename(src, dst, label):
    if src.exists():
        if src == dst:
            return
        if dst.exists():
            raise SystemExit(f"refusing to overwrite existing {label}: {dst}")
        operations.append((label, src, dst))

# 1. Rename video files (extension-agnostic)
for old_name, new_name in remap.items():
    for ext in ("mp4", "m4v", "mkv", "MP4"):
        src = VID_DIR / f"{old_name}.{ext}"
        plan_rename(src, VID_DIR / f"{new_name}.{ext}", "video")

# 2. Rename camInfo files — AMC default (camInfo_NN.yml), sensor-id-named (<id>.yml),
#    or extension variants. Pick the first that exists per sensor index.
caminfo = CAL_DIR / "camInfo"
for i, (old_name, new_name) in enumerate(remap.items()):
    for cand in (
        f"camInfo_{i:02d}.yml", f"camInfo_{i:02d}.yaml",
        f"{old_name}.yml",     f"{old_name}.yaml",
    ):
        src = caminfo / cand
        if src.exists():
            plan_rename(src, caminfo / f"{new_name}.yml", "camInfo")
            break

print("camera name remap:", remap)
for label, src, dst in operations:
    print(f"{label}: {src.name} -> {dst.name}")
print("calibration.json: sensor IDs will be rewritten")

if not APPLY:
    print("dry-run only — re-run with APPLY_RENAME=1 to apply these changes")
    raise SystemExit(0)

backup = CAL_DIR / "calibration.pre-normalize.json"
if not backup.exists():
    shutil.copy2(cal_path, backup)
manifest = CAL_DIR / "camera-normalization-manifest.json"
manifest.write_text(json.dumps({"dataset": DATASET, "remap": remap, "cal_dir": str(CAL_DIR), "video_dir": str(VID_DIR)}, indent=2))

for label, src, dst in operations:
    src.rename(dst)

# 3. Rewrite sensor IDs and any cross-references (e.g. globalCoordinates sibling refs)
txt = json.dumps(d, indent=2)
for old, new_name in remap.items():
    txt = txt.replace(f'"{old}"', f'"{new_name}"')
cal_path.write_text(txt)
print("renamed sensor IDs to:", [s["id"] for s in json.loads(txt)["sensors"]])
print(f"backup: {backup}")
print(f"manifest: {manifest}")
PY
```

If sensor IDs in `calibration.json` use a different pattern (e.g. user-supplied names like `north-cam`, `loading-dock`), the same block still works — it remaps by `sensors[]` order to `Camera, Camera_01, Camera_02, …`. The mapping doesn't preserve semantics; rename your videos/camInfo manually first if you need a specific order.

## Step 1 — Count cameras from `calibration.json`

```bash
DATASET="${SAMPLE_VIDEO_DATASET:?}"
CAL_DIR="${VSS_APPS_DIR}/industry-profiles/warehouse-operations/warehouse-mv3dt-app/calibration/sample-data/${DATASET}"

# Authoritative: parse calibration.json's sensors[] array (id field per sensor)
if test -f "${CAL_DIR}/calibration.json"; then
  CAM_COUNT=$(jq '.sensors | length' "${CAL_DIR}/calibration.json")
  SENSOR_IDS=$(jq -r '.sensors[].id' "${CAL_DIR}/calibration.json")
  echo "From calibration.json: ${CAM_COUNT} sensors — ${SENSOR_IDS}"
else
  # Fallback: count camInfo files. The shipped sample uses Camera*.yml; AMC
  # output may be cam_*.yaml. Accept both extensions AND both naming patterns.
  CAM_COUNT=$(find "${CAL_DIR}/camInfo/" -maxdepth 1 \
    \( -name 'cam_*.yml' -o -name 'cam_*.yaml' -o -name 'Camera*.yml' -o -name 'Camera*.yaml' \) \
    2>/dev/null | wc -l)
  echo "From camInfo/ (fallback): ${CAM_COUNT} files"
fi

test "${CAM_COUNT}" -ge 2 || { echo "ERROR: MV3DT requires ≥2 cameras"; exit 1; }
```

If `CAM_COUNT == 0`: calibration not actually landed yet — go back to [`calibration-workflow.md`](calibration-workflow.md) Step 4. If you're on the sample path and this happens, check the actual directory contents — the shipped sample uses `Camera.yml`, `Camera_01.yml`, `Camera_02.yml`, `Camera_03.yml`.

If `CAM_COUNT == 1`: MV3DT is a multi-view stack — single-camera deployment isn't supported. Use the 2D / 3D-per-camera paths in `vss-deploy-profile/references/warehouse.md` instead.

## Step 2 — Check against the GPU's `max_streams_supported`

Before propagating `NUM_STREAMS`, confirm the GPU can actually run that many MV3DT streams. For sample/videos, the configurator can trim the video set to the GPU's cap when `NUM_STREAMS` exceeds it. For RTSP, set `NUM_STREAMS` to the number of entries in `camera_info.json` and keep it within the supported count.

```bash
HARDWARE_PROFILE_VAL=$(grep '^HARDWARE_PROFILE=' "${ENV_FILE:-${VSS_APPS_DIR}/industry-profiles/warehouse-operations/.env}" | cut -d= -f2)
echo "HARDWARE_PROFILE=${HARDWARE_PROFILE_VAL}"

# Lookup public MV3DT supported stream count from the Warehouse Quickstart Guide.
case "${HARDWARE_PROFILE_VAL}" in
  RTXPRO6000BW)  CAP=18 ;;
  H100)          CAP=13 ;;
  L40S)          CAP=7  ;;
  IGX-THOR)      CAP=4  ;;
  DGX-SPARK)     CAP=4  ;;
  *)             CAP="?"; echo "WARN: HARDWARE_PROFILE=${HARDWARE_PROFILE_VAL} is not in the public MV3DT table; check .env and blueprint_config.yml before proceeding" ;;
esac

echo "GPU cap for mv3dt: ${CAP}"
echo "Calibrated cameras: ${CAM_COUNT}"
echo "Effective stream count = min(${CAM_COUNT}, ${CAP})"
```

If `CAP < CAM_COUNT`, the user has more cameras than the GPU can process at MV3DT batch size. For sample/videos, the configurator's `keep_count` file_management op will trim `.mp4` files at `${VSS_DATA_DIR}/videos/${SAMPLE_VIDEO_DATASET}/` down to `CAP`. For RTSP, reduce the camera list/calibration to the supported count or use a larger GPU before deploy. Decide:

- **Accept the cap.** Continue — perception will run with `CAP` streams, fusion will see `CAP` cameras. Tell the user explicitly so they're not surprised.
- **Move to a larger GPU.** Re-check `HARDWARE_PROFILE` against the actual hardware (see SKILL.md Prerequisites §3 for the supported MV3DT hardware slugs).
- **Override the cap.** Add a hardware-profile override in `blueprint-configurator/blueprint_config.yml` (advanced, requires understanding the trade-off — FPS will drop).

## Step 3 — Sync NUM_STREAMS in .env

```bash
ENV_FILE="${VSS_APPS_DIR}/industry-profiles/warehouse-operations/.env"

# Use the lesser of CAM_COUNT and CAP — match what the configurator will compute
[ "${CAP}" = "?" ] && EFFECTIVE="${CAM_COUNT}" \
  || EFFECTIVE=$(( CAM_COUNT < CAP ? CAM_COUNT : CAP ))

# Idempotent in-place replace
if grep -q '^NUM_STREAMS=' "${ENV_FILE}"; then
  sed -i "s/^NUM_STREAMS=.*/NUM_STREAMS=${EFFECTIVE}/" "${ENV_FILE}"
else
  echo "NUM_STREAMS=${EFFECTIVE}" >> "${ENV_FILE}"
fi

grep '^NUM_STREAMS=' "${ENV_FILE}"
```

This single key drives all three consumers above — compose substitutes `${NUM_STREAMS}` at `up` time. For RTSP, it must also equal the number of sensors in `SENSOR_FILE_PATH`; for sample/videos, it must equal the effective dataset/calibration count.

## Step 4 — Confirm DeepStream batch size

The shipped DeepStream config under `warehouse-mv3dt-app/deepstream/configs/` references `BATCH_SIZE` via env at runtime (set by `vss-configurator-mv3dt`). If the user hand-edited that config (rare), confirm `batch-size = NUM_STREAMS`:

```bash
DS_CFG_DIR="${VSS_APPS_DIR}/industry-profiles/warehouse-operations/warehouse-mv3dt-app/deepstream/configs"
grep -RnE '^batch-size|^max-batch-size' "${DS_CFG_DIR}" 2>/dev/null | head
```

Expected: lines show `${BATCH_SIZE}` / `${NUM_STREAMS}` (good — env-driven) or a number equal to `EFFECTIVE`. `vss-configurator-mv3dt` materializes the final DeepStream config on first start, so manual edits here are usually unnecessary — only intervene if a previous deploy left stale numbers.

## Step 5 — (Re-deploy only) Reconcile VST sensors with the new calibration

Relevant only when this is a **re-deploy** after the camera set changed (e.g. user re-calibrated with a different camera count, switched dataset slugs, or renamed cameras). On a fresh deploy, VST is empty — skip.

`vss-configurator-mv3dt` registers cameras with VST on start; it expects the VST sensor list and the new calibration to align by camera **name** (`Camera`, `Camera_01`, …). Default to the targeted VST API path below when the user wants to preserve existing broker, database, and overlay history.

### Default — targeted sensor trim via the VST API

Use this path when you only need to remove sensors that no longer appear in the new calibration:

```bash
VST_HOST="${HOST_IP:-localhost}"
VST_PORT="${VST_PORT:-30888}"
CAL_DIR="${VSS_APPS_DIR}/industry-profiles/warehouse-operations/warehouse-mv3dt-app/calibration/sample-data/${SAMPLE_VIDEO_DATASET}"

# Calibration uses camera names (e.g. "Camera", "Camera_01") in .sensors[].id
KEEP_NAMES=$(jq -r '.sensors[].id' "${CAL_DIR}/calibration.json")

# VST exposes sensors as { sensorId: <uuid>, name: <camera-name>, ... }.
# Match on the `name` field, delete by `sensorId`.
curl -sf "http://${VST_HOST}:${VST_PORT}/vst/api/v1/sensor/list" \
  | jq -r '.[] | "\(.sensorId) \(.name)"' \
  | while read sid name; do
      if ! echo "${KEEP_NAMES}" | grep -Fxq "${name}"; then
        curl -X DELETE "http://${VST_HOST}:${VST_PORT}/vst/api/v1/sensor/${sid}"
      fi
    done

# Verify
curl -sf "http://${VST_HOST}:${VST_PORT}/vst/api/v1/sensor/list" | jq -r '.[].name' | sort
```

Then proceed straight to [`deploy-rtvi-cv-3d-stack.md`](deploy-rtvi-cv-3d-stack.md). If the API returns HTTP 404 for some records, or the next start reports `Sensors count limit reached`, use the clean-reset path below after confirming the user accepts the volume reset.

### Last resort — reset compose volumes with `down -v`

> **WARNING:** `docker compose down -v` removes the containers and named volumes for this MV3DT compose project, not just VST sensor records. That resets data such as VST Postgres sensor metadata (`mdx_vios_pg_data`), broker/Kafka state and offsets (`mdx_mdx-kafka`), Elasticsearch overlay/index data, Logstash state, and any anonymous volumes created by compose. Use this only when the targeted VST API path does not fully reconcile the sensor set, or when the user explicitly wants a clean redeploy.

```bash
cd "${VSS_APPS_DIR}"
docker compose -f compose.yml \
  --env-file industry-profiles/warehouse-operations/.env \
  down -v
```

After the reset, proceed to [`deploy-rtvi-cv-3d-stack.md`](deploy-rtvi-cv-3d-stack.md). See [`teardown.md`](teardown.md) for the full discussion of `down -v` semantics.

## Step 6 — Sanity check before deploy

```bash
ENV_FILE="${VSS_APPS_DIR}/industry-profiles/warehouse-operations/.env"

# Triplet must agree:
echo "calibration.json sensors: $(jq '.sensors | length' "${CAL_DIR}/calibration.json" 2>/dev/null || echo MISSING)"
echo "camInfo files:            $(find "${CAL_DIR}/camInfo/" -maxdepth 1 \( -name '*.yml' -o -name '*.yaml' \) 2>/dev/null | wc -l)"
echo "NUM_STREAMS (.env):       $(grep '^NUM_STREAMS=' "${ENV_FILE}" | cut -d= -f2)"
echo "GPU cap for mv3dt:        ${CAP}"

# Sensor IDs must match VST runtime names exactly: Camera, Camera_01, ...
ok=1; i=0
while IFS= read -r id; do
  expected="Camera"
  test "$i" -eq 0 || expected=$(printf 'Camera_%02d' "$i")
  test "$id" = "$expected" || { echo "sensor ID mismatch: got '$id', expected '$expected'"; ok=0; }
  i=$((i + 1))
done < <(jq -r '.sensors[].id' "${CAL_DIR}/calibration.json")
test "$ok" -eq 1 || { echo "Run Step 0 with APPLY_RENAME=1 before deploy"; exit 1; }
```

All three counts should line up, `NUM_STREAMS` ≤ `CAP`, and sensor IDs should follow `Camera, Camera_01, ...`. Now proceed to [`deploy-rtvi-cv-3d-stack.md`](deploy-rtvi-cv-3d-stack.md).
