# Deploy auto-calibration service

Use this reference when the user wants to deploy AMC (launch the microservice + UI). The parent skill (``../SKILL.md`` (see `../SKILL.md`)) routes here on triggers like "launch AMC" / "deploy auto-calibration" / "set up auto-magic-calib".

Deploys the `vss-auto-calibration` service — AMC microservice + web UI from pre-built release images. The compose tree lives at [`deploy/docker/services/auto-calibration/`](../../../deploy/docker/services/auto-calibration/), and AMC is enabled only by `auto_calib`, `bp_wh_auto_calib_2d`, `bp_wh_auto_calib_3d`, or `bp_wh_auto_calib_mv3dt`. AMC is a service inside the `warehouse-operations` industry profile — env vars live in [`deploy/docker/industry-profiles/warehouse-operations/.env`](../../../deploy/docker/industry-profiles/warehouse-operations/.env).

## What's different from base VSS

- **Standalone microservice — not part of the VSS agent stack.** AMC ships its own MS + UI containers. The VSS agent, NIMs, VST, RTVI, etc. are **not** brought up by this skill — only the AMC backend and its web UI.
- **AMC piggybacks on the `warehouse-operations` industry profile.** Warehouse calibration profiles load the env automatically; running `auto_calib` standalone requires the same env to be present.
- **Default ports**: MS at `${VSS_AUTO_CALIBRATION_PORT}` (default **8010**); UI at `${VSS_AUTO_CALIBRATION_UI_PORT}` (default `5000`). MS uses `network_mode: host`, so 8010 is also the host port.
- **VIOS auto-wired.** When deployed with a warehouse calibration profile, `VIOS_BASE_URL` is fetched from `${VST_INTERNAL_URL}`. No manual VIOS config needed if VST is running in the same compose.
- **Optional VGGT model.** AMC works without VGGT, but model-based refinement needs `vggt_1B_commercial.pt` at `$VSS_DATA_DIR/auto-calib/vggt/` (the path the MS container mounts read-only). Skip this step unless the user explicitly wants VGGT.

## What gets deployed

| Service | Container | Port | Image (sample — see compose for the authoritative path) | Compose source |
|---|---|---|---|---|
| AMC MS | `vss-auto-calibration` | `${VSS_AUTO_CALIBRATION_PORT}` (default `8010`, host network) | `nvcr.io/nvidia/vss-core/vss-auto-calibration:<tag>` | [`services/auto-calibration/ms/compose.yml`](../../../deploy/docker/services/auto-calibration/ms/compose.yml) |
| AMC UI | `vss-auto-calibration-ui` | `${VSS_AUTO_CALIBRATION_UI_PORT}` (default `5000`) | `nvcr.io/nvidia/vss-core/vss-auto-calibration-ui:<tag>` | [`services/auto-calibration/ui/compose.yml`](../../../deploy/docker/services/auto-calibration/ui/compose.yml) |

> **Image references are illustrative.** The compose files above are the source of truth for the exact image repo and tag — they may differ by release. Don't pull a hand-typed path; read the resolved path from `docker compose config` / `resolved.yml` (Step 3) and let `docker compose up` pull it.

## Env recipe

Set in [`deploy/docker/industry-profiles/warehouse-operations/.env`](../../../deploy/docker/industry-profiles/warehouse-operations/.env) (the values below are the in-repo defaults):

| Variable | Purpose | Default |
|---|---|---|
| `VSS_AUTO_CALIBRATION_PORT` | MS HTTP port (host-networked, so this is also the host port) | `8010` |
| `VSS_AUTO_CALIBRATION_UI_PORT` | UI host port (UI publishes `:5000` inside the container) | `5000` |
| `VSS_AUTO_CALIBRATION_MS_API_URL` | URL the **browser** uses to call the MS (the UI runs in the user's browser, not inside the UI container). Defaults to `http://${HOST_IP}:${VSS_AUTO_CALIBRATION_PORT}/v1`. Override if MS and UI run on different hosts, **or** if `${HOST_IP}:${VSS_AUTO_CALIBRATION_PORT}` isn't routable from the browser (firewalled port, SSH-tunnel-only access, different network). | computed |
| `VGGT_MODEL_PATH` | In-container path the MS reads VGGT from | `/tmp/vggt_model/vggt_1B_commercial.pt` |
| `VIOS_BASE_URL` | Base URL of VIOS (used only by the `rtsp` calibration mode — see `rtsp.md`). Auto-set to `${VST_INTERNAL_URL}` when a warehouse profile with VST is running; for calibration-only RTSP use `bp_wh_auto_calib_2d`, `bp_wh_auto_calib_3d`, or `bp_wh_auto_calib_mv3dt`. | `${VST_INTERNAL_URL}` |
| `HOST_IP` | Host's network IP. **Must be a real reachable IP** — the UI container needs to reach the MS at this address. Not `localhost`, not `0.0.0.0`. | `hostname -I \| awk '{print $1}'` |
| `VSS_APPS_DIR` | **Absolute path to your repo's `deploy/docker/` directory** (compose-tree root) — NOT an arbitrary data dir. Compose uses it both for `env_file:` lookups (e.g. `${VSS_APPS_DIR}/services/vios/vst.env`) and for bind-mounts of in-repo configs + project state (AMC mounts `${VSS_APPS_DIR}/services/auto-calibration/projects` here). The `.env` ships with a placeholder `/path/to/deploy/docker` — **you MUST replace it with the absolute path to your checkout's `deploy/docker`**, otherwise the dry-run fails with `couldn't find env file: …/services/vios/vst.env`. | (no default — must be set) |
| `VSS_DATA_DIR` | Runtime data root (separate from `VSS_APPS_DIR`). MS bind-mounts `${VSS_DATA_DIR}/auto-calib/vggt` (read-only) for the VGGT model. | (no default — must be set) |

## Deployment flow

Standard compose-centric workflow: env overrides → `docker compose --env-file .env config` dry-run → review → `docker compose up`.

### Step 1 — NGC login

AMC pulls its images from the `vss-core` namespace on `nvcr.io` (the exact org — e.g. `nvidia` for published releases — is whatever the compose files in the table above reference). The user's NGC key must have access to that namespace.

The credential source is the `NGC_CLI_API_KEY` environment variable in the **current** shell/env file. Confirm it is set before logging in (this prints only `SET`/`NOT SET`, never the key):

```bash
echo "NGC_CLI_API_KEY: $([ -n "${NGC_CLI_API_KEY}" ] && echo SET || echo 'NOT SET')"
echo "$NGC_CLI_API_KEY" | docker login nvcr.io --username '$oauthtoken' --password-stdin
```

> **Credential handling.** State that you are logging in with `NGC_CLI_API_KEY` from the current env before you run it. If the var is `NOT SET`, or `docker login` fails / a pull later returns 401, **stop and ask the user for a valid NGC key** (`AskUserQuestion`) — do **not** reuse an NGC key seen earlier in the conversation unless the user explicitly confirms reusing it. Never echo, log, or persist the raw key (`--password-stdin` keeps it out of argv and shell history; keep it out of any file you write).

### Step 2 — (Optional) Stage the VGGT model

Skip this step unless the user explicitly asks for VGGT-refined output.

**2a. Accept the model license** (one-time, manual): visit https://huggingface.co/facebook/VGGT-1B-Commercial and click "Agree and access repository".

**2b. Get a HuggingFace read token**: https://huggingface.co/settings/tokens (starts with `hf_…`). Ask the user for it via `AskUserQuestion`.

**2c. Download into the VSS data dir**:

```bash
# venv with huggingface_hub
python3 -m venv /tmp/amc-hf-venv
/tmp/amc-hf-venv/bin/pip install --quiet huggingface_hub

# Download into the path the MS expects to mount
mkdir -p "${VSS_DATA_DIR}/auto-calib/vggt"
/tmp/amc-hf-venv/bin/hf download facebook/VGGT-1B-Commercial \
  --local-dir "${VSS_DATA_DIR}/auto-calib/vggt/" \
  --token <HF_TOKEN>

# Verify
ls -lh "${VSS_DATA_DIR}/auto-calib/vggt/vggt_1B_commercial.pt"
# Should show ~4.7GB file
```

> **Do not log or echo the HuggingFace token value.** Pass it inline to the `hf` CLI via `--token` rather than storing it on disk or in shell history.

### Step 2b — If VIOS is already running, confirm `VIOS_BASE_URL`

AMC's RTSP-stream calibration path calls VIOS over `${VIOS_BASE_URL}`. The warehouse-operations `.env` defaults to `VIOS_BASE_URL=${VST_INTERNAL_URL}` (which resolves to `http://${HOST_IP}:${VST_PORT}`). That default is correct when VIOS/VST comes up as part of the same compose stack — but if you're standing AMC up next to a **pre-existing** VIOS (separate image / different namespace / from another compose project), the default may point at nothing.

Detect first:

```bash
docker ps --format '{{.Names}}\t{{.Image}}' | grep -E "vst|vios|sensor-ms" || echo "(no VIOS detected)"
```

If VIOS is running, **before** the dry-run in Step 3:

1. Confirm `VIOS_BASE_URL` is set in `industry-profiles/warehouse-operations/.env`. If the file leaves it commented out or empty, set it explicitly:
   ```bash
   grep -E "^VIOS_BASE_URL=" deploy/docker/industry-profiles/warehouse-operations/.env \
     || echo 'VIOS_BASE_URL=${VST_INTERNAL_URL}' >> deploy/docker/industry-profiles/warehouse-operations/.env
   ```
2. Verify the URL actually points at the running VIOS. The default assumes `${HOST_IP}:${VST_PORT}` — check both:
   ```bash
   grep -E "^(HOST_IP|VST_PORT)=" deploy/docker/industry-profiles/warehouse-operations/.env
   docker port vst-ingress 2>/dev/null   # or whichever VIOS ingress container is running
   curl -sf -o /dev/null -w "%{http_code}\n" "http://${HOST_IP}:${VST_PORT}/"
   ```
   If `VST_PORT` doesn't match what the existing VIOS ingress publishes, override either `VST_PORT` or set `VIOS_BASE_URL` directly to the running URL (e.g. `VIOS_BASE_URL=http://10.34.3.199:30888`) — don't leave the variable form pointing at the wrong port.

If you don't intend to use AMC's RTSP-stream path (only sample-dataset or pre-recorded videos), `VIOS_BASE_URL` is unused and you can skip this step.

### Step 3 — Enable an auto-calibration compose profile and deploy

Pick the profile that matches the intent, then run the same **generate → confirm image access → bring up** sequence:

| Intent | `COMPOSE_PROFILES` value |
|---|---|
| Warehouse auto-calibration (RTSP via nvstreamer/VST) | `bp_wh_auto_calib_2d`, `bp_wh_auto_calib_3d`, or `bp_wh_auto_calib_mv3dt` |
| Standalone AMC only (no warehouse agent/UI stack) | `auto_calib` |

```bash
cd deploy/docker
export COMPOSE_PROFILES=auto_calib   # or a bp_wh_auto_calib_* profile from the table above

# 1. Generate the resolved compose for review
docker compose --env-file industry-profiles/warehouse-operations/.env config > resolved.yml
# Review resolved.yml — confirm vss-auto-calibration and vss-auto-calibration-ui appear

# 2. Confirm the NGC key can access the AMC images before bringing the stack up.
#    Image references are read from the resolved compose, so this tracks the release tag automatically.
AMC_IMAGES=$(docker compose --env-file industry-profiles/warehouse-operations/.env config --images | grep auto-calibration)
if [ -z "$AMC_IMAGES" ]; then
  echo "No auto-calibration images found in the resolved compose."
  echo "Confirm COMPOSE_PROFILES is exported and the chosen profile includes vss-auto-calibration before continuing."
  exit 1
fi
for img in $AMC_IMAGES; do
  echo "Checking access: $img"
  if ! docker pull "$img"; then
    echo
    echo "NGC login succeeded, but this key does not have access to the required AutoMagicCalib image:"
    echo "  $img"
    echo "Provide an NGC key with access to the vss-core namespace, then retry."
    exit 1
  fi
done

# 3. Bring up the stack (images are already local from the access check)
docker compose --env-file industry-profiles/warehouse-operations/.env up -d
```

### Step 4 — Verify

```bash
PORT=$(grep ^VSS_AUTO_CALIBRATION_PORT deploy/docker/industry-profiles/warehouse-operations/.env | cut -d= -f2)
UI_PORT=$(grep ^VSS_AUTO_CALIBRATION_UI_PORT deploy/docker/industry-profiles/warehouse-operations/.env | cut -d= -f2)
HOST_IP=$(hostname -I | awk '{print $1}')

# MS ready (cold pulls can take a bit after compose returns)
READY_URL="http://localhost:${PORT:-8010}/v1/ready"
for i in $(seq 1 24); do
  if curl -sf "$READY_URL"; then
    break
  fi
  echo "Waiting for AMC microservice readiness... ($i/24)"
  sleep 5
done
curl -sf "$READY_URL"
# Expected: {"code":0,"message":"VSS Auto Calibration Microservice is ready"}

# UI reachable
curl -s -o /dev/null -w "%{http_code}\n" "http://localhost:${UI_PORT:-5000}/"
# Expected: 200

# Containers healthy
docker ps --filter name=vss-auto-calibration --format '{{.Names}}\t{{.Status}}'
# Expected:
#   vss-auto-calibration       Up XXs (healthy)
#   vss-auto-calibration-ui    Up XXs

echo "Microservice: http://${HOST_IP}:${PORT:-8010}"
echo "Web UI:       http://${HOST_IP}:${UI_PORT:-5000}"
```

### Step 5 — Confirm the projects directory is writable

AMC stores each project under a host directory bind-mounted into the container. The container runs as **UID 1000** (`triton-server`), so that directory must be writable by UID 1000 — otherwise the first `POST /v1/create_project` returns `[Errno 13] Permission denied`. **On a fresh checkout this almost always fails the first time**: a `git clone` leaves `services/auto-calibration/projects` owned by the cloning user (whatever their UID is), and unless that happens to be UID 1000 the container can't write. Treat the write-test failing as the expected default on a new host and apply the scoped ACL below. Check this once after the stack is healthy, before any calibration run:

```bash
PROJECTS_DIR="${VSS_APPS_DIR}/services/auto-calibration/projects"
mkdir -p "$PROJECTS_DIR"

# Write-test as the container user, against the actual bind-mount destination
# inside the container (resolved from `docker inspect`, so this is robust to the
# container's WorkingDir and to release path changes — do NOT hardcode it).
DEST=$(docker inspect vss-auto-calibration \
  --format '{{range .Mounts}}{{println .Source .Destination}}{{end}}' \
  | awk -v s="$PROJECTS_DIR" '$1==s {print $2}')
if [ -z "$DEST" ]; then
  WORKDIR=$(docker inspect vss-auto-calibration --format "{{.Config.WorkingDir}}")
  if [ -z "$WORKDIR" ]; then
    echo "ERROR: could not determine container working directory — is vss-auto-calibration running?" >&2
    exit 1
  fi
  DEST="${WORKDIR%/}/projects"
fi

docker exec vss-auto-calibration sh -c \
  "touch '$DEST/.amc_write_test' && rm -f '$DEST/.amc_write_test'" \
  && echo "projects directory is writable" \
  || echo "projects directory is not writable by the container — apply the ACL below"
```

> The projects dir mounts under the container working directory. Use the mount destination resolved from `docker inspect`; a workdir-relative path with the working-directory basename prefixed can resolve to a nested non-existent path and mask a permission failure.

If the write test does not succeed (the common case on a fresh host — see above), grant the container user access with a narrow ACL (ask the user before changing host permissions). This adds write access for UID 1000 only and leaves existing ownership intact:

```bash
setfacl -m u:1000:rwx "$PROJECTS_DIR"     # prefix with sudo if the directory is root-owned
```

Re-run the write test to confirm, then continue. Prefer this scoped ACL over a broad `chmod -R 777`.

## Success criteria

- `curl http://localhost:${VSS_AUTO_CALIBRATION_PORT:-8010}/v1/ready` returns `{"code":0,"message":"VSS Auto Calibration Microservice is ready"}`.
- `vss-auto-calibration` reports `(healthy)` in `docker ps` (the compose healthcheck has a generous `start_period: 1000s`).
- Web UI at `http://<HOST_IP>:${VSS_AUTO_CALIBRATION_UI_PORT:-5000}` renders the AutoMagicCalib interface.

## Key Output

- **Microservice**: `http://<HOST_IP>:${VSS_AUTO_CALIBRATION_PORT:-8010}` — Swagger at `/docs`
- **Web UI**: `http://<HOST_IP>:${VSS_AUTO_CALIBRATION_UI_PORT:-5000}` — project management, file upload, calibration, results
- **Project state**: `${VSS_APPS_DIR}/services/auto-calibration/projects/` (bind-mounted into the MS container)
- **VGGT model** (optional): `${VSS_DATA_DIR}/auto-calib/vggt/vggt_1B_commercial.pt` (read-only mount)

## Troubleshooting

| Issue | Symptoms | Solution |
|---|---|---|
| NGC key logs in but can't pull AMC images | The Step 3 access check stops with "Access Denied" / 401 on `docker pull` of a `vss-core` AMC image, before the stack starts | The key authenticates but lacks `vss-core` access. Ask the user for an NGC key with access to the `vss-core` namespace (do not silently reuse a key from earlier in the conversation — see Step 1 § Credential handling), re-run `echo "$NGC_CLI_API_KEY" \| docker login nvcr.io --username '$oauthtoken' --password-stdin`, then retry Step 3. |
| `docker login` itself is rejected | Step 1 login returns an authentication error | The key is invalid or expired. Ask the user for a current NGC key and log in again before continuing. |
| `vss-auto-calibration` stays `(starting)` for >10 min | Healthcheck not green; MS not responding on `/v1/ready` | Check logs: `docker logs vss-auto-calibration`. Common cause: missing GPU access. Verify `runtime: nvidia` works: `docker run --rm --gpus all ubuntu:22.04 nvidia-smi` |
| UI loads but shows **"Failed to connect to the server"** | Browser dev-tools → Network tab shows the UI fetching `http://${HOST_IP}:${VSS_AUTO_CALIBRATION_PORT}/v1/...` and failing (ERR_CONNECTION_REFUSED / timeout / CORS) | (a) `HOST_IP` unset or `localhost`: `grep ^HOST_IP industry-profiles/warehouse-operations/.env` and set to the host's reachable IP. (b) `HOST_IP` is correct but `${VSS_AUTO_CALIBRATION_PORT}` isn't reachable from the browser (corp firewall blocks the port, the browser is on a different network, etc.): the UI on `:5000` still loads because that port is allowed, but the AJAX call to the MS port fails. Fix by either: (i) moving the MS to a port the browser can reach — set `VSS_AUTO_CALIBRATION_PORT=8080` (or another allowed port) in the env, regenerate `resolved.yml`, and `up -d`; (ii) SSH-tunnelling and overriding `VSS_AUTO_CALIBRATION_MS_API_URL=http://localhost:${VSS_AUTO_CALIBRATION_PORT}/v1`; or (iii) fronting the MS with a reverse proxy on an allowed port and pointing `VSS_AUTO_CALIBRATION_MS_API_URL` at it. |
| Port already in use | `docker compose up` errors with `address already in use` for 8010 or 5000 | Pick a different port: edit `VSS_AUTO_CALIBRATION_PORT` or `VSS_AUTO_CALIBRATION_UI_PORT` in `industry-profiles/warehouse-operations/.env`, re-run dry-run + up. |
| VGGT model not found in MS logs | MS log shows `VGGT model not found at /tmp/vggt_model/vggt_1B_commercial.pt` | Either download VGGT (Step 2) or ignore — AMC works without it. The warning is benign for non-VGGT runs. |
| Permission denied on VGGT path | MS log shows `PermissionError` on `/tmp/vggt_model/...` | The file at `${VSS_DATA_DIR}/auto-calib/vggt/vggt_1B_commercial.pt` is not readable by UID 1000. Fix: `sudo chmod a+r ${VSS_DATA_DIR}/auto-calib/vggt/vggt_1B_commercial.pt` |
| VIOS_BASE_URL empty (RTSP capture returns 503) | The `rtsp` calibration mode reports the MS rejects capture with "VIOS not configured" | Either deploy a warehouse calibration profile (`bp_wh_auto_calib_2d`, `bp_wh_auto_calib_3d`, or `bp_wh_auto_calib_mv3dt`) so VST is present, or set `VIOS_BASE_URL` explicitly in the env file and `docker compose up -d` again. |
| Container exits immediately | `docker ps` shows `vss-auto-calibration` as `Exited` | Check logs: `docker logs vss-auto-calibration`. Often a GPU device-ID mismatch or VGGT path typo. |
| `create_project` returns `[Errno 13] Permission denied` | First `POST /v1/create_project` after a fresh deploy fails writing `projects/project_<id>` | The host `services/auto-calibration/projects` directory isn't writable by the container user (UID 1000). Run the Step 5 write test, then grant access with `setfacl -m u:1000:rwx ${VSS_APPS_DIR}/services/auto-calibration/projects` and retry. |

## Stopping the services

```bash
cd deploy/docker
COMPOSE_PROFILES=auto_calib docker compose --env-file industry-profiles/warehouse-operations/.env down

# Or, if running as part of warehouse auto-calibration, tear down that profile:
COMPOSE_PROFILES=bp_wh_auto_calib_2d docker compose --env-file industry-profiles/warehouse-operations/.env down
```

## What comes next

Once the AMC stack is up and healthy, the parent skill picks one of three calibration modes based on what the user has:

- `sample-dataset.md` — bundled sample (recommended first run; sanity-checks the install).
- `videos.md` — pre-recorded MP4s.
- `rtsp.md` — live RTSP streams (requires VIOS).

**Agent behavior**: if the user's original prompt asked to both deploy AND calibrate (e.g. *"launch AMC and test the sample dataset"*, *"set up auto-magic-calib and calibrate my videos at /data/videos/"*), proceed immediately to one of the calibration-mode references once the readiness probe passes — don't stop at "deploy succeeded" and wait for re-prompt. If the user only asked to deploy, surface the URLs (MS + UI) and the three calibration options above so they can pick.
