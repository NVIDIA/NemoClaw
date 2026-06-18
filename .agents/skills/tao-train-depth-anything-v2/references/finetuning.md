# Finetuning Recipes

Relative and Metric variant finetuning recipes for `depth_net` mono models.

## Relative Variant Finetuning Recipe

Relative finetune from a TAO-trained `RelativeDepthAnything` checkpoint:

| Spec key | Value | Notes |
|---|---|---|
| `model.model_type` | `RelativeDepthAnything` | |
| `model.encoder` | `vitl` | matches the released TAO relative checkpoint |
| `model.mono_backbone.pretrained_path` | `""` | the full TAO checkpoint already carries the backbone state; setting this is redundant and is overwritten by the full-state load |
| `train.pretrained_model_path` | `<TAO relative ckpt>` | full Pytorch-Lightning state load |
| `train.precision` | `fp32` (recommended) or `bf16` (alternative on Ampere SM80+) | |
| `train.optim.lr` | `5e-6` | The released relative checkpoint is already converged; the AdamW default `1e-4` listed in Important Parameters is an order of magnitude too aggressive for finetune from a converged backbone, and degrades the released checkpoint's accuracy on a short adaptation run. Use `5e-6` and a gentle scheduler (`LambdaLR`) when adapting to a new dataset. |
| `train.optim.lr_scheduler` | `LambdaLR` | gentle warmup + decay; matches the Metric Variant Recipe |

The dataset block follows **Step 2 — Pair `model_type` and `dataset_name`** in SKILL.md. Use `RelativeMonoDataset` for generic relative data and `NYUDV2Relative` for raw NYU `sync_depth_*.png` data.

If the goal is a sanity check (1-epoch loss-decreasing, exit 0) rather than convergent finetune, use the released checkpoint directly for `evaluate` / `inference` / `export` instead of running `train` — a 1-epoch finetune at any LR is unlikely to reach the released benchmark and will measure the warmup transient, not skill correctness.

The relative variant emits scale-shift-invariant disparity (unbounded). The deploy-side evaluator runs LSQ alignment + GT disparity inversion; ensure the deploy spec sets `model.model_type: RelativeDepthAnything` so those paths engage (see `tao-deploy-depth-anything-v2.md`).

## Metric Variant Finetuning Recipe

**Checkpoint compatibility**: The Metric variant only loads checkpoints trained with TAO's `MetricDepthAnythingV2` model definition. Public Depth Anything v2 metric checkpoints (e.g., from the Depth Anything V2 GitHub release) use a different head attribute naming convention and will fail with `Unexpected key(s) in state_dict: "model.depth_head.*"` when passed to `train.pretrained_model_path`, `evaluate.checkpoint`, `inference.checkpoint`, or `export.checkpoint`. Use a TAO-trained metric checkpoint (or a TAO-converted equivalent) for all metric actions.

Metric finetuning uses a pretrained `RelativeDepthAnything` ViT-L backbone via `model.mono_backbone.pretrained_path`, with the metric head (`metric_depth_head`) initialized from scratch and no full PL state load (`train.pretrained_model_path: ""`). Because the backbone weights are already well-trained, the optimizer must step gently to preserve those features while the metric head converges; use `train.optim.lr: 5e-6` (20× lower than the AdamW default `1e-4` listed in Important Parameters) with `LambdaLR`.

The TAO repository ships an authoritative reference spec at `nvidia_tao_pytorch/cv/depth_net/experiment_specs/experiment_mono_metric.yaml`; metric finetuning **must** mirror its optimizer settings unless the user has empirical evidence to deviate.

**Required overrides for metric finetuning from a relative backbone:**

| Spec key | Recommended value | Source |
|---|---|---|
| `train.optim.lr` | `0.000005` (5e-6) | `experiment_mono_metric.yaml:39` — preserves the pretrained relative backbone while the from-scratch metric head converges. The AdamW default `1e-4` is too aggressive on this backbone-pretrained setup. |
| `train.optim.lr_scheduler` | `LambdaLR` | `experiment_mono_metric.yaml:40` |
| `model.mono_backbone.pretrained_path` | `<RelativeDepthAnything TAO ckpt>` | `experiment_mono_metric.yaml:45` — backbone-only load via `parse_lighting_checkpoint_to_backbone`; metric head reinitializes |
| `train.pretrained_model_path` | `""` | omit a full PL state load to keep the metric head from inheriting any pre-existing head weights |

**Dataset normalization block — required in train AND export specs:**

```yaml
dataset:
  dataset_name: MonoDataset
  normalize_depth: false   # NYU-trained metric checkpoint default
  min_depth: 0.001
  max_depth: 10.0
```

These three fields must mirror the values from the trained checkpoint's training spec in **both** the `train` action spec **and** the `export` action spec. The export pipeline reads `dataset.{normalize_depth, min_depth, max_depth}` to build the model graph the ONNX is traced from; omitting them makes the export silently use schema defaults that do not match the checkpoint, producing a serialized graph whose deploy-side evaluator output is non-physical even though the export action itself returns exit 0. Read the authoritative values from the checkpoint's sibling `experiment.yaml`.

**Defaults already enforced by the TAO trainer (do not need to be set):**

- `train.clip_grad_norm: 0.1` (clip-by-value at the Lightning `Trainer(gradient_clip_val=..., gradient_clip_algorithm="value")` level — `nvidia_tao_pytorch/cv/depth_net/scripts/train.py:94-95`).
- `train.optim.warmup_steps: 20` (linear LR warmup before the configured scheduler engages).
- `train.optim.weight_decay: 1e-4` (AdamW).

**Precision**: use `fp32` for the metric finetune. The from-scratch metric head + low lr combination is fragile under reduced precision; `fp32` is the safe default for this Recipe.

**Sanity-run override** (1-epoch loss-decreasing check on a small NYU subset):

```yaml
train:
  num_epochs: 1
  pretrained_model_path: ""
  precision: fp32
  optim:
    lr: 0.000005
    lr_scheduler: LambdaLR
model:
  model_type: MetricDepthAnything
  encoder: vitl
  mono_backbone:
    pretrained_path: /workspace/models/<relative_ckpt>.pth
    use_bn: False
    use_clstoken: False
```

A 1-epoch run with `metric_depth_head` random init will not reach released-checkpoint metric quality (that requires multi-epoch training); the recipe's purpose is functional sanity (`exit 0` + loss decreasing + no NaN).

**Sanity-run PASS criteria — entrypoint `Execution status: PASS` is not sufficient**:

The trainer's `Execution status: PASS` only signals epoch completion — it does not check for `train_loss = NaN`. A from-scratch metric head with low learning rate can produce `train_loss = NaN` while `val/loss` and the entrypoint PASS remain misleadingly clean. Inspect the `train_loss_step` values in the run log directly; PASS means *only* if the values are finite and decreasing.

Mitigations to try in order if NaN is observed:
- Increase `dataset.train_dataset.batch_size` to 2 or higher (the per-batch variance computation has unstable degrees-of-freedom at batch_size 1).
- Increase `train.optim.warmup_steps` from the default 20 (the LambdaLR factor at step 0 is 0, producing a no-op first update; the second step then sees a head still at random init).
- If both mitigations fail, fall back to reusing a pre-trained TAO metric checkpoint via `train.pretrained_model_path: <metric_ckpt>` and skip the from-scratch metric-head path entirely.
