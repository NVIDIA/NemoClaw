
# NV Engine Build -- Steps 4-5

Build a TensorRT engine from ONNX and derive PEAK_GPU_STREAMS for DeepStream sizing.

The ONNX model path is: `$ARGUMENTS`

## Pre-flight: Validate Inputs and Extract Variables

Before anything else, derive all variables from `$ARGUMENTS` and verify the environment:
```bash
ONNX_PATH="$ARGUMENTS"

# Derive MODEL_NAME from directory structure: models/{MODEL_NAME}/model/...
MODEL_NAME=$(echo "$ONNX_PATH" | sed 's|models/\([^/]*\)/.*|\1|')

# Derive MODEL_FILENAME as the ONNX basename without extension
MODEL_FILENAME=$(basename "$ONNX_PATH" .onnx)

# MAX_BS drives --optShapes, --maxShapes, and the engine filename postfix
# Starting value is 64 — will double iteratively in Step 5 if PEAK_GPU_STREAMS > 64
MAX_BS=64

echo "Model:    $MODEL_NAME"
echo "File:     $MODEL_FILENAME"
echo "ONNX:     $ONNX_PATH"
echo "Engine:   models/$MODEL_NAME/benchmarks/engines/${MODEL_FILENAME}_dynamic_b${MAX_BS}.engine"

# Verify ONNX file exists
ls -lh "$ONNX_PATH" || { echo "ERROR: ONNX file not found at $ONNX_PATH"; exit 1; }

# Verify trtexec is available and check TRT version
TRTEXEC=$(which trtexec) || { echo "ERROR: trtexec not found in PATH — install TensorRT or check PATH"; exit 1; }
$TRTEXEC --help 2>&1 | head -3
dpkg -l | grep libnvinfer-bin

# Verify GPU is available
nvidia-smi --query-gpu=name,memory.total --format=csv,noheader
```

If the ONNX file doesn't exist, inform the user to run Steps 1-3 first (see references/model-acquire.md).

> All subsequent commands use `$MODEL_NAME`, `$MODEL_FILENAME`, `$MAX_BS`, and `$TRTEXEC` — never hardcoded paths or template placeholders.

Inspect the ONNX model and auto-parse input name and spatial dimensions:
```bash
INSPECT_OUT=$(python3 skills/deepstream-import-vision-model/scripts/model/inspect-onnx.py "$ONNX_PATH")
echo "$INSPECT_OUT"

INPUT_NAME=$(echo "$INSPECT_OUT" | grep -oP 'input_name:\s*\K\S+')
H=$(echo "$INSPECT_OUT"          | grep -oP 'height:\s*\K[0-9]+')
W=$(echo "$INSPECT_OUT"          | grep -oP 'width:\s*\K[0-9]+')

echo "INPUT_NAME=$INPUT_NAME  H=$H  W=$W"
[ -z "$INPUT_NAME" ] && { echo "ERROR: could not parse INPUT_NAME from inspect output"; exit 1; }
# If H/W are empty (dynamic spatial dims), set them manually before proceeding:
#   H=640; W=640   # or whatever the model's expected input resolution is
#   Check the model card on HuggingFace or config.json image_size field
[ -z "$H" ] && { echo "ERROR: H not detected — model has dynamic spatial dims. Set H manually: H=<height>"; exit 1; }
[ -z "$W" ] && { echo "ERROR: W not detected — model has dynamic spatial dims. Set W manually: W=<width>";  exit 1; }
```

## Step 4: Build TensorRT Engine

Build one dynamic engine optimized for BS=64. `opt=max=64` ensures TRT optimizes kernels for
the exact batch size used for benchmarking and DeepStream. `min=1` handles single-stream validation.

```bash
STEP4_START=$(date +%s.%N)
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
# benchmarks/engines/ already exists from nv-model-acquire;
# mkdir -p kept here as a safety net for standalone use
mkdir -p models/$MODEL_NAME/benchmarks/engines models/$MODEL_NAME/benchmarks/b1 models/$MODEL_NAME/benchmarks/b${MAX_BS}

$TRTEXEC \
  --onnx="$ONNX_PATH" \
  --minShapes=$INPUT_NAME:1x3x${H}x${W} \
  --optShapes=$INPUT_NAME:${MAX_BS}x3x${H}x${W} \
  --maxShapes=$INPUT_NAME:${MAX_BS}x3x${H}x${W} \
  --fp16 \
  --skipInference \
  --memPoolSize=workspace:32768M \
  --timingCacheFile=models/$MODEL_NAME/benchmarks/engines/timing.cache \
  --saveEngine="models/$MODEL_NAME/benchmarks/engines/${MODEL_FILENAME}_dynamic_b${MAX_BS}.engine" \
  2>&1 | tee models/$MODEL_NAME/benchmarks/engines/${MODEL_FILENAME}_dynamic_build_${TIMESTAMP}.log

# Verify engine was created — trtexec exit code is lost through the pipe, so check the file
[ -f "models/$MODEL_NAME/benchmarks/engines/${MODEL_FILENAME}_dynamic_b${MAX_BS}.engine" ] || \
  { echo "ERROR: Engine file not created — check build log for errors"; exit 1; }

STEP4_END=$(date +%s.%N)
STEP4_DURATION=$(echo "$STEP4_END - $STEP4_START" | bc)
echo "[Step 4] Engine build completed in ${STEP4_DURATION}s"
```

Set the ENGINE variable — used by all subsequent trtexec and DeepStream runs:
```bash
ENGINE="models/$MODEL_NAME/benchmarks/engines/${MODEL_FILENAME}_dynamic_b${MAX_BS}.engine"
```

## Step 5: Benchmark — 2 Runs Only

Run exactly **2 trtexec benchmarks** using the Step 4 engine. No sweep needed.
- BS=1 → latency baseline (single-stream worst case)
- BS=64 → peak throughput → `PEAK_GPU_STREAMS`

```bash
STEP5_START=$(date +%s.%N)
```

### Run 5a — Latency baseline (BS=1)

> Log filename is **fixed** — no timestamp, no variation. Always `trtexec_b1.log`. This ensures the nv-import-vision-model-report skill can find it with an exact path, not a wildcard.

```bash
$TRTEXEC \
  --loadEngine="$ENGINE" \
  --shapes=$INPUT_NAME:1x3x${H}x${W} \
  --noDataTransfers --duration=10 --warmUp=1000 \
  2>&1 | tee models/$MODEL_NAME/benchmarks/b1/trtexec_b1.log
```

### Run 5b — Peak throughput (BS=MAX_BS)

> Log filename is **fixed** — always `trtexec_b${MAX_BS}.log`. Updated by the while loop if MAX_BS changes.

```bash
$TRTEXEC \
  --loadEngine="$ENGINE" \
  --shapes=$INPUT_NAME:${MAX_BS}x3x${H}x${W} \
  --noDataTransfers --duration=10 --warmUp=1000 \
  2>&1 | tee models/$MODEL_NAME/benchmarks/b${MAX_BS}/trtexec_b${MAX_BS}.log
```

### Parse results and compute PEAK_GPU_STREAMS
```bash
QPS_BS1=$(grep -oP 'Throughput:\s*\K[0-9.]+' \
  models/$MODEL_NAME/benchmarks/b1/trtexec_b1.log | tail -1)
GPU_MEAN_BS1=$(grep -oP 'GPU Compute Time:.*mean = \K[0-9.]+' \
  models/$MODEL_NAME/benchmarks/b1/trtexec_b1.log | tail -1)

QPS_BS_MAX=$(grep -oP 'Throughput:\s*\K[0-9.]+' \
  models/$MODEL_NAME/benchmarks/b${MAX_BS}/trtexec_b${MAX_BS}.log | tail -1)
GPU_MEAN_BS_MAX=$(grep -oP 'GPU Compute Time:.*mean = \K[0-9.]+' \
  models/$MODEL_NAME/benchmarks/b${MAX_BS}/trtexec_b${MAX_BS}.log | tail -1)
GPU_P99_BS_MAX=$(grep -oP 'GPU Compute Time:.*percentile\(99%\) = \K[0-9.]+' \
  models/$MODEL_NAME/benchmarks/b${MAX_BS}/trtexec_b${MAX_BS}.log | tail -1)

read IMGS_PER_SEC PEAK_GPU_STREAMS < <(python3 -c "
import math
imgs = float('$QPS_BS_MAX') * $MAX_BS
streams = int(math.floor(imgs / 30))
print(round(imgs, 2), streams)
")

echo "BS=1:       QPS=$QPS_BS1  GPU mean=${GPU_MEAN_BS1}ms"
echo "BS=$MAX_BS: QPS=$QPS_BS_MAX  imgs/s=$IMGS_PER_SEC  GPU mean=${GPU_MEAN_BS_MAX}ms  P99=${GPU_P99_BS_MAX}ms"
echo "PEAK_GPU_STREAMS=$PEAK_GPU_STREAMS  (floor($IMGS_PER_SEC / 30))"

STEP5_END=$(date +%s.%N)
STEP5_DURATION=$(echo "$STEP5_END - $STEP5_START" | bc)
echo "[Step 5] Benchmarks completed in ${STEP5_DURATION}s"
```

`PEAK_GPU_STREAMS` is the GPU-only upper bound on real-time 30fps stream count. DeepStream will always achieve fewer streams due to NVDEC, mux, and GStreamer overhead (typically 10–40%). Use `PEAK_GPU_STREAMS` as the starting stream count for DS Run 1 (calibration).

### Iterative Engine Scaling (PEAK_GPU_STREAMS > MAX_BS)

If `PEAK_GPU_STREAMS > MAX_BS`, the engine's max batch size is the bottleneck — DeepStream cannot run more streams than `MAX_BS`. **Double MAX_BS and rebuild**, then re-run trtexec and recompute `PEAK_GPU_STREAMS`. Repeat until `PEAK_GPU_STREAMS ≤ MAX_BS`.

**Why doubling, not jumping to PEAK directly**: Jumping from 64→512 based on an extrapolated projection wastes GPU memory if the projection was off. Doubling (64→128→256→512) makes incremental, verifiable steps — each trtexec run gives real throughput data before committing to a larger rebuild.

```bash
while [ "$PEAK_GPU_STREAMS" -gt "$MAX_BS" ]; do
  NEW_MAX_BS=$(python3 -c "print($MAX_BS * 2)")  # STRICT DOUBLING — do not change to ceil(log2(PEAK))
  echo "Rebuilding engine: PEAK_GPU_STREAMS=$PEAK_GPU_STREAMS > MAX_BS=$MAX_BS — doubling to: $NEW_MAX_BS"

  mkdir -p models/$MODEL_NAME/benchmarks/b${NEW_MAX_BS}

  $TRTEXEC \
    --onnx="$ONNX_PATH" \
    --minShapes=$INPUT_NAME:1x3x${H}x${W} \
    --optShapes=$INPUT_NAME:${NEW_MAX_BS}x3x${H}x${W} \
    --maxShapes=$INPUT_NAME:${NEW_MAX_BS}x3x${H}x${W} \
    --fp16 --skipInference \
    --memPoolSize=workspace:32768M \
    --timingCacheFile=models/$MODEL_NAME/benchmarks/engines/timing.cache \
    --saveEngine="models/$MODEL_NAME/benchmarks/engines/${MODEL_FILENAME}_dynamic_b${NEW_MAX_BS}.engine" \
    2>&1 | tee models/$MODEL_NAME/benchmarks/engines/${MODEL_FILENAME}_dynamic_build_b${NEW_MAX_BS}_${TIMESTAMP}.log

  [ -f "models/$MODEL_NAME/benchmarks/engines/${MODEL_FILENAME}_dynamic_b${NEW_MAX_BS}.engine" ] || \
    { echo "ERROR: Engine b${NEW_MAX_BS} not created — check build log"; exit 1; }

  # Update ENGINE and MAX_BS — re-run trtexec at new BS and recompute PEAK_GPU_STREAMS
  ENGINE="models/$MODEL_NAME/benchmarks/engines/${MODEL_FILENAME}_dynamic_b${NEW_MAX_BS}.engine"
  MAX_BS=$NEW_MAX_BS

  $TRTEXEC \
    --loadEngine="$ENGINE" \
    --shapes=$INPUT_NAME:${MAX_BS}x3x${H}x${W} \
    --noDataTransfers --duration=10 --warmUp=1000 \
    2>&1 | tee models/$MODEL_NAME/benchmarks/b${MAX_BS}/trtexec_b${MAX_BS}.log

  QPS_BS_MAX=$(grep -oP 'Throughput:\s*\K[0-9.]+' \
    models/$MODEL_NAME/benchmarks/b${MAX_BS}/trtexec_b${MAX_BS}.log | tail -1)
  GPU_MEAN_BS_MAX=$(grep -oP 'GPU Compute Time:.*mean = \K[0-9.]+' \
    models/$MODEL_NAME/benchmarks/b${MAX_BS}/trtexec_b${MAX_BS}.log | tail -1)
  GPU_P99_BS_MAX=$(grep -oP 'GPU Compute Time:.*percentile\(99%\) = \K[0-9.]+' \
    models/$MODEL_NAME/benchmarks/b${MAX_BS}/trtexec_b${MAX_BS}.log | tail -1)
  read IMGS_PER_SEC PEAK_GPU_STREAMS < <(python3 -c "
import math
imgs = float('$QPS_BS_MAX') * $MAX_BS
print(round(imgs, 2), int(math.floor(imgs / 30)))
")
  echo "Recomputed: BS=$MAX_BS  imgs/s=$IMGS_PER_SEC  PEAK_GPU_STREAMS=$PEAK_GPU_STREAMS"
done

echo "PEAK_GPU_STREAMS ($PEAK_GPU_STREAMS) <= MAX_BS ($MAX_BS) — engine scaling complete."
```

**Engine count summary:**

| Scenario | Example | Engines | trtexec runs |
|----------|---------|---------|-------------|
| PEAK_GPU_STREAMS ≤ 64 (transformer/large models) | RT-DETR, OWL-ViT | **1** (`b64`) | **2** |
| PEAK_GPU_STREAMS > 64, ≤ 128 (mid models) | TrafficCamNet | **2** (`b64` + `b128`) | **3** |
| PEAK_GPU_STREAMS > 128, ≤ 256 (fast models) | YOLO26n | **3** (`b64`+`b128`+`b256`) | **4** |
| PEAK_GPU_STREAMS > 256 (very fast nano models) | — | **4+** (keep doubling) | **5+** |

## trtexec Flags Reference

### Recommended Flags
| Flag | Purpose | When to use |
|------|---------|-------------|
| `--duration=10` | Longer run for stable numbers | All benchmark runs (5a, 5b) |
| `--warmUp=1000` | 1s warmup before measurement | All benchmark runs (5a, 5b) |
| `--noDataTransfers` | GPU-only compute (matches DS reality) | Always |

### Why GPU-only (`--noDataTransfers`) Only
In DeepStream, frames are decoded on GPU (`nvv4l2decoder`) and stay on GPU through `nvinfer` — no H2D transfer. Standard trtexec transfers synthetic data from host, which is not representative. Do NOT report H2D/D2H latency.

### Flags That Do NOT Help (tested)
| Flag | Result | Why |
|------|--------|-----|
| `--best` | No improvement | Engine already built with --fp16, runtime flag doesn't change precision |
| `--exposeDMA` | **45% WORSE** throughput | Serializes DMA transfers — kills pipelining |
| `--infStreams=4` | +2% QPS max | GPU already saturated |

### Key Metrics to Report from trtexec
- **Throughput (QPS)** and **Images/s** (QPS × batch_size)
- **GPU Compute mean (ms)** and **GPU Compute P99 (ms)**
- **GPU Compute per image (ms)** (GPU Compute mean / batch_size)
- Do **NOT** report: H2D latency, D2H latency, Host Latency, transfer overhead

## Engine Version Compatibility -- CRITICAL

TensorRT engine files are **not portable** across TensorRT versions.

### Pre-flight Version Check (MANDATORY before building engines)
Already done at the top of this skill via `$TRTEXEC --help` and `dpkg -l | grep libnvinfer-bin`. Do not repeat.

### Docker vs Host Engine Builds
Docker-built engines may silently fail at runtime when loaded by host DeepStream (symptom: 0% GPU, pipeline stuck). **Always build engines on the host** using the same `libnvinfer` version as DeepStream (`dpkg -l | grep libnvinfer-bin`). Never mix TRT versions between engine builder and runtime.

## Known Issues and Workarounds

### `--memPoolSize` Flag Format — `M` vs `MiB` (CRITICAL silent failure)

- **Correct**: `--memPoolSize=workspace:32768M` (suffix `M` = Mebibytes)
- **WRONG**: `--memPoolSize=workspace:32768MiB` — trtexec interprets `MiB` as bytes, so `32768MiB` becomes 32 KB. All tactics fail with "insufficient workspace". There is no parse warning; the only symptom is `Memory Pools: workspace: 0.03125 MiB` in the build log.
- Valid suffixes: `B`, `K`, `M`, `G`, or no suffix (default MiB).

### Deformable Attention Models (RT-DETR, DDETR, Deformable DETR)

Models using `MultiscaleDeformableAttnPlugin_TRT` build correctly on TRT 10.16 **provided workspace is sufficient**.
- **Required**: `--memPoolSize=workspace:32768M` (not the default 8GB) — deformable attention at BS=64 needs substantial workspace for ForeignNode fusion tactics.
- `--builderOptimizationLevel=4` (default) works; do not lower it unless necessary.
- Typical footprint at BS=64 on H100: activation ~4266 MiB, peak memory ~7809 MiB, build time ~825s. The compiler backend phase after engine generation can take 5-10 minutes with no log output — this is normal, not a hang.
- Error "Could not find any implementation for node {ForeignNode[...]} due to insufficient workspace" is a genuine signal to raise the workspace.

### DETR / DETR-family Backbone Mask ForeignNode Failure (TRT 10.16)

HF-exported DETR/DDETR models contain a dynamic backbone mask path (`Cast → Resize → Sigmoid`) that TRT 10.16 fuses into a ForeignNode with no valid tactic: `"Could not find any implementation for node {ForeignNode[.../Cast_2.../Sigmoid]}"`.

- **Preferred fix** (TRT 10.16.01+, PyTorch 2.11+, transformers 5.5+): use the dynamo export path with `torch.export.Dim("batch", min=1, max=N)` in `dynamic_shapes`. The dynamo exporter produces a different graph that does NOT trigger the ForeignNode failure. TRT converts it directly as a dynamic-batch engine.
- **Fallback for older toolchains**: run `onnxsim.simplify(model, input_shapes={'pixel_values': [BS, 3, H, W]})` first. This folds the mask into constants but bakes batch size, requiring per-batch ONNX + engine files.
- **Secondary workaround**: lower `builder_optimization_level` to 2 via the Python TRT API (`config.builder_optimization_level = 2`). Prevents over-aggressive fusion; engines built this way are still compatible with `trtexec --loadEngine`.

### Dynamic Engine Batch-Size Anomalies (transformer models)

Dynamic-shape engines for transformer models (DETR, RT-DETR) can show **non-monotonic throughput** — specific non-power-of-2 batch sizes (e.g., BS=17-19) perform dramatically worse than neighboring values. Cause: TRT tactic selection for attention layers at non-optimal shapes. When DS at `N` streams shows surprisingly low FPS, test `N±8` before concluding the GPU is saturated. Prefer power-of-2 batch sizes for production.

## Output Summary

```bash
TOTAL_DURATION=$(echo "$STEP4_DURATION + $STEP5_DURATION" | bc)
```

When complete, print:
```
=== TRT Engine Build Complete ===
Model:   $MODEL_NAME
Engine:  models/$MODEL_NAME/benchmarks/engines/${MODEL_FILENAME}_dynamic_b${MAX_BS}.engine
         (single engine — used for trtexec baseline and all DS runs)

trtexec Results:
  BS=1:       $QPS_BS1 QPS  |  GPU mean: ${GPU_MEAN_BS1}ms
  BS=$MAX_BS: $QPS_BS_MAX QPS  |  $IMGS_PER_SEC img/s  |  GPU mean: ${GPU_MEAN_BS_MAX}ms  P99: ${GPU_P99_BS_MAX}ms

PEAK_GPU_STREAMS (GPU-only upper bound): $PEAK_GPU_STREAMS streams @30fps

Timing:
  Step 4 (engine build): ${STEP4_DURATION}s
  Step 5 (benchmarks):   ${STEP5_DURATION}s
  Total Steps 4-5:       ${TOTAL_DURATION}s

Ready for: Steps 6-7 — read references/pipeline-run.md models/$MODEL_NAME/
```
