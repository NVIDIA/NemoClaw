# nvinfer Configuration File Reference

## Overview

The `nvinfer` GStreamer plugin uses a configuration file to define model parameters, preprocessing settings, and postprocessing options. This document provides a complete reference for all configuration parameters.

## Configuration File Formats

nvinfer supports **two configuration file formats**:

### Format 1: YAML Format (`.yml` or `.yaml`) - Recommended

```yaml
property:
  gpu-id: 0
  net-scale-factor: 0.00392156862745098
  onnx-file: /path/to/model.onnx
  batch-size: 1
  # ... more properties

class-attrs-all:
  topk: 20
  pre-cluster-threshold: 0.2
```

### Format 2: INI-style Text Format (`.txt`)

```ini
[property]
gpu-id=0
net-scale-factor=0.00392156862745098
onnx-file=/path/to/model.onnx
batch-size=1
# ... more properties

[class-attrs-all]
topk=20
pre-cluster-threshold=0.2
```

### Key Syntax Differences

| Aspect | YAML Format | INI Format |
|--------|-------------|------------|
| File extension | `.yml` or `.yaml` | `.txt` |
| Section headers | `property:` (no brackets) | `[property]` (with brackets) |
| Key-value separator | `: ` (colon + space) | `=` (equals) |
| Indentation | Required for nested values | Not used |
| Comments | `#` at start of line | `#` at start of line |

---

## Property Section Reference

The `property` section contains core inference configuration.

### Model Definition

| Parameter | Type | Description | Default |
|-----------|------|-------------|---------|
| `onnx-file` | string | Path to ONNX model file | - |
| `model-engine-file` | string | Path to a pre-built TensorRT engine file. When set, nvinfer loads this engine directly instead of regenerating it from the ONNX file on every run. The engine filename encodes the batch size, GPU index, and precision (see naming convention below). | - |
| `custom-network-config` | string | Path to custom network config file | - |
| `custom-lib-path` | string | Path to custom parsing library (.so) | - |
| `labelfile-path` | string | Path to class labels text file | - |
| `int8-calib-file` | string | Path to INT8 calibration file | - |
| `tlt-model-key` | string | Encryption key for TAO/TLT models | - |

**Usage Example (YAML)**:
```yaml
property:
  onnx-file: /opt/nvidia/deepstream/deepstream/samples/models/Primary_Detector/resnet18_trafficcamnet_pruned.onnx
  model-engine-file: /opt/nvidia/deepstream/deepstream/samples/models/Primary_Detector/resnet18_trafficcamnet_pruned.onnx_b1_gpu0_fp16.engine
  labelfile-path: /opt/nvidia/deepstream/deepstream/samples/models/Primary_Detector/labels.txt
```

#### model-engine-file — Purpose and Naming Convention

**Purpose:** The first time nvinfer runs with an ONNX model, TensorRT builds an optimised engine file. This serialisation step can take **minutes**. By specifying `model-engine-file`, you tell nvinfer to load an already-built engine directly, **skipping the ONNX-to-engine conversion** on subsequent runs and dramatically reducing startup time.

> **Agent guidance:** When generating nvinfer config files, **always include `model-engine-file`** alongside `onnx-file`. This avoids expensive re-compilation every time the pipeline starts. The engine file is specific to the batch size, GPU, and precision — if any of these change, a new engine must be generated (i.e. the first run without a matching engine file will trigger generation automatically).

**Naming convention:** TensorRT engine files follow the pattern:

```
<onnx-filename>_b<batch-size>_gpu<gpu-id>_<precision>.engine
```

| Component | Meaning | Example |
|-----------|---------|---------|
| `<onnx-filename>` | Full ONNX filename including `.onnx` extension | `resnet18_trafficcamnet_pruned.onnx` |
| `b<batch-size>` | Batch size the engine was built for | `b1`, `b4`, `b16` |
| `gpu<gpu-id>` | GPU device index | `gpu0`, `gpu1` |
| `<precision>` | Network precision mode | `fp32`, `int8`, `fp16` |

**Examples by batch size:**

```yaml
# batch-size: 1
property:
  batch-size: 1
  model-engine-file: /opt/nvidia/deepstream/deepstream/samples/models/Primary_Detector/resnet18_trafficcamnet_pruned.onnx_b1_gpu0_fp16.engine

# batch-size: 4
property:
  batch-size: 4
  model-engine-file: /opt/nvidia/deepstream/deepstream/samples/models/Primary_Detector/resnet18_trafficcamnet_pruned.onnx_b4_gpu0_fp16.engine

# batch-size: 16 (e.g. secondary classifier)
property:
  batch-size: 16
  model-engine-file: /opt/nvidia/deepstream/deepstream/samples/models/Secondary_VehicleMake/resnet18_vehiclemakenet_pruned.onnx_b16_gpu0_fp16.engine
```

**INI-style equivalent:**
```ini
[property]
batch-size=4
model-engine-file=/opt/nvidia/deepstream/deepstream/samples/models/Primary_Detector/resnet18_trafficcamnet_pruned.onnx_b4_gpu0_fp16.engine
```

### Processing Configuration

| Parameter | Type | Values | Description | Default |
|-----------|------|--------|-------------|---------|
| `gpu-id` | int | 0, 1, 2... | GPU device ID | 0 |
| `batch-size` | int | 1-32 | Maximum batch size | 1 |
| `process-mode` | int | 1=Primary, 2=Secondary | Inference mode | 1 |
| `network-mode` | int | 0=FP32, 1=INT8, 2=FP16 | Precision mode | 0 |
| `network-type` | int | 0=Detector, 1=Classifier, 2=Segmentation, 3=Instance Segmentation | Network type. Use instead of the legacy `is-classifier` key. | 0 |
| `interval` | int | 0-N | Skip N consecutive batches | 0 |
| `gie-unique-id` | int | 1-N | Unique ID for this GIE | 1 |

**Usage Example (YAML)**:
```yaml
property:
  gpu-id: 0
  batch-size: 4
  process-mode: 1
  network-mode: 2  # FP16
  interval: 0
  gie-unique-id: 1
```

### Network Input Configuration

| Parameter | Type | Description | Default |
|-----------|------|-------------|---------|
| `net-scale-factor` | float | Input normalization scale factor | 1.0 |
| `offsets` | string | Channel offsets (semicolon-separated) | - |
| `model-color-format` | int | 0=RGB, 1=BGR, 2=GRAY | 0 |
| `network-input-order` | int | 0=NCHW, 1=NHWC | 0 |
| `infer-dims` | string | Input tensor dimensions in C;H;W format (semicolon-separated). **Required** when the ONNX model has dynamic input shapes (e.g., exported with `dynamic=True`). Tells TensorRT the concrete dimensions to use for the optimization profile. | Inferred from ONNX (only works for static shapes) |
| `maintain-aspect-ratio` | int | 0=disabled, 1=enabled | 0 |
| `symmetric-padding` | int | 0=disabled, 1=enabled | 0 |
| `force-implicit-batch-dim` | int | 0=disabled, 1=enabled | 0 |

> **Agent guidance — `infer-dims` and dynamic ONNX models:** Many popular model frameworks (Ultralytics YOLO, HuggingFace, etc.) export ONNX models with dynamic axes by default. These models have symbolic dimension names (e.g., `batch`, `height`, `width`) instead of fixed integers, which TensorRT reads as `-1`. Without `infer-dims`, TensorRT's `setDimensions` call fails because all dimensions must be >= 0. **Always add `infer-dims` when the ONNX model has dynamic input shapes.**

**Usage Example (YAML)** — static-shape model (infer-dims optional):
```yaml
property:
  net-scale-factor: 0.00392156862745098  # 1/255
  offsets: 0;0;0
  model-color-format: 0  # RGB
  maintain-aspect-ratio: 1
```

**Usage Example (YAML)** — dynamic-shape ONNX model (infer-dims required):
```yaml
property:
  net-scale-factor: 0.00392156862745098  # 1/255
  model-color-format: 0  # RGB
  infer-dims: 3;640;640  # REQUIRED for dynamic ONNX models
  maintain-aspect-ratio: 1
```

**Usage Example (INI)** — dynamic-shape ONNX model:
```ini
[property]
net-scale-factor=0.00392156862745098
model-color-format=0
infer-dims=3;640;640
maintain-aspect-ratio=1
```

### Detection Configuration

| Parameter | Type | Description | Default |
|-----------|------|-------------|---------|
| `num-detected-classes` | int | Number of classes in model | - |
| `cluster-mode` | int | 1=DBSCAN, 2=NMS, 3=DBSCAN+NMS, 4=None | 2 |
| `parse-bbox-func-name` | string | Custom bbox parsing function name | - |
| `output-blob-names` | string | Model output layer names (semicolon-separated) | - |

**Usage Example (YAML)**:
```yaml
property:
  num-detected-classes: 4
  cluster-mode: 2  # NMS
```

> **Oriented bounding boxes (OBB) — `rotation_angle`:** `nvinfer` supports oriented bounding boxes via `NvDsInferObjectDetectionInfo.rotation_angle`. **If you are using an OBB model**, the angle output by the model can be **directly assigned** to `rotation_angle` in your custom bbox parser. **If you are not using an OBB model**, set `rotation_angle = 0`. In C++, `NvDsInferObjectDetectionInfo obj{};` value-initializes the struct and zero-initializes all fields, including `rotation_angle`; plain `NvDsInferObjectDetectionInfo obj;` does **not** and can leave rotated-box metadata uninitialized.
>
> Example (C++):
> ```cpp
> NvDsInferObjectDetectionInfo obj{};
> // ... fill classId, confidence, left/top/width/height ...
> obj.rotation_angle = is_obb_model ? angle_from_model : 0.0f;
> ```

### Secondary GIE Configuration (process-mode: 2)

| Parameter | Type | Description | Default |
|-----------|------|-------------|---------|
| `operate-on-gie-id` | int | GIE ID to operate on | -1 (all) |
| `operate-on-class-ids` | string | Class IDs to process (semicolon-separated) | - |
| `classifier-async-mode` | int | 0=sync, 1=async | 0 |
| `classifier-threshold` | float | Classification confidence threshold | 0.0 |
| `classifier-type` | string | Classifier label type (e.g., `vehicletype`, `vehiclemake`, `color`). Used to label classification results in metadata. | - |
| `input-object-min-width` | int | Minimum object width to classify | 0 |
| `input-object-min-height` | int | Minimum object height to classify | 0 |
| `input-object-max-width` | int | Maximum object width to classify | INT_MAX |
| `input-object-max-height` | int | Maximum object height to classify | INT_MAX |

**Usage Example (YAML)** - Secondary classifier:
```yaml
property:
  gpu-id: 0
  onnx-file: /path/to/classifier.onnx
  batch-size: 16
  process-mode: 2
  network-mode: 2
  network-type: 1
  gie-unique-id: 2
  operate-on-gie-id: 1
  operate-on-class-ids: 0
  classifier-async-mode: 1
  classifier-threshold: 0.51
  classifier-type: vehicletype
```

### Tensor Output Configuration

| Parameter | Type | Description | Default |
|-----------|------|-------------|---------|
| `output-tensor-meta` | int | 0=disabled, 1=enabled | 0 |
| `output-instance-mask` | int | 0=disabled, 1=enabled | 0 |
| `input-tensor-meta` | int | 0=disabled, 1=enabled | 0 |

**Usage Example (YAML)**:
```yaml
property:
  output-tensor-meta: 1  # Enable tensor output for custom postprocessing
```

### Scaling Configuration

| Parameter | Type | Description | Default |
|-----------|------|-------------|---------|
| `scaling-filter` | int | Scaling filter type (0-5) | 0 |
| `scaling-compute-hw` | int | 0=default, 1=GPU, 2=VIC | 0 |

---

## Class Attributes Sections

Class attributes sections configure detection parameters per class or for all classes.

### class-attrs-all (All Classes)

Applies to all detected classes.

> **IMPORTANT — camelCase key**: The DBSCAN minimum cluster size parameter is `minBoxes` (camelCase). Do NOT use `min-boxes` (kebab-case) — it is not recognized and will produce an "unknown key" warning at runtime.

| Parameter | Type | Description | Default |
|-----------|------|-------------|---------|
| `topk` | int | Maximum detections to keep after NMS | 20 |
| `nms-iou-threshold` | float | NMS IoU threshold (0.0-1.0) | 0.3 |
| `pre-cluster-threshold` | float | Confidence threshold before clustering | 0.4 |
| `eps` | float | DBSCAN epsilon parameter | 0.0 |
| `dbscan-min-score` | float | DBSCAN minimum confidence | 0.0 |
| `minBoxes` | int | DBSCAN minimum cluster size (camelCase, NOT `min-boxes`) | 0 |
| `roi-top-offset` | int | ROI top offset in pixels | 0 |
| `roi-bottom-offset` | int | ROI bottom offset in pixels | 0 |
| `detected-min-w` | int | Minimum detection width | 0 |
| `detected-min-h` | int | Minimum detection height | 0 |
| `detected-max-w` | int | Maximum detection width | INT_MAX |
| `detected-max-h` | int | Maximum detection height | INT_MAX |

**Usage Example (YAML)** - NMS clustering:
```yaml
class-attrs-all:
  topk: 20
  nms-iou-threshold: 0.5
  pre-cluster-threshold: 0.2
```

**Usage Example (YAML)** - DBSCAN clustering:
```yaml
class-attrs-all:
  detected-min-w: 4
  detected-min-h: 4
  minBoxes: 3
  eps: 0.7
  dbscan-min-score: 0.5
```

### class-attrs-N (Per-Class)

Override attributes for specific class ID N.

```yaml
class-attrs-0:
  topk: 30
  nms-iou-threshold: 0.4
  pre-cluster-threshold: 0.3

class-attrs-1:
  topk: 10
  nms-iou-threshold: 0.6
  pre-cluster-threshold: 0.5
```

---

## Complete Configuration Examples

### Example 1: Primary Detector (YAML)

```yaml
# Primary detector using ResNet18 TrafficCamNet
property:
  gpu-id: 0
  net-scale-factor: 0.00392156862745098
  onnx-file: /opt/nvidia/deepstream/deepstream/samples/models/Primary_Detector/resnet18_trafficcamnet_pruned.onnx
  model-engine-file: /opt/nvidia/deepstream/deepstream/samples/models/Primary_Detector/resnet18_trafficcamnet_pruned.onnx_b1_gpu0_fp16.engine
  labelfile-path: /opt/nvidia/deepstream/deepstream/samples/models/Primary_Detector/labels.txt
  batch-size: 1
  process-mode: 1
  model-color-format: 0
  network-mode: 2
  num-detected-classes: 4
  interval: 0
  gie-unique-id: 1
  cluster-mode: 2

class-attrs-all:
  topk: 20
  nms-iou-threshold: 0.5
  pre-cluster-threshold: 0.2

class-attrs-0:
  topk: 20
  nms-iou-threshold: 0.5
  pre-cluster-threshold: 0.4
```

### Example 2: Primary Detector (INI-style)

```ini
# Primary detector using ResNet18 TrafficCamNet
[property]
gpu-id=0
net-scale-factor=0.00392156862745098
onnx-file=/opt/nvidia/deepstream/deepstream/samples/models/Primary_Detector/resnet18_trafficcamnet_pruned.onnx
model-engine-file=/opt/nvidia/deepstream/deepstream/samples/models/Primary_Detector/resnet18_trafficcamnet_pruned.onnx_b1_gpu0_fp16.engine
labelfile-path=/opt/nvidia/deepstream/deepstream/samples/models/Primary_Detector/labels.txt
batch-size=1
process-mode=1
model-color-format=0
network-mode=2
num-detected-classes=4
interval=0
gie-unique-id=1
cluster-mode=2

[class-attrs-all]
topk=20
nms-iou-threshold=0.5
pre-cluster-threshold=0.2

[class-attrs-0]
topk=20
nms-iou-threshold=0.5
pre-cluster-threshold=0.4
```

### Example 3: Secondary Classifier (YAML)

```yaml
# Secondary classifier for vehicle make
property:
  gpu-id: 0
  net-scale-factor: 1.0
  onnx-file: /opt/nvidia/deepstream/deepstream/samples/models/Secondary_VehicleMake/resnet18_vehiclemakenet_pruned.onnx
  model-engine-file: /opt/nvidia/deepstream/deepstream/samples/models/Secondary_VehicleMake/resnet18_vehiclemakenet_pruned.onnx_b16_gpu0_fp16.engine
  labelfile-path: /opt/nvidia/deepstream/deepstream/samples/models/Secondary_VehicleMake/labels.txt
  batch-size: 16
  process-mode: 2
  model-color-format: 1
  network-mode: 2
  network-type: 1
  gie-unique-id: 2
  operate-on-gie-id: 1
  operate-on-class-ids: 0
  classifier-async-mode: 1
  classifier-threshold: 0.51
  classifier-type: vehiclemake
```

### Example 4: Tensor Output for Custom Postprocessing (YAML)

```yaml
# Enable tensor output for custom postprocessing
property:
  gpu-id: 0
  net-scale-factor: 0.00392156862745098
  onnx-file: /path/to/custom_model.onnx
  batch-size: 1
  process-mode: 1
  model-color-format: 0
  network-mode: 2
  num-detected-classes: 4
  gie-unique-id: 1
  output-tensor-meta: 1
  cluster-mode: 4  # No clustering, use custom postprocessing

class-attrs-all:
  pre-cluster-threshold: 0.1
```

---

## Common Pitfalls

### Pitfall 1: Wrong Section Name

**❌ Wrong (using `model:` instead of `property:`)**:
```yaml
model:
  onnx-file: /path/to/model.onnx
  batch-size: 1
```

**✅ Correct**:
```yaml
property:
  onnx-file: /path/to/model.onnx
  batch-size: 1
```

### Pitfall 2: Missing Colons in YAML

**❌ Wrong**:
```yaml
property
  gpu-id: 0
```

**✅ Correct**:
```yaml
property:
  gpu-id: 0
```

### Pitfall 3: Wrong Indentation

**❌ Wrong**:
```yaml
property:
gpu-id: 0
batch-size: 1
```

**✅ Correct**:
```yaml
property:
  gpu-id: 0
  batch-size: 1
```

### Pitfall 4: Using YAML syntax in INI file

**❌ Wrong (YAML in .txt file)**:
```ini
property:
  gpu-id: 0
```

**✅ Correct (INI format in .txt file)**:
```ini
[property]
gpu-id=0
```

### Pitfall 5: Incorrect process-mode for Secondary GIE

**❌ Wrong (using process-mode=1 for secondary)**:
```yaml
property:
  process-mode: 1
  operate-on-gie-id: 1  # Won't work with process-mode=1
```

**✅ Correct**:
```yaml
property:
  process-mode: 2  # Must be 2 for secondary GIE
  operate-on-gie-id: 1
```

### Pitfall 6: Missing `infer-dims` for Dynamic ONNX Models

**❌ Wrong (no `infer-dims` with a dynamic-shape ONNX model)**:
```yaml
# Model exported with dynamic=True (e.g., Ultralytics YOLO)
# ONNX input shape: [batch, 3, height, width] — all symbolic
property:
  onnx-file: yolo_model.onnx
  net-scale-factor: 0.00392156862745098
  # Missing infer-dims → TensorRT sees -1 for dynamic dims → engine build fails
```

**Error**: `IOptimizationProfile::setDimensions: Error Code 3: API Usage Error (Parameter check failed, condition: std::all_of(dims.d, dims.d + dims.nbDims, [](int32_t x) noexcept { return x >= 0; }))`

**✅ Correct**:
```yaml
property:
  onnx-file: yolo_model.onnx
  net-scale-factor: 0.00392156862745098
  infer-dims: 3;640;640  # C;H;W — tells TensorRT the concrete input dimensions
```

**When to add `infer-dims`**: Whenever the ONNX model was exported with dynamic axes (e.g., `dynamic=True` in Ultralytics, dynamic batch in other frameworks). If unsure, inspect the model with `python -c "import onnx; m = onnx.load('model.onnx'); print(m.graph.input)"` and check for symbolic dimension names.

### Pitfall 7: Using Legacy `is-classifier` Instead of `network-type`

**❌ Wrong (legacy key, produces deprecation warning)**:
```yaml
property:
  is-classifier: 1
```

**✅ Correct (use `network-type` in YAML configs)**:
```yaml
property:
  network-type: 1  # 0=Detector, 1=Classifier, 2=Segmentation, 3=Instance Segmentation
```

For primary detectors, simply omit both keys — the default is detector (`network-type: 0`).

### Pitfall 8: Using `min-boxes` Instead of `minBoxes`

**❌ Wrong (kebab-case — not recognized, produces "unknown key" warning)**:
```yaml
class-attrs-all:
  min-boxes: 3
```

**✅ Correct (camelCase)**:
```yaml
class-attrs-all:
  minBoxes: 3
```

Unlike most nvinfer config keys which use kebab-case, `minBoxes` uses camelCase. This is a legacy naming exception in the parser.

---

## DeepStream 9.0 Sample Model Paths

DeepStream 9.0 includes sample models at:

```
/opt/nvidia/deepstream/deepstream/samples/models/
├── Primary_Detector/
│   ├── resnet18_trafficcamnet_pruned.onnx
│   ├── labels.txt
│   └── cal_trt.bin (INT8 calibration)
├── Secondary_VehicleMake/
│   ├── resnet18_vehiclemakenet_pruned.onnx
│   └── labels.txt
├── Secondary_VehicleTypes/
│   ├── resnet18_vehicletypenet_pruned.onnx
│   └── labels.txt
└── SONYC_Audio_Classifier/
    └── ...
```

**Primary Detector Labels** (4 classes):
- 0: Car
- 1: TwoWheeler
- 2: Person
- 3: RoadSign

---

## GObject Properties vs Config File Parameters

Some parameters can be set via GObject properties on the `nvinfer` element:

```python
pipeline.add("nvinfer", "infer", {
    "config-file-path": "/path/to/config.yml",  # Required
    "batch-size": 4,                             # Overrides config file
    "unique-id": 1,                              # Overrides config file
    "output-tensor-meta": 1,                     # Overrides config file
    "interval": 2                                # Overrides config file
})
```

**Properties settable via GObject** (override config file):
- `batch-size`
- `unique-id`
- `process-mode`
- `interval`
- `output-tensor-meta`
- `input-tensor-meta`
- `output-instance-mask`
- `model-engine-file`

**Properties only in config file**:
- `net-scale-factor`
- `onnx-file`
- `infer-dims`
- `labelfile-path`
- `num-detected-classes`
- `cluster-mode`
- All `class-attrs-*` parameters

---

## Validation Checklist

Before running your pipeline, verify:

- [ ] Config file extension matches format (`.yml` for YAML, `.txt` for INI)
- [ ] Section name is `property:` (YAML) or `[property]` (INI)
- [ ] Model file path exists and is accessible
- [ ] `model-engine-file` is set and its name matches the current `batch-size`, `gpu-id`, and `network-mode` (precision)
- [ ] `infer-dims` is set if the ONNX model has dynamic input shapes (e.g., exported with `dynamic=True`)
- [ ] `num-detected-classes` matches your model
- [ ] `batch-size` <= number of streams
- [ ] `process-mode` is correct (1=Primary, 2=Secondary)
- [ ] Secondary GIE has `operate-on-gie-id` set correctly
- [ ] `gie-unique-id` is unique across all nvinfer instances

---

## Related Documentation

- **GStreamer Plugins Overview**: `gstreamer_plugins.md`
- **Service Maker Python API**: `service_maker_api.md`
- **Use Cases & Pipelines**: `use_cases_pipelines.md`
- **Best Practices**: `best_practices.md`
