# Use Case Reference

Per-use-case NGC resources, config files, batch-size touch points, required setup, and run command.

All paths below are **inside the RTVI-CV container** unless marked "(host)".

> **Local-path alternative (NGC is not required).** Every NGC reference
> shown below can be swapped for a local path on the host — the user
> picks the source per asset in Step 1.d (see
> `resource-plan.md`). When the user chooses
> `local`, `fetch_resources.sh` `cp`s the file/directory into
> `$HOME/rtvicv-storage/resources/local-<role>/`, and the container
> sees it at `/opt/storage/resources/local-<role>/`. The
> `ngc registry ... download-version` commands below run **only** when
> the user selected NGC for that asset and run **on the host** — the
> container itself never gets a `~/.ngc` mount.

**Placeholders (agent fills these in at runtime):**

| Placeholder | Description | Example |
|---|---|---|
| `<RTVI_CV_DOCKER_TAG>` | Container image tag | ask user / read from deployment doc |
| `<WAREHOUSE_APP_DATA_NGC>` | Warehouse NGC resource (`org/team/resource:version`) | ask user |
| `<SMARTCITY_APP_DATA_NGC>` | Smartcity videos NGC resource | ask user |
| `<RTDETR_MODEL_NGC>` | TrafficCamNet / RT-DETR model NGC path | ask user |
| `<GDINO_MODEL_NGC>` | Grounding DINO model NGC path | ask user |
| `<WAREHOUSE_APP_DATA_DIR>` | Extracted warehouse dataset dir under `$RESOURCES` | derived from download |
| `<SMARTCITY_APP_DATA_DIR>` | Extracted smartcity dataset dir under `$RESOURCES` | derived from download |
| `<RTDETR_MODEL_DIR>` | Extracted RT-DETR model dir under `$RESOURCES` | derived from download |
| `<GDINO_MODEL_DIR>` | Extracted GDINO model dir under `$RESOURCES` | derived from download |
| `<N>` | Batch size / max stream count | ask user |

Shared paths (inside container):

| Variable | Value |
|---|---|
| `CONFIGS` | `/opt/nvidia/deepstream/deepstream/sources/apps/sample_apps/metropolis_perception_app/reference-configs` |
| `SPARSE4D_REPO` | `/opt/nvidia/deepstream/deepstream/sources/sparse4d` |
| `TRITON_REPO` | `/opt/nvidia/deepstream/deepstream/sources/TritonGdino/triton_model_repo` |
| `STORAGE` | `/opt/storage` (host mount: `$HOME/rtvicv-storage`) |
| `RESOURCES` | `/opt/storage/resources` |
| `ENGINE_CACHE_DIR` | `/opt/storage/engines` (**single canonical dir for ALL use cases** — host: `~/rtvicv-storage/engines/`). Set once in `scripts/common.sh:82` as `$STORAGE/engines`; never override per use case or write engines anywhere else. Legacy `engine_cache/` directory, if present, is auto-migrated by Step 3.1. |
| `DS_APP_DIR` | `/opt/nvidia/deepstream/deepstream/sources/apps/sample_apps/metropolis_perception_app` |

> The agent should discover the actual directory names under `$RESOURCES` after download
> using `ls $RESOURCES` — NGC extraction directory names depend on the resource version
> and should not be hard-coded in configs.

---

## warehouse-2d

2D object detection on warehouse videos — RT-DETR + NvDCF tracker, 7 classes.

### NGC resources

See [`ngc-setup.md` § Warehouse](ngc-setup.md#warehouse-2d-and-3d-share-the-same-resource) — the canonical `<WAREHOUSE_APP_DATA_NGC>` download command lives there
and the resource ships both the 2D and 3D assets.

### Key asset paths

**Discovered at runtime by Step 4.a** — no hardcoded subdirectories. The skill `find`s by extension only (`*.onnx`) and by filename (`*.mp4` for video dirs), then asks the user to pick if multiple candidates exist.

| Asset | Variable set by Step 4.a |
|---|---|
| ONNX model | `$WAREHOUSE_2D_ONNX` — any `*.onnx` under `$RESOURCES` |
| Test videos dir | `$WAREHOUSE_2D_VIDEOS` — any directory under `$RESOURCES` that contains `.mp4`/`.mkv` files |

> **Warehouse-3d caveat:** Sparse4D needs videos whose filename stems match the `sensors[].id` entries in `calibration.json`. If the same NGC resource contains multiple video directories (e.g. a 2D set and a synthetic 3D set), the Step 4.a video-dir picker shows all candidates — pick the one whose stems match calibration. 2D and 3D deploys can coexist on the same host; they just resolve to different `$WAREHOUSE_*_VIDEOS` values.

### Config files (`$CONFIGS/warehouse-2d/`)

| File | Purpose |
|---|---|
| `ds-main-config.txt` | Main DeepStream pipeline config |
| `ds-ppl-analytics-pgie-config.yml` | nvinfer PGIE (RT-DETR) |
| `ds-detector-labels.txt` | 7 classes |
| `ds-nvdcf-accuracy-tracker-config.yml` | NvDCF tracker |

### Batch-size touch points

Handled by `scripts/update_batch_size.sh warehouse-2d <N>`:

- `ds-main-config.txt` → `[streammux] batch-size`, `[primary-gie] batch-size`, `[source-list] max-batch-size`
- `ds-ppl-analytics-pgie-config.yml` → engine filename `_b<N>_gpu*_fp*.engine`

### Model path update (one-time after download)

The shipped `ds-ppl-analytics-pgie-config.yml` contains `onnx-file: <PATH_TO_ONNX_MODEL>` (generic placeholder) and has `model-engine-file` commented out. Replace the placeholder with the ONNX path discovered in Step 4.a:

```bash
source scripts/common.sh
update_yaml_flat $CONFIGS/warehouse-2d/ds-ppl-analytics-pgie-config.yml onnx-file "$WAREHOUSE_2D_ONNX"
```

Do NOT write `model-engine-file` — DeepStream auto-builds the engine next to the ONNX on first run and reuses it on every subsequent run. The post-launch `cache_nvinfer_engine.sh` (Step 5.e) symlinks the auto-built engine into `$ENGINE_CACHE_DIR` so the tiered cache lookup can reuse it next time.

### Extra setup

None. Engine is built automatically on first run from the ONNX.

### Run command

```bash
cd $DS_APP_DIR
./metropolis_perception_app -c reference-configs/warehouse-2d/ds-main-config.txt
```

---

## warehouse-3d

3D object detection using **Sparse4D** (multi-camera BEV), 6 classes. Uses a custom `videotemplate` plugin instead of `nvinfer`.

### NGC resources

Same `<WAREHOUSE_APP_DATA_NGC>` as warehouse-2d (resource ships both 2D and 3D
assets) — see [`ngc-setup.md` § Warehouse](ngc-setup.md#warehouse-2d-and-3d-share-the-same-resource).

### Key asset paths

**Discovered at runtime by Step 4.a** — `find` by extension / filename only, no hardcoded NGC subdirectories. User confirms on ambiguity.

| Asset | Variable set by Step 4.a | `find` pattern |
|---|---|---|
| Sparse4D ONNX | `$SPARSE4D_ONNX` | `*.onnx` |
| Labels | `$SPARSE4D_LABELS` | `labels.txt` |
| Anchor | `$SPARSE4D_ANCHOR` | `*.npy` |
| Calibration (optional) | `$SPARSE4D_CALIB` | `calibration.json` (NGC resource first, fall back to the repo-shipped one) |
| Test videos dir | `$WAREHOUSE_3D_VIDEOS` | any directory containing `.mp4`/`.mkv` |

> **Sparse4D requires videos whose filename stems match the `sensors[].id` entries in `calibration.json`.** If the NGC resource contains multiple video directories (e.g. a 2D set and a BEV synthetic set), the Step 4.a video-dir picker lets the user select — pick the one whose stems match. Using a mismatched videos-dir will produce `Warning: No projection matrix found for camera <name>. Using identity matrix.` spam and wrong BEV boxes.

### Config files (`$CONFIGS/warehouse-3d/`)

| File | Purpose |
|---|---|
| `ds-main-config.txt` | Main DeepStream pipeline |
| `config.yaml` | Sparse4D model config (inference, calibration, preprocessing) |
| `calibration.json` | Camera calibration (extrinsics/intrinsics) |
| `ds-mtmc-preprocess-config.txt` | `nvdspreprocess` config |
| `ds-mtmc-videotemplate_custom_lib_config.txt` | `videotemplate` (sparse4d plugin) config |

### Required environment (inside container, every session)

```bash
export LD_PRELOAD=$SPARSE4D_REPO/libmsda_fp16.so
export LD_LIBRARY_PATH=$LD_LIBRARY_PATH:$SPARSE4D_REPO:/usr/local/lib/python3/dist-packages/torch/lib
```

### Batch-size touch points

Handled by `scripts/update_batch_size.sh warehouse-3d <N>`:

- `ds-main-config.txt` → `[streammux] batch-size`, `[source-list] max-batch-size`
- `config.yaml` → `num_sensors`
- `ds-mtmc-preprocess-config.txt` → `network-input-shape=N;3;540;960`

### Model path update (always — all four placeholders)

The shipped `config.yaml` contains `<PATH_TO_ONNX_MODEL>`, `<PATH_TO_ENGINE_FILE>`, `<PATH_TO_LABELS_FILE>`, `<PATH_TO_ANCHOR_FILE>`. All four must be substituted. `engine_file` must point at the persistent cache directory because `sparse4d_setup.sh` writes the TRT engine exactly to that path.

```bash
source scripts/common.sh
ONNX_BASE=$(basename "$SPARSE4D_ONNX")
update_yaml_flat $CONFIGS/warehouse-3d/config.yaml onnx_file    "$SPARSE4D_ONNX"
update_yaml_flat $CONFIGS/warehouse-3d/config.yaml engine_file  "$ENGINE_CACHE_DIR/${ONNX_BASE}_b<N>.engine"
update_yaml_flat $CONFIGS/warehouse-3d/config.yaml labels_file  "$SPARSE4D_LABELS"
update_yaml_flat $CONFIGS/warehouse-3d/config.yaml anchor       "$SPARSE4D_ANCHOR"

# Calibration: see apply-config.md § "NGC-supplied calibration.json" for the
# canonical NGC-first-then-repo-fallback resolution + copy logic. Same flow
# applies here.
```

### Extra setup

Run **after** updating configs and exporting env vars:

```bash
./scripts/setup_sparse4d.sh
```

This copies `config.yaml` and `calibration.json` into `$SPARSE4D_REPO/configs/` and runs `sparse4d_setup.sh` to build the TensorRT engine.

If `config.yaml` is modified later (e.g. to enable `generate_3d_bbox: True` for visualization), **re-copy it**:

```bash
cp $CONFIGS/warehouse-3d/config.yaml $SPARSE4D_REPO/configs/config.yaml
```

### Run command

```bash
cd $DS_APP_DIR
./metropolis_perception_app -c reference-configs/warehouse-3d/ds-main-config.txt
```

### CRITICAL — camera_id must match `calibration.json`

See [`apply-config.md` § camera_id MUST match `calibration.json` for warehouse-3d](apply-config.md#critical--camera_id-must-match-calibrationjson-for-warehouse-3d)
for the full rule, the discovery snippet, and the safe `.mp4`-stem
convention. The same constraint applies to every warehouse-3d deploy.

---

## smartcity-rtdetr

Smart city 2D detection using **RT-DETR** (TrafficCamNet), 5 classes.

### NGC resources

See `ngc-setup.md` for the canonical download commands
(`<RTDETR_MODEL_NGC>`, `<SMARTCITY_APP_DATA_NGC>` resolution + tar
extraction). The ReID model for NvDCF tracker is fetched separately via the
stable URL documented there.

### Key asset paths

**Discovered at runtime by Step 4.a** — `find` by extension only, user confirms on ambiguity. No hardcoded subdirectory names.

| Asset | Variable set by Step 4.a | `find` pattern |
|---|---|---|
| RT-DETR ONNX | `$RTDETR_ONNX` | `*.onnx` |
| Test videos dir | `$SMC_VIDEOS` | any directory containing `.mp4`/`.mkv` |
| ReID model | (fixed path) | `/opt/nvidia/deepstream/deepstream/samples/models/Tracker/resnet50_market1501.etlt` (downloaded by the NGC step above — not use-case-specific) |

### Config files (`$CONFIGS/smartcities/rt-detr/`)

| File | Purpose |
|---|---|
| `run_config-api-rtdetr-protobuf.txt` | Main pipeline config |
| `rtdetr-960x544.txt` | nvinfer PGIE (RT-DETR, INI-style) |
| `rtdetr-960x544-labels.txt` | 5 classes |
| `cfg_kafka.txt` | Kafka broker |

### Batch-size touch points

Handled by `scripts/update_batch_size.sh smartcity-rtdetr <N>`:

- `run_config-api-rtdetr-protobuf.txt` → `[streammux] batch-size`, `[primary-gie] batch-size`, `[source-list] max-batch-size`
- `rtdetr-960x544.txt` → `[property] batch-size`, engine filename `_b<N>_gpu*_fp*.engine`

### Model path update (always)

The shipped `rtdetr-960x544.txt` contains `onnx-file=<PATH_TO_ONNX_MODEL>` and has `model-engine-file` commented out. Replace the placeholder:

```bash
source scripts/common.sh
update_ds_config $CONFIGS/smartcities/rt-detr/rtdetr-960x544.txt "[property]" onnx-file "$RTDETR_ONNX"
```

Do NOT write `model-engine-file` — DS auto-builds next to the ONNX. `cache_nvinfer_engine.sh` (Step 5.e) symlinks the auto-built engine into `$ENGINE_CACHE_DIR` for next-deploy reuse.

### Extra setup

None. Engine is built automatically on first run.

### Run command

```bash
cd $DS_APP_DIR
./metropolis_perception_app -c reference-configs/smartcities/rt-detr/run_config-api-rtdetr-protobuf.txt
```

---

## smartcity-gdino

Smart city open-vocabulary detection using **Grounding DINO** via Triton (`nvinferserver` ensemble).

### NGC resources

Same videos + ReID as smartcity-rtdetr, **plus** the GDINO model — see
[`ngc-setup.md` § Smart City GDINO](ngc-setup.md#smart-city-gdino) for the
download command.

### Key asset paths

**Discovered at runtime by Step 4.a** — same dynamic pattern as smartcity-rtdetr.

| Asset | Variable set by Step 4.a | `find` pattern |
|---|---|---|
| GDINO ONNX | `$GDINO_ONNX` | `*.onnx` (if the user pulled both the GDINO and RT-DETR NGC models, Step 4.a disambiguates) |
| Test videos dir | `$SMC_VIDEOS` | any directory containing `.mp4`/`.mkv` |
| ReID model | (fixed path) | `/opt/nvidia/deepstream/deepstream/samples/models/Tracker/resnet50_market1501.etlt` |

### Config files (`$CONFIGS/smartcities/gdino/`)

| File | Purpose |
|---|---|
| `run_config-api-rtdetr-protobuf.txt` | Main pipeline config |
| `config_triton_nvinferserver_gdino.txt` | Triton PGIE |
| `cfg_kafka.txt` | Kafka broker |

### Batch-size touch points

Handled by `scripts/update_batch_size.sh smartcity-gdino <N>`:

- `run_config-api-rtdetr-protobuf.txt` → `[streammux] batch-size`, `[primary-gie] batch-size`, `[source-list] max-batch-size`
- `config_triton_nvinferserver_gdino.txt` → `max_batch_size`
- `$TRITON_REPO/ensemble_python_gdino/config.pbtxt` → `max_batch_size`
- `$TRITON_REPO/gdino_trt/config.pbtxt` → `max_batch_size`
- `$TRITON_REPO/gdino_postprocess/config.pbtxt` → `max_batch_size`
- `$TRITON_REPO/gdino_preprocess/config.pbtxt` → `max_batch_size`

### Extra setup

Run **after** updating configs:

```bash
./scripts/setup_gdino.sh --batch <N>
```

This auto-detects the GDINO ONNX under `$RESOURCES`, copies it into `$TRITON_REPO/gdino_trt/1/model.onnx`, and builds the TensorRT engine (`model.plan`) via `trtexec` with the correct dynamic shapes for batch `<N>`.

### Run command

```bash
cd $DS_APP_DIR
./metropolis_perception_app -c reference-configs/smartcities/gdino/run_config-api-rtdetr-protobuf.txt
```
