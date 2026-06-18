
# NV Import Vision Model Report -- Step 8

Generate benchmark report with charts, HTML, and PDF from completed benchmarks.

The model directory is: `$ARGUMENTS`

> ## ⛔ STRICT HTML+PDF RULE — NO EXCEPTIONS, NO DEVIATIONS
>
> **HTML and PDF MUST be generated via the canonical pipeline script. Do NOT write your own HTML generator.**
>
> **The ONLY permitted way to generate the HTML + PDF:**
> ```bash
> python3 skills/deepstream-import-vision-model/scripts/report/md-to-html-pdf.py \
>   models/$MODEL_NAME/reports/benchmark_report.md \
>   skills/deepstream-import-vision-model/scripts/report/report-style.css \
>   models/$MODEL_NAME/reports/ \
>   $MODEL_NAME
> ```
> This produces:
> - `models/$MODEL_NAME/reports/benchmark_report.html` — styled with report_style.css, charts embedded as base64
> - `models/$MODEL_NAME/reports/benchmark_report_${MODEL_NAME}.pdf` — via wkhtmltopdf
>
> **FORBIDDEN — never do any of these:**
> - Write your own `generate_html.py` or any custom markdown-to-HTML converter script
> - Call `wkhtmltopdf` directly — use `md-to-html-pdf.py` which already calls it correctly
> - Use `md-to-pdf.sh` — GFM+Mermaid design doc tool only, wrong CSS
> - Use `pandoc`, `pdflatex`, or any other converter
>
> The `report_style.css` provides the ONLY correct CSS (dark navy headers #283593, alternating rows #e8eaf6, dark code blocks #263238). Any other CSS produces wrong-looking reports.

## 8a: Report Structure — 12 Mandatory Sections

The report must contain exactly these 12 sections in order:

1. **Model Configuration** — model name, source (HF repo / NGC), architecture, ONNX source, input/output shapes, classes, custom parser name, cluster mode, precision, engine profile
2. **System Configuration** — GPU (name + VRAM), Driver, CUDA, TensorRT, DeepStream, OS, Python, PyTorch, ONNX versions
3. **Preprocessing** — net-scale-factor, offsets, color format, normalization details (with reference to the preprocessing table in deepstream-import-vision-model/SKILL.md)
4. **Engine Build Summary** — source format, conversion path, engine filename (with max_bs postfix), engine size (MB), FP16 flag, builder_optimization_level if non-default, timing cache path
5. **trtexec Results** — two runs (BS=1 and BS=MAX_BS) with: QPS, Images/s, GPU Compute mean/P99 (ms). Do NOT include H2D/D2H latency or Host Latency. Show PEAK_GPU_STREAMS derivation:
   ```
   PEAK_GPU_STREAMS = floor(QPS_at_MAX_BS × MAX_BS / 30)
                    = floor(imgs_per_sec_at_MAX_BS / 30)
   ```
6. **PEAK_GPU_STREAMS Derivation** — explicit calculation block showing formula, inputs, and result. If a second engine was built, show both PEAK_GPU_STREAMS computations.
7. **Single-Stream Validation** — KITTI frame count, frames with detections, top-10 detected classes (from KITTI dump), validation result (PASS/FAIL)
8. **DeepStream Benchmark Results** — two runs:
   - **DS Run 1 (Calibration at PEAK_GPU_STREAMS)**: streams, batch, FPS/stream, total img/s, real-time (YES/NO)
   - **DS Run 2 (Validation at RT_STREAMS)**: streams, batch, FPS/stream, total img/s, real-time (YES)
9. **trtexec vs DeepStream Comparison** — 3-column table: trtexec | DS Run 1 | DS Run 2, rows: engine, batch/streams, total imgs/s, FPS/stream, real-time ≥30fps, DS Efficiency %
10. **Efficiency Analysis** — efficiency formula, Run 1 and Run 2 percentages, breakdown of the gap (NVDEC + mux + GStreamer overhead), GPU-bound vs pipeline-bound verdict
11. **Pipeline Timing** — per-step wall-clock duration and total:
    | Step | Description | Duration |
    |------|-------------|----------|
    | 1-3  | HF Model Acquire (download + inspect ONNX) | {time}s |
    | 4    | Engine build | {time}s |
    | 5    | trtexec BS=1 + BS=MAX_BS | {time}s |
    | 6    | Parser + config + visual validation + KITTI | {time}s |
    | 7 Run 1 | DS Calibration (PEAK_GPU_STREAMS streams) | {time}s |
    | 7 Run 2 | DS Validation (RT_STREAMS streams) | {time}s |
    | 8    | Report generation | {time}s |
    | **Total** | **End-to-end** | **{total}s** |
12. **Reference Commands** — exact reproducible commands:
    - trtexec engine build (full command with all flags and paths)
    - trtexec benchmark BS=1 and BS=MAX_BS
    - DeepStream single-stream validation (`gst-launch-1.0` with filesink + OSD)
    - DeepStream multi-stream benchmark (`deepstream-app` with `enable-perf-measurement=1` via `ds-perf-run.sh`, PEAK_GPU_STREAMS and RT_STREAMS variants)
    - nvinfer config key fields (as an ini code block)
    - Custom parser build command (`make` with DEEPSTREAM_DIR and CUDA_VER)
    - Use actual absolute paths from the model directory, never placeholders

## Pre-flight: Extract Variables from Benchmark Logs

Before generating any output, derive all variables by reading completed benchmark files. These variables are used by every section below.

```bash
STEP8_START=$(date +%s.%N)

MODEL_DIR="${ARGUMENTS%/}"
MODEL_NAME=$(basename "$MODEL_DIR")

# Locate engine — pick the LARGEST batch engine (sort -V ensures numeric sort, tail picks highest)
ENGINE=$(ls models/$MODEL_NAME/benchmarks/engines/*_dynamic_b*.engine 2>/dev/null | sort -V | tail -1)
[ -z "$ENGINE" ] && { echo "ERROR: No engine found in models/$MODEL_NAME/benchmarks/engines/ — run Steps 4-5 first (references/engine-build.md)"; exit 1; }
MAX_BS=$(echo "$ENGINE" | grep -oP '_b\K[0-9]+(?=\.engine)')
MODEL_FILENAME=$(basename "$ENGINE" | sed 's/_dynamic_b[0-9]*.engine//')
echo "Using engine: $ENGINE (MAX_BS=$MAX_BS)"

# Extract input name and spatial dims from ONNX (needed for reference commands in the report)
ONNX_FILE=$(ls models/$MODEL_NAME/model/*.onnx 2>/dev/null | grep -v '_dynamic' | head -1)
if [ -n "$ONNX_FILE" ]; then
  INSPECT_OUT=$(python3 skills/deepstream-import-vision-model/scripts/model/inspect-onnx.py "$ONNX_FILE" 2>/dev/null)
  INPUT_NAME=$(echo "$INSPECT_OUT" | grep -oP 'input_name:\s*\K\S+')
  H=$(echo "$INSPECT_OUT" | grep -oP 'height:\s*\K[0-9]+')
  W=$(echo "$INSPECT_OUT" | grep -oP 'width:\s*\K[0-9]+')
fi
INPUT_NAME=${INPUT_NAME:-"images"}  # fallback
H=${H:-"640"}; W=${W:-"640"}       # fallback — update if model uses different resolution

# Parse trtexec BS=1 log — fixed filename trtexec_b1.log (no timestamp, no wildcard needed)
TRTEXEC_LOG_BS1="models/$MODEL_NAME/benchmarks/b1/trtexec_b1.log"
[ -f "$TRTEXEC_LOG_BS1" ] || { echo "ERROR: $TRTEXEC_LOG_BS1 not found — run Steps 4-5 first (references/engine-build.md)"; exit 1; }
QPS_BS1=$(grep -oP 'Throughput:\s*\K[0-9.]+' "$TRTEXEC_LOG_BS1" | tail -1)
GPU_MEAN_BS1=$(grep -oP 'GPU Compute Time:.*mean = \K[0-9.]+' "$TRTEXEC_LOG_BS1" | tail -1)

# Parse trtexec BS=MAX_BS log — fixed filename trtexec_b${MAX_BS}.log
TRTEXEC_LOG_BSMAX="models/$MODEL_NAME/benchmarks/b${MAX_BS}/trtexec_b${MAX_BS}.log"
[ -f "$TRTEXEC_LOG_BSMAX" ] || { echo "ERROR: $TRTEXEC_LOG_BSMAX not found — run Steps 4-5 first (references/engine-build.md)"; exit 1; }
QPS_BS_MAX=$(grep -oP 'Throughput:\s*\K[0-9.]+' "$TRTEXEC_LOG_BSMAX" | tail -1)
GPU_MEAN_BS_MAX=$(grep -oP 'GPU Compute Time:.*mean = \K[0-9.]+' "$TRTEXEC_LOG_BSMAX" | tail -1)
GPU_P99_BS_MAX=$(grep -oP 'GPU Compute Time:.*percentile\(99%\) = \K[0-9.]+' "$TRTEXEC_LOG_BSMAX" | tail -1)
[ -z "$QPS_BS_MAX" ] && { echo "ERROR: Could not parse Throughput from $TRTEXEC_LOG_BSMAX — log may be empty or malformed"; exit 1; }
[ -z "$MAX_BS" ] && { echo "ERROR: Could not parse batch size from engine filename: $ENGINE"; exit 1; }

read IMGS_PER_SEC PEAK_GPU_STREAMS < <(python3 -c "
import math
imgs = float('$QPS_BS_MAX') * $MAX_BS
print(round(imgs, 2), int(math.floor(imgs / 30)))
")

# Parse DeepStream Run 1 and Run 2 FPS from logs written by ds-run-pipeline
# Fixed filename pattern: benchmarks/ds/ds_s{N}_run1.log and ds_s{N}_run2.log
# Use glob to find them (N varies per model) then extract N from filename
DS_LOG_RUN1=$(ls models/$MODEL_NAME/benchmarks/ds/ds_s*_run1.log 2>/dev/null | head -1)
DS_LOG_RUN2=$(ls models/$MODEL_NAME/benchmarks/ds/ds_s*_run2.log 2>/dev/null | head -1)
[ -z "$DS_LOG_RUN1" ] && { echo "ERROR: No DS Run 1 log found at benchmarks/ds/ds_s*_run1.log — run Steps 6-7 first (references/pipeline-run.md)"; exit 1; }
[ -z "$DS_LOG_RUN2" ] && { echo "ERROR: No DS Run 2 log found at benchmarks/ds/ds_s*_run2.log — run Steps 6-7 first (references/pipeline-run.md)"; exit 1; }

N_RUN1=$(basename "$DS_LOG_RUN1" | grep -oP 'ds_s\K[0-9]+(?=_run1)')
N_RUN2=$(basename "$DS_LOG_RUN2" | grep -oP 'ds_s\K[0-9]+(?=_run2)')
[[ "$N_RUN1" =~ ^[0-9]+$ ]] || { echo "ERROR: Could not parse stream count from $(basename "$DS_LOG_RUN1") — expected filename pattern ds_s<N>_run1.log"; exit 1; }
[[ "$N_RUN2" =~ ^[0-9]+$ ]] || { echo "ERROR: Could not parse stream count from $(basename "$DS_LOG_RUN2") — expected filename pattern ds_s<N>_run2.log"; exit 1; }
RT_STREAMS=$N_RUN2

# deepstream-app **PERF: format is `**PERF: fps_run0 (fps_avg0)  fps_run1 (fps_avg1)  ...`
# Capture stream-0 instantaneous FPS (\K after `**PERF:`) — 1 value per line — so
# tail -10 always covers exactly 10 measurement windows regardless of stream count.
# Multiply by stream count for total throughput.
FPS_RAW_RUN1=$(grep -oP '\*\*PERF:\s*\K[0-9.]+' "$DS_LOG_RUN1" | tail -10 | python3 -c "
import sys; vals=[float(l) for l in sys.stdin if l.strip()]; print(round(sum(vals)/len(vals),2) if vals else 0)")
FPS_RAW_RUN2=$(grep -oP '\*\*PERF:\s*\K[0-9.]+' "$DS_LOG_RUN2" | tail -10 | python3 -c "
import sys; vals=[float(l) for l in sys.stdin if l.strip()]; print(round(sum(vals)/len(vals),2) if vals else 0)")

TOTAL_FPS_RUN1=$(python3 -c "print(round(float('$FPS_RAW_RUN1') * $N_RUN1, 2))")
TOTAL_FPS_RUN2=$(python3 -c "print(round(float('$FPS_RAW_RUN2') * $N_RUN2, 2))")

echo "=== Report Variables ==="
echo "MODEL_NAME=$MODEL_NAME  MAX_BS=$MAX_BS"
echo "BS=1:       QPS=$QPS_BS1  GPU mean=${GPU_MEAN_BS1}ms"
echo "BS=$MAX_BS: QPS=$QPS_BS_MAX  imgs/s=$IMGS_PER_SEC  PEAK_GPU_STREAMS=$PEAK_GPU_STREAMS"
echo "DS Run 1:   FPS/stream=$FPS_RAW_RUN1  streams=$N_RUN1  total=$TOTAL_FPS_RUN1 img/s"
echo "DS Run 2:   FPS/stream=$FPS_RAW_RUN2  streams=$N_RUN2  total=$TOTAL_FPS_RUN2 img/s  RT_STREAMS=$RT_STREAMS"
```

Then immediately write `benchmark_data.json` before generating charts (so charts can load it if needed):

```bash
mkdir -p models/$MODEL_NAME/reports
python3 << 'EOF'
import json, os

def to_num(v, cast=float):
    """Return cast(v) or None if v is empty/invalid — prevents malformed JSON."""
    try:
        return cast(v) if v and str(v).strip() else None
    except (ValueError, TypeError):
        return None

data = {
    "model_name":       os.environ.get("MODEL_NAME", ""),
    "engine":           os.environ.get("ENGINE", ""),
    "max_bs":           to_num(os.environ.get("MAX_BS"), int),
    "trtexec": {
        "bs1":   {
            "qps":         to_num(os.environ.get("QPS_BS1")),
            "gpu_mean_ms": to_num(os.environ.get("GPU_MEAN_BS1"))
        },
        "bsmax": {
            "qps":         to_num(os.environ.get("QPS_BS_MAX")),
            "gpu_mean_ms": to_num(os.environ.get("GPU_MEAN_BS_MAX")),
            "p99_ms":      to_num(os.environ.get("GPU_P99_BS_MAX")),
            "imgs_per_sec": to_num(os.environ.get("IMGS_PER_SEC"))
        }
    },
    "peak_gpu_streams": to_num(os.environ.get("PEAK_GPU_STREAMS"), int),
    "deepstream": {
        "run1": {
            "streams":        to_num(os.environ.get("N_RUN1"), int),
            "total_fps":      to_num(os.environ.get("TOTAL_FPS_RUN1")),
            "fps_per_stream": to_num(os.environ.get("FPS_RAW_RUN1"))
        },
        "run2": {
            "streams":        to_num(os.environ.get("N_RUN2"), int),
            "total_fps":      to_num(os.environ.get("TOTAL_FPS_RUN2")),
            "fps_per_stream": to_num(os.environ.get("FPS_RAW_RUN2"))
        }
    }
}
out_path = os.path.join("models", os.environ.get("MODEL_NAME", "unknown"),
                        "reports", "benchmark_data.json")
with open(out_path, "w") as f:
    json.dump(data, f, indent=2)
print("benchmark_data.json written")
EOF
```
> `<< 'EOF'` (quoted) prevents bash expansion — Python reads all variables via `os.environ.get()`, applies `to_num()` for safe numeric conversion (returns `None` instead of producing malformed JSON when a variable is unset), then uses `json.dump` to guarantee valid output.

## 8c-1: Chart Generation (MANDATORY)

All Python scripts in this step run inside the **shared venv** at `build/.venv_optimum` (which holds `matplotlib`, `numpy`, `markdown`, and `onnxruntime`). Activate it once before running any report scripts:

```bash
source build/.venv_optimum/bin/activate
```

Generate exactly **5 charts** using `matplotlib` in `models/{model_name}/reports/charts/`. Use the script at `skills/deepstream-import-vision-model/scripts/report/generate-benchmark-charts.py` or generate manually. Chart names are fixed — do not rename them.

| Filename | Content | Chart type |
|----------|---------|------------|
| `chart_trtexec_bs1_vs_bsmax.png` | Bar chart: QPS at BS=1 vs BS=MAX_BS (side by side) | Grouped bar |
| `chart_trtexec_throughput.png` | GPU-only images/sec at MAX_BS, with PEAK_GPU_STREAMS annotation (dashed line at y=PEAK_GPU_STREAMS×30) | Single bar or line |
| `chart_ds_streams_vs_fps.png` | Line chart: X=stream count (PEAK_GPU_STREAMS, RT_STREAMS), Y=FPS/stream. Red dashed line at 30fps threshold. | Line + markers |
| `chart_trt_vs_ds.png` | Grouped bars: trtexec total imgs/s \| DS Run 1 total imgs/s \| DS Run 2 total imgs/s | Grouped bar |
| `chart_efficiency.png` | DS efficiency %: 2 bars (Run 1 efficiency, Run 2 efficiency), dashed line at 100% | Bar |

Do NOT generate H2D/D2H transfer overhead charts.

Chart style requirements:
- Figure size: `figsize=(10, 6)`, DPI: 150
- Title: two-line format via `two_line_title(model_name, subtitle)` — model name on line 1, chart description on line 2 (prevents long titles from clipping outside figure bounds)
- Axis labels: 13px; Bar value labels: bold, 12-13px, positioned above bars
- Grid: `axis='y', alpha=0.3`; `plt.tight_layout()` before save
- Use `matplotlib.use('Agg')` (no display needed)

## 8c-1b: Markdown Report (MANDATORY)

Generate `benchmark_report.md` before the HTML. This file must contain all 12 sections filled with actual values — no placeholders allowed.

First, gather system info not already captured in pre-flight:

```bash
GPU_INFO=$(nvidia-smi --query-gpu=name,memory.total --format=csv,noheader | head -1)
GPU_NAME=$(echo "$GPU_INFO" | cut -d, -f1 | xargs)
GPU_VRAM=$(echo "$GPU_INFO" | cut -d, -f2 | xargs)
DRIVER_VER=$(nvidia-smi --query-gpu=driver_version --format=csv,noheader | head -1 | xargs)
CUDA_VER=$(nvcc --version 2>/dev/null | grep -oP 'release \K[0-9.]+' || echo "N/A")
TRT_VER=$(trtexec 2>&1 | head -3 | grep -oP 'TensorRT v\K[0-9.]+' || echo "N/A")
DS_VER=$(deepstream-app --version-all 2>/dev/null | grep -oP 'DeepStreamSDK \K[0-9.]+' || echo "N/A")
ENGINE_SIZE_MB=$(du -m "$ENGINE" | cut -f1)
IMGS_PER_SEC_BS1=$(python3 -c "print(round(float('$QPS_BS1') * 1, 2))")
GPU_P99_BS1=$(grep -oP 'GPU Compute Time:.*percentile\(99%\) = \K[0-9.]+' "$TRTEXEC_LOG_BS1" | tail -1)
GPU_P99_BS1=${GPU_P99_BS1:-"N/A"}  # fallback if log too short to have P99
EFFICIENCY_RUN1=$(python3 -c "print(round(float('$TOTAL_FPS_RUN1') / float('$IMGS_PER_SEC') * 100, 1))")
EFFICIENCY_RUN2=$(python3 -c "print(round(float('$TOTAL_FPS_RUN2') / float('$IMGS_PER_SEC') * 100, 1))")
RT_LABEL_RUN1=$(python3 -c "print('YES' if float('$FPS_RAW_RUN1') >= 30 else 'NO')")
RT_LABEL_RUN2=$(python3 -c "print('YES' if float('$FPS_RAW_RUN2') >= 30 else 'NO')")
```

Then write the markdown (use unquoted `<< MDEOF` so bash expands variables):

```bash
cat > models/$MODEL_NAME/reports/benchmark_report.md << MDEOF
# ${MODEL_NAME} Benchmark Report

Generated: $(date '+%Y-%m-%d %H:%M:%S')

---

## 1. Model Configuration

| Parameter | Value |
|-----------|-------|
| **Model Name** | ${MODEL_NAME} |
| **Source** | (fill from Steps 1-3 log) |
| **Architecture** | (fill from config.json model_type) |
| **ONNX Source** | models/${MODEL_NAME}/model/ |
| **Precision** | FP16 |
| **Engine File** | $(basename $ENGINE) |
| **Engine Profile** | min=1x3x640x640  opt=${MAX_BS}x3x640x640  max=${MAX_BS}x3x640x640 |
| **Custom Parser** | libnvdsinfer_${MODEL_NAME}_parser.so |
| **Cluster Mode** | (fill from nvinfer config) |

## 2. System Configuration

| Parameter | Value |
|-----------|-------|
| **GPU** | ${GPU_NAME} |
| **VRAM** | ${GPU_VRAM} |
| **Driver** | ${DRIVER_VER} |
| **CUDA** | ${CUDA_VER} |
| **TensorRT** | ${TRT_VER} |
| **DeepStream** | ${DS_VER} |

## 3. Preprocessing

| Parameter | Value |
|-----------|-------|
| **net-scale-factor** | (fill from nvinfer config) |
| **offsets** | (fill from nvinfer config) |
| **Color Format** | (fill from nvinfer config) |
| **Input Resolution** | 640×640 |

## 4. Engine Build Summary

| Parameter | Value |
|-----------|-------|
| **Source Format** | ONNX |
| **Engine File** | $(basename $ENGINE) |
| **Engine Size** | ${ENGINE_SIZE_MB} MB |
| **FP16** | Enabled |
| **MAX Batch Size** | ${MAX_BS} |
| **Workspace** | 32768 MiB |
| **Timing Cache** | models/${MODEL_NAME}/benchmarks/engines/timing.cache |

## 5. trtexec Results

| Metric | BS=1 | BS=${MAX_BS} |
|--------|------|------|
| **QPS (queries/s)** | ${QPS_BS1} | ${QPS_BS_MAX} |
| **Images/s** | ${IMGS_PER_SEC_BS1} | ${IMGS_PER_SEC} |
| **GPU Compute Mean (ms)** | ${GPU_MEAN_BS1} | ${GPU_MEAN_BS_MAX} |
| **GPU Compute P99 (ms)** | ${GPU_P99_BS1} | ${GPU_P99_BS_MAX} |

> Note: H2D/D2H latency excluded — trtexec run with \`--noDataTransfers\` to match DeepStream (GPU-to-GPU data flow, no host transfers).

![trtexec BS=1 vs BS=${MAX_BS}](charts/chart_trtexec_bs1_vs_bsmax.png)

## 6. PEAK_GPU_STREAMS Derivation

\`\`\`
PEAK_GPU_STREAMS = floor(imgs_per_sec_at_MAX_BS / 30)
                = floor(${IMGS_PER_SEC} / 30)
                = ${PEAK_GPU_STREAMS} streams
\`\`\`

![trtexec throughput at BS=${MAX_BS}](charts/chart_trtexec_throughput.png)

## 7. Single-Stream Validation

| Parameter | Value |
|-----------|-------|
| **Video Source** | sample_720p.mp4 (1280×720) |
| **KITTI Output Dir** | models/${MODEL_NAME}/samples/kitti_output/ |
| **Total Frames** | (fill from kitti dump) |
| **Frames with Detections** | (fill from kitti dump) |
| **Detection Rate** | (fill — must be ≥ 90%) |
| **Visual Capture Mode** | (fill: `nvv4l2h264enc MP4` OR `theoraenc OGV (NVENC unavailable)` OR `skipped (no encoder available)`) |
| **Visual Capture Artifact** | (fill: `samples/${MODEL_NAME}_output.mp4` for NVENC path; `samples/${MODEL_NAME}_output.ogv` for theoraenc fallback; `N/A` if skipped) |
| **Validation Result** | PASS |

> **Encoder reporting rule (MANDATORY):** The Visual Capture Mode field MUST be exactly one of:
> - `nvv4l2h264enc MP4` — NVENC succeeded; artifact is `.mp4`
> - `theoraenc OGV (NVENC unavailable)` — if `DS_SINGLE_STREAM_MODE=theoraenc-fallback`; use `.ogv` path from `DS_SINGLE_STREAM_OUTPUT=`
> - `skipped (no encoder available)` — if `DS_SINGLE_STREAM_MODE=skipped`; no artifact file
> `x264enc` and `openh264enc` are prohibited and must never appear in this field.

## 8. DeepStream Benchmark Results

### DS Run 1 — Calibration at PEAK_GPU_STREAMS (${N_RUN1} streams)

| Metric | Value |
|--------|-------|
| **Streams** | ${N_RUN1} |
| **Batch Size** | ${N_RUN1} |
| **FPS / Stream** | ${FPS_RAW_RUN1} |
| **Total Images/s** | ${TOTAL_FPS_RUN1} |
| **Real-Time (≥30 fps/stream)** | ${RT_LABEL_RUN1} |

### DS Run 2 — Validation at RT_STREAMS (${N_RUN2} streams)

| Metric | Value |
|--------|-------|
| **Streams** | ${N_RUN2} |
| **Batch Size** | ${N_RUN2} |
| **FPS / Stream** | ${FPS_RAW_RUN2} |
| **Total Images/s** | ${TOTAL_FPS_RUN2} |
| **Real-Time (≥30 fps/stream)** | ${RT_LABEL_RUN2} |

![DeepStream FPS/stream vs stream count](charts/chart_ds_streams_vs_fps.png)

## 9. trtexec vs DeepStream Comparison

| Metric | trtexec BS=${MAX_BS} | DS Run 1 (${N_RUN1} streams) | DS Run 2 (${N_RUN2} streams) |
|--------|---------------------|------------------------------|------------------------------|
| **Engine** | $(basename $ENGINE) | $(basename $ENGINE) | $(basename $ENGINE) |
| **Batch / Streams** | BS=${MAX_BS} | ${N_RUN1} streams | ${N_RUN2} streams |
| **Total imgs/s** | ${IMGS_PER_SEC} | ${TOTAL_FPS_RUN1} | ${TOTAL_FPS_RUN2} |
| **FPS / stream** | $(python3 -c "print(round(float('$IMGS_PER_SEC')/${MAX_BS},1))") | ${FPS_RAW_RUN1} | ${FPS_RAW_RUN2} |
| **Real-Time ≥30fps** | YES | ${RT_LABEL_RUN1} | ${RT_LABEL_RUN2} |
| **DS Efficiency %** | — | ${EFFICIENCY_RUN1}% | ${EFFICIENCY_RUN2}% |

![trtexec vs DeepStream total throughput](charts/chart_trt_vs_ds.png)

## 10. Efficiency Analysis

\`\`\`
DS Efficiency = DS_total_imgs_per_sec / trtexec_imgs_per_sec × 100
Run 1: ${TOTAL_FPS_RUN1} / ${IMGS_PER_SEC} × 100 = ${EFFICIENCY_RUN1}%
Run 2: ${TOTAL_FPS_RUN2} / ${IMGS_PER_SEC} × 100 = ${EFFICIENCY_RUN2}%
\`\`\`

Efficiency gap breakdown: NVDEC decode overhead (~5-10%), GStreamer mux/queue overhead (~5-10%), CPU scheduler jitter (~2-5%).

Interpretation notes for the numbers above:

- **Well-balanced pipeline**: GPU=99-100%, NVDEC=99-100%, CPU=30-40% with no single core pinned. The ~50% DS/trtexec gap at this utilization is physically irreducible — it's the cost of real decode + memory transfers that trtexec skips with \`--noDataTransfers\`.
- **DS efficiency above 100% is expected for ViT / transformer models**: the TRT compiler backend (opt-level 4) often produces bimodal GPU latency with two alternating execution paths (e.g., 1.5ms and 4.0ms modes for OWL-ViT). trtexec reports high variance and a conservative median; DeepStream's pipelined scheduling smooths the bimodal pattern and can achieve 100-110% of the trtexec baseline. This is not a measurement error.
- **1080p tends to saturate NVDEC** while GPU has headroom. The pipeline is pinned to 720p (\`sample_720p.mp4\`) specifically to keep benchmarks comparable across models.

![DeepStream efficiency vs trtexec baseline](charts/chart_efficiency.png)

## 11. Pipeline Timing

| Step | Description | Duration |
|------|-------------|----------|
| 1-3 | HF Model Acquire (download + inspect ONNX) | (fill from step timing) |
| 4 | Engine build | (fill from step timing) |
| 5 | trtexec BS=1 + BS=${MAX_BS} | (fill from step timing) |
| 6 | Parser + config + visual validation + KITTI | (fill from step timing) |
| 7 Run 1 | DS Calibration (${N_RUN1} streams) | (fill from step timing) |
| 7 Run 2 | DS Validation (${N_RUN2} streams) | (fill from step timing) |
| 8 | Report generation | (fill) |
| **Total** | **End-to-end** | **(fill)** |

## 12. Reference Commands

### Engine Build
\`\`\`bash
trtexec --onnx=models/${MODEL_NAME}/model/${MODEL_FILENAME}.onnx \\
  --saveEngine=models/${MODEL_NAME}/benchmarks/engines/${MODEL_FILENAME}_dynamic_b${MAX_BS}.engine \\
  --minShapes=${INPUT_NAME}:1x3x${H}x${W} \\
  --optShapes=${INPUT_NAME}:${MAX_BS}x3x${H}x${W} \\
  --maxShapes=${INPUT_NAME}:${MAX_BS}x3x${H}x${W} \\
  --fp16 --memPoolSize=workspace:32768M \\
  --timingCacheFile=models/${MODEL_NAME}/benchmarks/engines/timing.cache
\`\`\`

### trtexec Benchmark
\`\`\`bash
# BS=1
trtexec --loadEngine=$(basename $ENGINE) --shapes=${INPUT_NAME}:1x3x${H}x${W} \\
  --noDataTransfers --warmUp=1000 --duration=10

# BS=${MAX_BS}
trtexec --loadEngine=$(basename $ENGINE) --shapes=${INPUT_NAME}:${MAX_BS}x3x${H}x${W} \\
  --noDataTransfers --warmUp=1000 --duration=10
\`\`\`

### DeepStream Single-Stream Validation
\`\`\`bash
# See models/${MODEL_NAME}/scripts/ for full gst-launch-1.0 command
\`\`\`

### DeepStream Multi-Stream Benchmark
\`\`\`bash
# DS Run 1: ${N_RUN1} streams — see models/${MODEL_NAME}/scripts/
# DS Run 2: ${N_RUN2} streams — see models/${MODEL_NAME}/scripts/
\`\`\`

### Custom Parser Build
\`\`\`bash
cd models/${MODEL_NAME}/parser && make DEEPSTREAM_DIR=/opt/nvidia/deepstream/deepstream CUDA_VER=12
\`\`\`
MDEOF
echo "benchmark_report.md written: $(wc -l < models/$MODEL_NAME/reports/benchmark_report.md) lines"
```

> **Note on "fill" fields**: Fields marked `(fill from ...)` must be replaced with actual values from the step logs before finalizing. Search the step output logs for the exact values and substitute them. Do not leave any `(fill ...)` placeholder in the final report.

## 8c-2 + 8c-3: HTML + PDF Report (MANDATORY — ONE COMMAND)

Before generating HTML+PDF, verify all 5 charts exist:

```bash
CHART_DIR="models/$MODEL_NAME/reports/charts"
MISSING_CHARTS=0
for CHART in chart_trtexec_bs1_vs_bsmax.png chart_trtexec_throughput.png \
             chart_ds_streams_vs_fps.png chart_trt_vs_ds.png chart_efficiency.png; do
  [ ! -f "$CHART_DIR/$CHART" ] && { echo "ERROR: Missing $CHART_DIR/$CHART"; MISSING_CHARTS=$((MISSING_CHARTS+1)); }
done
[ "$MISSING_CHARTS" -gt 0 ] && { echo "ERROR: $MISSING_CHARTS chart(s) missing — re-run 8c-1"; exit 1; }
echo "All 5 charts verified OK"
```

Then run the canonical pipeline script — this generates BOTH the HTML and PDF correctly:

```bash
python3 skills/deepstream-import-vision-model/scripts/report/md-to-html-pdf.py \
  models/$MODEL_NAME/reports/benchmark_report.md \
  skills/deepstream-import-vision-model/scripts/report/report-style.css \
  models/$MODEL_NAME/reports/ \
  $MODEL_NAME
```

This script uses `report_style.css` (navy `#283593` headers, `#e8eaf6` rows, `#263238` code blocks), embeds charts as base64 data URIs, calls `wkhtmltopdf` internally, and outputs `benchmark_report.html` + `benchmark_report_{model_name}.pdf`.

> **NAMING RULES:**
> - HTML: always `benchmark_report.html` (no model name suffix)
> - PDF: always `benchmark_report_{model_name}.pdf` (model name postfix required)

Verify PDF size is >500 KB (confirms charts embedded). Run all python commands with the shared venv active (`source build/.venv_optimum/bin/activate`); `markdown` and `matplotlib` are already installed there.

## 8c-4: Final Report Checklist and Timing

After generating markdown, HTML, and PDF, record step timing:

```bash
STEP8_END=$(date +%s.%N)
STEP8_DURATION=$(echo "$STEP8_END - $STEP8_START" | bc)
echo "[Step 8] Report generation completed in ${STEP8_DURATION}s"
```

Before marking the report as complete, verify ALL of these exist:
- [ ] `reports/benchmark_report.md` — markdown source (12 sections)
- [ ] `reports/benchmark_report.html` — styled HTML (charts/ alongside)
- [ ] `reports/benchmark_report_{model_name}.pdf` — PDF >500 KB (confirms charts embedded)
- [ ] `reports/benchmark_data.json` — raw benchmark numbers
- [ ] `reports/charts/` — all 5 PNGs: `chart_trtexec_bs1_vs_bsmax.png`, `chart_trtexec_throughput.png`, `chart_ds_streams_vs_fps.png`, `chart_trt_vs_ds.png`, `chart_efficiency.png`
- **Charts**: fixed filenames above — never rename or add model name suffix to charts
