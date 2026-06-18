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

Full Phase 4 walkthrough — ONNX exporter, tao-deploy TensorRT engine builder + deploy spec YAMLs, TRT inference and evaluation endpoints, and the Phase 3+4 verification gate.

## Phase 4 — Export, Deployment & TensorRT Integration

### Step 8 — Implement Model Exporter (`tao-pytorch` → `tao-deploy`)

**File:** `tao-pytorch/nvidia_tao_pytorch/cv/<model_name>/scripts/export.py`

```python
@hydra_runner(config_path=os.path.join(spec_root, "experiment_specs"),
              config_name="experiment_spec", schema=ExperimentConfig)
@monitor_status(name="<ModelName>", mode="export")
def main(cfg: ExperimentConfig) -> None:
    obfuscate_logs(cfg)
    run_export(cfg)

def run_export(experiment_config):
    gpu_id = experiment_config.export.gpu_id
    torch.cuda.set_device(gpu_id)
    key = experiment_config.encryption_key
    TLTPyTorchCookbook.set_passphrase(key)

    # Load model — extracts raw nn.Module (not the PLModel wrapper)
    sf_model = <ModelName>PlModel.load_from_checkpoint(
        experiment_config.export.checkpoint,
        map_location="cpu",
        experiment_spec=experiment_config
    )
    model = sf_model.model   # Raw nn.Module — this is what gets exported
    model.eval()
    model.cuda()

    # Dummy input matching export config dimensions
    input_batch_size = 1 if experiment_config.export.batch_size == -1 else experiment_config.export.batch_size
    input_shape = [experiment_config.export.input_channel,
                   experiment_config.export.input_height,
                   experiment_config.export.input_width]
    dummy_input = torch.ones(input_batch_size, *input_shape, device='cuda')

    output_file = experiment_config.export.onnx_file

    # Export to ONNX — input/output names depend on task type:
    # Classification: input_names=["input"], output_names=["output"]
    # Detection:      input_names=["input"], output_names=["pred_logits", "pred_boxes"]
    # Segmentation:   input_names=["input"], output_names=["output"]
    # Instance Seg:   input_names=["input"], output_names=["pred_logits", "pred_masks"]
    onnx_export = ONNXExporter()
    onnx_export.export_model(
        model, experiment_config.export.batch_size, output_file, dummy_input,
        input_names=["input"], output_names=["output"],  # Adjust per task type
        opset_version=experiment_config.export.opset_version,
        do_constant_folding=True
    )
    onnx_export.check_onnx(output_file)

    # Encrypt if .etlt extension and encryption key set
    if output_file.endswith(".etlt") and key:
        encrypt_onnx(tmp_onnx_file, output_file, key)
```
**Critical:** `batch_size=-1` means dynamic batch — the `dynamic_axes` in `export_model()` must include `{0: "batch"}` for both input and output. The engine builder's `min/opt/max_batch_size` controls the actual batch range at TRT runtime.

### Step 9 — Implement TensorRT Engine Builder (`tao-deploy`)

**File:** `tao-deploy/nvidia_tao_deploy/cv/<model_name>/scripts/gen_trt_engine.py`

```python
from nvidia_tao_core.config.<model_name>.default_config import ExperimentConfig
from nvidia_tao_deploy.cv.common.initialize_experiments import initialize_gen_trt_engine_experiment
from nvidia_tao_deploy.utils.decoding import decode_model
from nvidia_tao_deploy.cv.common.utils import is_qdq_quantized_onnx
from nvidia_tao_deploy.cv.common.hydra.hydra_runner import hydra_runner
from nvidia_tao_deploy.cv.common.decorators import monitor_status

@hydra_runner(config_path=os.path.join(spec_root, "specs"),
              config_name="gen_trt_engine", schema=ExperimentConfig)
@monitor_status(name='<model_name>', mode='gen_trt_engine')
def main(cfg: ExperimentConfig) -> None:
    tmp_onnx_file, file_format = decode_model(cfg.gen_trt_engine.onnx_file)
    engine_builder_kwargs, create_engine_kwargs = initialize_gen_trt_engine_experiment(cfg)
    strongly_typed = is_qdq_quantized_onnx(tmp_onnx_file) if file_format == "onnx" else False

    builder = <ModelName>EngineBuilder(**engine_builder_kwargs,
                                       workspace=cfg.gen_trt_engine.tensorrt.workspace_size,
                                       is_qat=False,
                                       strongly_typed=strongly_typed,
                                       data_format="channels_first",
                                       preprocess_mode="torch")
    builder.create_network(tmp_onnx_file, file_format)
    builder.create_engine(**create_engine_kwargs)
```

The engine builder must inherit from `nvidia_tao_deploy.engine.builder.EngineBuilder` (the abstract base). For classification tasks, you can reuse `ClassificationEngineBuilder` from `tao-deploy/nvidia_tao_deploy/cv/classification_tf1/engine_builder.py` directly. For detection/segmentation, find the task-appropriate builder or subclass `EngineBuilder`.

**Also create spec files in `tao-deploy/nvidia_tao_deploy/cv/<model_name>/specs/`:**

These deploy specs use the **same ExperimentConfig dataclass** from tao-core. Field paths must match exactly.

**`specs/gen_trt_engine.yaml`:**
```yaml
results_dir: ???
gen_trt_engine:
  onnx_file: ???
  trt_engine: ???
  tensorrt:
    data_type: FP16
    workspace_size: 1024
    min_batch_size: 1
    opt_batch_size: 4
    max_batch_size: 8
```

**`specs/inference.yaml`:**
```yaml
results_dir: ???
inference:
  trt_engine: ???
  batch_size: 8
dataset:
  root_dir: ???                     # For classes.txt lookup
  test_dataset:
    images_dir: ???
  augmentation:
    mean: [0.485, 0.456, 0.406]    # MUST match training spec
    std: [0.229, 0.224, 0.225]     # MUST match training spec
```

**`specs/evaluate.yaml`:**
```yaml
results_dir: ???
evaluate:
  trt_engine: ???
  batch_size: 8
model:
  head:
    topk: [1]
dataset:
  root_dir: ???
  test_dataset:
    images_dir: ???
  augmentation:
    mean: [0.485, 0.456, 0.406]
    std: [0.229, 0.224, 0.225]
```

### Step 10 — TRT Engine Inference Endpoint (`tao-deploy`)

**File:** `tao-deploy/nvidia_tao_deploy/cv/<model_name>/scripts/inference.py`

```python
@hydra_runner(config_path=os.path.join(spec_root, "specs"),
              config_name="inference", schema=ExperimentConfig)
@monitor_status(name='<model_name>', mode='inference')
def main(cfg: ExperimentConfig) -> None:
    # Load class mapping from classes.txt (same file used during training)
    classmap = os.path.join(cfg.dataset.root_dir, 'classes.txt')
    mapping_dict = {line.rstrip(): idx for idx, line in enumerate(sorted(open(classmap)))}

    # Create TRT inferencer from engine file
    trt_infer = ClassificationInferencer(cfg.inference.trt_engine,
                                         data_format="channel_first",
                                         batch_size=cfg.inference.batch_size)

    # Create NumPy-based dataloader (no PyTorch dependency)
    # image_mean/std MUST match training augmentation config
    dl = ClassificationLoader(
        input_shape=trt_infer.input_tensors[0].shape,
        data_paths=[cfg.dataset.test_dataset.images_dir],
        class_mapping=mapping_dict,
        is_inference=True,
        batch_size=cfg.inference.batch_size,
        image_mean=cfg.dataset.augmentation.mean,
        image_std=cfg.dataset.augmentation.std
    )

    # Run inference and write result.csv
    with open(f"{cfg.results_dir}/result.csv", 'w') as csv_f:
        for imgs, _ in tqdm(dl):
            y_pred = trt_infer.infer(imgs)
            class_indices = np.argmax(y_pred, axis=1)
            conf = np.max(y_pred, axis=1)
            # Write (image_path, class_label, confidence) to CSV
```
**Output:** `{results_dir}/result.csv`

Use `ClassificationInferencer` (wraps TRT engine) and `ClassificationLoader` (NumPy-based, no PyTorch dependency) from `tao-deploy/nvidia_tao_deploy/cv/classification_tf1/`. For non-classification tasks, find or create the appropriate inferencer/loader classes.

### Step 11 — TRT Engine Evaluation Endpoint (`tao-deploy`)

**File:** `tao-deploy/nvidia_tao_deploy/cv/<model_name>/scripts/evaluate.py`

```python
@hydra_runner(config_path=os.path.join(spec_root, "specs"),
              config_name="evaluate", schema=ExperimentConfig)
@monitor_status(name='<model_name>', mode='evaluate')
def main(cfg: ExperimentConfig) -> None:
    # Same class mapping and inferencer/loader setup as inference.py
    # but with is_inference=False so ground truth labels are loaded
    classmap = os.path.join(cfg.dataset.root_dir, 'classes.txt')
    mapping_dict = {line.rstrip(): idx for idx, line in enumerate(sorted(open(classmap)))}

    trt_infer = ClassificationInferencer(cfg.evaluate.trt_engine, ...)
    dl = ClassificationLoader(
        ..., is_inference=False,   # Loads ground truth labels
        image_mean=cfg.dataset.augmentation.mean,
        image_std=cfg.dataset.augmentation.std
    )

    # Accumulate predictions and ground truth
    all_preds, all_labels = [], []
    for imgs, labels in tqdm(dl):
        y_pred = trt_infer.infer(imgs)
        all_preds.append(y_pred)
        all_labels.append(labels)

    # Compute metrics (sklearn)
    from sklearn.metrics import top_k_accuracy_score
    topk = cfg.model.head.topk  # e.g., [1, 5]
    results = {}
    for k in topk:
        results[f"top_{k}_accuracy"] = top_k_accuracy_score(all_labels, all_preds, k=k)

    # Write results.json
    with open(f"{cfg.results_dir}/results.json", 'w') as f:
        json.dump(results, f, indent=2)
```
**Output:** `{results_dir}/results.json` — `{"top_1_accuracy": 0.85, "top_5_accuracy": 0.97}`

### Phase 3+4 Gate — Verify the core implementation works before packaging.

Run inside Docker containers (these already have all dependencies):

```bash
# tao-pytorch checks:
docker run --rm --gpus all \
  -v $(pwd):/workspace \
  -w /workspace/tao-pytorch \
  -e PYTHONPATH=/workspace/tao-core:/workspace/tao-pytorch \
  tao-pytorch-base:latest \
  bash -c 'pip install /workspace/tao-core && python setup.py develop &&
    # 1. All imports work
    python3 -c "import nvidia_tao_pytorch.cv.<model_name>; print(\"pytorch import OK\")" &&

    # 2. Model builds and runs forward pass
    python3 -c "
import torch
from nvidia_tao_core.config.<model_name>.default_config import ExperimentConfig
from nvidia_tao_pytorch.cv.<model_name>.model.<model_name> import build_model
from omegaconf import OmegaConf
cfg = OmegaConf.structured(ExperimentConfig())
cfg.dataset.num_classes = 10
model = build_model(cfg).cuda().eval()
x = torch.randn(1, 3, 224, 224).cuda()
out = model(x)
print(f\"Output shape: {out.shape}\")
" &&

    # 3. ONNX export works
    python3 -c "
import torch, onnx
from nvidia_tao_core.config.<model_name>.default_config import ExperimentConfig
from nvidia_tao_pytorch.cv.<model_name>.model.<model_name> import build_model
from omegaconf import OmegaConf
cfg = OmegaConf.structured(ExperimentConfig())
cfg.dataset.num_classes = 10
model = build_model(cfg).cuda().eval()
x = torch.randn(1, 3, 224, 224).cuda()
torch.onnx.export(model, x, \"/tmp/test.onnx\",
    input_names=[\"input\"], output_names=[\"output\"],
    dynamic_axes={\"input\": {0: \"batch\"}, \"output\": {0: \"batch\"}},
    opset_version=17)
onnx.checker.check_model(\"/tmp/test.onnx\")
print(\"ONNX export OK\")
"
  '

# tao-deploy checks:
docker run --rm --gpus all \
  -v $(pwd):/workspace \
  -w /workspace/tao-deploy \
  -e PYTHONPATH=/workspace/tao-core:/workspace/tao-deploy \
  tao-deploy-base:latest \
  bash -c "pip install /workspace/tao-core && pip install -e . && \
    python3 -c \"import nvidia_tao_deploy.cv.<model_name>; print('deploy import OK')\""
```
Temp files (`/tmp/test.onnx`) live inside the container and are automatically cleaned up when the container exits (`--rm`).

If any of these fail, fix before proceeding. These are the foundation — everything else builds on them.

---

