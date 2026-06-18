# nvtracker Configuration Reference

## Overview

The `nvtracker` GStreamer plugin provides multi-object tracking capabilities in DeepStream pipelines. It tracks objects detected by inference engines across video frames, assigning unique tracking IDs and maintaining object trajectories. The plugin works with a reference low-level tracker library (`NvMultiObjectTracker`) that implements multiple tracking algorithms in a unified, composable architecture.

## Prerequisites

### Required System Dependencies

The tracker library (`libnvds_nvmultiobjecttracker.so`) requires the **libmosquitto** library for MQTT-based communication features (used by multi-view tracking). This must be installed before using the tracker.

**Install on Ubuntu/Debian:**
```bash
sudo apt-get update
sudo apt-get install -y libmosquitto1
```

**Install on RHEL/CentOS:**
```bash
sudo yum install mosquitto
```

**Common Error if Missing:**
```
gstnvtracker: Failed to open low-level lib at /opt/nvidia/deepstream/deepstream/lib/libnvds_nvmultiobjecttracker.so
dlopen error: libmosquitto.so.1: cannot open shared object file: No such file or directory
gstnvtracker: Failed to initialize low level lib.
```

If you see this error, install libmosquitto1 as shown above.

---

## Unified Tracker Architecture

The NvMultiObjectTracker library employs a **modular, composable architecture**. Different tracker algorithms share common modules (data association, target management, state estimation) while differing in core functionalities (visual tracking, deep association metric, segmentation).

### Module Composition by Tracker Type

| Module | IOU | NvSORT | NvDCF | NvDeepSORT | MaskTracker |
|--------|-----|--------|-------|------------|-------------|
| **State Estimator** | - | Kalman (Regular) | Kalman (Simple) | Kalman (Regular) | Kalman (Simple) |
| **Data Association** | Yes | Yes (Cascaded) | Yes (Cascaded) | Yes (Cascaded) | Yes (Cascaded) |
| **Visual Tracker (DCF)** | - | - | Yes | - | - |
| **Re-ID Network** | - | - | Optional | Yes | - |
| **Segmenter (SAM2)** | - | - | - | - | Yes |
| **Object Model Projection** | - | - | Optional (SV3DT) | - | - |
| **Pose Estimator** | - | - | Optional (SV3DT) | - | - |
| **Target Management** | Yes | Yes | Yes | Yes | Yes |
| **Target Re-Association** | - | - | Optional | - | - |

### Tracker Algorithm Summary

| Algorithm | Library | Use Case | GPU Usage | Accuracy |
|-----------|---------|----------|-----------|----------|
| **IOU** | `libnvds_nvmultiobjecttracker.so` | Bare-minimum baseline, simple scenes | Very Low | Low |
| **NvSORT** | `libnvds_nvmultiobjecttracker.so` | Balanced performance with medium/high accuracy detectors | Very Low | Medium |
| **NvDCF** | `libnvds_nvmultiobjecttracker.so` | High accuracy, robust against occlusion, supports PGIE interval > 0 | Medium | High |
| **NvDeepSORT** | `libnvds_nvmultiobjecttracker.so` | Re-identification, objects with similar appearance | Low | High |
| **MaskTracker** | `libnvds_nvmultiobjecttracker.so` | Precise segmentation + tracking using SAM2 (Developer Preview) | High | Very High |

**Library Location**: `/opt/nvidia/deepstream/deepstream/lib/libnvds_nvmultiobjecttracker.so`

---

## GObject Properties

### Required Properties

| Property | Type | Description |
|----------|------|-------------|
| `ll-lib-file` | string | Path to low-level tracker library |
| `ll-config-file` | string | Path to tracker configuration file. When sub-batches are used, specify multiple configs delimited by semicolon |

### Optional Properties

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `tracker-width` | int | 0 | Tracker input width in pixels (0=auto) |
| `tracker-height` | int | 0 | Tracker input height in pixels (0=auto) |
| `gpu-id` | int | 0 | GPU device ID |
| `display-tracking-id` | int | 1 | Show tracking ID in OSD (0/1) |
| `tracking-id-reset-mode` | int | 0 | ID reset behavior: 0=no reset, 1=reset on stream reset, 2=reset on EOS, 3=both |
| `tracking-surface-type` | int | 0 | Surface type for tracking |
| `compute-hw` | int | 0 | Compute engine for scaling: 0=Default, 1=GPU, 2=VIC (Jetson only) |
| `input-tensor-meta` | int | 0 | Use tensor metadata from upstream (nvdspreprocess) |
| `tensor-meta-gie-id` | int | -1 | GIE ID for tensor metadata (valid only if input-tensor-meta=1) |
| `user-meta-pool-size` | int | 16 | Tracker user metadata buffer pool size. Increase if you see "Unable to acquire a user meta buffer" warning |
| `sub-batches` | string | - | Sub-batch configuration (see Sub-batching section) |
| `sub-batch-err-recovery-trial-cnt` | int | 3 | Max reinit trials on sub-batch error. -1=infinite |

### Usage Example

```python
pipeline.add("nvtracker", "tracker", {
    "ll-lib-file": "/opt/nvidia/deepstream/deepstream/lib/libnvds_nvmultiobjecttracker.so",
    "ll-config-file": "/opt/nvidia/deepstream/deepstream/samples/configs/deepstream-app/config_tracker_NvDCF_perf.yml",
    "tracker-width": 640,
    "tracker-height": 384,
    "gpu-id": 0,
    "display-tracking-id": 1
})
```

---

## Sub-batching

The sub-batching feature allows splitting the input frame batch into multiple sub-batches, each processed by a **separate instance** of the low-level tracker library on dedicated threads. This enables:

- **Parallel processing** to minimize GPU idling due to CPU compute blocks
- **Different configs per sub-batch** (different algorithms, backends, parameters)
- **Scaling beyond 128 streams** (VPI backend limit per instance)

### Configuration Options

**Option 1: Static source-to-sub-batch mapping**
```
# Semicolon-delimited arrays of source IDs
sub-batches=0,1;2,3
# Sources 0,1 -> sub-batch 0; Sources 2,3 -> sub-batch 1
```

**Option 2: Dynamic sub-batch sizing**
```
# Colon-delimited sub-batch sizes
sub-batches=2:2
# Two sub-batches, each accommodating up to 2 streams
```

### Multiple Config Files with Sub-batches

When sub-batches are configured, specify one config file per sub-batch using semicolons:
```
ll-config-file=config_tracker_NvDCF_accuracy.yml;config_tracker_NvSORT.yml;config_tracker_IOU.yml
sub-batches=0,1;2;3
```

### Use Case: Mixed Algorithms
```ini
[tracker]
enable=1
tracker-width=960
tracker-height=544
ll-lib-file=/opt/nvidia/deepstream/deepstream/lib/libnvds_nvmultiobjecttracker.so
ll-config-file=config_tracker_NvDCF_accuracy.yml;config_tracker_NvSORT.yml
sub-batches=0,1;2,3
```

### Use Case: PVA Backend on Jetson
```ini
[tracker]
ll-config-file=config_tracker_NvDCF_accuracy.yml;config_tracker_NvDCF_accuracy_PVA.yml
sub-batches=0,1;2,3
```

> **Note**: The optimal sub-batches configuration depends on pipeline elements, hardware config, etc. Start with a single batch and keep splitting until an optimal performance point is reached.

---

## Tracker Configuration File (YAML)

The low-level tracker configuration is a YAML file with the following sections.

### Configuration File Structure

```yaml
%YAML:1.0

BaseConfig:
  minDetectorConfidence: 0.0

TargetManagement:
  maxTargetsPerStream: 150
  probationAge: 4
  maxShadowTrackingAge: 38
  earlyTerminationAge: 1

TrajectoryManagement:
  useUniqueID: 0

DataAssociator:
  dataAssociatorType: 0
  associationMatcherType: 0  # GREEDY=0, CASCADED=1

StateEstimator:
  stateEstimatorType: 0  # DUMMY=0, SIMPLE=1, REGULAR=2, SIMPLE_LOC=3

# Algorithm-specific sections (only one active):
VisualTracker:    # For NvDCF
ReID:             # For NvDeepSORT or NvDCF with Re-Assoc
Segmenter:        # For MaskTracker

# SV3DT-specific sections (NvDCF with stateEstimatorType=3):
ObjectModelProjection:  # Camera model + 3D projection output
PoseEstimator:          # Body pose estimation for 3D height
```

---

## Configuration Sections Reference

### BaseConfig

| Parameter | Type | Default | Description | Dynamic |
|-----------|------|---------|-------------|---------|
| `minDetectorConfidence` | float | 0.0 | Detections below this confidence are discarded | Yes |

### TargetManagement

Controls the lifecycle of tracked targets through three states: **Tentative** -> **Active** -> **Inactive** (shadow tracking).

| Parameter | Type | Description | Dynamic |
|-----------|------|-------------|---------|
| `maxTargetsPerStream` | int | Max targets per stream (includes shadow-tracked). Pre-allocates GPU memory | No |
| `preserveStreamUpdateOrder` | bool | Deterministic ID order across runs (single-threaded update) | No |
| `enableBboxUnClipping` | bool | Restore bboxes clipped by image border | Yes |
| `minIouDiff4NewTarget` | float | New detection is discarded if IOU with any existing target exceeds this | Yes |
| `minTrackerConfidence` | float | Below this confidence, target enters shadow mode [0.0, 1.0] | Yes |
| `probationAge` | int | Frames in Tentative mode before target becomes Active (Late Activation) | Yes |
| `maxShadowTrackingAge` | int | Max frames of shadow tracking before termination | Yes |
| `earlyTerminationAge` | int | If shadowTrackingAge reaches this during Tentative period, target is terminated early | Yes |
| `searchRegionPaddingScale` | float | Search region size as multiple of bbox diagonal (NvDCF) | Yes |
| `outputTerminatedTracks` | bool | Export terminated track history to metadata | No |
| `outputShadowTracks` | bool | Export shadow track data to metadata | No |
| `terminatedTrackFilename` | string | File prefix for saving terminated tracks | No |

#### Target State Transitions

```
  New Detection -> [Tentative] ---- (survives probationAge) ---> [Active]
                      |                                            |
                      | (earlyTerminationAge)                      | (no detection match for a while,
                      v                                            |  or confidence < minTrackerConfidence)
                  [Terminated]                                     v
                                                              [Inactive / Shadow]
                                                                   |
                                                                   | (maxShadowTrackingAge exceeded)
                                                                   v
                                                              [Terminated]
```

### TrajectoryManagement

Controls unique ID generation and target re-association.

| Parameter | Type | Description |
|-----------|------|-------------|
| `useUniqueID` | bool | Use 64-bit unique ID (random upper 32-bit per stream + sequential lower 32-bit) |
| `enableReAssoc` | bool | Enable motion-based target re-association |
| `minMatchingScore4Overall` | float | Min total score for re-association |
| `minTrackletMatchingScore` | float | Min tracklet IOU similarity for re-association |
| `minMatchingScore4ReidSimilarity` | float | Min ReID score for re-association |
| `matchingScoreWeight4TrackletSimilarity` | float | Weight for tracklet similarity in re-association |
| `matchingScoreWeight4ReidSimilarity` | float | Weight for ReID similarity in re-association |
| `minTrajectoryLength4Projection` | int | Min tracklet length to create projected trajectory |
| `prepLength4TrajectoryProjection` | int | Trajectory length used for projection state estimation |
| `trajectoryProjectionLength` | int | Length of projected trajectory |
| `maxAngle4TrackletMatching` | float | Max angle difference for tracklet matching [degrees] |
| `minSpeedSimilarity4TrackletMatching` | float | Min speed similarity for tracklet matching |
| `minBboxSizeSimilarity4TrackletMatching` | float | Min bbox size similarity for tracklet matching |
| `maxTrackletMatchingTimeSearchRange` | int | Time search range for tracklet matching |
| `trajectoryProjectionProcessNoiseScale` | float | Process noise scale for trajectory projection |
| `trajectoryProjectionMeasurementNoiseScale` | float | Measurement noise scale for trajectory projection |
| `trackletSpacialSearchRegionScale` | float | Spatial search region for peer tracklet |
| `reidExtractionInterval` | int | Frame interval for ReID feature extraction per target. -1=first frame only |

### DataAssociator

| Parameter | Type | Default | Description | Dynamic |
|-----------|------|---------|-------------|---------|
| `dataAssociatorType` | int | 0 | Data associator type {DEFAULT=0} | No |
| `associationMatcherType` | int | 0 | Matching algorithm {GREEDY=0, CASCADED=1} | No |
| `checkClassMatch` | bool | true | Only associate same-class objects | No |
| `usePrediction4Assoc` | bool | false | Use predicted state for association instead of last known state | Yes |
| **Similarity Thresholds** |||||
| `minMatchingScore4Overall` | float | 0.0 | Min total matching score | Yes |
| `minMatchingScore4SizeSimilarity` | float | 0.0 | Min bbox size similarity | Yes |
| `minMatchingScore4Iou` | float | 0.0 | Min IOU score | Yes |
| `minMatchingScore4VisualSimilarity` | float | 0.0 | Min visual similarity (NvDCF only) | Yes |
| `minMatchingScore4ReidSimilarity` | float | 0.0 | Min ReID similarity (NvDeepSORT only) | Yes |
| **Similarity Weights** |||||
| `matchingScoreWeight4Iou` | float | 1.0 | Weight for IOU | Yes |
| `matchingScoreWeight4SizeSimilarity` | float | 0.0 | Weight for size similarity | Yes |
| `matchingScoreWeight4VisualSimilarity` | float | 0.0 | Weight for visual similarity (NvDCF) | Yes |
| `matchingScoreWeight4ReidSimilarity` | float | 0.0 | Weight for ReID similarity (NvDeepSORT) | Yes |
| **Tentative Detection** |||||
| `tentativeDetectorConfidence` | float | 0.5 | Below this but above minDetectorConfidence = tentative detection | Yes |
| `minMatchingScore4TentativeIou` | float | 0.0 | Min IOU for tentative detection matching | Yes |
| **Mahalanobis Distance (NvDeepSORT)** |||||
| `thresholdMahalanobis` | float | -1.0 | Max Mahalanobis distance. Negative = disabled | Yes |

#### Cascaded Data Association (associationMatcherType: 1)

The cascaded matcher performs multi-stage matching with different priorities:

1. **Stage 1**: Confirmed detections <-> validated targets (joint similarity metrics)
2. **Stage 2**: Tentative detections <-> remaining active targets (IOU only)
3. **Stage 3**: Remaining confirmed detections <-> tentative targets (IOU only)

Total matching score formula:

`totalScore = w_iou * IOU + w_size * sizeSimilarity + w_reid * reidSimilarity + w_visual * visualSimilarity`

### StateEstimator

| Parameter | Type | Description |
|-----------|------|-------------|
| `stateEstimatorType` | int | Estimator type: **DUMMY=0**, **SIMPLE_BBOX_KF=1**, **REGULAR_BBOX_KF=2**, **SIMPLE_LOCATION_KF=3** |

**SIMPLE_BBOX_KF (type=1)**: 6-state Kalman filter `{x, y, w, h, dx, dy}` with absolute noise values:

| Parameter | Description |
|-----------|-------------|
| `processNoiseVar4Loc` | Process noise for bbox center |
| `processNoiseVar4Size` | Process noise for bbox size |
| `processNoiseVar4Vel` | Process noise for velocity |
| `measurementNoiseVar4Detector` | Measurement noise from detector |
| `measurementNoiseVar4Tracker` | Measurement noise from visual tracker (NvDCF) |

**REGULAR_BBOX_KF (type=2)**: 8-state Kalman filter `{x, y, w, h, dx, dy, dw, dh}` with height-proportional noise:

| Parameter | Description |
|-----------|-------------|
| `noiseWeightVar4Loc` | Noise weight proportional to bbox height (location) |
| `noiseWeightVar4Vel` | Noise weight proportional to bbox height (velocity) |
| `useAspectRatio` | Use aspect ratio `a` instead of width `w` in state vector (used by NvDeepSORT) |

**SIMPLE_LOCATION_KF (type=3)**: 4-state Kalman filter `{x, y, dx, dy}` for 3D world coordinate tracking (SV3DT). Tracks the projected foot location in image space rather than bounding box. The bounding box is reconstructed by projecting a 3D cylinder model (from `ObjectModelProjection`) back onto the image. **Does NOT use `processNoiseVar4Size`** since bbox size is derived from the 3D model projection rather than estimated directly.

| Parameter | Description |
|-----------|-------------|
| `processNoiseVar4Loc` | Process noise for foot location in image space |
| `processNoiseVar4Vel` | Process noise for velocity |
| `measurementNoiseVar4Detector` | Measurement noise from detector |
| `measurementNoiseVar4Tracker` | Measurement noise from visual tracker (NvDCF) |

> **Note**: When using `stateEstimatorType: 3`, the `ObjectModelProjection` section is required. The `PoseEstimator` section is optional but recommended for more accurate height estimation.

### VisualTracker (NvDCF)

| Parameter | Type | Description | Dynamic |
|-----------|------|-------------|---------|
| `visualTrackerType` | int | **DUMMY=0**, **NvDCF_legacy=1**, **NvDCF_VPI=2** | No |
| `useColorNames` | bool | Use ColorNames feature (10 channels) | No |
| `useHog` | bool | Use HOG feature (18 channels) | No |
| `useHighPrecisionFeature` | bool | 16-bit precision (vs 8-bit) | No |
| `featureImgSizeLevel` | int | Feature image size {1=12x12, 2=18x18, 3=24x24, 4=30x30, 5=36x36} per channel | No |
| `featureFocusOffsetFactor_y` | float | Hanning window center Y offset [-0.5, 0.5]. Negative moves up (good for surveillance) | Yes |
| `filterLr` | float | DCF filter learning rate [0.0, 1.0] | Yes |
| `filterChannelWeightsLr` | float | Channel weights learning rate [0.0, 1.0] | Yes |
| `gaussianSigma` | float | Gaussian sigma for desired response [pixels] | Yes |
| `vpiBackend4DcfTracker` | int | VPI backend: **CUDA=1**, **PVA=2** (Jetson only). Valid when visualTrackerType=2 | No |

#### PVA Backend Limitations (VPI)
- Max 512 objects per tracker instance
- Max 33 streams per instance (use sub-batching for more)
- Only supports: `useColorNames: 1`, `useHog: 1`, `featureImgSizeLevel: 3`

### ReID (Re-Identification)

| Parameter | Type | Description |
|-----------|------|-------------|
| `reidType` | int | **DUMMY=0**, **NvDEEPSORT=1**, **REASSOC=2** (re-association only), **BOTH=3** |
| `batchSize` | int | ReID network batch size |
| `workspaceSize` | int | TensorRT workspace (MB) |
| `reidFeatureSize` | int | Output feature dimension |
| `reidHistorySize` | int | Max features kept per target (gallery size) |
| `inferDims` | [int] | Network input dims [C, H, W] |
| `networkMode` | int | Precision: FP32=0, FP16=1, INT8=2 |
| `inputOrder` | int | NCHW=0, NHWC=1 |
| `colorFormat` | int | RGB=0, BGR=1 |
| `offsets` | [float] | Per-channel subtraction values |
| `netScaleFactor` | float | Scale factor after offset: `y = netScaleFactor * (x - offsets)` |
| `keepAspc` | bool | Preserve aspect ratio when resizing |
| `useVPICropScaler` | bool | Use VPI for crop and scale |
| `addFeatureNormalization` | bool | L2 normalize output features |
| `minVisibility4GalleryUpdate` | float | Min visibility to add ReID embedding to gallery (SV3DT only, e.g. 0.6) |
| `outputReidTensor` | bool | Export ReID features to user meta |
| `tltEncodedModel` | string | TAO model path |
| `tltModelKey` | string | TAO model key |
| `onnxFile` | string | ONNX model path |
| `modelEngineFile` | string | Pre-built TensorRT engine path |
| `calibrationTableFile` | string | INT8 calibration table path |

### Segmenter (MaskTracker)

| Parameter | Type | Description |
|-----------|------|-------------|
| `segmenterType` | int | **DUMMY=0**, **SAM2=1** |
| `segmenterConfigPath` | string | Path to segmenter config (e.g., `config_tracker_module_Segmenter.yml`) |

The segmenter config file defines four TensorRT-accelerated sub-networks (ImageEncoder, MaskDecoder, MemoryAttention, MemoryEncoder) and memory management parameters. See MaskTracker section for details.

### ObjectModelProjection (SV3DT)

Used for Single-View 3D Tracking (SV3DT). Projects a 3D cylinder model onto the image plane using camera calibration to estimate per-object visibility, foot location, and convex hull. This enables the tracker to recover complete bounding boxes and foot positions even under partial occlusion.

| Parameter | Type | Description |
|-----------|------|-------------|
| `cameraModelFilepath` | list[string] | Camera calibration file path per stream (one entry per stream, ordered by stream index) |
| `outputVisibility` | bool | Output per-object visibility (0.0\~1.0) estimated from occlusion via 3D model |
| `outputFootLocation` | bool | Output foot location in image and world coordinates, estimated from 3D model projection |
| `outputConvexHull` | bool | Output convex hull vertices for each object estimated from 3D cylinder model |
| `minPoseConfidence` | float | Minimum pose keypoint confidence for adaptive height estimation (0.0\~1.0) |

**Camera Model File (`camInfo.yml`):**

The camera model file provides the 3x4 camera projection matrix and a cylinder model representing the tracked object (human). The projection matrix maps 3D world coordinates to 2D image coordinates.

```yaml
%YAML:1.0

# 3x4 camera projection matrix (row-major)
# Maps 3D world coordinates (X, Y, Z) to 2D image coordinates (u, v)
projectionMatrix_3x4:
  - 2582.5691623002185
  - -485.10283397043617
  - 650.27745033162591
  - -89466.605755471101
  - -423.46809686390498
  - 1044.6870098337931
  - 2461.1283636622838
  - -214284.36100320917
  - -0.25563255317172684
  - -0.90495941862094287
  - 0.34014768617197644
  - -1181.960782357068

# Cylinder model dimensions for human (cm)
modelInfo:
  height: 205    # Height of the cylinder model
  radius: 33     # Radius of the cylinder model
```

> **Note**: The camera must be **static** (fixed position and orientation). The projection matrix can be obtained through standard camera calibration procedures. For multi-stream setups, provide one `camInfo.yml` per camera in the `cameraModelFilepath` list.

### PoseEstimator (SV3DT)

Estimates 2D body pose to determine precise target height for the 3D cylinder model. Used in conjunction with `ObjectModelProjection` for SV3DT. When enabled, the BodyPose3DNet model infers key body joints to compute the actual individual height rather than using a fixed default height.

| Parameter | Type | Description |
|-----------|------|-------------|
| `poseEstimatorType` | int | **0**=Disabled (use fixed-height model, match head to bbox top edge), **1**=Enabled (use BodyPose3DNet for precise height estimation) |
| `useVPICropScaler` | bool | Use VPI backend for cropping and scaling |
| `batchSize` | int | Batch size for pose estimation inference |
| `workspaceSize` | int | TensorRT workspace size (MB) |
| `inferDims` | [int] | Network input dims [C, H, W], e.g. `[3, 256, 192]` |
| `networkMode` | int | Precision: FP32=0, FP16=1, INT8=2 |
| `inputOrder` | int | NCHW=0, NHWC=1 |
| `colorFormat` | int | RGB=0, BGR=1 |
| `offsets` | [float] | Per-channel subtraction values |
| `netScaleFactor` | float | Scale factor after offset subtraction |
| `onnxFile` | string | Path to BodyPose3DNet ONNX model |
| `modelEngineFile` | string | Pre-built TensorRT engine path |
| `poseInferenceInterval` | int | Frame interval for pose inference. **-1**=first frame only (determine height once per target, most efficient) |

> **Note**: When `poseEstimatorType: 0`, no pose model is needed. The tracker uses a fixed-height human model matching the head to the bbox top edge. This is less accurate but has zero additional compute cost. When `poseEstimatorType: 1`, the BodyPose3DNet model (`bodypose3dnet_accuracy.onnx`) is required.

---

## Tracker Algorithm Configurations

### IOU Tracker

**Best for**: Bare-minimum baseline, sparse objects, detector runs every frame.

```yaml
%YAML:1.0

BaseConfig:
  minDetectorConfidence: 0

TargetManagement:
  preserveStreamUpdateOrder: 0
  maxTargetsPerStream: 150
  minIouDiff4NewTarget: 0.5
  probationAge: 4
  maxShadowTrackingAge: 38
  earlyTerminationAge: 1

TrajectoryManagement:
  useUniqueID: 0

DataAssociator:
  dataAssociatorType: 0
  associationMatcherType: 0    # GREEDY
  checkClassMatch: 1
  minMatchingScore4Overall: 0.0
  minMatchingScore4SizeSimilarity: 0.0
  minMatchingScore4Iou: 0.0
  matchingScoreWeight4SizeSimilarity: 0.4
  matchingScoreWeight4Iou: 0.6
```

### NvSORT Tracker

**Best for**: Balanced performance with medium/high accuracy detectors. Uses Kalman filter + cascaded data association.

```yaml
%YAML:1.0

BaseConfig:
  minDetectorConfidence: 0.1345

TargetManagement:
  enableBboxUnClipping: 0
  maxTargetsPerStream: 300
  minIouDiff4NewTarget: 0.5780
  minTrackerConfidence: 0.8216
  probationAge: 5
  maxShadowTrackingAge: 26
  earlyTerminationAge: 1

TrajectoryManagement:
  useUniqueID: 0

DataAssociator:
  dataAssociatorType: 0
  associationMatcherType: 1    # CASCADED
  checkClassMatch: 1
  minMatchingScore4Overall: 0.2543
  minMatchingScore4SizeSimilarity: 0.4019
  minMatchingScore4Iou: 0.2159
  matchingScoreWeight4SizeSimilarity: 0.1365
  matchingScoreWeight4Iou: 0.3836
  tentativeDetectorConfidence: 0.2331
  minMatchingScore4TentativeIou: 0.2867
  usePrediction4Assoc: 1

StateEstimator:
  stateEstimatorType: 2    # REGULAR_BBOX_KF
  noiseWeightVar4Loc: 0.0301
  noiseWeightVar4Vel: 0.0017
  useAspectRatio: 1
```

### NvDCF Tracker (Performance)

**Best for**: High accuracy, robust against occlusions, supports PGIE interval > 0.

```yaml
%YAML:1.0

BaseConfig:
  minDetectorConfidence: 0.0430

TargetManagement:
  enableBboxUnClipping: 1
  preserveStreamUpdateOrder: 0
  maxTargetsPerStream: 150
  minIouDiff4NewTarget: 0.7418
  minTrackerConfidence: 0.4009
  probationAge: 2
  maxShadowTrackingAge: 51
  earlyTerminationAge: 1

TrajectoryManagement:
  useUniqueID: 0

DataAssociator:
  dataAssociatorType: 0
  associationMatcherType: 1    # CASCADED
  checkClassMatch: 1
  minMatchingScore4Overall: 0.4290
  minMatchingScore4SizeSimilarity: 0.3627
  minMatchingScore4Iou: 0.2575
  minMatchingScore4VisualSimilarity: 0.5356
  matchingScoreWeight4VisualSimilarity: 0.3370
  matchingScoreWeight4SizeSimilarity: 0.4354
  matchingScoreWeight4Iou: 0.3656
  tentativeDetectorConfidence: 0.2008
  minMatchingScore4TentativeIou: 0.5296

StateEstimator:
  stateEstimatorType: 1    # SIMPLE_BBOX_KF
  processNoiseVar4Loc: 1.5110
  processNoiseVar4Size: 1.3159
  processNoiseVar4Vel: 0.0300
  measurementNoiseVar4Detector: 3.0283
  measurementNoiseVar4Tracker: 8.1505

VisualTracker:
  visualTrackerType: 2    # NvDCF_VPI
  useColorNames: 1
  useHog: 0
  featureImgSizeLevel: 2
  featureFocusOffsetFactor_y: -0.2000
  filterLr: 0.0750
  filterChannelWeightsLr: 0.1000
  gaussianSigma: 0.7500
```

### NvDCF Tracker (Accuracy with Re-Association)

Enables Re-Association for long-term tracking with ReID.

```yaml
%YAML:1.0

BaseConfig:
  minDetectorConfidence: 0.1894

TargetManagement:
  enableBboxUnClipping: 1
  maxTargetsPerStream: 150
  minIouDiff4NewTarget: 0.3686
  minTrackerConfidence: 0.1513
  probationAge: 2
  maxShadowTrackingAge: 42
  earlyTerminationAge: 1

TrajectoryManagement:
  useUniqueID: 0
  enableReAssoc: 1
  minMatchingScore4Overall: 0.6622
  minTrackletMatchingScore: 0.2940
  minMatchingScore4ReidSimilarity: 0.0771
  matchingScoreWeight4TrackletSimilarity: 0.7981
  matchingScoreWeight4ReidSimilarity: 0.3848
  minTrajectoryLength4Projection: 34
  prepLength4TrajectoryProjection: 58
  trajectoryProjectionLength: 33
  maxAngle4TrackletMatching: 67
  minSpeedSimilarity4TrackletMatching: 0.0574
  minBboxSizeSimilarity4TrackletMatching: 0.1013
  maxTrackletMatchingTimeSearchRange: 27
  trajectoryProjectionProcessNoiseScale: 0.0100
  trajectoryProjectionMeasurementNoiseScale: 100
  trackletSpacialSearchRegionScale: 0.0100
  reidExtractionInterval: 8

DataAssociator:
  dataAssociatorType: 0
  associationMatcherType: 1    # CASCADED
  checkClassMatch: 1
  minMatchingScore4Overall: 0.0222
  minMatchingScore4SizeSimilarity: 0.3552
  minMatchingScore4Iou: 0.0548
  minMatchingScore4VisualSimilarity: 0.5043
  matchingScoreWeight4VisualSimilarity: 0.3951
  matchingScoreWeight4SizeSimilarity: 0.6003
  matchingScoreWeight4Iou: 0.4033
  tentativeDetectorConfidence: 0.1024
  minMatchingScore4TentativeIou: 0.2852

StateEstimator:
  stateEstimatorType: 1    # SIMPLE_BBOX_KF
  processNoiseVar4Loc: 6810.8668
  processNoiseVar4Size: 1541.8647
  processNoiseVar4Vel: 1348.4874
  measurementNoiseVar4Detector: 100.0000
  measurementNoiseVar4Tracker: 293.3238

VisualTracker:
  visualTrackerType: 2    # NvDCF_VPI
  useColorNames: 1
  useHog: 1
  featureImgSizeLevel: 3
  featureFocusOffsetFactor_y: -0.1054
  filterLr: 0.0767
  filterChannelWeightsLr: 0.0339
  gaussianSigma: 0.5687

ReID:
  reidType: 2    # REASSOC only
  batchSize: 100
  workspaceSize: 1000
  reidFeatureSize: 256
  reidHistorySize: 100
  inferDims: [3, 256, 128]
  networkMode: 1    # FP16
  inputOrder: 0
  colorFormat: 0
  offsets: [123.6750, 116.2800, 103.5300]
  netScaleFactor: 0.01735207
  keepAspc: 1
  useVPICropScaler: 1
  addFeatureNormalization: 1
  tltEncodedModel: "/opt/nvidia/deepstream/deepstream/samples/models/Tracker/resnet50_market1501.etlt"
  tltModelKey: "nvidia_tao"
```

### NvDeepSORT Tracker

**Best for**: Re-identification across views, objects with similar appearance. Requires a Re-ID model.

```yaml
%YAML:1.0

BaseConfig:
  minDetectorConfidence: 0.0762

TargetManagement:
  preserveStreamUpdateOrder: 0
  maxTargetsPerStream: 150
  minIouDiff4NewTarget: 0.9847
  minTrackerConfidence: 0.4314
  probationAge: 2
  maxShadowTrackingAge: 68
  earlyTerminationAge: 1

TrajectoryManagement:
  useUniqueID: 0

DataAssociator:
  dataAssociatorType: 0
  associationMatcherType: 1    # CASCADED
  checkClassMatch: 1
  thresholdMahalanobis: 12.1875
  minMatchingScore4Overall: 0.1794
  minMatchingScore4SizeSimilarity: 0.3291
  minMatchingScore4Iou: 0.2364
  minMatchingScore4ReidSimilarity: 0.7505
  matchingScoreWeight4SizeSimilarity: 0.7178
  matchingScoreWeight4Iou: 0.4551
  matchingScoreWeight4ReidSimilarity: 0.3197
  tentativeDetectorConfidence: 0.2479
  minMatchingScore4TentativeIou: 0.2376

StateEstimator:
  stateEstimatorType: 2    # REGULAR_BBOX_KF
  noiseWeightVar4Loc: 0.0503
  noiseWeightVar4Vel: 0.0037
  useAspectRatio: 1

ReID:
  reidType: 1    # NvDEEPSORT
  batchSize: 100
  workspaceSize: 1000
  reidFeatureSize: 256
  reidHistorySize: 100
  inferDims: [3, 256, 128]
  networkMode: 1    # FP16
  inputOrder: 0
  colorFormat: 0
  offsets: [123.6750, 116.2800, 103.5300]
  netScaleFactor: 0.01735207
  keepAspc: 1
  useVPICropScaler: 1
  addFeatureNormalization: 1
  tltEncodedModel: "/opt/nvidia/deepstream/deepstream/samples/models/Tracker/resnet50_market1501.etlt"
  tltModelKey: "nvidia_tao"
  modelEngineFile: "/opt/nvidia/deepstream/deepstream/samples/models/Tracker/resnet50_market1501.etlt_b100_gpu0_fp16.engine"
```

**Setup ReID model:**
```bash
mkdir -p /opt/nvidia/deepstream/deepstream/samples/models/Tracker/
wget 'https://api.ngc.nvidia.com/v2/models/nvidia/tao/reidentificationnet/versions/deployable_v1.0/files/resnet50_market1501.etlt' \
  -P /opt/nvidia/deepstream/deepstream/samples/models/Tracker/
```

### MaskTracker (Developer Preview)

**Best for**: Precise object segmentation + tracking using SAM2. Works with diverse object classes.

```yaml
%YAML:1.0

BaseConfig:
  minDetectorConfidence: 0.3529

TargetManagement:
  enableBboxUnClipping: 1
  preserveStreamUpdateOrder: 0
  maxTargetsPerStream: 150
  minIouDiff4NewTarget: 0.7608
  minTrackerConfidence: 0.6223
  probationAge: 4
  maxShadowTrackingAge: 84
  earlyTerminationAge: 1

DataAssociator:
  dataAssociatorType: 0
  associationMatcherType: 1    # CASCADED
  checkClassMatch: 1
  minMatchingScore4Overall: 0.0293
  minMatchingScore4SizeSimilarity: 0.1047
  minMatchingScore4Iou: 0.0437
  matchingScoreWeight4SizeSimilarity: 0.2410
  matchingScoreWeight4Iou: 0.8590
  tentativeDetectorConfidence: 0.1866
  minMatchingScore4TentativeIou: 0.3660

TrajectoryManagement:
  useUniqueID: 0

StateEstimator:
  stateEstimatorType: 1    # SIMPLE_BBOX_KF
  processNoiseVar4Loc: 2856.7104
  processNoiseVar4Size: 8157.1946
  processNoiseVar4Vel: 2602.8703
  measurementNoiseVar4Detector: 0.1000
  measurementNoiseVar4Tracker: 8.6695

Segmenter:
  segmenterType: 1    # SAM2
  segmenterConfigPath: "/opt/nvidia/deepstream/deepstream/samples/configs/deepstream-app/config_tracker_module_Segmenter.yml"
```

**Setup SAM2 model:**
```bash
git clone https://github.com/NVIDIA-AI-IOT/deepstream_tools.git
cd deepstream_tools/sam2-onnx-tensorrt
bash run.sh
```

The segmentation mask is stored in `mask_params` field of `NvDsObjectMeta`. Set `display-mask=1` in OSD config to visualize.

### NvDCF 3D Tracker (SV3DT)

**Best for**: Tracking people in 3D physical world coordinates from a static camera. Estimates foot location, body visibility, and convex hull using camera calibration and a 3D cylinder human model. Recovers complete bounding boxes even under partial occlusion.

**Overview**: Single-View 3D Tracking (SV3DT) extends NvDCF with 3D state estimation. Instead of tracking bounding box coordinates directly, it tracks object positions in 3D world coordinates by projecting a cylinder model using the camera projection matrix. Key capabilities:

- **3D world coordinate tracking**: Estimates object foot position in real-world coordinates
- **Occlusion-aware bounding box recovery**: Reconstructs complete bounding boxes from partially occluded objects
- **Visibility estimation**: Computes per-object visibility ratio (0.0\~1.0) based on mutual occlusion
- **Convex hull output**: Provides projected 3D model convex hull vertices for each tracked object
- **Pose-based height estimation**: Optionally uses BodyPose3DNet to determine individual person height

**Prerequisites**:
- Static camera with known camera projection matrix (`camInfo.yml`)
- PeopleNet or similar person detector as PGIE
- ReID model (e.g., `resnet50_market1501.etlt`) for re-association
- BodyPose3DNet ONNX model (optional, for `poseEstimatorType: 1`)

**Setup models:**
```bash
# peoplenet model
mkdir -p PeopleNet
cd PeopleNet; wget --no-check-certificate --content-disposition https://api.ngc.nvidia.com/v2/models/nvidia/tao/peoplenet/versions/deployable_quantized_onnx_v2.6.3/zip -O peoplenet_deployable_quantized_onnx_v2.6.3.zip; unzip peoplenet_deployable_quantized_onnx_v2.6.3.zip
```

The model files are now stored in PeopleNet directory as

```
PeopleNet
  ├── labels.txt
  ├── resnet34_peoplenet.onnx
  └── ...
```

```bash
mkdir -p /opt/nvidia/deepstream/deepstream/samples/models/Tracker/

# ReID model
wget 'https://api.ngc.nvidia.com/v2/models/nvidia/tao/reidentificationnet/versions/deployable_v1.0/files/resnet50_market1501.etlt' \
  -P /opt/nvidia/deepstream/deepstream/samples/models/Tracker/

# BodyPose3DNet model (for poseEstimatorType: 1)
wget 'https://api.ngc.nvidia.com/v2/models/nvidia/tao/bodypose3dnet/versions/deployable_accuracy_onnx_1.0/files/bodypose3dnet_accuracy.onnx' \
  -P /opt/nvidia/deepstream/deepstream/samples/models/Tracker/
```

**Full Configuration (`config_tracker_NvDCF_accuracy_3D.yml`):**

```yaml
%YAML:1.0

BaseConfig:
  minDetectorConfidence: 0.1894

TargetManagement:
  enableBboxUnClipping: 1
  preserveStreamUpdateOrder: 0
  maxTargetsPerStream: 150
  minIouDiff4NewTarget: 0.3686
  minTrackerConfidence: 0.1513
  probationAge: 2
  maxShadowTrackingAge: 42
  earlyTerminationAge: 1
  # Export terminated tracklets
  outputTerminatedTracks: 1
  terminatedTrackFilename: track_dump_

TrajectoryManagement:
  useUniqueID: 0
  enableReAssoc: 1
  minMatchingScore4Overall: 0.6622
  minTrackletMatchingScore: 0.2940
  minMatchingScore4ReidSimilarity: 0.0771
  matchingScoreWeight4TrackletSimilarity: 0.7981
  matchingScoreWeight4ReidSimilarity: 0.3848
  minTrajectoryLength4Projection: 34
  prepLength4TrajectoryProjection: 58
  trajectoryProjectionLength: 33
  maxAngle4TrackletMatching: 67
  minSpeedSimilarity4TrackletMatching: 0.0574
  minBboxSizeSimilarity4TrackletMatching: 0.1013
  maxTrackletMatchingTimeSearchRange: 27
  trajectoryProjectionProcessNoiseScale: 0.0100
  trajectoryProjectionMeasurementNoiseScale: 100
  trackletSpacialSearchRegionScale: 0.0100
  reidExtractionInterval: 8

DataAssociator:
  dataAssociatorType: 0
  associationMatcherType: 1    # CASCADED
  checkClassMatch: 1
  minMatchingScore4Overall: 0.0222
  minMatchingScore4SizeSimilarity: 0.3552
  minMatchingScore4Iou: 0.0548
  minMatchingScore4VisualSimilarity: 0.5043
  matchingScoreWeight4VisualSimilarity: 0.3951
  matchingScoreWeight4SizeSimilarity: 0.6003
  matchingScoreWeight4Iou: 0.4033
  tentativeDetectorConfidence: 0.1024
  minMatchingScore4TentativeIou: 0.2852

StateEstimator:
  stateEstimatorType: 3    # SIMPLE_LOCATION_KF (3D)
  # Note: NO processNoiseVar4Size (bbox size derived from 3D model projection)
  processNoiseVar4Loc: 6810.8668
  processNoiseVar4Vel: 1348.4874
  measurementNoiseVar4Detector: 100.0000
  measurementNoiseVar4Tracker: 293.3238

ObjectModelProjection:
  cameraModelFilepath:    # one camInfo.yml per stream
    - configs/camInfo.yml
  outputVisibility: 1
  outputFootLocation: 1
  outputConvexHull: 1
  minPoseConfidence: 0.5

VisualTracker:
  visualTrackerType: 2    # NvDCF_VPI
  vpiBackend4DcfTracker: 1    # CUDA
  useColorNames: 1
  useHog: 1
  featureImgSizeLevel: 3
  featureFocusOffsetFactor_y: -0.1054
  filterLr: 0.0767
  filterChannelWeightsLr: 0.0339
  gaussianSigma: 0.5687

ReID:
  reidType: 2    # REASSOC only
  batchSize: 100
  workspaceSize: 1000
  reidFeatureSize: 256
  reidHistorySize: 100
  inferDims: [3, 256, 128]
  networkMode: 1    # FP16
  inputOrder: 0
  colorFormat: 0
  offsets: [123.6750, 116.2800, 103.5300]
  netScaleFactor: 0.01735207
  keepAspc: 1
  useVPICropScaler: 1
  addFeatureNormalization: 1
  minVisibility4GalleryUpdate: 0.6    # Only update ReID gallery when visibility >= 0.6
  tltEncodedModel: "/opt/nvidia/deepstream/deepstream/samples/models/Tracker/resnet50_market1501.etlt"
  tltModelKey: "nvidia_tao"
  modelEngineFile: "/opt/nvidia/deepstream/deepstream/samples/models/Tracker/resnet50_market1501.etlt_b100_gpu0_fp16.engine"

PoseEstimator:
  poseEstimatorType: 1    # 1=BodyPose3DNet, 0=disabled (fixed height)
  useVPICropScaler: 1
  batchSize: 1
  workspaceSize: 1000
  inferDims: [3, 256, 192]
  networkMode: 1    # FP16
  inputOrder: 0
  colorFormat: 0
  offsets: [123.6750, 116.2800, 103.5300]
  netScaleFactor: 0.00392156
  onnxFile: "/opt/nvidia/deepstream/deepstream/samples/models/Tracker/bodypose3dnet_accuracy.onnx"
  modelEngineFile: "/opt/nvidia/deepstream/deepstream/samples/models/Tracker/bodypose3dnet_accuracy.onnx_b1_gpu0_fp16.engine"
  poseInferenceInterval: -1    # -1 = first frame only (determine height once per target)
```

> **Key Differences from Standard NvDCF Accuracy Config:**
> - `stateEstimatorType: 3` instead of `1` — uses 3D location KF instead of bbox KF
> - `StateEstimator` has NO `processNoiseVar4Size` — bbox size is derived from the 3D model projection, not estimated
> - `ObjectModelProjection` section — camera calibration and 3D output controls
> - `PoseEstimator` section — optional body pose for height estimation
> - `minVisibility4GalleryUpdate: 0.6` in `ReID` — prevents occluded appearances from corrupting the gallery
> - `outputTerminatedTracks: 1` + `terminatedTrackFilename` — exports track history for evaluation

#### Multi-Stream Camera Configuration

For multi-stream setups, provide one camera calibration file per stream in the `cameraModelFilepath` list:

```yaml
ObjectModelProjection:
  cameraModelFilepath:
    - configs/camInfo_stream0.yml    # stream 0
    - configs/camInfo_stream1.yml    # stream 1
    - configs/camInfo_stream2.yml    # stream 2
  outputVisibility: 1
  outputFootLocation: 1
  outputConvexHull: 1
  minPoseConfidence: 0.5
```

Each camera must have its own calibrated projection matrix since cameras have different positions and orientations.

#### SV3DT Output Formats

**MOT Format** (`track_dump_<stream_id>.txt`):

When `outputTerminatedTracks: 1` and `terminatedTrackFilename` are set, terminated tracklets are saved in extended MOT format:

```
<frame>, <id>, <bb_left>, <bb_top>, <bb_width>, <bb_height>, <conf>, <foot_world_x>, <foot_world_y>, <class_id>, -1, <visibility>, <foot_image_x>, <foot_image_y>, <convex_hull_points...>
```

| Field | Description |
|-------|-------------|
| `frame` | Frame number |
| `id` | Target tracking ID |
| `bb_left, bb_top, bb_width, bb_height` | Recovered bounding box (complete, not clipped by occlusion) |
| `conf` | Detection confidence |
| `foot_world_x, foot_world_y` | Foot location in 3D world coordinates |
| `class_id` | Object class ID |
| `visibility` | Visibility ratio (0.0\~1.0), where 1.0 = fully visible |
| `foot_image_x, foot_image_y` | Foot location in image coordinates |
| `convex_hull_points` | Convex hull vertex coordinates from 3D cylinder projection |

**KITTI Format** (`track_results/` directory):

Track results can also be exported in KITTI tracking format for evaluation with standard benchmarks.

---

## Tracker Comparisons and Tradeoffs

| Tracker | GPU Usage | Accuracy | Visual Features | Key Advantage | Best Use Case |
|---------|-----------|----------|-----------------|---------------|---------------|
| **IOU** | Very Low | Low | No | Lightest weight | Sparse objects, detector every frame |
| **NvSORT** | Very Low | Medium | No | Kalman + cascaded matching | Medium/high accuracy detectors |
| **NvDCF** | Medium | High | DCF correlation filter | Robust to occlusion, supports PGIE interval > 0, tracker confidence output | Complex scenes, partial occlusion |
| **NvDeepSORT** | Low | High | Re-ID network | Discriminative appearance matching | Similar-looking objects, multi-camera |
| **MaskTracker** | High | Very High | SAM2 segmentation | Precise segmentation masks, works across object classes | Segmentation + tracking, diverse objects |
| **NvDCF 3D (SV3DT)** | Medium-High | High | DCF + 3D model + optional pose | 3D world tracking, occlusion-aware bbox, foot location | Static camera surveillance, people tracking in physical space |

> **Note**: IOU and NvSORT do not require video frame data (only bounding boxes). NvDCF and NvDeepSORT require NV12 or RGBA frames. MaskTracker requires frames for SAM2 inference.

> **tracker_confidence**: Only NvDCF generates per-object tracker confidence values. For IOU, NvSORT, NvDeepSORT, and MaskTracker, `tracker_confidence` is set to `1.0` by default.

---

## Dynamic Runtime Configuration

The tracker supports parameter updates at runtime without restarting the pipeline. Only parameters marked as **Dynamic=Yes** in the tables above are supported.

### REST API

```bash
curl -XPOST 'http://localhost:9000/api/v1/nvtracker/config-path' -d '{
  "stream": {
    "stream_id": "0",
    "config_path": "trackerUpdate.yaml"
  }
}'
```

### GStreamer Event

Use `gst_nvevent_nvtracker_config_update` to trigger a config update from within the application.

### C++ API

`NvMOT_UpdateParams(contextHandle, configStr)` accepts a YAML config string directly (no file on disk required).

### Control Section (Dynamic Only)

```yaml
Control:
  tracker-reset: 1  # Soft reset: removes all tracks and track history
```

> **Note**: Reconfiguring any stream in a batch re-configures all streams in that batch/sub-batch.

---

## Pipeline Integration

### Basic Usage

```python
from pyservicemaker import Pipeline
import platform

def tracking_pipeline(video_path, infer_config):
    pipeline = Pipeline("tracking-pipeline")

    # Source and decoding
    pipeline.add("filesrc", "src", {"location": video_path})
    pipeline.add("h264parse", "parser")
    pipeline.add("nvv4l2decoder", "decoder")
    pipeline.add("nvstreammux", "mux", {"batch-size": 1, "width": 1920, "height": 1080})

    # Inference
    pipeline.add("nvinfer", "pgie", {"config-file-path": infer_config})

    # Tracker
    pipeline.add("nvtracker", "tracker", {
        "ll-lib-file": "/opt/nvidia/deepstream/deepstream/lib/libnvds_nvmultiobjecttracker.so",
        "ll-config-file": "/opt/nvidia/deepstream/deepstream/samples/configs/deepstream-app/config_tracker_NvDCF_perf.yml",
        "tracker-width": 640,
        "tracker-height": 384
    })

    # Display
    pipeline.add("nvosdbin", "osd")
    sink_type = "nv3dsink" if platform.processor() == "aarch64" else "nveglglessink"
    pipeline.add(sink_type, "sink")

    # Link
    pipeline.link("src", "parser", "decoder")
    pipeline.link(("decoder", "mux"), ("", "sink_%u"))
    pipeline.link("mux", "pgie", "tracker", "osd", "sink")

    pipeline.start().wait()
```

### SV3DT (Single-View 3D Tracking) with PeopleNet

SV3DT reuses the `tracking_pipeline` structure above -- only the PGIE config and the `nvtracker` properties change. Splice these settings into that pipeline (do **not** call this snippet on its own; it assumes `pipeline`, `MUX_WIDTH`, and `MUX_HEIGHT` from the surrounding `tracking_pipeline` definition):

```python
# Call as: tracking_pipeline(video_path, "config_pgie_peoplenet.yml")
# Then override the tracker block with the 3D config below.

# --- nvtracker overrides for SV3DT ---
# Replace the "tracker" element added in tracking_pipeline with:
pipeline.add("nvtracker", "tracker", {
    # 3D tracker library + config (from deepstream_reference_apps/deepstream-tracker-3d)
    "ll-lib-file": "/opt/nvidia/deepstream/deepstream/lib/libnvds_nvmultiobjecttracker.so",
    "ll-config-file": "config_tracker_NvDCF_accuracy_3D.yml",  # references camInfo.yml

    # SV3DT requires tracker dimensions to match the muxer / camera calibration,
    # not the inference input -- otherwise the 3D cylinder projection is wrong.
    "tracker-width": MUX_WIDTH,    # e.g. 1920
    "tracker-height": MUX_HEIGHT,  # e.g. 1080

    "gpu-id": 0,
    "display-tracking-id": 1,
})
```

**Key deltas vs. the basic `tracking_pipeline`:**

| Property | Basic NvDCF | SV3DT |
|----------|-------------|-------|
| `ll-config-file` | `config_tracker_NvDCF_perf.yml` | `config_tracker_NvDCF_accuracy_3D.yml` (+ `camInfo.yml`) |
| `tracker-width` / `tracker-height` | Match inference (e.g. 640x384) | **Must match muxer/calibration** (e.g. 1920x1080) |
| PGIE | Any detector | PeopleNet (SV3DT models humans) |

### Accessing Tracking Data

```python
from pyservicemaker import BatchMetadataOperator

class TrackingAnalyzer(BatchMetadataOperator):
    def handle_metadata(self, batch_meta):
        for frame_meta in batch_meta.frame_items:
            print(f"Frame {frame_meta.frame_number}:")

            for obj_meta in frame_meta.object_items:
                print(f"  Object: class={obj_meta.class_id}, "
                      f"object_id={obj_meta.object_id}, "
                      f"confidence={obj_meta.confidence:.2f}, "
                      f"tracker_confidence={obj_meta.tracker_confidence:.2f}")
```

---

## Performance Tuning

### Tracker Dimensions

Match tracker dimensions to inference input for best performance:

```python
# If inference uses 960x544, match tracker
pipeline.add("nvtracker", "tracker", {
    "tracker-width": 960,
    "tracker-height": 544,
    # ...
})
```

### Track Lifecycle Parameters

| Scene Type | maxShadowTrackingAge | probationAge | earlyTerminationAge |
|------------|---------------------|--------------|---------------------|
| Simple | 15 | 2 | 1 |
| Moderate | 30 | 3 | 1 |
| Complex/Occlusion | 60 | 5 | 2 |

### Memory Pre-allocation

Total GPU memory is proportional to: `(number of streams) x maxTargetsPerStream`. The library pre-allocates all memory during init -- no growth during runtime.

### Accuracy Tuning

DeepStream 7.0+ includes **PipeTuner** for automatic accuracy tuning. It explores the parameter space and finds optimal parameters for metrics like HOTA, MOTA, and IDF1.

---

## Miscellaneous Data Output

The tracker can output additional data via `NvDsTargetMiscDataBatch` (controlled by `user-meta-pool-size`):

| Data Type | Enable Config | Description |
|-----------|---------------|-------------|
| **Past-frame data** | `enablePastFrame: 1` | Tracked data from Tentative period, reported after activation |
| **Terminated tracks** | `outputTerminatedTracks: 1` | Full trajectory history for terminated targets |
| **Shadow tracks** | `outputShadowTracks: 1` | Shadow tracking target data (not otherwise visible) |

---

## Sample Configuration Files

```
/opt/nvidia/deepstream/deepstream/samples/configs/deepstream-app/
|-- config_tracker_IOU.yml                # Fast IOU tracker (GREEDY)
|-- config_tracker_NvSORT.yml             # NvSORT (CASCADED + Regular KF)
|-- config_tracker_NvDCF_max_perf.yml     # NvDCF maximum performance
|-- config_tracker_NvDCF_perf.yml         # NvDCF balanced performance
|-- config_tracker_NvDCF_accuracy.yml     # NvDCF highest accuracy (Re-Assoc + ReID)
|-- config_tracker_NvDeepSORT.yml         # NvDeepSORT with ReID
|-- config_tracker_MaskTracker.yml        # MaskTracker with SAM2
|-- config_tracker_module_Segmenter.yml   # Segmenter module config for MaskTracker

# SV3DT 3D Tracker config (from deepstream_reference_apps):
# https://github.com/NVIDIA-AI-IOT/deepstream_reference_apps/tree/master/deepstream-tracker-3d
|-- config_tracker_NvDCF_accuracy_3D.yml   # NvDCF 3D tracking (SV3DT)
|-- camInfo.yml                            # Camera calibration for SV3DT
```

---

## Common Issues

### Issue 1: Tracking IDs Not Appearing

**Cause**: OSD not configured to display tracking IDs.

**Solution**:
```python
pipeline.add("nvtracker", "tracker", {
    "display-tracking-id": 1,
})
```

### Issue 2: Frequent ID Switches

**Cause**: Low matching thresholds or short shadow tracking age.

**Solutions**:
- Increase `maxShadowTrackingAge` in tracker config
- Increase `minMatchingScore4Iou` and similarity weights
- Switch from GREEDY to CASCADED matching (`associationMatcherType: 1`)
- Consider using NvDCF or NvDeepSORT for visual/ReID-based matching

### Issue 3: Too Many Simultaneous Tracks

**Solution**: Reduce `maxTargetsPerStream` and/or increase `minDetectorConfidence` in BaseConfig.

### Issue 4: "Unable to acquire a user meta buffer"

**Cause**: Buffer pool exhausted when downstream is slow to release.

**Solution**: Increase `user-meta-pool-size` from default 16 to 64 or higher.

### Issue 5: Failed to Open Low-Level Lib

**Cause**: Missing `libmosquitto1` dependency.

**Solution**: `sudo apt-get install -y libmosquitto1`

### Issue 6: NvDCF Performance Bottleneck on Jetson

**Solution**: Use PVA backend to offload DCF operations from GPU:
```yaml
VisualTracker:
  visualTrackerType: 2
  vpiBackend4DcfTracker: 2  # PVA backend
```

---

## Related Documentation

- **GStreamer Plugins Overview**: `gstreamer_plugins.md`
- **Service Maker Python API**: `service_maker_api.md`
- **nvinfer Configuration**: `nvinfer_config.md`
- **Use Cases & Pipelines**: `use_cases_pipelines.md`
- **Official Docs**: https://docs.nvidia.com/metropolis/deepstream/dev-guide/text/DS_plugin_gst-nvtracker.html
