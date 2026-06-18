---
name: nemo-automodel-recipe-development
description: Create and modify NeMo AutoModel training and evaluation recipes, including YAML structure, builders, and execution flow.
when_to_use: Creating or modifying training, SFT, or eval recipes, adding new YAML config fields, debugging recipe construction or trainer issues, or understanding the recipe execution flow.
license: Apache-2.0
metadata:
  author: NVIDIA
  tags:
    - nemo-automodel
    - recipe-development
---

# NeMo AutoModel Recipe Development

## Instructions

For recipe questions, answer with the smallest complete path to action:

1. Name the relevant recipe file or YAML section.
2. List the builder functions or config keys involved.
3. Include a minimal YAML or command example when the question asks how to
   configure something.
4. End with a local validation command or tiny CPU-compatible test.

For conceptual recipe questions, answer from this skill without inspecting the
repository or loading other AutoModel skills unless the user asks you to edit
files. Keep the response focused on recipe YAML, builders, CLI routing, tests,
and local validation.

Use these compact answer patterns for common questions:

- New finetuning recipe variant: start from the closest file under
  `nemo_automodel/recipes/`, update the model, dataset or dataloader,
  optimizer, loss, LR scheduler, step scheduler, and checkpoint builders,
  register a CLI route only if adding a command or domain alias, add example
  YAML under `examples/`, then add a tiny CPU-compatible unit test and run
  `automodel finetune llm -c <config.yaml>`.
- `_target_` fields: describe `_target_` as the fully qualified Python callable,
  explain that sibling keys become keyword arguments, show optimizer and dataset
  examples, and mention nested CLI overrides such as `--optimizer.lr`.
- Validation and checkpointing: name `step_scheduler.val_check_interval`,
  `step_scheduler.checkpoint_interval`, `validation_dataset`,
  `restore_from.path`, and consolidated safetensors; include the minimal YAML
  snippet from this skill.

For validation and checkpointing, always name:

- `step_scheduler.val_check_interval` for validation cadence.
- `step_scheduler.checkpoint_interval` for save cadence.
- `validation_dataset` as the validation dataloader source.
- `restore_from.path` for resume.
- Consolidated safetensors as the default checkpoint format for HF ecosystem
  compatibility.

## Routing Boundary

Use this skill for recipe construction and execution-flow questions: YAML
structure, `_target_` callables, builder functions, validation datasets,
checkpoint configuration, CLI route registration, and recipe-specific tests.

Do not use this skill for standalone distributed strategy selection, cluster
launcher configuration, or model architecture onboarding unless the user is
asking how those choices appear inside an AutoModel recipe YAML.

## Recipe Architecture

### Execution Flow

```
CLI (automodel finetune llm -c config.yaml)
  -> app.py parses command + domain + config
    -> recipe script (e.g. train_ft.py) main(config_path)
      -> Recipe class .setup() builds all components
        -> .run_train_validation_loop() executes training
```

### Recipe Class

Recipes inherit from `BaseRecipe` and implement two methods:

- `setup()` -- builds model, optimizer, dataloader, loss, LR scheduler, step scheduler, and checkpoint config via builder functions.
- `run_train_validation_loop()` -- executes the training and validation loop.

### Builder Pattern

All components are constructed through dedicated builder functions:

- `build_model()` -- instantiates the model from config
- `build_optimizer()` -- creates optimizer (AdamW, etc.)
- `build_dataloader()` -- sets up train and validation dataloaders
- `build_loss_fn()` -- creates the loss function
- `build_lr_scheduler()` -- creates the learning rate scheduler
- `build_step_scheduler()` -- creates the step scheduler controlling training progression
- `build_checkpoint_config()` -- configures checkpointing

### Infrastructure Application Order

Components are applied in this strict order after building:

1. PEFT (LoRA, etc.)
2. FP8 quantization
3. QAT (quantization-aware training)
4. Checkpoint load / restore
5. Parameter freezing
6. Sharding (FSDP2, Megatron-FSDP, DDP)
7. Device placement
8. `torch.compile`
9. Context parallelism hooks

## YAML Config Anatomy

A complete recipe config follows this structure:

```yaml
step_scheduler:
  max_steps: 1000
  num_epochs: 1
  grad_accumulation_steps: 4
  val_check_interval: 100
  checkpoint_interval: 500
  log_interval: 10

dist_env:
  master_addr: localhost
  master_port: 29500

rng:
  seed: 42

model:
  _target_: nemo_automodel.models.llm.NemotronHForCausalLM
  name_or_path: meta-llama/Llama-3.2-1B
  # additional model kwargs passed to the constructor

compile:
  enabled: false
  backend: inductor

clip_grad_norm:
  max_norm: 1.0

distributed:
  strategy: fsdp2       # fsdp2 | megatron_fsdp | ddp
  dp_size: auto
  tp_size: 1
  cp_size: 1

loss_fn:
  _target_: torch.nn.CrossEntropyLoss

dataset:
  _target_: nemo_automodel.datasets.squad.SquadDataset
  tokenizer_name_or_path: meta-llama/Llama-3.2-1B
  max_seq_length: 2048

validation_dataset:
  _target_: nemo_automodel.datasets.squad.SquadDataset
  split: validation

packed_sequence:
  enabled: false

dataloader:
  batch_size: 4
  num_workers: 4
  pin_memory: true

optimizer:
  _target_: torch.optim.AdamW
  lr: 2.0e-5
  weight_decay: 0.01

lr_scheduler:
  _target_: nemo_automodel.schedulers.CosineAnnealingWarmup
  warmup_steps: 50
  min_lr: 1.0e-6
```

### The `_target_` Pattern

The `_target_` key specifies a fully qualified Python callable. All remaining keys in that section are passed as keyword arguments:

```yaml
optimizer:
  _target_: torch.optim.AdamW   # callable
  lr: 2.0e-5                    # kwarg
  weight_decay: 0.01            # kwarg
```

This is equivalent to: `torch.optim.AdamW(lr=2e-5, weight_decay=0.01)`.

### CLI Overrides

Any config value can be overridden from the command line:

```bash
automodel finetune llm -c config.yaml \
  --optimizer.lr 1e-4 \
  --step_scheduler.max_steps 500 \
  --distributed.tp_size 2
```

## Examples

Validation and checkpointing:

```yaml
step_scheduler:
  val_check_interval: 100
  checkpoint_interval: 500

validation_dataset:
  _target_: nemo_automodel.datasets.squad.SquadDataset
  split: validation

restore_from:
  path: /checkpoints/step-500
```

## Domain-Specific Notes

### LLM

- `nemo_automodel/recipes/llm/train_ft.py` handles both finetuning and pretraining. The distinction is in the config (dataset, learning rate, etc.).
- `nemo_automodel/recipes/llm/kd.py` implements knowledge distillation with a teacher and student model.
- `nemo_automodel/recipes/llm/benchmark.py` runs throughput and latency benchmarks.

### VLM

- Uses `NeMoAutoModelForImageTextToText` instead of causal LM classes.
- Config includes a `processor` section instead of a standalone tokenizer.
- Recipe lives in `nemo_automodel/recipes/vlm/finetune.py`.

### Diffusion

- Uses `NeMoAutoDiffusionPipeline`.
- Requires a `parallel_scheme` dict in config to define parallelism.
- Only supports DDP and FSDP2 strategies (no Megatron-FSDP).
- Recipe lives in `nemo_automodel/recipes/diffusion/train.py`.

### Retrieval

- Two encoder patterns:
  - **Bi-encoder** (`nemo_automodel/recipes/retrieval/train_bi_encoder.py`): separate query and document encoders, contrastive loss.
  - **Cross-encoder** (`nemo_automodel/recipes/retrieval/train_cross_encoder.py`): joint encoding, classification head.
- Hard negative mining: `nemo_automodel/recipes/retrieval/mine_hard_negatives.py`.

## Training Loop Details

The training loop follows this structure per epoch:

```
for epoch in range(num_epochs):
    for batch_idx in range(batches_per_epoch):
        # --- gradient accumulation inner loop ---
        for micro_batch in micro_batches:
            if pipeline_parallel:
                schedule.step(micro_batch)    # PP schedule
            else:
                loss = model(micro_batch)     # direct forward
                loss.backward()

        # --- optimizer step ---
        scale_grads_and_clip_grad_norm(model, max_norm)
        optimizer.step()
        lr_scheduler.step()
        optimizer.zero_grad()

        # --- logging ---
        MetricsSample(step, epoch, loss, grad_norm, lr, mem, tps, mfu)

        # --- validation (at configured intervals) ---
        if step % val_check_interval == 0:
            run_validation()

        # --- checkpoint (at configured intervals) ---
        if step % checkpoint_interval == 0:
            save_checkpoint()
```

### StepScheduler

Controls all training progression: total epochs, total steps, gradient accumulation steps, validation interval, checkpoint interval, and logging interval.

### Gradient Clipping

Applied via `scale_grads_and_clip_grad_norm()` after the backward pass and before the optimizer step. Controlled by `clip_grad_norm.max_norm` in config.

### Context Parallelism

When `cp_size > 1`, batches are split across the context-parallel group using `make_cp_batch_and_ctx()`. This must happen before the forward pass.

### MetricsSample

Each training step produces a `MetricsSample` with fields:

- `step` -- global step count
- `epoch` -- current epoch
- `loss` -- training loss
- `grad_norm` -- gradient norm after clipping
- `lr` -- current learning rate
- `mem` -- GPU memory usage
- `tps` -- tokens per second
- `mfu` -- model FLOPS utilization

## Validation & Checkpointing

### Validation

- Runs at intervals defined by `step_scheduler.val_check_interval`.
- Uses the validation dataloader built from `validation_dataset` config.
- Model is set to eval mode; gradients are disabled.

### Checkpointing

- Default format: consolidated safetensors for easy deployment on HF ecosystem (always prefer this over DCP).
- Checkpoint interval controlled by `step_scheduler.checkpoint_interval`.
- Resume training via the `restore_from` config key pointing to a checkpoint directory.

```yaml
restore_from:
  path: /checkpoints/step-500
```

## Pitfalls

| Problem | Cause | Fix |
|---|---|---|
| Silent config errors | Typo in `_target_` value | The class path must be a valid, importable Python callable. Double-check the module path and class name. |
| Training crashes at first step | `global_batch_size` not divisible by `local_batch_size * dp_size * grad_accumulation_steps` | Ensure the batch size math is consistent across all dimensions. |
| New recipe not accessible via CLI | Missing CLI command alias registration | Register the new route in the CLI app so `automodel <command> <domain>` resolves correctly. |
| Shape mismatch at forward pass | Dataset collate function output does not match model input signature | Verify that the collate function returns tensors with the keys and shapes the model expects. |
| OOM during validation | Validation batch size too large or gradients not disabled | Wrap validation in `torch.no_grad()` and consider a smaller validation batch size. |
| Checkpoint restore fails | Mismatched model architecture between checkpoint and config | Ensure the model config matches the checkpoint exactly (layer count, hidden dim, vocab size). |
