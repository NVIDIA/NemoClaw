# Teardown — MV3DT stack

Parent: [`../SKILL.md`](../SKILL.md). Stop the MV3DT stack, optionally clear data, leave the host clean for redeploy.

This teardown is scoped to whatever this skill brought up — the same compose file the deploy used. It's safe to run repeatedly.

## Step 1 — Stop containers and reset named volumes (recommended for redeploys)

```bash
cd "${VSS_APPS_DIR}"
docker compose -f compose.yml \
  --env-file industry-profiles/warehouse-operations/.env \
  down -v
```

`down -v` removes the MV3DT containers (perception, fusion, mosquitto, broker, VST sensor stack, configurator, nvstreamer) **and** resets the named docker volumes (Kafka log, Postgres VST DB, Elasticsearch data, Logstash libs). This is the recommended path for any redeploy where:

- the dataset or camera count changed (sensor records re-initialize from the new calibration),
- the calibration file changed for the same dataset slug,
- you want each deploy to start from a known-clean state.

Named volumes persist across `docker compose down` by design, which is great when you want to retain Kafka offsets or Elasticsearch history between restarts. For redeploys after a camera-set change, the cleaner path is to let those volumes reset alongside the containers — `down -v` does both in one step.

### Alternate — stop containers, keep volumes

When you intend to bring the same dataset back up against the existing broker / VST history (for example, restarting after a quick config tweak), use plain `down` and skip Step 2:

```bash
docker compose -f compose.yml \
  --env-file industry-profiles/warehouse-operations/.env \
  down
```

## Step 2 — (Optional) Targeted volume cleanup + prune

When you stopped with plain `down` in Step 1 but later decide to reset only certain volumes, target them explicitly. Then prune dangling resources:

```bash
# Remove MV3DT-named volumes explicitly
docker volume rm $(docker volume ls -q | grep '^mdx_') 2>/dev/null

# Then clean up dangling resources
docker volume prune -f
docker system prune -f
```

**Prune does not reliably remove the named volumes.** Neither `docker volume prune -f` nor `docker system prune -af --volumes` is a dependable way to clear `mdx_mdx-kafka` / `mdx_vios_pg_data` — prune skips anonymous/unreferenced volumes, and named project volumes routinely survive a full system prune. Always target them explicitly with `docker volume rm $(docker volume ls -q | grep '^mdx_')` (or `down -v`, which drops the project's volumes as part of teardown). Skip the prune lines if other docker workloads on this host share the volume namespace.

## Step 3 — Clear data logs

The shipped cleanup script drops data dirs the warehouse stack writes to (Elasticsearch indexes, Kafka logs, VST sensor state, etc.).

**Pass `--skip-revert-from-oldest-backup`** so the script does not roll your `.env` and other configs back to their packaged backup snapshots. The configurator re-renders those files at next deploy from `.env`, so reverting them isn't needed; leaving the flag off causes the script to source a placeholder `.env`, lose `VSS_DATA_DIR`, and then no-op the data_log deletes without any error.

```bash
bash "${VSS_APPS_DIR}/scripts/cleanup_all_datalog.sh" \
  -e industry-profiles/warehouse-operations/.env \
  --skip-revert-from-oldest-backup
```

Sudo may prompt for some paths.

### Verify the cleanup actually ran

The cleanup script doesn't print per-path success, so confirm by disk usage:

```bash
# Should be small (a few MB at most) or report "No such file or directory"
du -sh "${VSS_DATA_DIR}/data_log" 2>/dev/null
du -sh "${VSS_DATA_DIR}/auto-calib"/{vst_storage,nvstreamer_data}/ 2>/dev/null
```

If you see multi-GB sizes after Step 3, the deletes did not take effect. Confirm `VSS_DATA_DIR` resolves in your shell (`echo "${VSS_DATA_DIR}"`), then re-run Step 3.

## Step 4 — Tear down AMC (only if you deployed it standalone)

If [`calibration-workflow.md`](calibration-workflow.md) deployed `auto_calib` separately and you didn't tear it down already, do it now:

```bash
cd "${VSS_APPS_DIR}"
COMPOSE_PROFILES=auto_calib docker compose \
  --env-file industry-profiles/warehouse-operations/.env \
  down
```

Normal MV3DT profiles (`bp_wh_kafka_mv3dt` / `bp_wh_redis_mv3dt`) do not include AMC. Auto-calibration warehouse profiles use `bp_wh_auto_calib_*`; if AMC is still running after the MV3DT teardown, use the command above.

## What is preserved across teardown

These are intentionally not deleted:

- **Calibration outputs** — `${VSS_APPS_DIR}/industry-profiles/warehouse-operations/warehouse-mv3dt-app/calibration/sample-data/<slug>/` (bind-mounted, not a docker volume). Next deploy reuses them.
- **AMC project state** — `${VSS_APPS_DIR}/services/auto-calibration/projects/project_<id>/` (bind-mounted). Lets you re-run VGGT or fetch logs after teardown.
- **NGC images** in `nvcr.io` — local docker image cache is preserved. Next deploy uses cached images unless you `--pull always`.

What is **not** preserved (be aware):

- **Configurator-rendered configs** under `warehouse-mv3dt-app/{vst,nvstreamer,deepstream,vss-behavior-analytics}/configs/` and `services/analytics/video-analytics-api/configs/` — these are re-rendered on next deploy from `.env`, so this is normally fine, but any hand-edits you made between deploys will be overwritten.
- **`.env` if you omit `--skip-revert-from-oldest-backup` in Step 3** — the cleanup script will roll `.env` back to its packaged snapshot (placeholders for `VSS_APPS_DIR`, `VSS_DATA_DIR`, `HOST_IP`, `NGC_CLI_API_KEY`). With the flag set as shown above, `.env` is untouched.

## Nuke option (you're really sure)

When you want to wipe everything including bind-mounted state, named volumes, and the cached image layers:

```bash
cd "${VSS_APPS_DIR}"

# Stop everything, drop named volumes, drop locally-built images
docker compose -f compose.yml \
  --env-file industry-profiles/warehouse-operations/.env down -v --rmi local

# Clear bind-mounted AMC state — DESTRUCTIVE.
# Auto-proceed when sudo is passwordless; otherwise surface the commands for the user.
DATASET="${SAMPLE_VIDEO_DATASET:?}"
if sudo -n true 2>/dev/null; then
  sudo rm -rf "${VSS_APPS_DIR}/services/auto-calibration/projects/"

  # Clear your own calibration outputs (keep the ship-with-repo sample!)
  if [ "${DATASET}" != "warehouse-4cams-20mx20m-synthetic" ]; then
    sudo rm -rf "${VSS_APPS_DIR}/industry-profiles/warehouse-operations/warehouse-mv3dt-app/calibration/sample-data/${DATASET}"
  fi
else
  echo "Sudo requires a password on this host. Please run the commands below in your shell, then confirm to continue:"
  echo "  sudo rm -rf \"${VSS_APPS_DIR}/services/auto-calibration/projects/\""
  if [ "${DATASET}" != "warehouse-4cams-20mx20m-synthetic" ]; then
    echo "  sudo rm -rf \"${VSS_APPS_DIR}/industry-profiles/warehouse-operations/warehouse-mv3dt-app/calibration/sample-data/${DATASET}\""
  fi
fi

# Drop data_log and optionally revert .env (intentional this time)
bash "${VSS_APPS_DIR}/scripts/cleanup_all_datalog.sh" \
  -e industry-profiles/warehouse-operations/.env

docker volume prune -f
docker system prune -f
```

Don't run this if you have AMC project state or custom calibration you want to keep — they're both wiped.

## After teardown — common next steps

- Edit `.env` and redeploy: [`deploy-rtvi-cv-3d-stack.md`](deploy-rtvi-cv-3d-stack.md).
- Re-calibrate from scratch: walk [`calibration-workflow.md`](calibration-workflow.md) again.
- Switch to the full warehouse blueprint (with agents / ELK): [`../../vss-deploy-profile/references/warehouse.md`](../../vss-deploy-profile/references/warehouse.md).
