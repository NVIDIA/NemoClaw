
# NV Model Acquire — Steps 1-3

Acquire an ONNX model from Hugging Face, creating the mandatory model folder structure.

## MANDATORY: Model Folder Structure

Create this layout at the start of Step 2 (once `$MODEL_NAME` is set by Step 1):
```
models/{model_name}/
  model/       config/       parser/       scripts/
  benchmarks/engines/
  reports/charts/      samples/
```
```bash
mkdir -p models/$MODEL_NAME/{model,parser,config,scripts,benchmarks/engines,reports/charts,samples}
```
Temporary staging dirs (`hf_model/`, `ngc_download/`, `build/`) are created inline where needed and cleaned up afterward — they are NOT part of this structure.

## Step 1: Parse the Model Source URL

Accept a model URL or ID in one of these formats and extract the required fields:

```bash
[ -z "$ARGUMENTS" ] && { echo "ERROR: No model URL or ID provided. Usage: /deepstream-import-vision-model <url>"; exit 1; }
INPUT="${ARGUMENTS}"

if echo "$INPUT" | grep -q "catalog.ngc.nvidia.com"; then
  # NGC catalog URL
  # e.g. https://catalog.ngc.nvidia.com/orgs/nvidia/teams/tao/models/trafficcamnet_transformer_lite/files?version=deployable_resnet50_v2.0
  MODEL_SOURCE="ngc"
  NGC_ORG=$(echo "$INPUT"    | sed 's|.*/orgs/\([^/]*\)/.*|\1|')
  NGC_TEAM=$(echo "$INPUT"   | sed 's|.*/teams/\([^/]*\)/.*|\1|')
  MODEL_NAME=$(echo "$INPUT" | sed 's|.*/models/\([^/]*\)/.*|\1|')
  NGC_VERSION=$(echo "$INPUT" | sed 's|.*version=\([^&]*\).*|\1|')
  echo "Source: NGC  Org: $NGC_ORG  Team: $NGC_TEAM  Model: $MODEL_NAME  Version: $NGC_VERSION"
else
  # HuggingFace full URL or short ID (e.g. https://huggingface.co/onnx-community/yolov8n or onnx-community/yolov8n)
  MODEL_SOURCE="hf"
  SLUG=$(echo "$INPUT" | sed 's|https://huggingface.co/||' | sed 's|/resolve/.*||' | sed 's|/$||')
  HF_ORG=$(echo "$SLUG"    | cut -d/ -f1)
  MODEL_NAME=$(echo "$SLUG" | cut -d/ -f2)
  echo "Source: HF  Org: $HF_ORG  Model: $MODEL_NAME"
fi
```

- `MODEL_SOURCE` (`hf` or `ngc`) drives category selection in Step 2
- `MODEL_NAME` is used as the folder name throughout (`models/{MODEL_NAME}/`)
- Proceed to Step 2 with these variables set

## Step 2: Detect Model Source and Format

First, create the model directory structure (required for all sources), then route by source:
```bash
# Create permanent model directory structure (all sources — HF and NGC)
mkdir -p models/$MODEL_NAME/{model,parser,config,scripts,benchmarks/engines,reports/charts,samples}

# Route based on MODEL_SOURCE set in Step 1
if [ "$MODEL_SOURCE" = "ngc" ]; then
  echo "NGC model detected — skipping HF repo browse, proceeding to Step 2d"
  # Skip to Step 2d directly — do not run any HF curl commands below
fi
# The following HF browse, config download, and labels extraction only runs for MODEL_SOURCE=hf
```

- Browse the HF repository and classify available model files using the vetted helper script
  (validates inputs, uses HTTPS+TLSv1.2 only, honors `$HF_TOKEN`):
  ```bash
  FILES="$(bash skills/deepstream-import-vision-model/scripts/model/hf-list-files.sh "$HF_ORG" "$MODEL_NAME")"
  ONNX_FILES=$(echo "$FILES" | grep -E '\.onnx$' || true)
  ST_FILES=$(echo "$FILES" | grep -E '\.(safetensors|bin)$' || true)
  echo "ONNX files:      ${ONNX_FILES:-none}"
  echo "SafeTensors/bin: ${ST_FILES:-none}"
  echo "All files:       $FILES"

  # If ONNX list is empty in root, also check /onnx subdirectory
  if [ -z "$ONNX_FILES" ]; then
      ONNX_SUB="$(bash skills/deepstream-import-vision-model/scripts/model/hf-list-files.sh "$HF_ORG" "$MODEL_NAME" onnx | grep -E '\.onnx$' || true)"
      echo "ONNX in /onnx subdir: ${ONNX_SUB:-none}"
  fi
  ```
- Classify the repo into one of these categories:

  **Category A: ONNX files available** -> proceed to Step 2a (select ONNX variant)
  **Category B: SafeTensors/PyTorch only (no ONNX)** -> proceed to Step 2b (export to ONNX)
  **Category C: No usable model files** -> inform user, suggest alternative repos
  **Category D: NGC model (not on HuggingFace)** -> proceed to Step 2d (NGC download)

- Download `config.json` — required for architecture detection and label extraction.
  Uses the vetted helper script (validated inputs, HTTPS+TLS, honors `$HF_TOKEN`):
  ```bash
  # HF: download from API via vetted helper. NGC: extracted from archive in Step 2d.
  if [ "$MODEL_SOURCE" = "hf" ]; then
    bash skills/deepstream-import-vision-model/scripts/model/hf-download-config.sh \
        "$HF_ORG" "$MODEL_NAME" "models/$MODEL_NAME/config/config.json"
  else
    echo "NGC model — config.json will be extracted from the downloaded archive in Step 2d"
  fi
  # Note: models/$MODEL_NAME/config/ already exists from the MANDATORY mkdir at the top of Step 2
  ```
- Inspect `config.json` to identify:
  - Model type (e.g., `grounding-dino`, `detr`, `yolos`, `resnet`, `swin`)
  - Architecture class (e.g., `GroundingDinoForObjectDetection`)
  - Number of inputs (single input vs multi-modal)

- **Reject non-detection architectures (fail fast)**: Check the `architectures` field in `config.json` before continuing. If the architecture class ends in a non-detection suffix such as `ForImageClassification`, `ForSemanticSegmentation`, `ForInstanceSegmentation`, `ForPanopticSegmentation`, `ForDepthEstimation`, `ForMaskedLM`, `ForTokenClassification`, or `ForCausalLM`, **abort the pipeline with a clear error and exit non-zero**: `"deepstream-import-vision-model currently supports object detection models only. Detected architecture: {arch_class}. Classification, segmentation, and other vision tasks are not yet supported."` Do not prompt the user. Detection architectures end in `ForObjectDetection` (or, for some DETR-family variants, `ForConditionalDetection` / `ForZeroShotObjectDetection`).

- **Extract `labels.txt` from `config.json`** — run this immediately after `config.json` is in place (for HF models that is now; for NGC models this runs at the end of Step 2d):
  ```bash
  python3 - <<EOF
  import json, sys
  with open("models/$MODEL_NAME/config/config.json") as f:
      cfg = json.load(f)

  # Primary: id2label (standard HF detection/classification format)
  if "id2label" in cfg:
      labels = [cfg["id2label"][str(i)] for i in range(len(cfg["id2label"]))]
  # Fallback 1: label2id reversed
  elif "label2id" in cfg:
      labels = [k for k, v in sorted(cfg["label2id"].items(), key=lambda x: x[1])]
  # Fallback 2: names dict/list (some YOLO HF repos)
  elif "names" in cfg:
      names = cfg["names"]
      labels = [names[str(i)] for i in range(len(names))] if isinstance(names, dict) else list(names)
  else:
      print("ERROR: No label map found in config.json -- cannot create labels.txt", file=sys.stderr)
      sys.exit(1)

  with open("models/$MODEL_NAME/config/labels.txt", "w") as f:
      f.write("\n".join(labels) + "\n")
  print(f"labels.txt: {len(labels)} classes")
  print("  " + ", ".join(labels[:5]) + (" ..." if len(labels) > 5 else ""))
  EOF
  ```
  If the script exits with error (no label map found), **fail the pipeline with a clear error and exit** — do not prompt the user, and never fall back to hardcoded COCO, ImageNet, or any other default list. This same script runs for HF and NGC — the only requirement is that `config.json` exists at `models/$MODEL_NAME/config/config.json`.

### Step 2a: Select ONNX Variant (Category A)
- Identify available quantization variants (fp32, fp16, int8, int4, quantized, etc.)
- **Default preference: fp16**. Apply this logic:
  1. If fp16 variant exists -> **select it silently**, log: `"Selected: fp16 (default). All available: [list]"`
  2. If fp16 does NOT exist -> **auto-select deterministically** in this priority order: fp32 > int8 > int4 > quantized > first ONNX alphabetically. Log: `"Selected: {variant} (fp16 unavailable). All available: [list]"`. Do not prompt the user.
  3. If only one ONNX file exists -> log it and proceed without asking
- **Construct the resolved download URL** for the selected variant from the tree listing:
  ```bash
  # The tree API returns entries with a "path" field (relative to repo root)
  # Construct the download URL as:
  PATH_FROM_TREE="<path field from tree listing, e.g. onnx/model_fp16.onnx>"
  ONNX_URL="https://huggingface.co/$HF_ORG/$MODEL_NAME/resolve/main/$PATH_FROM_TREE"
  # Example: path="onnx/model_fp16.onnx" -> URL ends in /resolve/main/onnx/model_fp16.onnx
  # Store this URL for use in Step 3
  ```
- After URL construction, proceed to **Step 3** (download ONNX)

### Step 2b: Export SafeTensors to ONNX (Category B)

When the repo only has `.safetensors` (or `.bin`) files and no ONNX export, convert to ONNX using an **isolated virtual environment** to avoid polluting the host system.

#### 2b-i: Setup Isolated Virtual Environment
- **ALWAYS** use a dedicated venv for export tools. Never install optimum/transformers/torch system-wide.
- Use a **single shared venv** at `build/.venv_optimum` across all models — `optimum`, `transformers`, `torch`, and `safetensors` are heavy (~2-5 GB) and identical from one model to the next, so creating one per model wastes ~minutes of install time and GBs of disk every run. The `skills/deepstream-import-vision-model/scripts/model/safetensors-to-onnx.sh` helper is built around this shared venv; align the skill-driven path with it.
  ```bash
  mkdir -p build
  VENV=build/.venv_optimum
  if [ ! -x "$VENV/bin/optimum-cli" ]; then
    python3 -m venv "$VENV"
    source "$VENV/bin/activate"
    pip install --upgrade pip
    pip install optimum[exporters] torch transformers safetensors onnxruntime matplotlib numpy markdown
  else
    source "$VENV/bin/activate"
  fi
  ```
- For a new model that needs **extra packages** (e.g. `timm` for DETR-family backbones, `onnxsim`, or a different `optimum` pin), `pip install` them **into the existing shared venv** rather than creating a new one:
  ```bash
  source build/.venv_optimum/bin/activate
  pip install timm   # or: pip install 'optimum[exporters]<2.1'
  ```
- The venv lives under `build/.venv_optimum` at the repo root, keeping `models/` clean and excluded from git via the root `.gitignore`
- All subsequent Python/pip commands in Step 2b must run inside this venv
- Legacy per-model venvs at `build/.venv_$MODEL_NAME` from older runs are still cleaned up by `skills/deepstream-import-vision-model/scripts/model/cleanup.sh "$MODEL_NAME"` for backward compatibility

#### 2b-ii: Download Required Files
- Download from the HF repo into `models/$MODEL_NAME/hf_model/` using `-P` to avoid changing the working directory:
  ```bash
  mkdir -p models/$MODEL_NAME/hf_model
  HF_BASE="https://huggingface.co/$HF_ORG/$MODEL_NAME/resolve/main"
  # Download model files
  wget -P models/$MODEL_NAME/hf_model "$HF_BASE/model.safetensors"
  wget -P models/$MODEL_NAME/hf_model "$HF_BASE/config.json"
  wget -P models/$MODEL_NAME/hf_model "$HF_BASE/preprocessor_config.json"
  # For text+vision models, also download tokenizer files (failures are non-fatal):
  wget -P models/$MODEL_NAME/hf_model "$HF_BASE/tokenizer.json"         || true
  wget -P models/$MODEL_NAME/hf_model "$HF_BASE/tokenizer_config.json"  || true
  wget -P models/$MODEL_NAME/hf_model "$HF_BASE/vocab.txt"              || true
  wget -P models/$MODEL_NAME/hf_model "$HF_BASE/special_tokens_map.json" || true
  ```
- For sharded models (multiple `.safetensors` files), also download `model.safetensors.index.json` and all shards

#### 2b-iii: Try optimum-cli Export (Preferred) -- Max 3 Retries

> **optimum 2.1.0 removed the `onnx` subcommand.** If `optimum-cli export onnx` exits with "unknown command", pin an older version (`pip install 'optimum[exporters]<2.1'`) or skip straight to **Step 2b-iv** (manual `torch.onnx.export`). The `optimum.exporters.onnx` Python module is also gone in 2.1+.

- Attempt export using optimum-cli:
  ```bash
  source build/.venv_optimum/bin/activate
  optimum-cli export onnx \
    --model models/$MODEL_NAME/hf_model \
    --task object-detection \
    --opset 17 \
    models/$MODEL_NAME/onnx_export/
  ```
- Common `--task` values for detection/vision models:
  - `object-detection` -- DETR, YOLOS, Conditional DETR
  - `image-classification` -- ResNet, ViT, Swin, ConvNeXt
  - `image-segmentation` -- Mask2Former, SAM
  - `semantic-segmentation` -- SegFormer, UperNet
  - `zero-shot-object-detection` -- OWL-ViT, Grounding DINO (if supported)
- If export succeeds, copy the ONNX file to the `model/` subdirectory:
  ```bash
  cp models/$MODEL_NAME/onnx_export/model.onnx models/$MODEL_NAME/model/$MODEL_NAME.onnx
  ```
- **Retry policy**: If the export fails, retry up to **3 times total** with adjustments between attempts:
  - **Retry 1**: Try a different `--task` value if the error suggests wrong task type
  - **Retry 2**: Try a different `--opset` version (e.g., 14 or 16 instead of 17)
  - **Retry 3**: Try with `--no-post-process` or other flags relevant to the error
  - After 3 failed attempts with optimum-cli, fall back to **Step 2b-iv** (manual torch.onnx.export)

#### 2b-iv: Fallback -- Manual torch.onnx.export (If optimum fails) -- Max 3 Retries
- If optimum-cli fails after 3 retries (unsupported architecture), use manual export:
  ```bash
  source build/.venv_optimum/bin/activate
  python3 -c "
  from transformers import AutoModelForObjectDetection, AutoConfig
  import torch

  model = AutoModelForObjectDetection.from_pretrained('models/$MODEL_NAME/hf_model')
  model.eval()

  # Create dummy input matching preprocessor_config.json dimensions
  dummy = torch.randn(1, 3, 800, 800)

  torch.onnx.export(model, dummy, 'models/$MODEL_NAME/model/$MODEL_NAME.onnx',
    export_params=True, opset_version=17, do_constant_folding=True,
    input_names=['pixel_values'],
    output_names=['logits', 'pred_boxes'],
    dynamic_axes={'pixel_values': {0: 'batch'},
                  'logits': {0: 'batch'},
                  'pred_boxes': {0: 'batch'}})
  "
  ```
- Adjust input/output names and shapes based on the model architecture
- **Retry policy**: If manual export fails, retry up to **3 times total** with adjustments:
  - **Retry 1**: Try a different `AutoModel` class (e.g., `AutoModel`, `AutoModelForImageClassification`)
  - **Retry 2**: Try a different opset version or simplify dynamic_axes
  - **Retry 3**: Try with `torch.onnx.export(..., operator_export_type=torch.onnx.OperatorExportTypes.ONNX_ATEN_FALLBACK)`
  - After 3 failed attempts, **stop and generate a failure report**

> **Gotchas for recent PyTorch/transformers**:
> - PyTorch 2.11+ with onnxscript installed auto-upgrades opset to 18 even when `opset_version=17` is requested. The resulting opset-18 ONNX is compatible with TRT 10.16 — accept it.
> - The dynamo backend (`dynamo=True`) may silently ignore `dynamic_axes` for transformer models where attention reshape patterns bake the batch dimension into the graph. Verify exported input shapes with `onnx.load()`. For DETR-family models on TRT 10.16, prefer the dynamo path with `torch.export.Dim("batch", min=1, max=N)` — it avoids the backbone-mask ForeignNode failure described in `nv-engine-build`.
> - The legacy TorchScript path (`dynamo=False`) crashes with transformers 5.5+ due to `create_bidirectional_mask` incompatibility.
> - **External data files**: `torch.onnx.export` may produce `model.onnx.data` alongside the `.onnx`. Consolidate before TRT conversion: `m = onnx.load(path, load_external_data=True); onnx.save(m, consolidated_path)`.

#### 2b-v: Handle Multi-Modal Models (e.g., Grounding DINO)
- Models that take **both image AND text** inputs need special handling for DeepStream (nvinfer only supports image input)
- Strategy: **freeze the text prompt** into the ONNX graph as a constant
  1. Run the model once with a fixed text prompt (e.g., "person . car . truck .")
  2. Export ONNX with the text embeddings baked in as constants
  3. The resulting ONNX model only needs `pixel_values` as input
- If freezing is not possible, check `onnx-community/` for pre-converted single-input versions
- **Inform the user** about the frozen text prompt and its implications (fixed detection classes)

#### 2b-vi: onnxsim — Run After Export When Needed

If the model has dynamic shape paths that cause TRT `ForeignNode` fusion issues, simplify the ONNX graph with `onnxsim` **before** engine building:

```bash
source build/.venv_optimum/bin/activate
pip install onnxsim
python3 -m onnxsim \
  models/$MODEL_NAME/model/$MODEL_NAME.onnx \
  models/$MODEL_NAME/model/${MODEL_NAME}_sim.onnx
# Use the _sim.onnx for engine building if the original triggers ForeignNode errors
```

Only run `onnxsim` if TRT build fails with `ForeignNode` warnings — it is not needed for most models.

#### 2b-vii: Validate ONNX Output
- After export, validate the ONNX file:
  ```bash
  source build/.venv_optimum/bin/activate
  python3 -c "
  import onnx
  m = onnx.load('models/$MODEL_NAME/model/$MODEL_NAME.onnx')
  onnx.checker.check_model(m)
  print('Inputs:')
  for i in m.graph.input:
    dims = [d.dim_param or d.dim_value for d in i.type.tensor_type.shape.dim]
    print(f'  {i.name}: {dims}')
  print('Outputs:')
  for o in m.graph.output:
    dims = [d.dim_param or d.dim_value for d in o.type.tensor_type.shape.dim]
    print(f'  {o.name}: {dims}')
  print('ONNX validation passed!')
  "
  ```
- Verify:
  - Single image input (no text/mask inputs -- remove if needed)
  - Output shapes match expected detection format
  - Dynamic batch dimension is present

#### 2b-viii: Cleanup
- Deactivate the venv after export is complete:
  ```bash
  deactivate
  ```
- **Keep `build/.venv_optimum` across runs** — it is shared by every SafeTensors → ONNX export and rebuilding it for each model costs minutes and GBs. `cleanup.sh` intentionally does not remove it.
- `cleanup.sh` removes per-model artifacts (`models/$MODEL_NAME/hf_model`, `models/$MODEL_NAME/onnx_export`, and any legacy `build/.venv_$MODEL_NAME` left over from older runs):
  ```bash
  # Validated script; will refuse unsafe paths. Shared .venv_optimum is preserved.
  bash skills/deepstream-import-vision-model/scripts/model/cleanup.sh "$MODEL_NAME"
  # Preview without removing:
  # bash skills/deepstream-import-vision-model/scripts/model/cleanup.sh "$MODEL_NAME" --dry-run
  ```
- The ONNX file is now at `models/$MODEL_NAME/model/$MODEL_NAME.onnx` -- proceed to engine building

### Step 2d: NGC Model Download (Category D)

When the model comes from NVIDIA NGC (not HuggingFace), download using the `ngc` CLI if available, or fall back to `wget` for direct file download:

```bash
# Vetted helper: prefers ngc CLI if installed, else falls back to authenticated
# HTTPS+TLS via curl against the public NGC catalog API. All inputs validated
# against ^[A-Za-z0-9._-]+$. See skills/deepstream-import-vision-model/scripts/model/ngc-download.sh for details.
bash skills/deepstream-import-vision-model/scripts/model/ngc-download.sh \
    "$NGC_ORG" "$NGC_TEAM" "$MODEL_NAME" "$NGC_VERSION" \
    "models/$MODEL_NAME/ngc_download"

# Inspect downloaded files
echo "Downloaded files:"
ls -lhR models/$MODEL_NAME/ngc_download/
```

- Identify the ONNX file(s) in the downloaded archive (often inside a subdirectory named after the model version)
- If the download contains a `.etlt` or `.engine` file only (TAO encrypted format), check if a plain ONNX is also provided; if not, use the TAO-provided engine directly and skip Step 4 (engine build)
- Copy the ONNX to the model directory:
  ```bash
  NGC_ONNX=$(find models/$MODEL_NAME/ngc_download -name "*.onnx" | head -1)
  cp "$NGC_ONNX" models/$MODEL_NAME/model/$MODEL_NAME.onnx
  echo "ONNX: $NGC_ONNX -> models/$MODEL_NAME/model/$MODEL_NAME.onnx"
  ```
- Extract `config.json` from the archive and build `labels.txt` (same logic as HF path):
  ```bash
  NGC_CONFIG=$(find models/$MODEL_NAME/ngc_download -name "config.json" | head -1)
  if [ -z "$NGC_CONFIG" ]; then
    echo "ERROR: config.json not found in NGC archive — cannot create labels.txt"
    echo "Cannot proceed without a label map — aborting. Provide an NGC archive that contains config.json."
    exit 1
  else
    cp "$NGC_CONFIG" models/$MODEL_NAME/config/config.json
    echo "config.json extracted from: $NGC_CONFIG"
    # Now run the same labels.txt extraction as the HF path
    python3 - <<EOF
import json, sys
with open("models/$MODEL_NAME/config/config.json") as f:
    cfg = json.load(f)
if "id2label" in cfg:
    labels = [cfg["id2label"][str(i)] for i in range(len(cfg["id2label"]))]
elif "label2id" in cfg:
    labels = [k for k, v in sorted(cfg["label2id"].items(), key=lambda x: x[1])]
elif "names" in cfg:
    names = cfg["names"]
    labels = [names[str(i)] for i in range(len(names))] if isinstance(names, dict) else list(names)
else:
    print("ERROR: No label map found in config.json -- cannot create labels.txt", file=sys.stderr)
    sys.exit(1)
with open("models/$MODEL_NAME/config/labels.txt", "w") as f:
    f.write("\n".join(labels) + "\n")
print(f"labels.txt: {len(labels)} classes")
print("  " + ", ".join(labels[:5]) + (" ..." if len(labels) > 5 else ""))
EOF
  fi
  ```

## Step 3: Download the ONNX Model

The model directory structure was already created in the MANDATORY block at the top. Do NOT run `mkdir -p` again here — just download the file:

```bash
wget -O "models/$MODEL_NAME/model/$MODEL_NAME.onnx" "${ONNX_URL}"
```

Where `$ONNX_URL` is the resolved URL constructed at the end of Step 2a (Category A) or derived from the NGC download path (Category D). Categories B and D write the ONNX directly to `models/$MODEL_NAME/model/$MODEL_NAME.onnx` during export/copy — Step 3 only applies to Category A.
- Also download any external data files if the ONNX model references them (files with `.onnx_data` extension or similar)
- Verify the download completed successfully and report file size

## Timing

Record wall-clock time at the start and end of this skill:
```bash
STEP_START=$(date +%s.%N)
# ... all steps ...
STEP_END=$(date +%s.%N)
STEP_DURATION=$(echo "$STEP_END - $STEP_START" | bc)
```

## Output Summary

When complete, print:
```
=== HF Model Acquire Complete ===  [Steps 1-3: ${STEP_DURATION}s]
Model:  $MODEL_NAME
ONNX:   models/$MODEL_NAME/model/$MODEL_NAME.onnx ({size} MB)
Input:  {input_name} {input_shape}
Output: {output_names} {output_shapes}
Labels: {num_classes} classes -> models/$MODEL_NAME/config/labels.txt
Ready for: Steps 4-5 — read references/engine-build.md models/$MODEL_NAME/model/$MODEL_NAME.onnx
```
(`{size}`, `{input_name}`, `{input_shape}`, `{output_names}`, `{output_shapes}`, `{num_classes}` are filled from the ONNX inspection output — all other fields use bash variables.)
