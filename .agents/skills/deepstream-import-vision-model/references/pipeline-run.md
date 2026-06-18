
# DS Run Pipeline -- Steps 6-7

Integrate a TensorRT model into DeepStream with parser, validation, and multi-stream benchmarks.

The model directory is: `$ARGUMENTS`

## Pre-flight: Extract Variables

```bash
[ -z "$ARGUMENTS" ] && { echo "ERROR: No model directory provided. Usage: /deepstream-import-vision-model models/<model_name>/"; exit 1; }
MODEL_DIR="${ARGUMENTS%/}"
MODEL_NAME=$(basename "$MODEL_DIR")

# Find ONNX file (exclude _dynamic variants created during export)
ONNX_FILE=$(ls models/$MODEL_NAME/model/*.onnx 2>/dev/null | grep -v '_dynamic' | head -1)
[ -z "$ONNX_FILE" ] && { echo "ERROR: No ONNX file found in models/$MODEL_NAME/model/ — run Steps 1-3 first (references/model-acquire.md)"; exit 1; }
MODEL_FILENAME=$(basename "$ONNX_FILE" .onnx)

# Find TRT engine from nv-engine-build
ENGINE=$(ls models/$MODEL_NAME/benchmarks/engines/*_dynamic_b*.engine 2>/dev/null | head -1)
[ -z "$ENGINE" ] && { echo "ERROR: No engine found in models/$MODEL_NAME/benchmarks/engines/ — run Steps 4-5 first (references/engine-build.md)"; exit 1; }
MAX_BS=$(echo "$ENGINE" | grep -oP '_b\K[0-9]+(?=\.engine)')

# Read PEAK_GPU_STREAMS from trtexec Step 5b log — fixed filename, no timestamp, no wildcard
TRTEXEC_LOG="models/$MODEL_NAME/benchmarks/b${MAX_BS}/trtexec_b${MAX_BS}.log"
[ -f "$TRTEXEC_LOG" ] || { echo "ERROR: trtexec log not found at $TRTEXEC_LOG — run Steps 4-5 first (references/engine-build.md)"; exit 1; }
QPS_BS_MAX=$(grep -oP 'Throughput:\s*\K[0-9.]+' "$TRTEXEC_LOG" | tail -1)
read IMGS_PER_SEC PEAK_GPU_STREAMS < <(python3 -c "
import math
imgs = float('$QPS_BS_MAX') * $MAX_BS
print(round(imgs, 2), int(math.floor(imgs / 30)))
")

# Read spatial dimensions from ONNX inspection
INSPECT_OUT=$(python3 skills/deepstream-import-vision-model/scripts/model/inspect-onnx.py "$ONNX_FILE")
INPUT_NAME=$(echo "$INSPECT_OUT" | grep -oP 'input_name:\s*\K\S+')
H=$(echo "$INSPECT_OUT"          | grep -oP 'height:\s*\K[0-9]+')
W=$(echo "$INSPECT_OUT"          | grep -oP 'width:\s*\K[0-9]+')
[ -z "$INPUT_NAME" ] && { echo "ERROR: could not parse INPUT_NAME from inspect output"; exit 1; }
[ -z "$H" ]          && { echo "ERROR: could not parse H — dynamic spatial dims? Set H manually"; exit 1; }
[ -z "$W" ]          && { echo "ERROR: could not parse W — dynamic spatial dims? Set W manually"; exit 1; }

# Detect installed CUDA version for parser compilation
CUDA_VER=$(ls /usr/local/ 2>/dev/null | grep -oP '^cuda-\K[0-9]+\.[0-9]+$' | sort -V | tail -1)
[ -z "$CUDA_VER" ] && CUDA_VER=12.8
echo "CUDA_VER=$CUDA_VER"

# Count labels
[ -f "models/$MODEL_NAME/config/labels.txt" ] || { echo "ERROR: labels.txt not found — run Steps 1-3 first (references/model-acquire.md)"; exit 1; }
NUM_LABELS=$(wc -l < models/$MODEL_NAME/config/labels.txt)

# Parser function suffix: PascalCase of MODEL_NAME, sanitized for C++ identifiers
# e.g. yolov8n→Yolov8n  rtdetr-l→RtdetrL  grounding-dino-base→GroundingDinoBase
PARSER_FUNC_SUFFIX=$(python3 -c "
import re
parts = re.sub(r'[^a-zA-Z0-9]', ' ', '$MODEL_NAME').split()
print(''.join(p.capitalize() for p in parts))
")
# Sanitize MODEL_NAME for use in C++ source/library filenames — mirrors PARSER_FUNC_SUFFIX logic.
# e.g. rtdetr-l → rtdetr_l  grounding-dino-base → grounding_dino_base
MODEL_NAME_SAFE=$(echo "$MODEL_NAME" | tr -c 'A-Za-z0-9' '_')

# Video source — default is sample_720p.mp4 (MANDATORY). Never autonomously substitute
# sample_1080p_h264.mp4 or any other file. DS_VIDEO may only be set when the user explicitly
# provides a custom video path; it is not a licence to pick a different resolution.
VIDEO="${DS_VIDEO:-/opt/nvidia/deepstream/deepstream/samples/streams/sample_720p.mp4}"
[ -f "$VIDEO" ] || {
  echo "ERROR: Video file not found: $VIDEO"
  echo "  Fix 1: Set DS_VIDEO=/path/to/sample_720p.mp4 before running"
  echo "  Fix 2: Install DeepStream samples (replace 9.0 with your installed minor version): apt-get install deepstream-9.0-samples"
  exit 1
}

echo "Model:            $MODEL_NAME"
echo "ONNX:             $ONNX_FILE  (input=$INPUT_NAME, ${H}x${W})"
echo "Engine:           $ENGINE  (MAX_BS=$MAX_BS)"
echo "PEAK_GPU_STREAMS: $PEAK_GPU_STREAMS  (floor($IMGS_PER_SEC img/s / 30))"
echo "Labels:           $NUM_LABELS classes"
```

> All subsequent commands use these variables — never hardcoded paths or template placeholders.

## Step 6: DeepStream Integration

```bash
STEP6_START=$(date +%s.%N)
```

### 6a: Inspect Model Output Format

Verify output tensor shapes and value ranges before writing the parser:
```bash
python3 -c "
import onnxruntime as ort, numpy as np
sess = ort.InferenceSession('$ONNX_FILE')
inp = sess.get_inputs()[0]
out = sess.get_outputs()
print(f'Input: {inp.name} shape={inp.shape}')
for o in out: print(f'Output: {o.name} shape={o.shape}')
dummy = np.random.randn(*[d if isinstance(d,int) else 1 for d in inp.shape]).astype(np.float32)
result = sess.run(None, {inp.name: dummy})
for i,r in enumerate(result): print(f'Output[{i}] range: [{r.min():.4f}, {r.max():.4f}]')
"
```

**CRITICAL**: Determine the correct `net-scale-factor` from the output ranges and model family:

| Model expects | net-scale-factor | Notes |
|---------------|-----------------|-------|
| 0–255 input (OpenCV Zoo) | `1.0` | No normalization |
| 0–1 normalized | `0.00392156862745098` (1/255) | Standard |
| ImageNet normalized | `0.01752` + offsets | Rare in DS |

Wrong scale factor = zero detections. Always verify with KITTI dump (Step 6g) before benchmarks.

### 6b: Write Custom Bounding Box Parser

Create `models/$MODEL_NAME/parser/nvdsinfer_custombboxparser_${MODEL_NAME_SAFE}.cpp`:
```cpp
extern "C"
bool NvDsInferParseCustom${PARSER_FUNC_SUFFIX}(
    std::vector<NvDsInferLayerInfo> const &outputLayersInfo,
    NvDsInferNetworkInfo const &networkInfo,
    NvDsInferParseDetectionParams const &detectionParams,
    std::vector<NvDsInferObjectDetectionInfo> &objectList);

CHECK_CUSTOM_PARSE_FUNC_PROTOTYPE(NvDsInferParseCustom${PARSER_FUNC_SUFFIX});
```

Parser implementation rules:
- Include `nvdsinfer_custom_impl.h` and use `NvDsInferObjectDetectionInfo` (classId, left, top, width, height, detectionConfidence)
- Decode model-specific output format into pixel-space bounding boxes:
  - YOLOX-style `[N, num_anchors, 5+C]`: decode grid offsets, exp(w/h), objectness×class_score
  - SSD-style `[N, num_dets, 6]`: extract class, confidence, normalized → pixel coords
  - YOLO with BatchedNMS: parse keepCount, bboxes, scores, classes from 4 output layers
- **Clip all coordinates** to `[0, networkInfo.width-1]` and `[0, networkInfo.height-1]`
- Use `detectionParams.perClassPreclusterThreshold` for confidence filtering
- **NMS**: Dense heads → `cluster-mode=2` (DeepStream NMS). Fused TRT NMS → `cluster-mode=4`
- **Sanity check for undecoded output**: if bbox values land in [0, 3], the parser is reading grid-space offsets. Most models need `(raw + grid_offset) * stride` for cx/cy and `exp(raw) * stride` for w/h. Verify raw output ranges with Python/ONNX Runtime before writing the parser.
- Reference: `/opt/nvidia/deepstream/deepstream/sources/libs/nvdsinfer_customparser/nvdsinfer_custombboxparser.cpp`; Header: `sources/includes/nvdsinfer_custom_impl.h`

#### Model-family parser patterns

- **DETR / Conditional DETR**: outputs `logits [B, num_queries, num_classes+1]` and `pred_boxes [B, num_queries, 4]`. Boxes are `(cx, cy, w, h)` normalized to `[0,1]` — convert to `(left, top, width, height)` in pixels. Use **softmax** (not sigmoid) on logits. **Background class is the LAST index** (e.g., index 91 for a 92-class DETR, despite `config.json` showing `"0": "N/A"`). Skip the background class when iterating. DETR uses Hungarian matching — NMS is not needed; set `cluster-mode=4` (not `nms-iou-threshold=0.0`, which is a legacy key).
- **OWL-ViT / CLIP-based zero-shot detectors**: outputs `logits [B, num_patches, num_classes]` and `pred_boxes [B, num_patches, 4]`. **Sigmoid** activation (per-class independent scoring, not softmax). Boxes are `(cx, cy, w, h)` normalized `[0,1]`. Use `cluster-mode=2` (NMS with IoU threshold). CLIP preprocessing: `net-scale-factor=0.01459`, `offsets=122.77;116.75;104.09`. Confidence threshold 0.10 works well for general detection; lower to 0.05 for recall-focused tasks.
- **HF RT-DETR preprocessing quirk**: `RTDetrImageProcessor` may have `do_normalize=false` even though `image_mean`/`image_std` fields exist. When `do_normalize=false`, the model expects `[0,1]` scaled input — set `net-scale-factor=1/255` with no offsets. The ONNX export does NOT bake normalization into the first Conv layer. Verify with ONNX Runtime on a real frame before debugging nvinfer.

#### NGC TAO models — use the built-in parser library

NVIDIA NGC TAO models (trafficcamnet, peoplenet, TrafficCamNet Transformer Lite, etc.) ship with TAO-specific parsers pre-compiled into a system library:
- **Library path**: `/opt/nvidia/deepstream/deepstream/lib/libnvds_infercustomparser.so` — NOT `libnvds_infercustomparser_tao.so` (even if the NGC YAML config suggests it).
- Custom parse function names: `NvDsInferParseCustomDDETRTAO`, `NvDsInferParseCustomRTDETRTAO`, etc.
- **No custom parser compilation needed** — point `custom-lib-path` at the system library and `parse-bbox-func-name` at the TAO function.
- KITTI dump from `deepstream-app` may emit zero-valued bbox coordinates for DETR/RT-DETR parsers even when detections are correct. Verify visually with JPEG frame extraction instead.

### `network-type` vs `model-type` — use `network-type=0`

- `model-type` is a legacy/unknown key — nvinfer ignores it with a warning.
- `network-type=0` (Detector) is required to invoke `parse-bbox-func-name`.
- `network-type=100` (Other) does NOT invoke the custom bbox parser — it requires `output-tensor-meta=1` for external post-processing.
- **Symptom of the wrong key**: custom parse function is never called (zero detections, no parser debug output) — check that `network-type=0` is set.

### 6c: Create Makefile

Write `models/$MODEL_NAME/parser/Makefile` using Python to guarantee literal TAB characters in recipe lines (heredoc in bash can produce spaces, which break make):
```bash
python3 - << EOF
model = '$MODEL_NAME'
model_safe = '$MODEL_NAME_SAFE'
content = (
    "DEEPSTREAM_DIR ?= /opt/nvidia/deepstream/deepstream\n"
    "CUDA_VER ?= 12.8\n"
    "CC := g++\n"
    "CFLAGS := -Wall -std=c++11 -shared -fPIC\n"
    "CFLAGS += -I\$(DEEPSTREAM_DIR)/sources/includes -I/usr/local/cuda-\$(CUDA_VER)/include\n"
    "LIBS := -lnvinfer\n"
    "LFLAGS := -Wl,--start-group \$(LIBS) -Wl,--end-group\n"
    f"SRCFILES := nvdsinfer_custombboxparser_{model_safe}.cpp\n"
    f"TARGET_LIB := libnvdsinfer_{model_safe}_parser.so\n"
    "\n"
    "all: \$(TARGET_LIB)\n"
    "\$(TARGET_LIB): \$(SRCFILES)\n"
    "\t\$(CC) -o \$@ \$^ \$(CFLAGS) \$(LFLAGS)\n"   # TAB required by make
    "clean:\n"
    "\trm -rf \$(TARGET_LIB)\n"                       # TAB required by make
)
with open(f'models/{model}/parser/Makefile', 'w') as f:
    f.write(content)
print(f"Makefile written: models/{model}/parser/Makefile")
EOF
```

### 6d: Build Parser Library

```bash
make -C models/$MODEL_NAME/parser \
  DEEPSTREAM_DIR=/opt/nvidia/deepstream/deepstream \
  CUDA_VER=$CUDA_VER

# Verify the symbol is exported
nm -D models/$MODEL_NAME/parser/libnvdsinfer_${MODEL_NAME_SAFE}_parser.so | grep NvDsInferParseCustom
```

### 6e: Create nvinfer Config File

```bash
cat > models/$MODEL_NAME/config/config_infer_primary_${MODEL_NAME}.txt << EOF
[property]
gpu-id=0
net-scale-factor=0.00392156862745098
model-color-format=0
onnx-file=../model/${MODEL_FILENAME}.onnx
model-engine-file=../benchmarks/engines/${MODEL_FILENAME}_dynamic_b${MAX_BS}.engine
labelfile-path=labels.txt
batch-size=1
network-mode=2
num-detected-classes=${NUM_LABELS}
process-mode=1
interval=0
gie-unique-id=1
network-type=0
custom-lib-path=../parser/libnvdsinfer_${MODEL_NAME_SAFE}_parser.so
parse-bbox-func-name=NvDsInferParseCustom${PARSER_FUNC_SUFFIX}
# 2=DeepStream NMS (dense heads: YOLO, SSD). Use 4 if engine has fused NMS output
cluster-mode=2
infer-dims=3;${H};${W}
maintain-aspect-ratio=1

[class-attrs-all]
topk=200
nms-iou-threshold=0.45
pre-cluster-threshold=0.25
EOF
```

> **Path note**: All paths are relative to the `config/` directory where this file lives.
> `net-scale-factor` defaults to `1/255` — update to `1.0` if the model expects 0–255 input (verify via Step 6a).

Verify label count matches:
```bash
echo "labels.txt: $NUM_LABELS classes -> num-detected-classes=$NUM_LABELS"
```

### 6f: Single-Stream Visual Validation

> **ENCODER RULE:**
> Primary encoder is `nvv4l2h264enc` (NVENC via V4L2) → `.mp4`. `x264enc` and `openh264enc` are **prohibited**.
> On systems where `/dev/v4l2-nvenc` is unavailable, the approved fallback is `theoraenc + oggmux`
> (LGPL; both ship in gst-plugins-base) → `.ogv`. If `theoraenc`/`oggmux` are absent, video creation is skipped.
> Use `skills/deepstream-import-vision-model/scripts/deepstream/ds-single-stream.sh` which handles this automatically
> and emits a `DS_SINGLE_STREAM_MODE=` marker the report parser reads.

**Primary (NVENC available):**

```bash
mkdir -p models/$MODEL_NAME/samples

GST_DEBUG=1 gst-launch-1.0 \
  filesrc location=$VIDEO ! \
  qtdemux ! queue leaky=downstream ! h264parse ! queue ! nvv4l2decoder ! queue ! \
  m.sink_0 nvstreammux name=m batch-size=1 width=1280 height=720 ! queue ! \
  nvinfer config-file-path=models/$MODEL_NAME/config/config_infer_primary_${MODEL_NAME}.txt ! queue ! \
  nvvideoconvert ! 'video/x-raw(memory:NVMM),format=RGBA' ! \
  nvdsosd ! nvvideoconvert ! 'video/x-raw(memory:NVMM),format=NV12' ! \
  nvv4l2h264enc ! h264parse ! mp4mux ! \
  filesink location=models/$MODEL_NAME/samples/${MODEL_NAME}_output.mp4 sync=0
```

**Fallback (NVENC unavailable — `/dev/v4l2-nvenc` missing, `theoraenc`/`oggmux` present):**

Output extension switches from `.mp4` to `.ogv` (Ogg/Theora container). `theoraenc` consumes planar `I420`, not `NV12`.

```bash
GST_DEBUG=1 gst-launch-1.0 \
  filesrc location=$VIDEO ! \
  qtdemux ! queue leaky=downstream ! h264parse ! queue ! nvv4l2decoder ! queue ! \
  m.sink_0 nvstreammux name=m batch-size=1 width=1280 height=720 ! queue ! \
  nvinfer config-file-path=models/$MODEL_NAME/config/config_infer_primary_${MODEL_NAME}.txt ! queue ! \
  nvvideoconvert ! nvdsosd ! nvvideoconvert ! \
  "video/x-raw, format=I420" ! theoraenc quality=48 ! oggmux ! \
  filesink location=models/$MODEL_NAME/samples/${MODEL_NAME}_output.ogv sync=0
```

Extract a frame to visually confirm bounding boxes — auto-detect which output file exists:

```bash
SAMPLE_OUT=$(ls models/$MODEL_NAME/samples/${MODEL_NAME}_output.{mp4,ogv} 2>/dev/null | head -1)

case "$SAMPLE_OUT" in
  *.mp4)
    gst-launch-1.0 \
      filesrc location="$SAMPLE_OUT" ! \
      qtdemux ! h264parse ! nvv4l2decoder ! videoconvert ! "video/x-raw,format=RGB" ! \
      jpegenc quality=95 ! \
      multifilesink location=models/$MODEL_NAME/samples/frame_%04d.jpg max-files=3
    ;;
  *.ogv)
    gst-launch-1.0 \
      filesrc location="$SAMPLE_OUT" ! \
      oggdemux ! theoradec ! videoconvert ! "video/x-raw,format=RGB" ! \
      jpegenc quality=95 ! \
      multifilesink location=models/$MODEL_NAME/samples/frame_%04d.jpg max-files=3
    ;;
esac
```

If **no detections appear**, the most common cause is wrong `net-scale-factor` — update the config and re-run.

### 6g: KITTI Dump — Verify Detections Programmatically

Run a KITTI dump to confirm detections exist before multi-stream benchmarks.

> **Note:** `gie-kitti-output-dir` is a `deepstream-app` `[application]`
> property — it is **not** read by `nvinfer` directly. Appending it to the
> nvinfer config and running a `gst-launch-1.0 ... nvinfer ...` pipeline
> silently produces zero KITTI files. Use the `ds-kitti-dump.sh` helper,
> which wraps `deepstream-app` with the correct `[application]` section.

```bash
mkdir -p models/$MODEL_NAME/samples/kitti_output

bash skills/deepstream-import-vision-model/scripts/deepstream/ds-kitti-dump.sh \
  models/$MODEL_NAME/config/config_infer_primary_${MODEL_NAME}.txt \
  models/$MODEL_NAME/samples/kitti_output \
  100 \
  "$VIDEO"

# Summarise detection results
KITTI_FILES=$(ls models/$MODEL_NAME/samples/kitti_output/*.txt 2>/dev/null | wc -l)
echo "KITTI frames written: $KITTI_FILES"
echo "Top detected classes:"
cat models/$MODEL_NAME/samples/kitti_output/*.txt 2>/dev/null \
  | awk '{print $1}' | sort | uniq -c | sort -rn | head -10
```

**Validation gate**: If `KITTI_FILES == 0` or all files are empty, detections are broken. Do NOT proceed to Step 7.

```bash
# MANDATORY hard stop — do not comment out or remove this check
if [ "$KITTI_FILES" -eq 0 ]; then
  echo "ERROR: KITTI validation FAILED — zero detection files written."
  echo "Fix net-scale-factor, parser output format, or config before retrying."
  echo "Do NOT proceed to Step 7 benchmarks with broken detections."
  exit 1
fi
FRAMES_WITH_DETECTIONS=$(grep -rl '.' models/$MODEL_NAME/samples/kitti_output/ 2>/dev/null | wc -l)
DETECTION_RATE=$(python3 -c "print(round($FRAMES_WITH_DETECTIONS/$KITTI_FILES*100,1))")
echo "Detection rate: $FRAMES_WITH_DETECTIONS / $KITTI_FILES frames = ${DETECTION_RATE}%"
if python3 -c "exit(0 if $FRAMES_WITH_DETECTIONS/$KITTI_FILES >= 0.9 else 1)"; then
  echo "KITTI validation PASSED (>= 90% frames with detections)"
else
  echo "ERROR: Detection rate ${DETECTION_RATE}% < 90% threshold. Fix parser before proceeding."
  exit 1
fi
```

```bash
STEP6_END=$(date +%s.%N)
STEP6_DURATION=$(echo "$STEP6_END - $STEP6_START" | bc)
echo "[Step 6] completed in ${STEP6_DURATION}s"
```

### DeepStream Troubleshooting

| Symptom | Fix |
|---------|-----|
| Zero detections | Wrong `net-scale-factor` — check model family table in Step 6a |
| Engine rebuilds every run | `model-engine-file` path wrong — verify relative path from `config/` |
| Parser crash | Output tensor shape mismatch — re-check Step 6a output shapes |
| Wrong bounding box positions | Grid/stride decoding mismatch — verify model architecture docs |
| `"layers num: 0"` | Harmless for dynamic-shape engines — do not debug |
| deepstream-app segfaults | Use `gst-launch-1.0` instead (transformer models) |

## Step 7: Multi-Stream DeepStream Benchmark

### 7b: Create DS Benchmark Config

Create one nvinfer config for all DS benchmark runs. `batch-size` is overridden at runtime via the nvinfer GStreamer element property:

```bash
mkdir -p models/$MODEL_NAME/benchmarks/ds

cat > models/$MODEL_NAME/benchmarks/ds/config_infer_ds_${MODEL_NAME}.txt << EOF
[property]
gpu-id=0
net-scale-factor=0.00392156862745098
model-color-format=0
onnx-file=../../model/${MODEL_FILENAME}.onnx
model-engine-file=../engines/${MODEL_FILENAME}_dynamic_b${MAX_BS}.engine
labelfile-path=../../config/labels.txt
batch-size=${MAX_BS}
network-mode=2
num-detected-classes=${NUM_LABELS}
process-mode=1
interval=0
gie-unique-id=1
network-type=0
custom-lib-path=../../parser/libnvdsinfer_${MODEL_NAME_SAFE}_parser.so
parse-bbox-func-name=NvDsInferParseCustom${PARSER_FUNC_SUFFIX}
# 2=DeepStream NMS (dense heads: YOLO, SSD). Use 4 if engine has fused NMS output
cluster-mode=2
infer-dims=3;${H};${W}
maintain-aspect-ratio=1

[class-attrs-all]
topk=200
nms-iou-threshold=0.45
pre-cluster-threshold=0.25
EOF
```

> **Path note**: Paths are relative to `benchmarks/ds/` where this config lives.

### Queue Placement Rules (MANDATORY)

Every pipeline stage must be separated by `queue` elements. Use `leaky=downstream` after `qtdemux` to drop excess frames under GPU saturation; all other queues use no leaky setting (threading only). Always set `batched-push-timeout=-1` on `nvstreammux`. **Never include** `nvmultistreamtiler`, `nvdsosd`, or extra `nvvideoconvert` in benchmark runs — only use for single-stream visual validation (Step 6f).

### 7c: Two-Run DS Benchmark

Only **2 DS pipeline runs** characterise DS overhead vs trtexec.

Both runs go through `deepstream-app` with `[application] enable-perf-measurement=1` (wrapped by `skills/deepstream-import-vision-model/scripts/deepstream/ds-perf-run.sh`). FPS is parsed from the canonical `**PERF:` lines DeepStream emits at the configured measurement interval. This replaces the older `gst-launch-1.0 ... ! fpsdisplaysink` path so the runtime no longer depends on `gstreamer1.0-plugins-bad`.

> **PERF line format**: `**PERF: <fps_run> (<fps_avg>)` — one float per active source. The helper script averages the per-stream instantaneous FPS across the last few measurement windows; the parser below mirrors that contract.

**DS Run 1 — Calibration at PEAK_GPU_STREAMS streams:**

> **CRITICAL**: Use `$PEAK_GPU_STREAMS` directly. Do NOT pre-apply any efficiency discount (no ×0.6, ×0.7, etc.). Run 1 *measures* the real overhead — do not guess it.

> Log filenames are **fixed** — no timestamp variation. Always `ds_s${N}_run1.log` and `ds_s${N}_run2.log` in `benchmarks/ds/`. The nv-import-vision-model-report skill reads these exact paths.

```bash
# Hard constraint: num_streams <= engine max batch size — always
N=$(python3 -c "print(min($PEAK_GPU_STREAMS, $MAX_BS))")
LOG_RUN1="models/$MODEL_NAME/benchmarks/ds/ds_s${N}_run1.log"

STEP7_RUN1_START=$(date +%s.%N)
bash skills/deepstream-import-vision-model/scripts/deepstream/ds-perf-run.sh \
  models/$MODEL_NAME/benchmarks/ds/config_infer_ds_${MODEL_NAME}.txt \
  "$N" \
  "$LOG_RUN1" \
  "$VIDEO"

FPS_RUN1=$(grep -oP '\*\*PERF:\s*\K[0-9.]+' "$LOG_RUN1" | tail -10 | python3 -c "
import sys; vals=[float(l) for l in sys.stdin if l.strip()]; print(round(sum(vals)/len(vals),2) if vals else 0)")
python3 -c "exit(0 if float('$FPS_RUN1') > 0 else 1)" || \
  { echo "ERROR: FPS parsing failed for Run 1 — check $LOG_RUN1"; exit 1; }

TOTAL_FPS_RUN1=$(python3 -c "print(round(float('$FPS_RUN1') * $N, 2))")
RT_STREAMS=$(python3 -c "import math; print(min(int(math.floor(float('$TOTAL_FPS_RUN1') / 30)), $MAX_BS))")
echo "DS Run 1: $N streams | FPS/stream=$FPS_RUN1 | total=$TOTAL_FPS_RUN1 img/s | RT_STREAMS=$RT_STREAMS"
STEP7_RUN1_END=$(date +%s.%N)
STEP7_RUN1_DURATION=$(echo "$STEP7_RUN1_END - $STEP7_RUN1_START" | bc)
echo "[Step 7 Run 1] completed in ${STEP7_RUN1_DURATION}s"
```

**DS Run 2 — Validation at RT_STREAMS:**
```bash
N=$RT_STREAMS
LOG_RUN2="models/$MODEL_NAME/benchmarks/ds/ds_s${N}_run2.log"

STEP7_RUN2_START=$(date +%s.%N)
bash skills/deepstream-import-vision-model/scripts/deepstream/ds-perf-run.sh \
  models/$MODEL_NAME/benchmarks/ds/config_infer_ds_${MODEL_NAME}.txt \
  "$N" \
  "$LOG_RUN2" \
  "$VIDEO"

FPS_RUN2=$(grep -oP '\*\*PERF:\s*\K[0-9.]+' "$LOG_RUN2" | tail -10 | python3 -c "
import sys; vals=[float(l) for l in sys.stdin if l.strip()]; print(round(sum(vals)/len(vals),2) if vals else 0)")
python3 -c "exit(0 if float('$FPS_RUN2') > 0 else 1)" || \
  { echo "ERROR: FPS parsing failed for Run 2 — check $LOG_RUN2"; exit 1; }

TOTAL_FPS_RUN2=$(python3 -c "print(round(float('$FPS_RUN2') * $N, 2))")
RT_CONFIRMED=$(python3 -c "print('YES' if float('$FPS_RUN2') >= 30 else 'NO')")
echo "DS Run 2: $N streams | FPS/stream=$FPS_RUN2 | total=$TOTAL_FPS_RUN2 img/s | Real-time: $RT_CONFIRMED"
STEP7_RUN2_END=$(date +%s.%N)
STEP7_RUN2_DURATION=$(echo "$STEP7_RUN2_END - $STEP7_RUN2_START" | bc)
echo "[Step 7 Run 2] completed in ${STEP7_RUN2_DURATION}s"
```

> **NVDEC saturation on fast nano models**: very fast models (YOLO-nano family, etc.) can saturate NVDEC before GPU. Symptom: DS aggregate FPS plateaus at the same value regardless of stream count (e.g., 6,976 at 128 streams, 7,060 at 200 streams). In this case, `PEAK_GPU_STREAMS` from trtexec is an overestimate — Run 1 at that count will show fps/stream well below 30. The `RT_STREAMS = floor(TOTAL_FPS_RUN1 / 30)` formula above produces the correct NVDEC-limited ceiling. Do not pre-apply an efficiency factor to `PEAK_GPU_STREAMS` to compensate — the 2-run method measures overhead, it does not guess it.

**If Run 2 is still not real-time** (FPS/stream < 30): halve RT_STREAMS and retry once:
```bash
if [ "$RT_CONFIRMED" = "NO" ]; then
  RT_STREAMS=$(python3 -c "import math; print(max(1, int(math.floor($RT_STREAMS / 2))))")
  echo "Run 2 not real-time — retrying at $RT_STREAMS streams"
  N=$RT_STREAMS
  LOG_RUN2="models/$MODEL_NAME/benchmarks/ds/ds_s${N}_run2.log"
  bash skills/deepstream-import-vision-model/scripts/deepstream/ds-perf-run.sh \
    models/$MODEL_NAME/benchmarks/ds/config_infer_ds_${MODEL_NAME}.txt \
    "$N" \
    "$LOG_RUN2" \
    "$VIDEO"
  FPS_RUN2=$(grep -oP '\*\*PERF:\s*\K[0-9.]+' "$LOG_RUN2" | tail -10 | python3 -c "
import sys; vals=[float(l) for l in sys.stdin if l.strip()]; print(round(sum(vals)/len(vals),2) if vals else 0)")
  TOTAL_FPS_RUN2=$(python3 -c "print(round(float('$FPS_RUN2') * $N, 2))")
  RT_CONFIRMED=$(python3 -c "print('YES' if float('$FPS_RUN2') >= 30 else 'NO')")
  echo "Retry: $N streams | FPS/stream=$FPS_RUN2 | Real-time: $RT_CONFIRMED"
fi
```

**CONSTRAINT**: `num_streams <= engine_max_bs` always. Already enforced above via `min(RT_STREAMS, MAX_BS)`.

```bash
TRTEXEC_QPS=$(grep -oP 'Throughput:\s*\K[0-9.]+' "$TRTEXEC_LOG" | tail -1)
TRTEXEC_IMGS=$(python3 -c "print(round(float('$TRTEXEC_QPS') * $MAX_BS, 2))")
DS_EFF_RUN1=$(python3 -c "print(round(float('$TOTAL_FPS_RUN1') / float('$TRTEXEC_IMGS') * 100, 1))")
DS_EFF_RUN2=$(python3 -c "print(round(float('$TOTAL_FPS_RUN2') / float('$TRTEXEC_IMGS') * 100, 1))")
```

## Timing and Output Summary

```bash
TOTAL_67_DURATION=$(echo "$STEP6_DURATION + $STEP7_RUN1_DURATION + $STEP7_RUN2_DURATION" | bc)
```

When complete, print:
```
=== DeepStream Integration Complete ===
Model: $MODEL_NAME | Engine: $ENGINE
trtexec: $TRTEXEC_IMGS img/s @ BS=$MAX_BS
DS Run 1 (PEAK): $PEAK_GPU_STREAMS streams | $FPS_RUN1 fps/s | eff $DS_EFF_RUN1%
DS Run 2 (RT):   $RT_STREAMS streams | $FPS_RUN2 fps/s | RT: $RT_CONFIRMED | eff $DS_EFF_RUN2%
Timing: Step6=${STEP6_DURATION}s Run1=${STEP7_RUN1_DURATION}s Run2=${STEP7_RUN2_DURATION}s Total=${TOTAL_67_DURATION}s
Ready for: Step 8 — read references/report-generation.md models/$MODEL_NAME/
```
