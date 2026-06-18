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

Full Phase 7 walkthrough — diagnose accuracy / TRT-vs-native gap / training speed / inference latency, hyperparameter tuning, INT8 quantization, pruning, knowledge distillation, resolution tuning, and the optimization decision tree.

## Phase 7 — Optimization & Tuning (conditional)

> Enter this phase only if the implementation is functionally correct (Phase 6 passes) but accuracy, latency, or resource usage needs improvement. Ask the user what their target metrics are before optimizing.

### Step 26 — Diagnose What Needs Improvement

Run the end-to-end pipeline (Step 22) with real data (not just dry-run) and measure:

1. **Accuracy**: Compare against the HF model's reported metrics. If TAO accuracy is significantly lower:
   - Check data augmentation — are mean/std correct for this model?
   - Check learning rate — HF models often use different LR than TAO defaults
   - Check if backbone weights loaded correctly — print `missing_keys` and `unexpected_keys` from `load_state_dict()`
   - Try longer training (more epochs) with the HF-recommended schedule

2. **TRT vs Native accuracy gap**: If TRT accuracy is worse than native PyTorch:
   - Try FP32 engine first — if FP32 matches, the issue is precision loss in FP16
   - Compare preprocessing: ensure `augmentation.mean/std` and `preprocess_mode` match exactly
   - Run inference on the same images and compare output tensors numerically

3. **Training speed**: If training is too slow:
   - Profile with `torch.profiler` to find bottleneck
   - Check data loading: increase `workers`, enable `pin_memory=True`
   - Check if model is too large for GPU: reduce `batch_size` or enable gradient checkpointing

4. **Inference latency**: If TRT engine is too slow:
   - Profile with `trtexec --onnx=model.onnx --fp16 --verbose`
   - Check if dynamic batch is causing inefficiency — try fixed batch size
   - Check workspace size — increase if layers are falling back to slower algorithms

### Step 27 — Hyperparameter Tuning

Adjust training hyperparameters to improve accuracy:

```bash
# Try different learning rates
<model_name> train -e spec.yaml train.optim.lr=0.0001 train.num_epochs=50

# Try different optimizers
<model_name> train -e spec.yaml train.optim.optim=sgd train.optim.lr=0.01 train.optim.momentum=0.9

# Try different LR schedules
<model_name> train -e spec.yaml train.optim.policy=cosine train.optim.warmup_epochs=5

# Try different augmentations
<model_name> train -e spec.yaml dataset.augmentation.random_flip.enable=True \
  dataset.augmentation.random_color.enable=True \
  dataset.augmentation.random_erase.enable=True
```

**EMA (Exponential Moving Average)** — often improves accuracy:
```yaml
train:
  enable_ema: True
  ema_decay: 0.998     # Typical range: 0.99-0.9999
```

**Backbone freezing** — useful for small datasets:
```yaml
model:
  backbone:
    freeze_backbone: True     # Freeze all backbone layers
    freeze_norm: True         # Freeze batch norm statistics
# Only head is trainable → faster convergence, less overfitting
```

### Step 28 — Quantization (INT8)

If inference latency needs to be reduced, apply INT8 quantization:

**Post-Training Quantization (PTQ):**
```yaml
quantize:
  backend: "torchao"             # or "modelopt.pytorch"
  mode: "static_ptq"            # Requires calibration data
  algorithm: "minmax"           # or entropy, awq_clip, awq_lite
  device: "cuda"
```

**For TRT INT8 engine:**
```yaml
gen_trt_engine:
  tensorrt:
    data_type: INT8
    calibration:
      cal_image_dir: [/path/to/calibration/images]
      cal_cache_file: /path/to/cal.cache
      cal_batch_size: 8
      cal_batches: 100
```

**Accuracy check:** Always compare INT8 accuracy against FP16/FP32. Expect <1% accuracy loss. If larger:
- Try `entropy` calibration algorithm instead of `minmax`
- Increase calibration data (more images, more batches)
- Use per-layer precision control to keep sensitive layers in FP16

### Step 29 — Pruning (reduce model size)

If the model is too large for the target deployment:

```yaml
prune:
  mode: "amount"           # Prune by percentage
  amount: 0.3              # Remove 30% of channels
  granularity: 8           # 8-channel pruning granularity
  raw_prune_score: "L1"    # L1-norm based importance scoring
```

After pruning, **retrain** the pruned model to recover accuracy:
```bash
<model_name> train -e spec.yaml \
  train.resume_training_checkpoint_path=/path/to/pruned_model.pth \
  train.num_epochs=20   # Fewer epochs than initial training
```

### Step 30 — Knowledge Distillation (transfer knowledge)

If you have a larger, more accurate teacher model:

```yaml
distill:
  pretrained_teacher_model_path: /path/to/teacher.pth
  teacher:
    backbone:
      type: "<larger_backbone>"
  loss_type: "FD"          # Feature Distillation (smooth L1)
  loss_lambda: 0.5         # Balance between supervised and distillation loss
  mode: "auto"             # auto, logits, summary, or spatial
```

Distillation trains a smaller student model to match a larger teacher's behavior.

### Step 31 — Resolution & Input Size Tuning

For ViT-based models, changing input resolution can significantly affect accuracy/speed:

```yaml
dataset:
  img_size: 384            # Try larger resolution for better accuracy
                           # Or smaller resolution for faster inference
export:
  input_width: 384
  input_height: 384
```

**Note:** TAO automatically handles positional embedding interpolation for ViT models when the resolution changes from the pretrained size. The interpolation happens in `backbone_v2/vit.py` via bicubic interpolation.

### Optimization Decision Tree

```
Accuracy too low?
├── Check data pipeline (mean/std, augmentations, dataset format)
├── Check weight loading (missing keys, wrong mapping)
├── Try longer training / different LR schedule
├── Enable EMA
├── Try backbone freezing (small datasets)
└── Try knowledge distillation (if teacher available)

TRT accuracy worse than native?
├── Try FP32 engine first (isolate precision vs preprocessing issue)
├── Verify augmentation.mean/std match across all specs
├── Compare output tensors numerically on same input
└── Use per-layer FP16 for sensitive layers in INT8 engine

Inference too slow?
├── Use FP16 precision (default for most models)
├── Try INT8 quantization with calibration
├── Reduce input resolution
├── Prune model channels
├── Optimize batch size (larger = more throughput, up to GPU memory)
└── Profile with trtexec --verbose

Model too large?
├── Prune channels (amount=0.3-0.5)
├── Use INT8 quantization
├── Reduce input resolution
└── Distill to smaller backbone
```

---

