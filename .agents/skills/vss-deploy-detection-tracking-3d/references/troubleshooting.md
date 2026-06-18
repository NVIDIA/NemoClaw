# MV3DT troubleshooting

Parent: [`../SKILL.md`](../SKILL.md). MV3DT-specific failure modes. For broader warehouse issues that apply to 2D/3D/MV3DT alike, the deeper reference is [`../../vss-deploy-profile/references/warehouse-debug.md`](../../vss-deploy-profile/references/warehouse-debug.md).

## Top failure modes (in order of frequency)

### Only a fraction of cameras actually running (per-GPU stream cap)

**Symptom:** You set `NUM_STREAMS=4` but `mdx-raw` only shows 2 sensors, perception logs 2 FPS lines, the VST sensor list has 2 entries.

**Cause:** `vss-configurator-mv3dt` computes `final_stream_count = min(NUM_STREAMS, max_streams_supported[HARDWARE_PROFILE].mv3dt)` and applies a `keep_count` op against `${VSS_DATA_DIR}/videos/${SAMPLE_VIDEO_DATASET}/` so `final_stream_count` `.mp4` files remain (lex-sorted, last N kept). Per-GPU caps live in `blueprint-configurator/blueprint_config.yml:592-642`; see the table in `SKILL.md` Prerequisites §3.

Two common variants:
- `HARDWARE_PROFILE` set to a slug not in the canonical table (e.g. `A6000`) — the configurator falls back to defaults and may apply an unintended cap. Use the slug from SKILL.md Prerequisites §3.
- More cameras than the GPU's `mv3dt` cap supports — the configurator trims the dataset to the cap.

**Diagnose:**
```bash
ls "${VSS_DATA_DIR}/videos/${SAMPLE_VIDEO_DATASET}/"*.mp4 | wc -l
grep '^HARDWARE_PROFILE=' "${VSS_APPS_DIR}/industry-profiles/warehouse-operations/.env"
docker logs vss-configurator-mv3dt 2>&1 | grep -iE 'keep_count|final_stream_count|max_streams'
```

**Fix:** Either accept the cap (and tell the user explicitly), or move to a GPU with a higher cap. Re-source missing `.mp4` files from a backup; the configurator will trim again on next deploy unless `HARDWARE_PROFILE` covers your camera count. See [`configure-cameras.md`](configure-cameras.md) Step 2 for the lookup table.

### Perception reports `Active sources : 0` after a redeploy with a new dataset

**Symptom:** Containers are all up and healthy; perception logs the configured sensor names but every PERF line shows `0.00000` FPS and `Active sources : 0`. `vss-configurator-mv3dt` logs `Error adding sensor <name>. Received status code 501 from VMS. Retrying...` and `vss-vios-sensor` logs `Sensors count limit reached`. `vss-vios-streamprocessing` may log `ProxyRTSPClient ... RTSP "DESCRIBE" command failed; trying again` for stream URLs that no longer correspond to files on disk.

**Cause:** Named docker volumes (notably `mdx_vios_pg_data` — VST's Postgres) persist across `docker compose down` by design. When a redeploy switches dataset / camera set / camera names, the previous deploy's sensor records remain in the VST DB. VST enforces a per-device sensor cap that matches `max_streams_supported` for the GPU; with the cap already occupied by records from the prior deploy, new registrations from the configurator return HTTP 501. The public DELETE API only reaches sensors whose owning device is currently registered, so some prior records can sit beyond its scope.

**Diagnose:**
```bash
docker logs --tail 30 vss-configurator-mv3dt 2>&1 | grep -iE 'status code 501|Sensors count|Successfully added'
docker logs --tail 30 vss-vios-sensor       2>&1 | grep -iE 'count limit|sensor/add|hasSpace'
docker logs --tail 30 vss-vios-nvstreamer-mv3dt 2>&1 | grep -iE 'Exceeded sync file|DESCRIBE' | tail
curl -sf "http://${HOST_IP:-localhost}:30888/vst/api/v1/sensor/list" \
  | jq -r '.[] | "\(.sensorId)  \(.name)"'
```

If the sensor list shows names from a previous dataset (or more entries than `min(NUM_STREAMS, max_streams_supported)`), VST state is the cause.

**Fix:** Reset VST state and redeploy from a clean slate:

```bash
cd "${VSS_APPS_DIR}"
docker compose -f compose.yml \
  --env-file industry-profiles/warehouse-operations/.env down -v

bash scripts/cleanup_all_datalog.sh \
  -e industry-profiles/warehouse-operations/.env \
  --skip-revert-from-oldest-backup

docker compose -f compose.yml \
  --env-file industry-profiles/warehouse-operations/.env \
  up --detach --pull always
```

`down -v` resets the named volumes (including the VST Postgres DB), so configurator re-registers sensors fresh from the current calibration. See [`teardown.md`](teardown.md) for the full discussion and [`configure-cameras.md`](configure-cameras.md) Step 5 for the targeted-trim alternative when you want to keep most state.

### `vss-rtvi-cv-mv3dt` crashes at startup with `MqttCommunicator` "invalid node" / tracker submit failures

**Symptom:** `vss-rtvi-cv-mv3dt` reaches stream init, then exits. Logs show:

```
new stream added [0:<uuid>:cam_01]
!![Exception] [MqttCommunicator] Error initializing pub/sub info: invalid node; first invalid key: "cam_01"
ERROR from tracking_tracker: Failed to submit input to tracker
gstnvtracker: Low-level tracker lib returned error 1
App run failed
```

**Cause:** The perception container ships a hardcoded `pub_sub_info_config.yml` (`warehouse-mv3dt-app/deepstream/configs/pub_sub_info_config.yml`) and tracker config (`ds-mv3dt-tracker-config.yml`) that expect camera names `Camera` (first), `Camera_01`, `Camera_02`, … VST registered sensors under the actual video filenames (here `cam_00..cam_03`), so the MQTT pub/sub map lookup fails and the tracker can't initialize. Common for custom datasets where the user's videos / AMC defaults don't match the sample convention.

**Diagnose:**
```bash
docker logs vss-rtvi-cv-mv3dt 2>&1 | grep -E 'pubBrokerTopicStr|stream_name|invalid node|MqttCommunicator' | head -30
curl -sf "http://${HOST_IP:-localhost}:30888/vst/api/v1/sensor/list" | jq -r '.[].name' | sort
jq -r '.sensors[].id' "${CAL_DIR}/calibration.json" | sort
```

If the VST sensor names and calibration sensor IDs don't match `Camera / Camera_01 / Camera_02 / ...`, that's the issue.

**Fix:** Tear down (`down -v` to clear VST sensor state), then walk [`configure-cameras.md`](configure-cameras.md) **Step 0** — rename videos, `camInfo/*.yml`, and `sensors[].id` in `calibration.json` to the `Camera, Camera_NN` convention together. Redeploy.

### VST streamprocessing logs `No calibration data found for sensor: Camera...`

**Symptom:** VST video streams are present, but overlays are missing. `vss-vios-streamprocessing` logs show:

```
No calibration data found for sensor: Camera
No calibration data found for sensor: Camera_01
```

**Cause:** The VST runtime stream names are `Camera, Camera_01, ...`, but the deployed `calibration.json` still has AMC/VGGT IDs such as `cam_00, cam_01, ...`. Streamprocessing matches by sensor name and cannot find the calibration entries.

**Diagnose:**
```bash
docker logs vss-vios-streamprocessing 2>&1 | grep 'No calibration data found' | tail
jq -r '.sensors[].id' "${CAL_DIR}/calibration.json"
curl -sf "http://${HOST_IP:-localhost}:30888/vst/api/v1/sensor/list" | jq -r '.[].name' | sort
```

**Fix:** Walk [`configure-cameras.md`](configure-cameras.md) **Step 0** and apply the normalization (`APPLY_RENAME=1`) so videos, `camInfo/*.yml`, and `sensors[].id` all use `Camera, Camera_01, ...`. Then recreate streamprocessing or do a clean redeploy if VST already registered stale sensors. Re-run [`verify-and-view.md`](verify-and-view.md) Step 4b before reporting success.

### `vss-behavior-analytics-mv3dt` restart loop with `calibration 'upsert-all' payload failed schema validation`

**Symptom:** `vss-behavior-analytics-mv3dt` is in `Restarting` state. Logs show:

```
[ERROR] calibration 'upsert-all' payload failed schema validation: sensors/0/group/alias: '' should be non-empty; sensors/0/group/dimensions: [] is too short; sensors/0/group/name: '' should be non-empty; sensors/0/group/origin: [] is too short; sensors/0/group/type: '' should be non-empty (+ N more ...)
```

**Cause:** API-only AMC/VGGT `export_calibration?calibration_type=cartesian` can leave `sensors[].group`, `sensors[].region`, or `sensors[].place` as empty objects/arrays when the user didn't define ROIs / regions in the AMC UI Parameters step. The schema validator rejects these and the container exits 1.

**Diagnose:**
```bash
jq '.sensors[0] | {group, region, place}' "${CAL_DIR}/calibration.json"
# Empty group.name / region.placeLevel / place=[] confirm the cause.
```

**Fix:** Walk [`calibration-workflow.md`](calibration-workflow.md) **Step 4a** — the inline `jq` block patches placeholder values into the empty fields so the validator passes. For metric BEV bounds, populate these in the AMC UI Parameters step before export or tune them after deploy using [`verify-and-view.md`](verify-and-view.md) **Tune BEV `group` / `region` for better overlays**.

### `vss-import-calibration-output-mv3dt` exits 1 with `imageMetadata.json not found`

**Symptom:** Under extended profile (`MINIMAL_PROFILE=""`), `vss-import-calibration-output-mv3dt` runs once and exits 1. Logs show:

```
importing calibration ...
{"success":true}importing images ...
imageMetadata.json not found at /opt/vss/images/imageMetadata.json
Exiting Script.
```

Stack otherwise runs; VST video wall renders raw video without overlays because the import didn't populate the metadata index in Elasticsearch.

**Cause:** AMC's MV3DT export doesn't produce `images/Top.png` + `images/imageMetadata.json`; the importer expects both at the bind-mounted path. Only relevant under extended profile — minimal mode doesn't deploy this container at all.

**Diagnose:**
```bash
ls "${CAL_DIR}/images/" 2>/dev/null
docker logs vss-import-calibration-output-mv3dt 2>&1 | tail -10
```

**Fix:** Walk [`calibration-workflow.md`](calibration-workflow.md) **Step 4b** — synthesize `Top.png` from the user's `layout.png` (or any project-output PNG) and write a matching `imageMetadata.json` with a `place` string mirroring `sensors[0].place`. Then force-recreate the one-shot importer so logs reflect only the retry — no full redeploy needed.

```bash
cd "${VSS_APPS_DIR}"
docker compose -f compose.yml \
  --env-file industry-profiles/warehouse-operations/.env \
  up --no-deps --force-recreate import-calibration-output-container-mv3dt
```

### `vss-import-calibration-output-mv3dt` exits 0 but overlays are missing

**Symptom:** Under extended profile (`MINIMAL_PROFILE=""`), `vss-import-calibration-output-mv3dt` shows `Exited (0)`, but VST overlays are missing. Importer logs include `{"error":"Something broke!"}` or video-analytics API logs show `EACCES: permission denied, open '/web-api-app/files/...'`.

**Cause:** The video-analytics API upload bind (`${VSS_DATA_DIR}/data_log/vss_video_analytics_api:/web-api-app/files`) is not writable by the API container. The importer uses `curl` without failing on HTTP error responses, so the one-shot can exit 0 even when the API rejected the calibration/image upload.

**Diagnose:**
```bash
docker logs vss-import-calibration-output-mv3dt 2>&1 | tail -50
docker logs vss-video-analytics-api-mv3dt 2>&1 | grep -iE 'EACCES|permission denied|Something broke|error' | tail -20
docker exec vss-video-analytics-api-mv3dt sh -lc 'touch /web-api-app/files/.amc_write_test && rm -f /web-api-app/files/.amc_write_test'
```

**Fix:** Create the upload directory before retrying and apply the same scoped ACL used in `SKILL.md` Prerequisites §4. Then restart the API and rerun the one-shot importer; no full redeploy is needed.

```bash
API_UPLOAD_DIR="${VSS_DATA_DIR}/data_log/vss_video_analytics_api"
mkdir -p "${API_UPLOAD_DIR}"
setfacl -R    -m u:1000:rwx "${API_UPLOAD_DIR}"
setfacl -R -d -m u:1000:rwx "${API_UPLOAD_DIR}"

docker restart vss-video-analytics-api-mv3dt

cd "${VSS_APPS_DIR}"
docker compose -f compose.yml \
  --env-file industry-profiles/warehouse-operations/.env \
  up --no-deps --force-recreate import-calibration-output-container-mv3dt
```

Re-run [`verify-and-view.md`](verify-and-view.md) Step 4b. Do not report success until the import check is clean.

### `vss-rtvi-cv-bev-fusion` not healthy / `/tmp/fusion_ready` missing

**Cause(s):**
- Broker not ready — `broker-health-check` hasn't completed yet, so `mdx-raw` topic doesn't exist.
- `MAX_EXPECTED_SENSORS` (= `NUM_STREAMS`) higher than actual streams — fusion buffers and waits.
- `STREAM_TYPE` in `.env` doesn't match the broker that's actually up (e.g. `.env` says `kafka` but `redis` is deployed because user set `BP_PROFILE=bp_wh_redis`).

**Diagnose:**
```bash
docker ps --filter name=broker-health-check          # must show Exited (0)
docker logs --tail 100 vss-rtvi-cv-bev-fusion 2>&1 | tail -30
docker exec kafka kafka-topics --bootstrap-server localhost:9092 --list 2>/dev/null \
  || docker exec redis redis-cli KEYS 'mdx*'

# Verify fusion health (NOT via docker exec ... test -f /tmp/fusion_ready — the image strips test out of PATH):
docker inspect --format '{{.State.Health.Status}}' vss-rtvi-cv-bev-fusion
```

**Fix:** Wait if `broker-health-check` is still `Up` (it can take 2–3 min). If it `Exited` non-zero, check broker logs (`docker logs kafka` or `docker logs redis`). If `MAX_EXPECTED_SENSORS` mismatch: walk [`configure-cameras.md`](configure-cameras.md) again.

### `vss-rtvi-cv-mv3dt` exits / `ds-start-mv3dt.sh` fails

**Cause(s):**
- `camInfo/cam_*.yaml` mount is missing or empty (calibration not landed).
- `NUM_STREAMS` doesn't equal the count of `camInfo/*.yaml` files — DeepStream batch size mismatches model expectations.
- `BodyPose3DNet` model files not at `${VSS_DATA_DIR}/models/mv3dt/BodyPose3DNet/` — perception can't load weights.

**Diagnose:**
```bash
DATASET="${SAMPLE_VIDEO_DATASET:?}"
CAL_DIR="${VSS_APPS_DIR}/industry-profiles/warehouse-operations/warehouse-mv3dt-app/calibration/sample-data/${DATASET}"

ls -l "${CAL_DIR}/camInfo/" | head
docker exec vss-rtvi-cv-mv3dt ls /tmp/camInfo/ 2>/dev/null   # what perception actually sees
docker exec vss-rtvi-cv-mv3dt ls /opt/storage/BodyPose3DNet/ 2>/dev/null
docker logs --tail 200 vss-rtvi-cv-mv3dt 2>&1 | tail -60
```

**Fix:** Re-walk [`calibration-workflow.md`](calibration-workflow.md) Step 4 and [`configure-cameras.md`](configure-cameras.md). For missing BodyPose3DNet, confirm `VSS_DATA_DIR` points at extracted `vss-warehouse-app-data` (see [`deploy-rtvi-cv-3d-stack.md`](deploy-rtvi-cv-3d-stack.md) — `${VSS_DATA_DIR}/models/mv3dt/BodyPose3DNet/` must exist).

### `mosquitto` unhealthy

**Cause(s):**
- `MQTT_HOST` / `MQTT_PORT` in `.env` don't match the mosquitto container's actual host/port.
- Mosquitto's bind port (`1883` by default) already in use on the host.

**Diagnose:**
```bash
grep -E '^MQTT_(HOST|PORT)=' "${VSS_APPS_DIR}/industry-profiles/warehouse-operations/.env"
ss -tlnp | grep ':1883'                         # port collision check
docker logs --tail 50 mosquitto 2>&1 | tail
```

**Fix:** Set `MQTT_HOST=localhost`, `MQTT_PORT=1883` (mosquitto uses `network_mode: host`). If another process has 1883, stop it (or pick a different `MQTT_PORT` and redeploy).

### BEV out of sync — frames look stale or duplicated

**Cause(s):**
- Camera clocks drift; per-camera frame timestamps fall outside `SENSOR_TIMEOUT_MS` window (default 100 ms).
- `BUFFER_DURATION_S` too short for the actual end-to-end latency.

**Diagnose:**
Watch `mdx-bev` rate vs `mdx-raw` rate over a minute. The shipped Kafka image is `confluentinc/cp-kafka:8.2.0` which uses `kafka-get-offsets` (not the older `kafka-run-class kafka.tools.GetOffsetShell` — that class is gone):
```bash
docker exec kafka kafka-get-offsets --bootstrap-server localhost:9092 --topic mdx-raw
docker exec kafka kafka-get-offsets --bootstrap-server localhost:9092 --topic mdx-bev
```
If `mdx-bev` grows much slower than `mdx-raw` × num cameras, fusion is dropping under-late frames.

**Fix:** Override the env in `services/rtvi/rtvi-cv/rtvi-cv-mv3dt/compose.yaml:52` (`SENSOR_TIMEOUT_MS`) and `:54` (`BUFFER_DURATION_S`) via env file:

```bash
# Add to industry-profiles/warehouse-operations/.env
echo 'SENSOR_TIMEOUT_MS=300' >> "${VSS_APPS_DIR}/industry-profiles/warehouse-operations/.env"
echo 'BUFFER_DURATION_S=3.0' >> "${VSS_APPS_DIR}/industry-profiles/warehouse-operations/.env"
```

Then `docker compose ... up -d` to apply. Tune upward incrementally.

### BodyPose3DNet TRT engine build hangs first start

**Symptom:** `vss-rtvi-cv-mv3dt` sits in `(starting)` for many minutes. No FPS lines yet.

**Normal:** First-start engine build takes 3–8 min on H100, 8–15 min on L4. Tail `docker logs -f vss-rtvi-cv-mv3dt` for `Build engine successfully`.

**Diagnose if it's truly stuck (>15 min):**
```bash
docker logs --tail 200 vss-rtvi-cv-mv3dt 2>&1 | grep -iE 'cuda|out of memory|killed|error' | tail -20
nvidia-smi
```
If GPU OOM appears, perception is competing with another workload on `RT_CV_DEVICE_ID`. Free the GPU (or change `RT_CV_DEVICE_ID` in `.env`) and redeploy.

### AMC MV3DT export ZIP missing `transforms.yml` / `camInfo/*.yaml`

**Cause(s):**
- `result_type=amc` requested but AMC didn't actually finish — `project_state != COMPLETED`.
- VGGT path requested (`result_type=vggt`) but VGGT wasn't run or didn't complete.

**Diagnose:**
```bash
curl -s "http://localhost:8010/v1/get_project_info/${project_id}" | jq '.project_info | {project_state, vggt_state}'
curl -s "http://localhost:8010/v1/amc/calibrate/${project_id}/log" | tail -60
```

**Fix:** Per [`calibration-workflow.md`](calibration-workflow.md) Step 2 — re-poll until `project_state == COMPLETED`. If VGGT requested, also check `vggt_state == COMPLETED` (VGGT only runs if the model file is staged).

### VST video wall (`/vst` on `:30888`) unreachable

**Cause(s):**
- The browser opened the base port instead of `http://<HOST_IP>:30888/vst`.
- VST stack didn't come up (sensor-ms / postgres in bad state).
- Firewall blocks port 30888 from the browser host.
- `HOST_IP` is `localhost` and you're trying to reach from a remote browser.

**Diagnose:**
```bash
docker ps | grep -E 'vios|sensor-ms|centralizedb'
ss -tlnp | grep ':30888'
curl -sf "http://localhost:30888/vst/api/v1/sensor/list"   # from the host itself
```

**Fix:** If VST containers are missing, the profile gating didn't activate them — confirm `COMPOSE_PROFILES` resolves to `bp_wh_kafka_mv3dt` (or `_redis_`). If `HOST_IP=localhost` in `.env`, change it to the actual reachable IP and redeploy (compose substitutes at start time). For firewall, port-forward via SSH (`ssh -L 30888:localhost:30888`) or open the port on the host.

### VST video wall: "Failed to create Video Source" despite a healthy pipeline

**Symptom:** VST UI loads at `http://<HOST_IP>:30888/vst` fine. Click play on any sensor → `Playback Error: Error 22: Failed to create Video Source`, `Error 2: Failed to start inbound stream`, or an ICE-negotiation failure. Data is flowing — `mdx-raw` and `mdx-bev` offsets are growing, `vss-vios-streamprocessing` is writing per-minute mkv chunks to `${VSS_DATA_DIR}/data_log/`, `rtsp://<HOST_IP>:30554/live/<sensorId>` is serving valid H264.

**Cause:** WebRTC negotiation fails between the browser and VST — the ICE candidates advertise a host/UDP port the browser can't reach. Common triggers:
- **Outbound STUN** to `stun.l.google.com:19302` (VST's default `stunurl_list`). Corp / VPN blocks Google STUN frequently.
- **Inbound UDP** on a random port range (VST's default `webrtc_port_range: {min:0, max:0}`). Corp / cloud / on-prem firewalls that don't pass arbitrary UDP make ICE negotiation fail.
- **Edge and remote hosts (Thor, cloud VM, SSH / VPN / NAT).** When you reach the host only through an SSH tunnel and forward just the TCP UI port (`-L 30888:...`), the dashboard loads but the UDP media path isn't tunnelled, so playback fails with `Error 2` / `Error 22`. This is the most common cause on IGX-THOR / AGX-THOR. See [`verify-and-view.md` § Edge and remote hosts](verify-and-view.md).

**Sensor-status caveat.** While WebRTC is blocked, `GET /vst/api/v1/sensor/list` may report `state: "offline"` and `url: null` for each sensor. That field reflects browser-reachability, not pipeline health — if `streamprocessing` is actively recording chunks, the pipeline is fine. Focus diagnostics on the transport layer, not the sensor status.

**Diagnose:**
```bash
# Pipeline is healthy?
docker logs --tail 50 vss-vios-streamprocessing 2>&1 | grep -E 'write|mkv|chunk' | tail
ls -la "${VSS_DATA_DIR}/data_log/" | head

# RTSP source reachable?
ffprobe -v error -timeout 5000000 "rtsp://${HOST_IP}:30554/live/<sensorId>" 2>&1 | head

# Browser network access?
curl -fI "http://${HOST_IP}:30888/vst" -o /dev/null -w "%{http_code}\n"   # 200 = UI works
nc -zu stun.l.google.com 19302                                            # blocked? STUN unreachable
```

**Workarounds** (in order of effort):
1. **Run the browser on the host itself.** VNC, X-forwarding, or RDP — bypasses the WebRTC firewall entirely.
2. **Bypass VST UI, use RTSP directly.** `ffplay rtsp://<HOST_IP>:30554/live/<sensorId>` if port 30554 is reachable. Over SSH this tunnels cleanly (RTSP is TCP): `ssh -L 30554:localhost:30554 <user>@<host>`, then `ffplay rtsp://localhost:30554/live/<sensorId>`. No overlays, but you see the raw stream.
3. **Bypass UI entirely; consume `mdx-bev`.** Data is on the broker — write a downstream consumer.
4. **Self-host a TURN server** on TCP/443 and reconfigure VST's `stunurl_list` / `webrtc_port_range`. Heavyweight; out of scope for this skill.

### VST overlays show the sample warehouse layout, or 3D bboxes do not align with custom calibration

**Symptom:** VST top-view widget displays the bundled sample warehouse layout and/or 3D bounding boxes do not line up with the camera views, even though `calibration.json` at `<CAL_DIR>` looks correct, AMC overlay images in the project output look correct, perception is at 30 FPS, and `mdx-bev` is growing. Re-running AMC, switching detectors, or running VGGT refinement does not change the VST overlay.

**Cause:** `services/vios/streamprocessing/docker-compose.yaml` may include bind-mount sources that point at the bundled sample dataset instead of `${SAMPLE_VIDEO_DATASET}`. VST reads overlay configuration from its container configuration directory, so for custom datasets the VST overlay may use the sample `cameraMatrix` while perception, behavior-analytics, and video-analytics-api read from the custom dataset calibration path.

**Diagnose:**
```bash
docker inspect vss-vios-streamprocessing \
  --format '{{range .Mounts}}{{println .Destination " <- " .Source}}{{end}}' \
  | grep -E "calibration\.json|Top\.png"
# If either source path contains "warehouse-4cams-20mx20m-synthetic" instead of your ${SAMPLE_VIDEO_DATASET}, update the mount sources.
```

**Fix:** Apply the update from [`deploy-rtvi-cv-3d-stack.md`](deploy-rtvi-cv-3d-stack.md) Step 0b so the sample-data path resolves through `${SAMPLE_VIDEO_DATASET}`. Then recreate `streamprocessing-ms-mv3dt` in place and hard-refresh the VST tab. Full stack restart is not required.

### No bounding-box overlays in VST video wall

**Expected behavior under `MINIMAL_PROFILE="true"`.** Overlays require Elasticsearch + `vss-video-analytics-api-mv3dt` + `vss-import-calibration-output-mv3dt`, all gated under `_extended`. None of them deploy in minimal mode. See [`verify-and-view.md`](verify-and-view.md) Step 5.

**Fix:** Tear down ([`teardown.md`](teardown.md)), set `MINIMAL_PROFILE=""` in `.env`, redeploy ([`deploy-rtvi-cv-3d-stack.md`](deploy-rtvi-cv-3d-stack.md)). There is no "minimal + just ELK" middle path in the current compose — the `_extended` services share a single gating suffix and come up together.

In the VST UI itself, overlays are off by default per stream — enable via the video player's options menu.

### `error from registry: Incorrect Repository Format` during compose pull

**Symptom:** `docker compose up --pull always --build` aborts mid-pull with `error from registry: Incorrect Repository Format`. No containers are created. Failure is non-deterministic across Docker / Compose versions — what works on one host fails on another with the same `.env`.

**Cause:** A handful of services in `services/infra/compose.yml` are locally built but declared with bare-tag `image:` fields (e.g. `image: elasticsearch` — no registry, no version). With `--pull always`, compose tries to resolve those references against the default registry (Docker Hub) before considering the build context. Some Docker / Compose versions reject the resolution outright and abort the whole `up`; others fall through to the build and succeed. The repo-side fix is to scope these references (e.g. `image: <project>-elasticsearch:local`); until that lands, work around it from the deploy side.

**Workaround A — pre-build the locally-built services, then `up` without `--pull always` (version-independent, no system changes):**

```bash
cd "${VSS_APPS_DIR}"

# Discover services whose resolved image: lacks a registry/host prefix —
# these are the ones compose tries (and may fail) to pull as Docker Hub refs.
LOCAL_SVCS=$(docker compose -f compose.yml \
  --env-file industry-profiles/warehouse-operations/.env config 2>/dev/null \
  | python3 -c "
import sys, yaml
d = yaml.safe_load(sys.stdin)
for n, s in (d.get('services') or {}).items():
    img = s.get('image', '')
    head = img.split(':')[0]
    if s.get('build') and '/' not in head and '.' not in head:
        print(n)
")
echo "Will pre-build: $LOCAL_SVCS"

docker compose -f compose.yml \
  --env-file industry-profiles/warehouse-operations/.env build $LOCAL_SVCS

# Now bring up the rest. Drop --pull always (default --pull missing will
# fetch registry images that aren't local; the pre-built ones are skipped).
docker compose -f compose.yml \
  --env-file industry-profiles/warehouse-operations/.env \
  up --detach --force-recreate
```

**Workaround B — pin Docker / Compose to a known-good version.** The warehouse-deploy skill documents this in [`../../vss-deploy-profile/references/warehouse.md`](../../vss-deploy-profile/references/warehouse.md) (search "Incorrect Repository Format"). Two caveats specific to this fallback:

- Downgrading the Docker engine often switches the underlying containerd major version. The local image store from the previous Docker is invisible to the older containerd snapshotter — the first `compose up` after the pin re-pulls every NGC image (10+ GB).
- It's a system-wide change. Workaround A is the safer first attempt if anything else on the host depends on the current Docker version.

### Image pull 401 / 403 from `nvcr.io`

**Cause(s):**
- `docker login nvcr.io` not run (or token expired).
- `NGC_CLI_API_KEY` doesn't have access to the image — `vss-core` lives in `nvidia`, and your key may not see it.

**Diagnose:**
```bash
docker login --username '$oauthtoken' --password "${NGC_CLI_API_KEY}" nvcr.io
ngc registry image list "nvidia/vss-core/*" 2>&1 | head -5
```

**Fix:** Re-login. If `nvidia/vss-core/*` does not list the image, the key does not have access — confirm with `ngc org list`, then use a key with access to the published VSS images.

### Pipeline stalls at end-of-video (videos mode) — `Active sources : 0`, offsets flat

**Symptom:** A `videos`-mode deploy runs fine, then after the clips reach end-of-file the VST wall goes black, perception logs `Active sources : 0` with `PERF` FPS `0.00000`, and DeepStream spins in `gst_rtspsrc_reconnect ... Resetting source N, attempts: NN` (climbing). Kafka `mdx-raw`/`mdx-bev` offsets (or Redis stream lengths) stop growing. `vss-vios-nvstreamer-mv3dt` logs a rapid `GST_MESSAGE_EOS → pause → startStream → EOS` cycle.

**Cause:** input MP4s are finite. `nv_streamer_loop_playback: true` (in `warehouse-mv3dt-app/nvstreamer/configs/vst-config.json`) is the default, but the loop is **not reliably seamless** — at EOS the RTSP session can drop to DeepStream instead of continuing, and DeepStream's reconnect doesn't always re-establish. Short clips loop for a while, then desync.

**Do NOT** `docker restart vss-vios-nvstreamer-mv3dt` to recover — it leaves nvstreamer rejecting DESCRIBEs with `RTSP lookup: Exceeded sync file count, ignoring the request` → `404 Stream Not Found`, even though `vst/api/v1/sensor/list` still shows sensors `online`. The file streams don't re-sync on a bare restart.

**Fix (reliable recovery):** clean redeploy from a reset state — same as the "`Active sources : 0` after a redeploy" fix above:
```bash
cd "${VSS_APPS_DIR}"
docker compose -f compose.yml --env-file industry-profiles/warehouse-operations/.env down -v
bash scripts/cleanup_all_datalog.sh -e industry-profiles/warehouse-operations/.env --skip-revert-from-oldest-backup
# re-apply data_log perms (SKILL.md Prerequisites §4), then:
docker compose -f compose.yml --env-file industry-profiles/warehouse-operations/.env up --detach --pull always
```
Videos and the landed calibration survive (separate paths). This recovers the stream but only buys another clip-length before the next EOS.

**Durable fix (for unattended / long demos):** make the source effectively continuous so EOS rarely fires — concatenate each `Camera*.mp4` into one long file (stream-copy, no re-encode), e.g. via the ffmpeg `concat` demuxer, and stage the long files under `${VSS_DATA_DIR}/videos/${SAMPLE_VIDEO_DATASET}/`. Then redeploy.

## When to drop down to `warehouse-debug.md`

For general warehouse-blueprint issues (NGC permissions, low FPS tuning beyond MV3DT, GPU saturation across multiple stacks, broker tuning, NGC app-data extraction), the deeper reference is [`../../vss-deploy-profile/references/warehouse-debug.md`](../../vss-deploy-profile/references/warehouse-debug.md). That's an MV3DT-aware reference too, just broader.

## Clean reset

If multiple things are off and you want to start clean: [`teardown.md`](teardown.md). Tear down, fix env, redeploy.
