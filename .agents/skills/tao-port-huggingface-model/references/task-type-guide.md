<!--
Copyright (c) 2026, NVIDIA CORPORATION.  All rights reserved.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
-->

# CV Task Type Guide

How to adapt the TAO implementation for each Computer Vision task type. The HF model's `pipeline_tag` determines which patterns to follow.

---

## Quick Reference

| pipeline_tag | TAO Reference Model | Outputs | ONNX Outputs | Post-Processing | Metrics | Dataset Format |
|---|---|---|---|---|---|---|
| `image-classification` | `classification_pyt` | Logits (B,C) | Single | Softmax → argmax | Top-k Accuracy | Class subdirectories |
| `object-detection` | `dino`, `rtdetr` | Logits (B,Q,C) + Boxes (B,Q,4) | Multi (2) | Sigmoid → Top-K | mAP (COCO) | COCO JSON |
| `image-segmentation` | `segformer` | Logits (B,C,H,W) | Single | Argmax per pixel | mIoU | Image + Mask pairs |
| `instance-segmentation` | `mask2former` | Logits (B,Q,C) + Masks (B,Q,H,W) | Multi (2) | Threshold + filter | AP (COCO) | COCO JSON + masks |
| `panoptic-segmentation` | `oneformer` | Logits + Masks | Multi (2) | Merge stuff+things | PQ | COCO Panoptic |
| `zero-shot-object-detection` | `grounding_dino` | Logits (B,Q,T) + Boxes (B,Q,4) | Multi (2+text) | Contrastive score | mAP | COCO JSON + captions |
| `depth-estimation` | `mono_depth` | Depth map (B,1,H,W) | Single | Direct output | RMSE, Abs.Rel | Image + depth maps |

**Key:** B=batch, C=classes, Q=queries, H/W=spatial, T=text tokens

---

## 1. Image Classification

### Architecture
```
Backbone (ViT, ResNet, etc.) → Global Pooling → Linear Head → Logits (num_classes)
```

### Implementation Notes
- Simplest task type — use `classification_pyt` as the direct reference
- Single output tensor, no post-processing beyond softmax+argmax
- `BackboneBase.get_classifier()` returns the linear head
- `BackboneBase.forward()` returns logits directly

### Config Specifics
```python
ModelConfig:
  backbone: BackboneConfig     # type, pretrained_path, freeze
  head: HeadConfig             # type=TAOLinearClsHead, in_channels, topk, loss
```

### Dataset Structure
```
root_dir/
├── classes.txt              # Alphabetically sorted class names
├── train/{class_name}/      # Images organized by class
├── val/{class_name}/
└── test/{class_name}/
```

### ONNX Export
```python
input_names=["input"]         # (B, 3, H, W)
output_names=["output"]       # (B, num_classes)
```

### TRT Deploy
- Reuse `ClassificationEngineBuilder`, `ClassificationInferencer`, `ClassificationLoader` from `classification_tf1/`
- `preprocess_mode="torch"` for ImageNet normalization

---

## 2. Object Detection (DETR-based)

### Architecture
```
Backbone → Input Projection (1x1 Conv + GroupNorm per scale level)
  → Deformable Transformer Encoder → Transformer Decoder
  → Class Head (Linear → num_classes) + Box Head (MLP → 4)
```

### Implementation Notes
- Multi-scale features: backbone produces feature pyramid at strides [4, 8, 16, 32]
- Use `backbone.forward_feature_pyramid(x)` instead of `backbone.forward(x)`
- Hungarian matching loss (optimal assignment between predictions and GT)
- DETR models are **NMS-free** — use Top-K selection instead
- DN (denoising) queries require special handling during training
- Detection head outputs normalized box coords `(cx, cy, w, h)` — convert to `(x1, y1, x2, y2)` in post-processing

### Config Specifics
```python
ModelConfig:
  backbone: str                    # backbone variant name
  num_queries: int = 300           # number of detection queries
  num_feature_levels: int = 4      # multi-scale feature levels
  enc_layers: int = 6              # encoder layers
  dec_layers: int = 6              # decoder layers
  hidden_dim: int = 256            # transformer hidden dim
  cls_loss_coef: float = 2.0       # classification loss weight
  bbox_loss_coef: float = 5.0      # L1 box loss weight
  giou_loss_coef: float = 2.0      # GIoU loss weight
```

### Dataset Structure
```
data_dir/
├── train/
│   ├── images/
│   └── annotations.json       # COCO format
├── val/
│   ├── images/
│   └── annotations.json
└── classmap.txt               # For inference: class names
```

### Loss Functions
- **Sigmoid Focal Loss**: Classification (alpha=0.25, gamma=2)
- **L1 Loss**: Box regression on normalized coords
- **GIoU Loss**: Generalized IoU for box alignment
- **Hungarian Matching**: `scipy.optimize.linear_sum_assignment` for bipartite matching
- **Auxiliary losses**: From intermediate decoder layers

### ONNX Export
```python
input_names=["input"]           # (B, 3, H, W)
output_names=["pred_logits", "pred_boxes"]
# pred_logits: (B, num_queries, num_classes) — raw logits, sigmoid in post-processing
# pred_boxes: (B, num_queries, 4) — normalized (cx, cy, w, h)
```

### TRT Deploy
- Use `DDETRDetEngineBuilder` (from deformable_detr) — also used by DINO
- Use `DDETRInferencer` — handles multi-output extraction
- Post-processing: sigmoid on logits → Top-K selection → box coord scaling → (x1,y1,x2,y2)
- Output: annotated images + KITTI-format label files

### Metrics
- COCO mAP@0.5:0.95 (primary)
- mAP@0.50 (secondary)
- Per-class AP

---

## 3. Semantic Segmentation

### Architecture
```
Backbone → Multi-scale Feature Pyramid
  → Decode Head (feature fusion + upsampling) → Per-pixel Logits (num_classes, H, W)
```

### Implementation Notes
- Use `backbone.forward_feature_pyramid(x)` for multi-scale features
- Decode head fuses features at multiple resolutions
- Output spatial dimensions match input (or can be lower-res + bilinear upsample)
- Loss computed per-pixel with optional ignore index (e.g., 255 for void)
- `SegFormerHead` uses multi-resolution MLP fusion

### Config Specifics
```python
ModelConfig:
  backbone: BackboneConfig
  decode_head: DecodeHeadConfig
    in_channels: [64, 128, 320, 512]    # Per-scale feature dimensions
    in_index: [0, 1, 2, 3]              # Which backbone scales to use
    feature_strides: [4, 8, 16, 32]     # Spatial stride per scale
    decoder_params:
      embed_dim: 256                     # Decoder hidden dim

DatasetConfig:
  segment:
    palette:                             # Label-to-color mapping
      - {label_id: 0, rgb: [0,0,0], mapping_class: "background", seg_class: "background"}
      - {label_id: 1, rgb: [128,0,0], mapping_class: "person", seg_class: "person"}
    label_transform: "norm"              # or None
```

### Dataset Structure
```
data_dir/
├── train/
│   ├── images/       # RGB images
│   └── masks/        # Single-channel PNG, pixel value = class_id
├── val/
│   ├── images/
│   └── masks/
└── test/
    ├── images/
    └── masks/
```

### Loss Functions
- **Cross Entropy**: Per-pixel classification (supports `ignore_index=255`)
- **Focal Loss**: Hard example mining (alpha, gamma configurable)
- **mIoU Loss**: Directly optimizes Intersection over Union
- **mmIoU Loss**: Minimax IoU — encourages balanced class performance

### ONNX Export
```python
input_names=["input"]           # (B, 3, H, W)
output_names=["output"]         # (B, num_classes, H, W)
# Dynamic spatial dims: H and W can vary
dynamic_axes={"input": {0: "batch", 2: "height", 3: "width"},
              "output": {0: "batch", 2: "height", 3: "width"}}
```

### TRT Deploy
- Use `SegformerEngineBuilder` (minimal override of base builder)
- Use `SegformerInferencer` + `SegformerLoader` (from `segformer/`)
- Post-processing: argmax per pixel → save as PNG mask
- Output: mask PNGs + optional overlay visualizations

### Metrics
- mIoU (mean Intersection over Union) — primary
- Per-class IoU
- Pixel accuracy

---

## 4. Instance Segmentation

### Architecture
```
Backbone → Pixel Decoder (multi-scale feature refinement)
  → Transformer Decoder (query-based instance prediction)
  → Class Head + Mask Head
```

### Implementation Notes
- Outputs **per-instance** masks (not per-class like semantic seg)
- Each query predicts one instance: class + binary mask
- Mask predictions at reduced resolution — upsampled in post-processing
- Uses Hungarian matching (like detection) to assign predictions to GT instances
- Supports both "thing" (countable) and "stuff" (uncountable) categories

### Config Specifics
```python
ModelConfig:
  backbone: BackboneConfig
  num_queries: int = 100        # One query per potential instance
  # Mask head and class head integrated into transformer decoder
```

### ONNX Export
```python
input_names=["input"]                    # (B, 3, H, W)
output_names=["pred_logits", "pred_masks"]
# pred_logits: (B, num_queries, num_classes + 1)  — includes no-object class
# pred_masks: (B, num_queries, H/4, W/4)          — reduced resolution
```

### Post-Processing
1. Softmax on logits → filter by confidence threshold
2. Select Top-K instances by score
3. Bilinear upsample masks to original resolution
4. Apply sigmoid → threshold at 0.5 for binary masks
5. Remove overlapping instances (higher confidence wins)

### Metrics
- COCO AP (Average Precision) — primary
- AP@0.50, AP@0.75 (IoU thresholds)
- Per-class AP

---

## 5. Panoptic Segmentation

### Architecture
Same as instance segmentation, but with task-conditional head that handles both "things" and "stuff":
```
Backbone → Pixel Decoder → Transformer Decoder
  → Task-conditional Head (semantic + instance + panoptic modes)
```

### Implementation Notes
- Unified architecture for semantic, instance, and panoptic segmentation
- Task token conditions the decoder behavior
- **Stuff classes** (background, sky): treated like semantic seg
- **Thing classes** (person, car): treated like instance seg
- Panoptic output merges both

### Metrics
- **PQ (Panoptic Quality)** = SQ × RQ
  - SQ (Segmentation Quality): IoU of matched segments
  - RQ (Recognition Quality): F1 of matched/unmatched
- Also reports mIoU for stuff and AP for things

---

## 6. Zero-Shot / Grounding Detection

### Architecture
```
Image Backbone → Multi-scale Features
Text Encoder (BERT) → Text Embeddings
  → Cross-Modal Fusion (Transformer)
  → Contrastive Class Head + Box Head
```

### Implementation Notes
- **Requires text input** in addition to images — major architectural difference
- Class predictions via contrastive similarity (not fixed linear head)
- Text encoder (BERT) can be frozen or fine-tuned
- Feature alignment layer maps text embeddings to vision space
- ONNX export must handle text input tensors
- At inference, text prompt defines what to detect (open vocabulary)

### ONNX Export
```python
input_names=["inputs", "input_ids", "attention_mask", "position_ids",
             "token_type_ids", "text_token_mask"]
output_names=["pred_logits", "pred_boxes"]
# pred_logits shape: (B, num_queries, max_text_len) — NOT num_classes!
```

### Special Considerations
- Text tokenizer needed at inference time (pre-tokenize or include in pipeline)
- Logit shape depends on text length, not fixed class count
- Contrastive scoring: aggregate logits across text tokens per detection

---

## 7. Depth Estimation

### Architecture
```
Encoder (Backbone) → Decoder (progressive upsampling) → Depth Map (1, H, W)
```

### Implementation Notes
- Single-channel output (depth value per pixel)
- May use photometric loss (compares reprojected views)
- Stereo variants take two input images

### ONNX Export
```python
input_names=["input"]           # (B, 3, H, W) or (B, 6, H, W) for stereo
output_names=["output"]         # (B, 1, H, W)
```

### Metrics
- RMSE (Root Mean Square Error)
- Abs.Rel (Absolute Relative Error)
- δ thresholds (% of pixels within 1.25^n ratio)

---

## Task-Type Decision Tree

When the agent determines the HF model's `pipeline_tag`, use this to select the implementation strategy:

```
pipeline_tag
├── image-classification
│   └── Reference: classification_pyt
│       └── Simple backbone + linear head
│       └── Single ONNX output
│       └── Reuse Classification{EngineBuilder,Inferencer,Loader}
│
├── object-detection
│   └── Reference: dino (DETR-based) or rtdetr (real-time)
│       └── Backbone + transformer encoder/decoder + detection heads
│       └── Multi ONNX output (logits + boxes)
│       └── Hungarian matching loss
│       └── Needs DDETRDet{EngineBuilder,Inferencer}
│
├── image-segmentation
│   └── Reference: segformer
│       └── Backbone + decode head
│       └── Single ONNX output (spatial)
│       └── Per-pixel loss with ignore_index
│       └── Reuse or extend Segformer{EngineBuilder,Inferencer,Loader}
│
├── instance-segmentation
│   └── Reference: mask2former
│       └── Backbone + pixel decoder + transformer decoder
│       └── Multi ONNX output (logits + masks)
│       └── Hungarian matching + mask losses
│
├── panoptic-segmentation
│   └── Reference: oneformer
│       └── Task-conditional architecture
│       └── Multi ONNX output + task token
│
├── zero-shot-object-detection
│   └── Reference: grounding_dino
│       └── Multi-modal (image + text)
│       └── BERT text encoder required
│       └── Contrastive class prediction
│
├── depth-estimation
│   └── Reference: mono_depth / stereo_depth
│       └── Encoder-decoder for depth maps
│       └── Single ONNX output
│
└── OTHER
    └── Halt — unsupported task type
```

---

## What Changes Per Task Type

| Component | Classification | Detection | Segmentation | Instance Seg |
|---|---|---|---|---|
| **backbone.forward** | `forward()` | `forward_feature_pyramid()` | `forward_feature_pyramid()` | `forward_feature_pyramid()` |
| **Head type** | Linear | Transformer + MLP | Decode head | Pixel decoder + Transformer |
| **Loss** | CE | Focal + L1 + GIoU | CE / Focal / IoU | CE + Mask + Match |
| **ONNX outputs** | 1 | 2 (logits, boxes) | 1 | 2 (logits, masks) |
| **Dynamic spatial** | No | Yes (image H/W) | Yes (H/W) | Yes (H/W) |
| **Post-process** | Softmax+argmax | Sigmoid+TopK+scale | Argmax per pixel | Sigmoid+filter+upsample |
| **Dataset** | Class dirs | COCO JSON | Image+Mask pairs | COCO JSON + masks |
| **Deploy inferencer** | Classification* | DDETR* | Segformer* | Custom |
| **Deploy dataloader** | Classification* | ImageBatcher | Segformer* | Custom |
| **Metrics** | Top-k Acc | mAP (COCO) | mIoU | AP (COCO) |

*Reusable from existing TAO implementations

---

## Positional Embedding Handling for ViT-based Models

When the HF model uses a ViT backbone and the TAO training resolution differs from the pretrained resolution:

```python
# TAO handles this automatically in backbone_v2/vit.py:
def _interpolate_pos_encoding(self, x, w, h):
    # Bicubic interpolation of positional embeddings
    # Class token kept unchanged, patch tokens interpolated
    pos_tokens = F.interpolate(pos_tokens, size=(new_h, new_w), mode='bicubic')
```

Also available as a utility:
```python
from nvidia_tao_pytorch.core.utils.pos_embed_interpolation import interpolate_pos_embed
checkpoint = interpolate_pos_embed(checkpoint, orig_resolution, orig_patch_size,
                                    new_resolution, new_patch_size)
```

This is critical when the HF model was pretrained at e.g., 224×224 but TAO trains at 384×384.
