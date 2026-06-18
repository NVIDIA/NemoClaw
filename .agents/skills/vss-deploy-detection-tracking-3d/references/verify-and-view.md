# Verify and view the deployed MV3DT stack

Parent: [`../SKILL.md`](../SKILL.md). Run **after** [`deploy-rtvi-cv-3d-stack.md`](deploy-rtvi-cv-3d-stack.md) returns. Goal: confirm perception + fusion are running, BEV is flowing through the broker, and the user has a working browser viewing path (VST video wall).

Overlay viz uses the existing VST video wall — there's no separate visualization skill for MV3DT. Whether bounding boxes actually render depends on which profile was deployed (see [`../SKILL.md` Q0](../SKILL.md#q0--profile-size-overlays-or-not)).

## Step 1 — Container health

```bash
docker ps --format 'table {{.Names}}\t{{.Status}}' \
  | grep -E 'mv3dt|mosquitto|kafka|redis|vios|centralizedb|configurator|broker-health-check|behavior|elasticsearch|logstash|kibana|video-analytics|auto-calib'
```

Expected — all the following must show `Up` (or `Up (healthy)` where a health check applies):

### Always-deployed (both profiles)

| Container | Expected state |
|---|---|
| `vss-rtvi-cv-mv3dt` | `Up` (no compose health check — see Step 2 for FPS sanity) |
| `vss-rtvi-cv-bev-fusion` | `Up (healthy)` — health check is `/tmp/fusion_ready` sentinel |
| `mosquitto` | `Up (healthy)` |
| `kafka` *or* `redis` (per `STREAM_TYPE`) | `Up` |
| `vss-broker-health-check` | `Exited (0)` — one-shot, then completes |
| `vss-vios-sensor` | `Up (healthy)` |
| `vss-vios-ingress` | `Up (healthy)` |
| `vss-vios-streamprocessing` | `Up (healthy)` — records streams for the VST video wall |
| `vss-vios-postgres` | `Up (healthy)` — VST sensor-ms backing store |
| `vss-haproxy-ingress` | `Up` — present under MV3DT (services still reached on direct ports) |
| `sdr-controller` | `Up` (with `sdrc-*` one-shot init helpers `Exited (0)`) |
| `vss-configurator-mv3dt` | `Up (healthy)` |
| `vss-vios-nvstreamer-mv3dt` | `Up` (sample/videos only — absent when feeding external RTSP) |
| `vss-behavior-analytics-mv3dt` | `Up` (always — NOT gated by MINIMAL_PROFILE) |

> `vss-auto-calibration` / `-ui` are **not** part of the MV3DT deploy (they belong to the separate `auto_calib` calibration flow). If you see them running, they're from that flow — see [`deploy-rtvi-cv-3d-stack.md`](deploy-rtvi-cv-3d-stack.md) "What this brings up".

### Extra under extended (`MINIMAL_PROFILE=""`)

| Container | Expected state |
|---|---|
| `elasticsearch` | `Up (healthy)` |
| `vss-elasticsearch-init` | `Exited (0)` — one-shot |
| `logstash` | `Up` |
| `kibana` | `Up (healthy)` |
| `vss-kibana-init-mv3dt` | `Exited (0)` — one-shot |
| `vss-video-analytics-api-mv3dt` | `Up (healthy)` |
| `vss-import-calibration-output-mv3dt` | `Exited (0)` — one-shot |

If anything stays `(starting)` or `(unhealthy)` past ~15 min, jump to [`troubleshooting.md`](troubleshooting.md).

## Step 2 — Perception FPS

```bash
docker logs --tail 200 vss-rtvi-cv-mv3dt 2>&1 | grep -iE 'fps|engine|error' | tail -20
```

Expected on a healthy bring-up (first run, in order):

1. `Build engine successfully` lines (BodyPose3DNet TRT engine compile — 3–8 min).
2. `FPS = …` lines per camera once streams flow.

For ongoing monitoring:

```bash
docker logs -f vss-rtvi-cv-mv3dt 2>&1 | grep -i fps
```

Target FPS depends on `HARDWARE_PROFILE` — see the per-GPU `max_streams_supported` table in `SKILL.md` Prerequisites §3 (anchored at `blueprint_config.yml`). Roughly: ~30 FPS / camera on datacenter-class GPUs running at or below their cap; lower on edge platforms or when running at the cap. Confirm against the canonical table in `blueprint_config.yml` for your GPU before reporting "low FPS" — you may simply be at expected throughput.

**Stream count check.** If perception logs report fewer FPS lines than `NUM_STREAMS`, the per-GPU cap has been applied (see [`configure-cameras.md`](configure-cameras.md) Step 2). Compare:

```bash
ls "${VSS_DATA_DIR}/videos/${SAMPLE_VIDEO_DATASET}/"*.mp4 | wc -l
docker logs vss-rtvi-cv-mv3dt 2>&1 | grep -c 'Source.*added'
```

If the second number is less than the first, the `keep_count` op trimmed videos at deploy time.

## Step 3 — BEV Fusion ready

The fusion container marks itself ready by creating `/tmp/fusion_ready` and the compose health check probes that file. **Don't try to `docker exec ... test -f /tmp/fusion_ready` — the image strips out `test`/`ls` from PATH.** Use the compose-evaluated health status instead:

```bash
docker inspect --format '{{.State.Health.Status}}' vss-rtvi-cv-bev-fusion
# Expected: healthy
```

If `unhealthy` or `starting` past 5 min, the sentinel never appeared. Diagnose:

```bash
docker logs --tail 100 vss-rtvi-cv-bev-fusion 2>&1 | tail -30
```

Common causes: broker topic `mdx-raw` not yet produced (perception hasn't emitted), or `MAX_EXPECTED_SENSORS` differs from actual stream count (see [`configure-cameras.md`](configure-cameras.md)).

## Step 4 — Broker offsets growing

Confirm metadata is flowing end-to-end by watching the two topics MV3DT uses:

- `mdx-raw` — per-camera detections (perception → fusion)
- `mdx-bev` — fused BEV frames (fusion → downstream)

### Kafka path

The shipped image is `confluentinc/cp-kafka:8.2.0`, which exposes `kafka-get-offsets`. The older `kafka-run-class kafka.tools.GetOffsetShell` does **not** exist in this image — `ClassNotFoundException`. Use:

```bash
# Latest offsets — repeat after 30s, numbers must grow on both topics
docker exec kafka kafka-get-offsets --bootstrap-server localhost:9092 --topic mdx-raw
docker exec kafka kafka-get-offsets --bootstrap-server localhost:9092 --topic mdx-bev

# Output is `<topic>:<partition>:<offset>` — sum partitions for total messages.

# Optional: peek at one fused message
docker exec kafka kafka-console-consumer \
  --bootstrap-server localhost:9092 --topic mdx-bev \
  --from-beginning --max-messages 1
```

### Redis path

```bash
# Stream length — repeat, must grow
docker exec redis redis-cli XLEN mdx-raw
docker exec redis redis-cli XLEN mdx-bev

# Optional: peek at one message
docker exec redis redis-cli XRANGE mdx-bev - + COUNT 1
```

If `mdx-bev` is empty but `mdx-raw` is growing: fusion isn't producing output — check [`troubleshooting.md`](troubleshooting.md).

## Step 4b — Readiness gate (must pass before reporting success)

**Container health from Step 1 is not sufficient** — perception and fusion can be `Up`/`healthy` while `Active sources : 0` and the broker offsets stay flat. Do **not** report success or hand the user the URLs until every check below is green. This block ties Steps 2–4 together and adds the exact VST sensor-set check:

```bash
ENV_FILE="${VSS_APPS_DIR}/industry-profiles/warehouse-operations/.env"
NUM_STREAMS=$(grep '^NUM_STREAMS=' "$ENV_FILE" | cut -d= -f2)
MINIMAL_PROFILE_VAL=$(grep '^MINIMAL_PROFILE=' "$ENV_FILE" | cut -d= -f2 | tr -d '"')
VST_HOST="${HOST_IP:-localhost}"; VST_PORT="${VST_PORT:-30888}"
CAL_DIR="${VSS_APPS_DIR}/industry-profiles/warehouse-operations/warehouse-mv3dt-app/calibration/sample-data/${SAMPLE_VIDEO_DATASET}"

# 1. NvStreamer + perception: active sources must equal NUM_STREAMS
ACTIVE=$(docker logs vss-rtvi-cv-mv3dt 2>&1 | grep -oE 'Active sources : [0-9]+' | tail -1 | grep -oE '[0-9]+$')
echo "Active sources: ${ACTIVE:-0} (expect ${NUM_STREAMS})"

# 2. VST sensor set must EXACTLY match the calibration cameras, all online
EXPECTED=$(jq -r '.sensors[].id' "${CAL_DIR}/calibration.json" 2>/dev/null | sort)
SENSORS=$(curl -sf "http://${VST_HOST}:${VST_PORT}/vst/api/v1/sensor/list" | jq -r '.[] | "\(.name)\t\(.state)"')
echo "VST sensors (name/state):"; printf '%s\n' "${SENSORS}" | sed 's/^/  /'
ALL_NAMES=$(printf '%s\n' "${SENSORS}"    | awk -F'\t' 'NF{print $1}' | sort)
ONLINE_NAMES=$(printf '%s\n' "${SENSORS}" | awk -F'\t' 'tolower($2) == "online"{print $1}' | sort)
if [ -z "${EXPECTED}" ]; then
  # No baseline to compare against — don't report a false MISMATCH. Fix CAL_DIR /
  # SAMPLE_VIDEO_DATASET so calibration.json is readable, then re-run this check.
  echo "  could not read expected sensors from ${CAL_DIR}/calibration.json — skipping sensor-set comparison (check CAL_DIR / SAMPLE_VIDEO_DATASET)"
else
  [ "${ALL_NAMES}" = "${EXPECTED}" ] \
    && echo "  sensor set matches calibration exactly" \
    || echo "  MISMATCH — extra / missing / empty sensor records present"
  [ "${ONLINE_NAMES}" = "${EXPECTED}" ] \
    && echo "  all expected sensors online" \
    || echo "  some expected sensors are NOT online"
fi

# 3. Broker offsets must grow across two samples. Use whichever broker is up
#    (STREAM_TYPE / BP_PROFILE selects kafka or redis).
if docker ps --format '{{.Names}}' | grep -qx kafka; then
  off() { docker exec kafka kafka-get-offsets --bootstrap-server localhost:9092 --topic "$1" 2>/dev/null | awk -F: '{s+=$3} END{print s+0}'; }
else
  off() { docker exec redis redis-cli XLEN "$1" 2>/dev/null | tr -dc '0-9'; }
fi
r1=$(off mdx-raw); b1=$(off mdx-bev); sleep 15; r2=$(off mdx-raw); b2=$(off mdx-bev)
echo "mdx-raw: ${r1:-0} -> ${r2:-0}    mdx-bev: ${b1:-0} -> ${b2:-0}"
{ [ "${r2:-0}" -gt "${r1:-0}" ] && [ "${b2:-0}" -gt "${b1:-0}" ]; } \
  && echo "  offsets growing on both topics" \
  || echo "  offsets NOT growing on one or both topics"

# 4. Extended profile: calibration/image import must really succeed for VST overlays.
#    The importer can exit 0 even when the API returned {"error":...}; inspect both logs.
if [ "${MINIMAL_PROFILE_VAL}" != "true" ]; then
  docker exec vss-video-analytics-api-mv3dt sh -lc 'touch /web-api-app/files/.amc_write_test && rm -f /web-api-app/files/.amc_write_test' \
    && echo "  video-analytics upload dir writable" \
    || echo "  video-analytics upload dir NOT writable"

  IMPORT_STATE=$(docker inspect vss-import-calibration-output-mv3dt --format '{{.State.Status}} {{.State.ExitCode}}' 2>/dev/null || echo "missing")
  IMPORT_LOG=$(docker logs --tail 200 vss-import-calibration-output-mv3dt 2>&1 || true)
  API_LOG=$(docker logs --tail 200 vss-video-analytics-api-mv3dt 2>&1 || true)
  echo "Import container: ${IMPORT_STATE}"
  if printf '%s\n%s\n' "${IMPORT_LOG}" "${API_LOG}" | grep -qiE 'EACCES|permission denied|"error"|"success":false|Something broke|imageMetadata\.json not found'; then
    echo "  calibration/image import FAILED — inspect importer and video-analytics-api logs"
  elif printf '%s\n' "${IMPORT_LOG}" | grep -qiE 'import done|upload.*complete|calibration.*imported'; then
    echo "  calibration/image import completed without known error markers"
  else
    echo "  calibration/image import not confirmed — importer log did not show a known success marker"
  fi

  KIBANA_URL="http://${VST_HOST}:5601/kibana/app/dashboards"
  KIBANA_CODE=$(curl -s -o /dev/null -w '%{http_code}' "${KIBANA_URL}" || true)
  if [ "${KIBANA_CODE}" = "200" ]; then
    echo "  Kibana dashboards reachable at ${KIBANA_URL}"
  else
    echo "  Kibana dashboards not confirmed at ${KIBANA_URL} (HTTP ${KIBANA_CODE:-000})"
  fi
  echo "  note: http://${VST_HOST}:5601/ can return 404 because Kibana is served under /kibana"
else
  echo "Import check skipped under minimal profile"
fi

# 5. VST streamprocessing must be able to find calibration by runtime sensor name.
SP_LOG=$(docker logs --tail 300 vss-vios-streamprocessing 2>&1 || true)
if printf '%s\n' "${SP_LOG}" | grep -q 'No calibration data found for sensor'; then
  printf '%s\n' "${SP_LOG}" | grep 'No calibration data found for sensor' | tail -10
  echo "  streamprocessing calibration lookup FAILED — run configure-cameras.md Step 0 and redeploy/recreate streamprocessing"
else
  echo "  streamprocessing calibration lookup has no missing-sensor entries"
fi
```

**Pass criteria — all required checks:**

1. `Active sources` equals `NUM_STREAMS`.
2. The VST sensor set matches the calibration cameras **exactly** (no extra, empty, or stale records).
3. Every expected sensor reports **online**.
4. Both `mdx-raw` and `mdx-bev` offsets grew between the two samples.
5. Under extended profile, the video-analytics upload-dir write test passes.
6. Under extended profile, importer logs reach `done` and neither importer nor video-analytics-api logs contain `EACCES`, permission errors, `{"error":...}`, or `Something broke`.
7. Under extended profile, `http://<HOST_IP>:5601/kibana/app/dashboards` returns HTTP 200; bare `http://<HOST_IP>:5601/` can return 404 because Kibana is served under `/kibana`.
8. `vss-vios-streamprocessing` logs do not contain `No calibration data found for sensor` for the runtime camera names.

If any core stream check fails, the deploy is not actually processing streams — go to [`troubleshooting.md`](troubleshooting.md) (`Active sources : 0` and stale-state entries) rather than reporting the URLs. If the extended-profile import check or streamprocessing calibration lookup check fails, the deploy may process streams but overlays are not ready; fix the issue in [`troubleshooting.md`](troubleshooting.md) before reporting success. A sensor-set mismatch, stale/offline record, or `Active sources : 0` on healthy containers is the stale-state case — the fix is a **full clean redeploy** (`down -v` **and** clearing host-side `data_log`, then redeploy), not `down -v` alone. See the redeploy note in [`deploy-rtvi-cv-3d-stack.md`](deploy-rtvi-cv-3d-stack.md) Step 3.

## Step 5 — VST video wall

```
http://<HOST_IP>:30888/vst
```

Report the `/vst` route as the launch URL. Opening the base port without `/vst` can show the default nginx landing page and is not the VST UI.

Use `HOST_IP` from the `.env` (or whatever the user can actually reach from a browser — see "Browser reachability" below for cloud VMs / corp VPN).

### Bounding-box overlays (extended profile only)

Overlays render only when Elasticsearch is populated with the metadata index — i.e. **`MINIMAL_PROFILE=""` (extended)**. Under minimal mode, ELK + `vss-video-analytics-api-mv3dt` + `vss-import-calibration-output-mv3dt` are not deployed, and VST shows raw video without overlays. This matches `vss-deploy-profile/references/warehouse.md` lines 37 / 211.

If you're on minimal and the user wants overlays: tear down ([`teardown.md`](teardown.md)), set `MINIMAL_PROFILE=""`, redeploy ([`deploy-rtvi-cv-3d-stack.md`](deploy-rtvi-cv-3d-stack.md)).

In the VST UI, enable overlays via the player's options menu — by default the 3D bounding box overlay is off; toggle it on per stream.

### Tune BEV `group` / `region` for better overlays

If the BEV top-view floor map looks **stretched or squished**, or overlays sit off to one side, the `group`/`region` values in `calibration.json` (and/or the `Top.png` aspect) need refining. For API-only AMC/VGGT runs these were set to schema-valid **placeholders** by [`calibration-workflow.md` § 4a](calibration-workflow.md) — enough to boot the stack, but not geometrically accurate. This is expected; tune them now that everything is deployed.

Surface the current values to the user first:

```bash
CAL_DIR="${VSS_APPS_DIR}/industry-profiles/warehouse-operations/warehouse-mv3dt-app/calibration/sample-data/${SAMPLE_VIDEO_DATASET}"
jq '.sensors[0] | {group, region, place}' "${CAL_DIR}/calibration.json"
```

Then point the user at the canonical customization docs to set them properly:

- **Accurate `group.origin` / `group.dimensions`** are derived from camera **FOV coverage** (union of per-camera ground-projected frustums), not from the image size. The VSS Configurator normally computes these automatically; to (re)generate manually, run `spatial-ai-data-utils`'s `tools/camera_grouping/calculate_origin.py` against `calibration.json` (`--overwrite`, optionally `--map_file <Top.png> --visualize`).
- **`group_id` / `region` labels** per camera are defined in the Sensor Info File (`camera_info.json`, with `SENSOR_INFO_SOURCE=file`).
- Field meanings and the camera-grouping tools are documented in the NVIDIA **VSS Warehouse 3D-Vision-AI Profile → Customization** guide: `https://docs.nvidia.com/vss/latest/warehouse-docs/3D-profile.html#customization`.

After editing `calibration.json`, re-import it (re-run the one-shot `import-calibration-output-container-mv3dt` compose service) and restart `vss-vios-streamprocessing` so VST reloads it, then hard-refresh the VST tab (`Ctrl+Shift+R`).

> **Floor-map aspect.** VST renders `Top.png` into a fixed-aspect (≈16:9) panel. A plan-view image whose aspect is far from 16:9 (e.g. a tall/portrait layout) will appear stretched **regardless of `region` values** — pad/letterbox `Top.png` to ~16:9 (origin-preserving, so world↔pixel mapping is unchanged) if needed.

### Browser reachability

The VST UI loads over TCP/30888, but video playback uses **WebRTC**. The browser must reach:

1. **TCP/30888** — UI itself.
2. **Outbound STUN** — VST's `vst_config.json` defaults `stunurl_list` to `stun.l.google.com:19302`. Corp / VPN networks often block this.
3. **Inbound UDP** on a wide port range — VST's `webrtc_port_range` defaults to random UDP (`{min: 0, max: 0}`). Corp / cloud / on-prem firewalls that don't pass arbitrary UDP will make WebRTC fail at ICE negotiation. This is the most common reason "VST UI loads but playback fails" on hosts that are otherwise healthy.

**Symptom of WebRTC failure:** UI loads fine, but clicking play on a sensor shows `Playback Error: Error 22: Failed to create Video Source` — even when the data pipeline is healthy (`mdx-raw` / `mdx-bev` offsets growing, `vss-vios-streamprocessing` is recording chunks).

**Sensor-status caveat.** Even when WebRTC is failing, `GET /vst/api/v1/sensor/list` may report `state: "offline"` and `url: null` on each sensor. That field reflects browser-reachability, not pipeline health. If `streamprocessing` is actively writing files to disk under `${VSS_DATA_DIR}/data_log/`, the data pipeline is fine — the issue is the browser→host transport.

**Workarounds.**

1. **Run the browser on the host.** VNC, X-forward, or RDP into the deploy host — bypasses the WebRTC firewall entirely.
2. **Bypass VST UI; use RTSP directly.** VST publishes the per-sensor stream at `rtsp://<HOST_IP>:30554/live/<sensorId>`. Open with `ffplay`, `vlc`, or `mpv` if TCP/30554 is reachable. No overlays, but lets you see the raw stream.
3. **Bypass UI entirely; consume `mdx-bev`.** The data is on the broker — write a downstream consumer in your language of choice.
4. **Self-host TURN.** Heavyweight: stand up a TURN server on TCP/443 (reachable through corp HTTPS) and point VST at it. Out of scope for this skill; needs VST config edits.

#### Edge and remote hosts (Thor, cloud VM, SSH / VPN / NAT)

On IGX-THOR / AGX-THOR and other edge or cloud hosts you often reach the box only through SSH, a VPN, or a proxy — `HOST_IP` isn't directly routable from your laptop. Forwarding the UI port is enough to *load* the dashboard but **not** to play video:

```bash
# Loads the VST UI in your laptop browser — dashboard only.
ssh -L 30888:localhost:30888 <user>@<edge-host>
# then open: http://localhost:30888/vst/#/live-streams
```

WebRTC media travels over **UDP on a random port range plus STUN**, which a TCP `-L` tunnel does not carry — so playback still fails with `Error 2: Failed to start inbound stream`, `Error 22`, or an ICE failure even though the UI loaded. To actually see frames through SSH, forward the **RTSP** port instead (RTSP over TCP tunnels cleanly) and play the per-sensor stream:

```bash
# Real frames over SSH — no overlays, but reliable through a tunnel.
ssh -L 30554:localhost:30554 <user>@<edge-host>
ffplay "rtsp://localhost:30554/live/<sensorId>"   # sensorId from /vst/api/v1/sensor/list
```

For the full overlay UI on these hosts, run the browser **on the host** (VNC / X-forward / RDP — workaround 1 above) or stand up a TURN server (workaround 4). Forwarding only TCP/30888 reproduces the "UI loads, playback fails" symptom and is the most common cause of `Error 2` / `Error 22` on Thor and other SSH/VPN-only hosts.

If the user is on a host without these restrictions (LAN, public IP with permissive firewall), Step 5 just works.

## Step 6 — Other diagnostic endpoints

| Surface | URL | Notes |
|---|---|---|
| NvStreamer UI | `http://<HOST_IP>:31000` | Configure / inspect the RTSP server (sample / videos mode only) |
| Auto-Calibration UI | `http://<HOST_IP>:5000` | Only if AMC was deployed via the separate `auto_calib` flow ([`calibration-workflow.md`](calibration-workflow.md)) — **not** part of the MV3DT deploy itself |
| VST sensor list (API) | `http://<HOST_IP>:30888/vst/api/v1/sensor/list` | `jq` it to confirm `NUM_STREAMS` sensors are registered |
| VST MCP | `http://<HOST_IP>:8001` | Read-only diagnostics |
| Kibana (extended only) | `http://<HOST_IP>:5601/kibana/app/dashboards` | Dashboards for `mdx-bev` and friends. Bare `:5601/` may return 404 because Kibana uses base path `/kibana`. |

`vss-haproxy-ingress` does come up under MV3DT, but there's no path-based ingress routing for the MV3DT surfaces — access the services on their direct ports as listed above (the agent UI / `:7777` path routing belongs to the full `bp_wh` agents profile, not `MODE=mv3dt`).

## When something is wrong

See [`troubleshooting.md`](troubleshooting.md).
