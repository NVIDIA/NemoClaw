# Troubleshooting

Common failures, their root causes, and the fix that worked in the field.
The skill consults this file on hard errors before re-prompting the user.

---

## Verify Deployment

```bash
# Liveness — process is up
curl -f http://localhost:9000/api/v1/live

# Readiness — pipeline is ready (after streams attached)
curl http://localhost:9000/api/v1/ready
# Expected: {"ds-ready":"YES"}

# Startup — first-time init complete
curl http://localhost:9000/api/v1/startup

# List active streams
curl http://localhost:9000/api/v1/stream/get-stream-info

# Per-stream FPS, GPU/CPU, memory
curl http://localhost:9000/api/v1/metrics
```

**Healthy log signatures** (grep in `~/rtvicv-storage/logs/<usecase-and-model>_<ts>.txt`):

- `Pipeline is PLAYING` — DeepStream pipeline running
- `deserialize cuda engine from file` — TRT engine loaded from cache (fast start)
- `REST Server started` / `Listening on 0.0.0.0:9000` — API ready
- `serialize cuda engine to file` — first-run engine build completing (~3–10 min)

---

## Logs

```bash
# Live container logs
docker logs -f <CONTAINER_NAME>

# Deployment log (settings + configs + app stdout)
tail -f ~/rtvicv-storage/logs/<usecase-and-model>_<ts>.txt

# Container resource usage
docker stats <CONTAINER_NAME>

# GPU utilisation
nvidia-smi -l 1
```

For verbose GStreamer output, set `GST_DEBUG=2` inside the container.

---

## Common Failures

| Symptom                                                | Root cause                                             | Fix |
|--------------------------------------------------------|--------------------------------------------------------|-----|
| `unauthorized` on `docker pull`                        | NGC auth failed                                        | `docker login nvcr.io -u '$oauthtoken' -p "$NGC_API_KEY"` |
| `nvidia-container-cli: device error`                   | GPU index wrong or driver mismatch                     | `nvidia-smi` to check indices; try `--gpus all` |
| `bind: address already in use` (port 9000)             | Another service holds 9000                             | Set `[http-server] http-port=9001` in `ds-main-config.txt` |
| `Failed to set pipeline to PAUSED` (eglsink)           | `DISPLAY` unset/malformed inside container             | Re-exec with `-e DISPLAY=:0 -e XAUTHORITY=/root/.Xauthority`; `xhost +local:root` on host first |
| `kFP16 … Retrying without explicit FP16 flag`          | RT-DETR ships strongly-typed FP16 ONNX                 | **Expected — wait for `serialize cuda engine to file: … successfully`** |
| Sparse4D engine build fails                            | `LD_PRELOAD` not set                                   | `export LD_PRELOAD=$SPARSE4D_REPO/libmsda_fp16.so` then re-run `setup_sparse4d.sh` |
| Tracker fails to load `resnet50_market1501.etlt` / pipeline never reaches PLAYING (smartcity-* / warehouse-2d) | The tracker config references `/opt/nvidia/deepstream/deepstream/samples/models/Tracker/resnet50_market1501.etlt` but the etlt ships deeper in the perception-app sources tree | Run `docker exec <c> /tmp/scripts/setup_tracker_reid.sh` — it auto-locates the bundled etlt and copies it to the expected path. `apply_config.sh` calls this automatically at Step 4.a.1 for warehouse-2d / smartcity-rtdetr / smartcity-gdino. **Do NOT** swap the tracker config to `NvDCF_perf.yml` as a workaround — that loses ReID-based identity persistence. |
| GDINO `model.plan` missing                             | `setup_gdino.sh` not run / ONNX not found              | Re-run `setup_gdino.sh --batch <N>` after verifying ONNX under `$RESOURCES` |
| BEV boxes wrong / `No projection matrix found`         | warehouse-3d `.mp4` stems don't match `calibration.json` | Pick a video dir whose `.mp4` stems match `sensors[].id` |
| Engine cache not persisting                            | `/opt/storage` mount missing                           | Add `-v ~/rtvicv-storage:/opt/storage` to `docker run` |
| Stale engine gives wrong output                        | ONNX changed but cache filename matched the batch      | `rm ~/rtvicv-storage/engines/<stale>.engine` or set `FORCE_ENGINE_REBUILD=1` |
| `no element "x264enc"` (filedump)                      | Software encoder deps not installed                    | Re-run `update_output_sink.sh <usecase> filedump` (auto-installs via `user_additional_install.sh`) |
| Image arch mismatch on pull                            | Wrong tag for platform                                 | SBSA needs the `-sbsa-` tag variant; re-ask user for the correct image ref |
| Host files flipped to root after deploy                | Bind-mounted `reference-configs/` got chowned          | Avoid bind-mounting `reference-configs/`; recover with `sudo chown -R $USER:$USER <path>` |

---

## Gotchas & Known Issues

- **warehouse-3d `camera_id` must match `calibration.json`**. The `.mp4`
  filename stems (e.g. `Camera_01`) must exactly match `sensors[].id` in
  `calibration.json`. Mismatches fall back to the identity matrix and produce
  wrong BEV boxes.
- **`eglsink` DISPLAY format**. Pass `:0`, not `0`. A bare number causes
  `Failed to set pipeline to PAUSED`. Always use `docker exec -e DISPLAY=:0
  -e XAUTHORITY=/root/.Xauthority`.
- **kFP16 retry is expected**. RT-DETR ONNX ships as strongly-typed FP16; TRT
  prints an error and retries silently. This is not a bug — wait for the
  serialize-success log line.
- **Filedump `.mp4` uses MKV muxer by default**. Recoverable on abnormal exit
  (SIGKILL). Most players auto-detect by content. Use
  `update_output_sink.sh ... --container 1` only if a strict MP4 parser is
  downstream.
- **Engine cache canonical dir is `~/rtvicv-storage/engines/`**. Never
  `engine_cache/`. The skill auto-migrates legacy `engine_cache/` on deploy.
- **No NGC mount on the container**. NGC downloads happen on the host (Step
  1.g via `fetch_resources.sh`) and the data is staged into
  `~/rtvicv-storage`. The container reads the bind mount; it never runs
  `ngc registry`.
- **Parallel instances**. Use `--network=host` (default) and change
  `http-port` in `ds-main-config.txt` for each instance. Port 9000 can only
  be held by one process.

---

## Engine Cache Hygiene

The cache lives at `~/rtvicv-storage/engines/`. Each entry's filename uses
the ONNX basename as its stem, so an ONNX version bump produces a fresh cache
entry automatically:

```
~/rtvicv-storage/engines/<onnx-basename>_b<N>.engine                       # nvinfer / Sparse4D
~/rtvicv-storage/engines/<onnx-basename>_b<N>.plan                         # GDINO / Triton
~/rtvicv-storage/engines/resnet50_market1501.etlt_b<N>_gpu<G>_fp<P>.engine # NvDCF_accuracy ReID tracker
```

The tracker ReID engine is cached the same way (warehouse-2d /
smartcity-rtdetr / smartcity-gdino). `setup_tracker_reid.sh` runs
twice: once before launch (plants a symlink from the Tracker/ path
into the cache when one already exists — `<1 s` deserialisation
instead of `~2 min` rebuild) and once after launch (moves a freshly-
built engine into the cache so the next deploy is fast).

| Action                                | Command                                                        |
|---------------------------------------|----------------------------------------------------------------|
| Force rebuild on next deploy          | `FORCE_ENGINE_REBUILD=1 ./scripts/setup_gdino.sh --batch 4`    |
| Clear a specific cached engine        | `rm ~/rtvicv-storage/engines/<onnx>_b4.engine`                 |
| Wipe the entire cache                 | `rm -f ~/rtvicv-storage/engines/*.{engine,plan}`               |
| Move stray non-engine files out of cache | `bash scripts/clean_engine_cache.sh` (idempotent — moves anything that isn't `*.engine` or `*.plan` into `~/rtvicv-storage/engines/.quarantine/`; does NOT delete) |
| Tracker engine path mismatch (engine builds in `deepstream-9.0/Tracker/` but symlink-path search misses it) | `setup_tracker_reid.sh` now scans every `/opt/nvidia/deepstream/deepstream*/samples/models/Tracker/` dir and plants symlinks in all of them, so the engine is cached regardless of which path the tracker wrote it to. |
