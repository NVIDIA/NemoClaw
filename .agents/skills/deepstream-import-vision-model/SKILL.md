---
name: deepstream-import-vision-model
description: >
  Use this skill to bring any vision model from HuggingFace or NVIDIA NGC into
  an NVIDIA DeepStream pipeline with end-to-end automation: ONNX download,
  SafeTensors export, TRT engine build, custom nvinfer bbox parser, multi-stream
  benchmark, and PDF report. Object detection models only.
license: CC-BY-4.0 AND Apache-2.0
metadata:
  author: NVIDIA CORPORATION
  version: 1.2.1
---

# DeepStream Import Vision Model

When this skill is active, **read the relevant reference document before starting each phase**. Do not rely on memory — reference documents contain exact script paths, bash variable conventions, log filename contracts, and critical parsing rules.

**Current scope:** Object detection models only. Fail fast on classification, segmentation, or other architectures detected in `config.json`.

## Pipeline Overview

| Step | Phase | Reference | What it does |
|------|-------|-----------|--------------|
| 1–3 | Model Acquire | [references/model-acquire.md](references/model-acquire.md) | Browse HF/NGC, detect format, download ONNX or export SafeTensors |
| 4–5 | Engine Build  | [references/engine-build.md](references/engine-build.md) | Build dynamic TRT engine, run trtexec BS=1 and BS=MAX_BS |
| 6–7 | DS Pipeline   | [references/pipeline-run.md](references/pipeline-run.md) | Custom bbox parser, nvinfer config, single-stream + multi-stream benchmarks |
| 8   | Report        | [references/report-generation.md](references/report-generation.md) | 5 charts, HTML, PDF benchmark report |

Run the full pipeline autonomously without pausing for confirmation at each step.

## Pre-flight Checks

Run before starting:

```bash
# 1. GPU and drivers
nvidia-smi

# 2. TensorRT version match (must match between builder and DS runtime)
trtexec 2>&1 | head -3
dpkg -l | grep libnvinfer-bin

# 3. Shared Python venv — create once, reuse across all models
mkdir -p build
VENV=build/.venv_optimum
if [ ! -x "$VENV/bin/python3" ]; then
  python3 -m venv "$VENV"
  "$VENV/bin/pip" install --upgrade pip -q
  "$VENV/bin/pip" install "optimum[exporters]>=1.20,<2.0" "torch<2.12" \
    transformers onnxruntime matplotlib numpy markdown -q
fi

# 4. System tools
which wkhtmltopdf || apt-get install -y wkhtmltopdf
which mediainfo    || apt-get install -y mediainfo
which deepstream-app  # required for KITTI dump (Step 6g) and benchmark perf-measurement (Step 7c); shipped with DeepStream SDK

# 5. Sample video — only check default path when user has not provided a custom DS_VIDEO
if [ -z "$DS_VIDEO" ]; then
  [ -f /opt/nvidia/deepstream/deepstream/samples/streams/sample_720p.mp4 ] || \
    echo "WARNING: sample_720p.mp4 not found. Install DeepStream samples or set DS_VIDEO=/path/to/your.mp4"
fi
```

## Mandatory Output Structure

Create once `MODEL_NAME` is known (Step 1). Never dump files flat.

```
models/{model_name}/
  model/           <- ONNX file(s)
  parser/          <- .cpp, Makefile, .so
  config/          <- nvinfer config, ds-app config, labels.txt
  scripts/         <- run helper scripts
  benchmarks/
    engines/       <- _dynamic_b{MAX_BS}.engine, timing.cache, build logs
    b1/            <- trtexec BS=1 log
    b{MAX_BS}/     <- trtexec BS=MAX_BS log
    ds/            <- DS benchmark logs
  reports/         <- benchmark_report.md, .html, .pdf, benchmark_data.json
    charts/        <- chart_*.png (5 charts)
  samples/         <- output .mp4 or .ogv (theoraenc fallback), test frames
    kitti_output/  <- KITTI detection .txt files
```

```bash
mkdir -p models/$MODEL_NAME/{model,parser,config,scripts,benchmarks/engines,benchmarks/ds,reports/charts,samples/kitti_output}
```

## Critical Rules

1. **Engine naming** — always `{model}_dynamic_b{MAX_BS}.engine`. Never bare `model_dynamic.engine`.
2. **batch_size == num_streams** — in DS runs, `batch-size` and stream count are always equal.
3. **Log filenames are fixed** — `trtexec_b1.log`, `trtexec_b${MAX_BS}.log`, `ds_s${N}_run1.log`, `ds_s${N}_run2.log`. No timestamps. Report generation reads exact paths.
4. **Parser zero-init** — always `NvDsInferObjectDetectionInfo obj = {};`. Required for DS 9.0 OBB support; bare `obj;` leaves `rotation_angle` uninitialized, causing tilted bounding boxes.
5. **KITTI validation gate** — do NOT proceed to Step 7 if KITTI frame count is zero or detection rate < 90%.
6. **Shared venv** — `build/.venv_optimum` reused across all models. Never create per-model venvs.
7. **trtexec `--noDataTransfers`** — GPU-only compute matches DeepStream's GPU-to-GPU data flow.
8. **Report HTML+PDF** — always use `skills/deepstream-import-vision-model/scripts/report/md-to-html-pdf.py`. Never write a custom HTML generator or call `wkhtmltopdf` directly.
9. **Object detection only** — reject non-detection architectures from `config.json` before building anything.
10. **Encoder fallback (MANDATORY)** — `x264enc` and `openh264enc` are **prohibited**. On NVENC-unavailable systems, use `theoraenc + oggmux` (LGPL; ships in gst-plugins-base; output is `.ogv`). If `theoraenc`/`oggmux` are absent, skip video creation (`DS_SINGLE_STREAM_MODE=skipped`). Report which mode was used: `nvv4l2h264enc` / `theoraenc-fallback` / `skipped`.
11. **Video source (MANDATORY)** — default is always `sample_720p.mp4` (1280×720). Never autonomously substitute `sample_1080p_h264.mp4` or any other file. Only use a different video when the user explicitly provides a path (via `DS_VIDEO` env var or script argument).

## Pipeline Timing

Wrap every step:

```bash
STEP_START=$(date +%s.%N)
# ... step commands ...
STEP_END=$(date +%s.%N)
STEP_DURATION=$(echo "$STEP_END - $STEP_START" | bc)
echo "[Step N] completed in ${STEP_DURATION}s"
```

Track `PIPELINE_START` (before Step 1) and `PIPELINE_END` (after Step 8). Report all durations in the benchmark report.

## Report Output (MANDATORY — all 3 formats)

1. `benchmark_report.md` — markdown source (12 mandatory sections)
2. `benchmark_report.html` — styled HTML (charts base64-inlined, no local file access)
3. `benchmark_report_{model_name}.pdf` — via `md-to-html-pdf.py`; verify charts are embedded by counting `data:image/png` occurrences in the HTML output: `grep -o 'data:image/png' benchmark_report.html | wc -l` should equal 5

Run charts and report scripts with the shared venv active: `source build/.venv_optimum/bin/activate`.

## Reference Documents

**IMPORTANT**: Read the relevant reference before starting each phase. Do NOT generate code from memory.

| Document | Use When |
|----------|----------|
| [references/model-acquire.md](references/model-acquire.md) | Steps 1–3: HF/NGC URL parsing, format detection, ONNX download, SafeTensors export, label extraction |
| [references/engine-build.md](references/engine-build.md) | Steps 4–5: trtexec engine build, benchmarks, PEAK_GPU_STREAMS derivation, iterative scaling |
| [references/pipeline-run.md](references/pipeline-run.md) | Steps 6–7: custom bbox parser, nvinfer config, single-stream validation, KITTI dump, multi-stream benchmark |
| [references/report-generation.md](references/report-generation.md) | Step 8: benchmark_data.json, 5 charts, 12-section markdown report, HTML + PDF |

## Scripts

Located in `scripts/`.

| Script | Phase | Purpose |
|--------|-------|---------|
| `model/hf-list-files.sh` | 1–3 | List HuggingFace repo files |
| `model/hf-download-config.sh` | 1–3 | Download config.json from HF |
| `model/ngc-list-files.sh` | 1–3 | List NGC model files |
| `model/ngc-download.sh` | 1–3 | Download NGC model archive |
| `model/safetensors-to-onnx.sh` | 1–3 | Export SafeTensors → ONNX via optimum-cli |
| `model/inspect-onnx.py` | 1–5 | Inspect ONNX input/output shapes |
| `model/make-static-batch-onnx.py` | 4–5 | Bake batch dim into ONNX |
| `model/cleanup.sh` | Any | Remove staging dirs, preserve shared venv |
| `engine/benchmark-trtexec.sh` | 4–5 | Run trtexec with standard flags |
| `deepstream/ds-single-stream.sh` | 6–7 | Single-stream visual validation (NVENC primary; theoraenc+oggmux fallback; skip if neither) |
| `deepstream/ds-sweep.sh` | 6–7 | 2-phase batch size sweep |
| `deepstream/benchmark-ds.sh` | 6–7 | Fixed-stream DS benchmark |
| `deepstream/ds-kitti-dump.sh` | 6–7 | KITTI detection dump via deepstream-app |
| `deepstream/ds-perf-run.sh` | 7 | Step 7c two-run benchmark — wraps `deepstream-app` with `enable-perf-measurement=1`, writes fixed-name log for the report parser |
| `deepstream/extract-frame.sh` | 6–7 | Extract sample frames from output video (`.mp4` NVENC path or `.ogv` theoraenc fallback) |
| `report/generate-benchmark-charts.py` | 8 | Generate 5 benchmark PNG charts |
| `report/md-to-html-pdf.py` | 8 | Markdown → styled HTML → PDF (canonical benchmark report path) |
| `report/md-to-pdf.sh` | Any | Markdown → PDF via pandoc/pdflatex — for design docs and references only, NOT for benchmark reports (use md-to-html-pdf.py for those) |
| `report/report-style.css` | 8 | CSS for HTML report |
| `report/render-mermaid-for-pdf.py` | 8 | Mermaid diagram → PNG |
| `report/mermaid-puppeteer.json` | 8 | Vetted Puppeteer config for Mermaid (sandboxed; non-root) |
| `report/mermaid-puppeteer-root.json` | 8 | Vetted Puppeteer config for Mermaid (used when running as root) |

## Quick Error Reference

| Error | Fix |
|-------|-----|
| Tilted/diagonal bounding boxes | Parser struct not zero-initialized — use `NvDsInferObjectDetectionInfo obj = {};` |
| Zero KITTI files | `gie-kitti-output-dir` not read by nvinfer — use `ds-kitti-dump.sh` (wraps `deepstream-app`) |
| Engine rebuilds every DS run | `model-engine-file` path wrong — check relative path from `config/` dir |
| `setDimensions` negative dims | Add `infer-dims=3;H;W` to nvinfer config for dynamic ONNX models |
| `--memPoolSize` workspace 0.03 MiB | Use `M` suffix not `MiB` — e.g. `--memPoolSize=workspace:32768M` |
| ForeignNode build failure (DETR) | Use dynamo export path or run `onnxsim` — see references/engine-build.md |
| Zero detections | Wrong `net-scale-factor` — check model family table in references/pipeline-run.md |
| `No module named 'pyservicemaker'` | Install into venv: `pip install /opt/nvidia/deepstream/.../pyservicemaker*.whl` |

<!-- Signing refresh marker.  -->
