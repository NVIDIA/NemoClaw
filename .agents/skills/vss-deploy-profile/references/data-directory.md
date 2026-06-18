# Deploy — Data directory layout

### Step 1b — Prepare the data directory

**This is the #1 source of silent-deploy bugs. Follow it exactly.**

The stack mounts several subdirs of `$VSS_DATA_DIR` into containers that each
run as a different uid. Docker auto-creates empty bind-mount paths as
`root:root`, which is read-only for the container processes.

Run this verbatim before `docker compose up`:

```bash
DATA=$VSS_DATA_DIR      # e.g. <repo>/data
mkdir -p \
  "$DATA/data_log/analytics_cache" \
  "$DATA/data_log/calibration_toolkit" \
  "$DATA/data_log/elastic/data" \
  "$DATA/data_log/elastic/logs" \
  "$DATA/data_log/kafka" \
  "$DATA/data_log/redis/data" \
  "$DATA/data_log/redis/log" \
  "$DATA/agent_eval/dataset" \
  "$DATA/agent_eval/results"
# Profile-specific subdirs:
#   alerts → mkdir -p "$DATA/data_log/vss_video_analytics_api" "$DATA/videos/dev-profile-alerts" "$DATA/models/rtdetr-its" "$DATA/models/gdino"
#   search → mkdir -p "$DATA/models"
chmod -R 777 "$DATA/data_log" "$DATA/agent_eval"
# If you created $DATA/models above, also: chmod -R 777 "$DATA/models"
```

> **FORBIDDEN: `chown -R ubuntu:ubuntu $VSS_DATA_DIR` (or any recursive chown).**
>
> This is "good housekeeping" to a shell-admin instinct but is **the** deploy-
> breaking command in this stack. You will observe a "healthy" deploy
> (containers Up, endpoints 200) while the video pipeline is silently broken.
> Use `chmod -R 777` on the specific subdirs above — nothing else.

**If postgres is already broken** (common when redeploying without a clean
`data-dir`):

```bash
docker logs vss-vios-postgres
# Resolve the actual volume (its name is <compose_project>_vios_pg_data — the
# project prefix varies by deploy, so detect it rather than hard-coding it):
vol=$(docker volume ls --format '{{.Name}}' | grep 'vios_pg_data$')
# If the logs show a corrupted/stale PGDATA volume, stop the stack, then:
docker volume rm "$vol"
```
