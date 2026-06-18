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

# TAO Workflow Consistency Guide

How the user-facing TAO CLI works end-to-end, and what the agent's generated code must be consistent with.

---

## 1. CLI Invocation Pattern

Users run TAO commands via console_scripts registered in `setup.py`:

```bash
# tao-pytorch commands
<model_name> <subtask> -e <experiment_spec.yaml> [hydra_overrides...]

# Examples:
classification_pyt train -e experiment_spec.yaml train.num_epochs=50 train.optim.lr=0.001
segformer evaluate -e experiment_spec.yaml evaluate.checkpoint=/path/to/model.pth
dino export -e experiment_spec.yaml export.onnx_file=/results/model.onnx

# tao-deploy commands (identical pattern)
classification_pyt gen_trt_engine -e gen_trt_engine.yaml gen_trt_engine.tensorrt.data_type=FP16
classification_pyt inference -e inference.yaml inference.trt_engine=/path/to/model.engine
classification_pyt evaluate -e evaluate.yaml evaluate.trt_engine=/path/to/model.engine
```

**Critical:** The console_script name IS the model name. Hydra overrides use **dot notation** matching the dataclass field paths exactly.

---

## 2. Entrypoint Dispatch Flow

```
console_script main()
  → get_subtasks(scripts_package)         # discovers train.py, evaluate.py, etc. via pkgutil
  → command_line_parser(parser, subtasks)  # extracts: subtask, -e spec_file, unknown_args
  → launch(args, unknown_args, subtasks)   # orchestrates execution
```

### `launch()` in tao-pytorch:
1. Validates experiment_spec_file exists
2. Constructs Hydra args: `--config-path <dir> --config-name <filename>`
3. Reads GPU config from spec file: `train.num_gpus`, `train.gpu_ids`, `train.num_nodes`
4. Sets `TAO_VISIBLE_DEVICES` env var
5. For multi-GPU: wraps with `torchrun --nnodes=N --nproc-per-node=M`
6. Runs script as subprocess with `subprocess.Popen()`
7. Sends telemetry on completion

### `launch()` in tao-deploy:
1. Same basic pattern but from `nvidia_tao_deploy.cv.common.entrypoint.entrypoint_hydra`
2. Uses pyCUDA for GPU validation
3. Single-GPU focused (deploy tasks don't use multi-GPU)
4. Sets `CUDA_VISIBLE_DEVICES` directly

**What the agent must produce:**

```python
# tao-pytorch entrypoint: nvidia_tao_pytorch/cv/<model_name>/entrypoint/<model_name>.py
from nvidia_tao_pytorch.cv.<model_name> import scripts
from nvidia_tao_pytorch.core.entrypoint import get_subtasks, command_line_parser, launch

def main():
    subtasks = get_subtasks(scripts)
    args, unknown_args = command_line_parser(subtasks)
    launch(vars(args), unknown_args, subtasks, network="<model_name>")

if __name__ == "__main__":
    main()

# tao-deploy entrypoint: nvidia_tao_deploy/cv/<model_name>/entrypoint/<model_name>.py
from nvidia_tao_deploy.cv.<model_name> import scripts
from nvidia_tao_deploy.cv.common.entrypoint.entrypoint_hydra import (
    get_subtasks, command_line_parser, launch
)

def main():
    subtasks = get_subtasks(scripts)
    args, unknown_args = command_line_parser(subtasks)
    launch(vars(args), unknown_args, subtasks, network="<model_name>")

if __name__ == "__main__":
    main()
```

---

## 3. Hydra Config Resolution

The `@hydra_runner` decorator merges configs in this order (last wins):

```
1. ExperimentConfig dataclass defaults (schema)
2. YAML experiment spec values
3. CLI overrides (dot notation)
```

```python
@hydra_runner(
    config_path=os.path.join(spec_root, "experiment_specs"),  # directory containing YAML
    config_name="experiment_spec",                              # YAML filename (no .yaml)
    schema=ExperimentConfig                                     # dataclass from tao-core
)
@monitor_status(name="<ModelName>", mode="train")
def main(cfg: ExperimentConfig) -> None:
    ...
```

**Key behaviors:**
- `hydra.output_subdir=null` — no `.hydra/` directory created
- `hydra.run.dir=.` — run in current directory
- OmegaConf interpolation: `${results_dir}/train/model.pth` resolves at access time
- `MISSING` fields (from `omegaconf.MISSING`) must be provided in YAML or CLI — otherwise runtime error

---

## 4. ExperimentConfig Hierarchy

Every TAO model's `ExperimentConfig` inherits from `CommonExperimentConfig` and MUST have these top-level sections:

```python
@dataclass
class ExperimentConfig(CommonExperimentConfig):
    """Top-level config — drives both tao-pytorch and tao-deploy scripts."""
    model: ModelConfig              = DATACLASS_FIELD(ModelConfig())
    dataset: DatasetConfig          = DATACLASS_FIELD(DatasetConfig())
    train: TrainExpConfig           = DATACLASS_FIELD(TrainExpConfig())
    evaluate: EvalExpConfig         = DATACLASS_FIELD(EvalExpConfig())
    inference: InferenceExpConfig   = DATACLASS_FIELD(InferenceExpConfig())
    export: ExportExpConfig         = DATACLASS_FIELD(ExportExpConfig())
    gen_trt_engine: GenTrtEngineExpConfig = DATACLASS_FIELD(GenTrtEngineExpConfig())
    quantize: ModelQuantizationConfig = DATACLASS_FIELD(ModelQuantizationConfig())
    # Optional (task-specific):
    distill: DistillConfig          = DATACLASS_FIELD(DistillConfig())
```

### Inherited from CommonExperimentConfig:
```python
model_name: Optional[str]     # for model-agnostic invocation
encryption_key: Optional[str] # checkpoint encryption
results_dir: Optional[str]    # top-level output directory
wandb: WandBConfig            # experiment tracking (enable, project, entity, tags)
```

### Standard TrainConfig fields (base for all TrainExpConfig):
```python
num_gpus: int          # default=1
gpu_ids: List[int]     # default=[0]
num_nodes: int         # default=1
seed: int              # default=1234
num_epochs: int        # default=10
checkpoint_interval: int  # default=1
validation_interval: int  # default=1
resume_training_checkpoint_path: Optional[str]
results_dir: Optional[str]
cudnn:
    benchmark: bool    # default=False
    deterministic: bool # default=True
```

### Standard EvaluateConfig / InferenceConfig fields:
```python
num_gpus: int
gpu_ids: List[int]
checkpoint: str        # MISSING — required
trt_engine: Optional[str]
results_dir: Optional[str]
batch_size: int        # default=-1 (auto)
```

### Standard ExportConfig fields:
```python
results_dir: Optional[str]
gpu_id: int            # default=0 (singular — export is single-GPU)
checkpoint: str        # MISSING — required
onnx_file: str         # MISSING — output path
input_channel: int     # default=3
input_width: int       # default=960
input_height: int      # default=544
opset_version: int     # default=17
batch_size: int        # default=-1 (dynamic)
```

### Standard GenTrtEngineConfig fields:
```python
results_dir: Optional[str]
gpu_id: int            # default=0
onnx_file: str         # MISSING — input ONNX path
trt_engine: Optional[str] # output engine path
tensorrt:
    data_type: str     # FP32, FP16, or INT8
    workspace_size: int # default=1024 (MB)
    min_batch_size: int # default=1
    opt_batch_size: int # default=1
    max_batch_size: int # default=1
    calibration:       # for INT8 only
        cal_image_dir: List[str]
        cal_cache_file: str
        cal_batch_size: int
        cal_batches: int
```

---

## 5. Experiment Spec YAML Structure

The agent must generate a spec YAML that mirrors the ExperimentConfig dataclass exactly. Field names in YAML must match field names in the dataclass.

### Classification example:
```yaml
encryption_key: tlt_encode
results_dir: ???  # User must provide

model:
  backbone:
    type: "vit_large_patch14_dinov2_swiglu"
    pretrained_backbone_path: null
    freeze_backbone: False
    freeze_norm: False
  head:
    type: TAOLinearClsHead
    in_channels: 1024   # Must match backbone output dim from model_params_mapping.py
    topk: [1, 5]
    loss:
      type: CrossEntropyLoss
      label_smooth_val: 0.0

dataset:
  dataset: "CLDataset"
  root_dir: ???  # Location of classes.txt
  num_classes: 1000
  img_size: 224
  batch_size: 128
  workers: 8
  shuffle: True
  augmentation:
    mean: [0.485, 0.456, 0.406]
    std: [0.229, 0.224, 0.225]
    random_flip:
      enable: True
      hflip_probability: 0.5
      vflip_probability: 0.0
    random_rotate:
      enable: False
    random_color:
      enable: False
    random_erase:
      enable: False
  train_dataset:
    images_dir: ${dataset.root_dir}/train
  val_dataset:
    images_dir: ${dataset.root_dir}/val
  test_dataset:
    images_dir: ${dataset.root_dir}/test

train:
  seed: 1234
  num_epochs: 25
  num_gpus: 1
  gpu_ids: [0]
  num_nodes: 1
  checkpoint_interval: 10
  validation_interval: 1
  resume_training_checkpoint_path: null
  clip_grad_norm: 2.0
  precision: fp32
  enable_ema: False
  optim:
    optim: adamw
    lr: 0.00006
    weight_decay: 0.05
    policy: cosine
    warmup_epochs: 5
    momentum: 0.9
  tensorboard:
    enabled: True

evaluate:
  checkpoint: ${results_dir}/train/<model_name>_model_latest.pth

inference:
  checkpoint: ${results_dir}/train/<model_name>_model_latest.pth

export:
  results_dir: ${results_dir}/export
  gpu_id: 0
  checkpoint: ${results_dir}/train/<model_name>_model_latest.pth
  onnx_file: ${export.results_dir}/<model_name>.onnx
  input_width: 224
  input_height: 224
  batch_size: -1
  opset_version: 17

gen_trt_engine:
  onnx_file: ${export.results_dir}/<model_name>.onnx
  trt_engine: ${results_dir}/trt/<model_name>.engine
  tensorrt:
    data_type: FP16
    workspace_size: 1024
    min_batch_size: 1
    opt_batch_size: 4
    max_batch_size: 8
```

### Detection (DINO-style) differences:
```yaml
dataset:
  train_data_sources:
    - image_dir: /data/train/images
      json_file: /data/train/annotations.json
  val_data_sources:
    - image_dir: /data/val/images
      json_file: /data/val/annotations.json
  test_data_sources:
    image_dir: /data/test/images
    json_file: /data/test/annotations.json
  infer_data_sources:
    image_dir: [/data/infer/images]
    classmap: /data/classmap.txt
  num_classes: 91
  augmentation:
    scales: [480, 512, 544, 576, 608, 640, 672, 704, 736, 768, 800]
    input_mean: [0.485, 0.456, 0.406]
    input_std: [0.229, 0.224, 0.225]

model:
  backbone: "fan_small_12_p4_hybrid"
  num_queries: 300
  num_feature_levels: 4
  enc_layers: 6
  dec_layers: 6
  hidden_dim: 256
```

### Segmentation (Segformer-style) differences:
```yaml
dataset:
  segment:
    palette:
      - label_id: 0
        rgb: [0, 0, 0]
        mapping_class: "background"
        seg_class: "background"
      - label_id: 1
        rgb: [128, 0, 0]
        mapping_class: "person"
        seg_class: "person"
  augmentation:
    mean: [0.485, 0.456, 0.406]
    std: [0.229, 0.224, 0.225]

model:
  backbone:
    type: "mit_b5"
  decode_head:
    in_channels: [64, 128, 320, 512]
    in_index: [0, 1, 2, 3]
    feature_strides: [4, 8, 16, 32]
```

---

## 6. Deploy Spec YAMLs

Deploy specs are separate YAML files (not the same experiment spec used for training). They live in `nvidia_tao_deploy/cv/<model_name>/specs/`.

### gen_trt_engine.yaml:
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

### inference.yaml:
```yaml
results_dir: ???
inference:
  trt_engine: ???
  batch_size: 8
dataset:
  root_dir: ???         # For classes.txt lookup
  test_dataset:
    images_dir: ???
  augmentation:
    mean: [0.485, 0.456, 0.406]
    std: [0.229, 0.224, 0.225]
```

### evaluate.yaml:
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

**Critical:** Deploy scripts import `ExperimentConfig` from `tao-core` — the same dataclass. So deploy spec field names must also match the dataclass paths.

---

## 7. Results Directory Structure & Cross-Phase Data Flow

Each phase produces outputs that feed into the next:

```
results_dir/                          ← set by user
├── train/                            ← train script writes here
│   ├── lightning_logs/version_1/
│   │   ├── hparams.yaml
│   │   ├── metrics.csv
│   │   └── events.out.tfevents.*     ← TensorBoard data
│   ├── model_001.pth                 ← checkpoint at epoch 1
│   ├── model_010.pth                 ← checkpoint at epoch 10
│   ├── <model_name>_model_latest.pth ← symlink to latest (IMPORTANT)
│   └── status.json                   ← TAO status logger
│
├── evaluate/                         ← evaluate script writes here
│   ├── result.csv                    ← per-image predictions + GT
│   └── results.json                  ← aggregate metrics
│
├── inference/                        ← inference script writes here
│   └── result.csv                    ← per-image predictions
│
├── export/                           ← export script writes here
│   ├── <model_name>.onnx            ← ONNX model
│   ├── labels.txt                    ← class labels (optional)
│   └── nvdsinfer_config.yaml         ← DeepStream config (optional)
│
├── trt/                              ← gen_trt_engine writes here
│   └── <model_name>.engine           ← TensorRT engine
│
├── trt_infer/                        ← TRT inference writes here
│   └── result.csv
│
└── trt_eval/                         ← TRT evaluation writes here
    └── results.json
```

### Cross-phase references (how outputs chain):

```
train → export:
  export.checkpoint = ${results_dir}/train/<model_name>_model_latest.pth

export → gen_trt_engine:
  gen_trt_engine.onnx_file = ${results_dir}/export/<model_name>.onnx

gen_trt_engine → inference:
  inference.trt_engine = ${results_dir}/trt/<model_name>.engine

gen_trt_engine → evaluate:
  evaluate.trt_engine = ${results_dir}/trt/<model_name>.engine
```

---

## 8. Checkpoint Naming Conventions

The `checkpoint_filename` attribute on the PLModel controls naming:

```python
class MyModelPlModel(TAOLightningModule):
    def __init__(self, experiment_spec):
        super().__init__(experiment_spec)
        self.checkpoint_filename = "<model_name>_model"  # e.g., "classifier_model"
```

This produces:
- `model_{epoch:03d}.pth` — per-epoch checkpoints (e.g., `model_001.pth`)
- `<checkpoint_filename>_latest.pth` — symlink to latest (e.g., `classifier_model_latest.pth`)

The `configure_callbacks()` method sets up `ModelCheckpoint`:
```python
ModelCheckpoint(
    filename="model_{epoch:03d}",    # per-epoch naming
    every_n_epochs=checkpoint_interval,
    save_last="link",                # creates _latest symlink
    save_top_k=-1,                   # keep all
    save_on_train_epoch_end=True,
    dirpath=results_dir,
)
```

**Agent must ensure:** The `checkpoint_filename` in the PLModel matches what the experiment spec YAML references in `evaluate.checkpoint`, `inference.checkpoint`, and `export.checkpoint`.

---

## 9. Dataset Directory Convention

### Classification:
```
root_dir/
├── classes.txt          ← one class name per line, sorted alphabetically
├── train/
│   ├── class_a/
│   │   ├── img001.jpg
│   │   └── img002.jpg
│   └── class_b/
│       └── img003.jpg
├── val/
│   └── ...              ← same structure as train/
└── test/
    └── ...              ← same structure as train/
```

`classes.txt` is read by both tao-pytorch (dataset) and tao-deploy (inference/evaluate) to build label mappings. The deploy dataloader auto-discovers class names from alphabetically-sorted subdirectory names if `classes.txt` is missing.

### Detection (COCO format):
```
data_dir/
├── train/
│   ├── images/
│   └── annotations.json   ← COCO JSON format
├── val/
│   ├── images/
│   └── annotations.json
└── classmap.txt            ← class_name per line for inference
```

### Segmentation:
```
data_dir/
├── train/
│   ├── images/
│   └── masks/             ← PNG masks with label IDs as pixel values
├── val/
│   ├── images/
│   └── masks/
└── test/
    ├── images/
    └── masks/
```

---

## 10. Augmentation Config Consistency

The `augmentation.mean` and `augmentation.std` values MUST be consistent across:

1. **tao-pytorch training** — `dataset.augmentation.mean/std` in experiment spec
2. **tao-pytorch export** — baked into ONNX preprocessing (or applied externally)
3. **tao-deploy inference** — `dataset.augmentation.mean/std` in deploy inference spec
4. **tao-deploy evaluation** — `dataset.augmentation.mean/std` in deploy evaluate spec
5. **tao-deploy engine builder** — `preprocess_mode` ("torch" uses ImageNet defaults)

Standard ImageNet normalization (used by most models):
```yaml
mean: [0.485, 0.456, 0.406]
std: [0.229, 0.224, 0.225]
```

If the HF model uses different normalization, update ALL specs consistently.

The deploy `ClassificationEngineBuilder` uses `preprocess_mode`:
- `"torch"` → mean=[0.485, 0.456, 0.406], scale=1/[0.229, 0.224, 0.225]
- `"caffe"` → mean=[103.939, 116.779, 123.68], scale=1.0, BGR channel order
- `"tf"` → mean=0, scale=1/127.5, then subtract 1

---

## 11. Multi-GPU Configuration Flow

```
User YAML spec                    Entrypoint launch()              Training script
─────────────                     ──────────────────               ───────────────
train:                       →    Reads num_gpus, gpu_ids     →   TAO_VISIBLE_DEVICES env var
  num_gpus: 4                     Sets TAO_VISIBLE_DEVICES         parsed by initialize_train_experiment()
  gpu_ids: [0,1,2,3]             Wraps with torchrun:              → trainer_kwargs['devices']
  num_nodes: 1                    torchrun --nproc-per-node=4       → Trainer(devices=[0,1,2,3],
                                                                              strategy='ddp_find_unused_parameters_true',
                                                                              sync_batchnorm=True)
```

**Agent must ensure:**
- PLModel's `configure_callbacks()` and training script handle DDP correctly
- Data module uses `DistributedSampler` when multi-GPU
- `use_distributed_sampler=False` in Trainer (PLModel provides custom sampler)

---

## 12. Train Script → initialize_train_experiment() Contract

`initialize_train_experiment(cfg, key)` returns `(resume_ckpt, trainer_kwargs)`:

```python
trainer_kwargs = {
    'logger': [TensorBoardLogger(save_dir=results_dir, version=1, name="lightning_logs")],
    'devices': [0, 1, 2, 3],    # from TAO_VISIBLE_DEVICES
    'max_epochs': cfg.train.num_epochs,
    'check_val_every_n_epoch': cfg.train.validation_interval,
    'default_root_dir': results_dir,
    'accelerator': 'gpu',
    'enable_checkpointing': False,  # PLModel defines own ModelCheckpoint in configure_callbacks()
}
```

The agent's train script must:
1. Call `initialize_train_experiment(cfg, key)`
2. Create the data module: `dm = <DataModule>(cfg.dataset)` then `dm.setup(stage="fit")`
3. Create the model: `model = <ModelPlModel>(cfg)`
4. Determine strategy: `'ddp_find_unused_parameters_true'` if multi-GPU else `'auto'`
5. Map precision: `fp16` → `'16-mixed'`, `bf16` → `'bf16-mixed'`, `fp32` → `'32-true'`
6. Create Trainer with `sync_batchnorm=True`, `use_distributed_sampler=False`
7. Call `trainer.fit(model, dm, ckpt_path=resume_ckpt)`

---

## 13. Evaluate/Inference Script Contract

```python
# evaluate.py
model_path, trainer_kwargs = initialize_evaluation_experiment(cfg, key)
dm = <DataModule>(cfg.dataset)
dm.setup(stage="test")
model = <ModelPlModel>.load_from_checkpoint(model_path, map_location="cpu", experiment_spec=cfg)
trainer = Trainer(**trainer_kwargs)
trainer.test(model, datamodule=dm)

# inference.py
model_path, trainer_kwargs = initialize_inference_experiment(cfg, key)
dm = <DataModule>(cfg.dataset)
dm.setup(stage="predict")
model = <ModelPlModel>.load_from_checkpoint(model_path, map_location="cpu", experiment_spec=cfg)
trainer = Trainer(**trainer_kwargs)
trainer.predict(model, datamodule=dm)
```

**Key:** `load_from_checkpoint` requires `experiment_spec=cfg` as a keyword argument. The PLModel's `__init__` must accept `experiment_spec` and use it to rebuild the model architecture.

---

## 14. Export Script Contract

```python
# Load model
sf_model = <ModelPlModel>.load_from_checkpoint(model_path, map_location="cpu", experiment_spec=cfg)
model = sf_model.model  # Extract the raw nn.Module (not the PLModel wrapper)
model.eval()
model.cuda()

# Create dummy input matching export config
dummy_input = torch.ones(batch_size, input_channel, input_height, input_width, device='cuda')

# Export via ONNXExporter
from nvidia_tao_pytorch.core.exporters import ONNXExporter
onnx_exporter = ONNXExporter()
onnx_exporter.export_model(
    model, batch_size, output_file, dummy_input,
    input_names=['input'], output_names=['output'],
    opset_version=cfg.export.opset_version,
    do_constant_folding=True
)
```

**Agent must ensure:**
- ONNX input name is always `"input"`, output name is always `"output"`
- The raw `model` (not PLModel wrapper) is exported
- Input dimensions match what the deploy pipeline expects
- Dynamic batch size if `batch_size == -1`

---

## 15. Deploy gen_trt_engine Script Contract

```python
# Decrypt ONNX if encrypted
tmp_onnx_file, file_format = decode_model(cfg.gen_trt_engine.onnx_file)

# Initialize builder kwargs
engine_builder_kwargs, create_engine_kwargs = initialize_gen_trt_engine_experiment(cfg)

# Detect QDQ quantization
strongly_typed = is_qdq_quantized_onnx(tmp_onnx_file) if file_format == "onnx" else False

# Build engine
builder = <ModelName>EngineBuilder(
    **engine_builder_kwargs,
    workspace=cfg.gen_trt_engine.tensorrt.workspace_size,
    is_qat=False,
    strongly_typed=strongly_typed,
    data_format="channels_first",
    preprocess_mode="torch"        # Must match training normalization
)
builder.create_network(tmp_onnx_file, file_format)
builder.create_engine(**create_engine_kwargs)
```

---

## 16. Deploy Inference Script Contract

```python
# Load class mapping
classmap = os.path.join(cfg.dataset.root_dir, 'classes.txt')
mapping_dict = {line.rstrip(): idx for idx, line in enumerate(sorted(open(classmap)))}

# Create TRT inferencer
trt_infer = ClassificationInferencer(
    cfg.inference.trt_engine,
    data_format="channel_first",
    batch_size=cfg.inference.batch_size
)

# Create NumPy dataloader
dl = ClassificationLoader(
    input_shape=trt_infer.input_tensors[0].shape,  # From TRT engine
    data_paths=[cfg.dataset.test_dataset.images_dir],
    class_mapping=mapping_dict,
    is_inference=True,
    batch_size=cfg.inference.batch_size,
    image_mean=cfg.dataset.augmentation.mean,       # Must match training
    image_std=cfg.dataset.augmentation.std           # Must match training
)

# Run inference and write results
with open(f"{cfg.results_dir}/result.csv", 'w') as csv_f:
    for imgs, _ in dl:
        y_pred = trt_infer.infer(imgs)
        class_indices = np.argmax(y_pred, axis=1)
        # Write to CSV
```

---

## 17. Status Logging

Scripts use `@monitor_status(name='<ModelName>', mode='<subtask>')` decorator which:
1. Creates `status.json` in results_dir
2. Writes RUNNING status on entry
3. Writes SUCCESS/FAILURE status on exit
4. Captures exceptions and logs tracebacks

The `name` parameter should match the model's display name. The `mode` must be one of: `train`, `evaluate`, `inference`, `export`, `gen_trt_engine`.

---

## 18. WandB / MLOps Integration

If `cfg.wandb.enable` is True and the user has WandB configured:
- `initialize_train_experiment()` adds a WandB logger
- Logs: metrics per epoch, hyperparameters, model artifacts
- Config fields: `wandb.project`, `wandb.entity`, `wandb.tags`, `wandb.name`, `wandb.run_id`

The agent doesn't need to add WandB code — it's handled by `initialize_train_experiment()`. But the ExperimentConfig must include the `wandb` section (inherited from `CommonExperimentConfig`).

---

## 19. Encryption Key Flow

```
User sets: encryption_key: "tlt_encode" in YAML
  → initialize_train_experiment() calls TLTPyTorchCookbook.set_passphrase(key)
  → ModelCheckpoint saves .pth files (unencrypted) or .tlt files (encrypted)
  → Export can produce .etlt (encrypted ONNX) if key is set
  → Deploy decode_model() decrypts .etlt back to ONNX before TRT build
```

The agent doesn't need to implement encryption logic — just pass `cfg.encryption_key` to the initialization functions.

---

## 20. Consistency Checklist

Before considering implementation complete, verify:

- [ ] `ExperimentConfig` dataclass field names match experiment spec YAML keys exactly
- [ ] `model_params_mapping.py` maps every backbone variant → correct `head.in_channels`
- [ ] `checkpoint_filename` in PLModel matches what specs reference in `evaluate.checkpoint`, etc.
- [ ] `augmentation.mean/std` are identical across training spec, deploy inference spec, and deploy evaluate spec
- [ ] `preprocess_mode` in EngineBuilder matches the normalization used during training
- [ ] `input_names=['input']` and `output_names=['output']` in ONNX export
- [ ] Deploy specs use `gen_trt_engine.onnx_file` and `gen_trt_engine.trt_engine` (not bare `onnx_file`)
- [ ] `results_dir` interpolation paths (`${results_dir}/train/...`) form a valid chain
- [ ] Entrypoint imports from correct module (`nvidia_tao_pytorch.core.entrypoint` vs `nvidia_tao_deploy.cv.common.entrypoint.entrypoint_hydra`)
- [ ] Scripts use correct decorator imports (`nvidia_tao_pytorch.core.hydra.hydra_runner` vs `nvidia_tao_deploy.cv.common.hydra.hydra_runner`)
- [ ] `monitor_status` imported from correct module per repo
- [ ] `classes.txt` path is consistent between training dataset and deploy inference/evaluate
- [ ] Dynamic batch export (`batch_size: -1`) matches `dynamic_axes` in ONNX export call
