# Cosmos-RL Training Parameters

Important spec parameters for Cosmos-Reason2-8B SFT, grouped by area.

## Training Loop
- **train.epoch**: Number of training epochs. Default 10.
- **train.train_batch_per_replica**: Global batch size per training step. Ideally >= 32 for stability. CRITICAL: must be divisible by `train.train_policy.mini_batch` (default 4). Recommended: 32.
- **train.compile**: Set to true for potential speedup on newer GPUs (H100), else false.
- **train.output_dir**: Output directory for checkpoints and logs.

## Model & Policy
- **policy.model_name_or_path**: HuggingFace model path. Must be `nvidia/Cosmos-Reason2-8B`.
- **policy.model_max_length**: Context window size. Must be 40960 for video SFT. Affected by FPS, resolution, and prompt length.
- **policy.model_gradient_checkpointing**: Save VRAM by recomputing activations. Keep true for large models.

## Parallelism (Multi-GPU / Multi-Node)
- **policy.parallelism.dp_shard_size**: Data-parallel shard size. CRITICAL: should equal **GPUs per node** (the Cosmos-RL equivalent of `num_gpus`).
- **policy.parallelism.dp_replicate_size**: Data-parallel replication = **node count** (equivalent of `num_nodes`). For single-node training set to 1.
- **policy.parallelism.tp_size**: Tensor parallelism. Default 1.
- **policy.parallelism.cp_size**: Context parallelism. Default 1.
- **policy.parallelism.pp_size**: Pipeline parallelism. Default 1.

For multi-node, set `dp_replicate_size = num_nodes` and `dp_shard_size = gpus_per_node`. Cosmos-RL handles the distributed init internally via FSDP — it does **not** rely on the platform-level `MASTER_ADDR` / `WORLD_SIZE` env vars the way `torchrun`-launched jobs do. Just submit with `gpu_count=<gpus_per_node>` and `num_nodes=<N>` on the SDK; the Cosmos-RL spec keys drive the actual sharding.

For platform-side multi-node setup (sbatch flags on SLURM, Indexed Job + Service on Kubernetes, native multi-replica on Lepton), see the platform skill's "Multi-node training" section: `skills/platform/tao-run-on-lepton`, `skills/platform/tao-run-on-slurm`, `skills/platform/tao-run-on-kubernetes`. Brev and local Docker are single-host only.

## Optimization & Data Loading
- **train.optm_lr**: Learning rate. Default 1e-6.
- **train.train_policy.type**: Training policy. Default `sft`.
- **train.train_policy.mini_batch**: Micro-batch size per GPU. If OOM, reduce this. Constraint: `train_batch_per_replica % mini_batch == 0`.
- **train.train_policy.dataset.name**: Unique ID for dataset cache. IMPORTANT: change this if you modify `fps` or `total_pixels` to force cache regeneration.
- **train.train_policy.dataset.test_size**: Validation split. Float (0.0–1.0) = ratio; Int = absolute number.

## Vision Encoders
- **custom.vision.fps** *or* **custom.vision.nframes** — **mutually exclusive**, set exactly one.
  - `fps` (default in template, recommended): extract frames at this rate. High motion: 3. Low motion/static: 1–2.
  - `nframes`: extract this many frames evenly across the clip (use for fixed-count batching).
  - Setting both makes qwen-vl-utils' decord backend error out (`Only accept either fps or nframes`) and silently fall back to torchvision, which deadlocks under multi-worker dataloading (`BlockingIOError [Errno 11]` swscaler errors). If you switch from `fps` to `nframes`, also delete `fps` from your spec.
- **custom.vision.total_pixels**: Resolution constraint. Increase if the object of focus is small relative to the frame. Default 3136000.
- **custom.system_prompt**: Instructions prepended to every prompt.

## Checkpointing
- **train.ckpt.save_freq_in_epoch**: Save every N epochs. Default 10.
- **train.ckpt.max_keep**: Keep N most recent checkpoints. Default 8 (use 1 to save storage).
- **train.ckpt.export_safetensors**: Export in safetensors format. Default true.

## Validation
- **validation.freq_in_epoch**: Run validation every N epochs. Too frequent slows training.

## Logging
- **logging.logger**: Options: `console`, `wandb`.
- **logging.project_name** / **logging.experiment_name**: W&B experiment tracking.

## Hardware
Cosmos-RL models are 8B parameters and benefit from multi-GPU training with FSDP sharding. `dp_shard_size` should equal total GPU count. Recommended: 8x A100 or H100 (80GB each).
