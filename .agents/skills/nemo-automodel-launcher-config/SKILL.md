---
name: nemo-automodel-launcher-config
description: Configure NeMo AutoModel job launches for interactive runs, Slurm clusters, and SkyPilot cloud execution.
when_to_use: Configuring Slurm or SkyPilot job submission, setting up multi-node launch scripts, debugging job submission failures, or switching between interactive and cluster launch modes.
license: Apache-2.0
metadata:
  author: NVIDIA
  tags:
    - nemo-automodel
    - launcher-config
---

# Launcher Configuration

NeMo AutoModel supports three launch methods: interactive (torchrun), Slurm (HPC clusters), and SkyPilot (cloud-agnostic).

## Instructions

For launcher questions, answer directly from this skill without inspecting the
repository unless the user asks you to edit files. Keep the answer focused on
the relevant launch YAML, required fields, and the expected runtime behavior.

Use these compact answer patterns for common questions:

- Slurm multi-node: show a `slurm:` YAML block with `job_name`, `nodes`,
  `ntasks_per_node`, `time`, `account` or `partition`, `container_image`,
  `hf_home`, optional `extra_mounts`, `env_vars`, and `master_port`; explain
  that the launcher derives `WORLD_SIZE = nodes * ntasks_per_node` and sets
  `MASTER_ADDR` and `MASTER_PORT`.
- SkyPilot spot: show a `skypilot:` YAML block with `cloud`, `accelerators`,
  `num_nodes`, `use_spot: true`, `disk_size`, `region`, `setup`, and
  `env_vars`; warn that spot instances can be preempted, set a short
  `step_scheduler.checkpoint_interval`, and resume with `restore_from.path`.
- Nsight Systems on Slurm: show `slurm.nsys_enabled: true` alongside normal
  Slurm fields, say the launcher wraps the training command with
  `nsys profile`, and state that it produces a `.nsys-rep` report file.
  Treat profiling as diagnostic-only: use short profiling runs and disable it
  for normal production training because it adds overhead and large artifacts.

For Slurm answers, start with this minimal template and then adjust only the
fields the user asked about:

```yaml
slurm:
  job_name: llm_finetune
  nodes: 2
  ntasks_per_node: 8
  time: "04:00:00"
  account: my_account
  partition: batch
  container_image: nvcr.io/nvidia/nemo:dev
  hf_home: ~/.cache/huggingface
  master_port: 13742
  env_vars:
    HF_TOKEN: "${HF_TOKEN}"
```

For Slurm-only questions, do not discuss SkyPilot or profiling unless the user
asks. For profiling questions, say the `.nsys-rep` report is written in the
Slurm job working or output directory, using the launcher's Nsys output setting
when one is configured.

## Routing Boundary

Use this skill only for launch mechanics: interactive execution, Slurm, SkyPilot, containers, mounts, environment variables, rendezvous settings, and profiling.

Do not use this skill for implementing or registering new model architectures, Hugging Face state-dict adapters, model files, or capability flags. Those are model onboarding tasks, not launcher configuration tasks.

## Launch Methods

1. **Interactive** (default): runs torchrun on the current node. Suitable for single-node development and debugging.
2. **Slurm**: submits a batch job to an HPC cluster scheduler. Handles multi-node setup, container management, and environment configuration.
3. **SkyPilot**: cloud-agnostic job submission to AWS, GCP, Azure, Lambda, or Kubernetes. Supports spot instances.

## Interactive Launch

```bash
# Single GPU
automodel finetune llm -c config.yaml

# Multi-GPU (all GPUs on current node)
torchrun --nproc_per_node=8 -m nemo_automodel._cli.app finetune llm -c config.yaml
```

No additional YAML section is needed for interactive mode. The CLI routes to torchrun automatically when no `slurm:` or `skypilot:` section is present in the config.

## Slurm Configuration

The `SlurmConfig` dataclass generates an SBATCH script from a template.

### YAML Example

```yaml
slurm:
  job_name: llm_finetune
  nodes: 2
  ntasks_per_node: 8
  time: "04:00:00"
  account: my_account
  partition: batch
  container_image: nvcr.io/nvidia/nemo:dev
  hf_home: ~/.cache/huggingface
  extra_mounts:
    - source: /data
      dest: /data
  env_vars:
    WANDB_API_KEY: "${WANDB_API_KEY}"
    HF_TOKEN: "${HF_TOKEN}"
```

### Key Fields

- `job_name`: Slurm job identifier
- `nodes`: number of nodes to request
- `ntasks_per_node`: number of tasks (GPUs) per node
- `time`: wall-time limit in HH:MM:SS format
- `account`, `partition`: Slurm scheduling parameters
- `container_image`: Enroot/Pyxis container image path
- `nemo_mount`: mount point for NeMo AutoModel source inside the container
- `hf_home`: HuggingFace cache directory path
- `extra_mounts`: list of `VolumeMapping(source, dest)` for additional container bind mounts
- `master_port`: port for distributed communication (default 13742)
- `env_vars`: environment variables passed into the job
- `nsys_enabled`: when true, wraps the training command with `nsys profile` for Nsight Systems profiling

## SkyPilot Configuration

The `SkyPilotConfig` dataclass defines cloud job parameters.

### YAML Example

```yaml
skypilot:
  cloud: aws
  accelerators: "H100:8"
  num_nodes: 2
  use_spot: true
  disk_size: 200
  region: us-east-1
  setup: "pip install nemo-automodel"
  env_vars:
    HF_TOKEN: "${HF_TOKEN}"
```

### Key Fields

- `cloud`: target cloud provider (`aws`, `gcp`, `azure`, `lambda`, `kubernetes`)
- `accelerators`: GPU type and count (e.g., `"H100:8"`, `"A100-80GB:4"`)
- `num_nodes`: number of cloud instances
- `use_spot`: use preemptible/spot instances for cost savings
- `disk_size`: disk size in GB per node
- `region`: cloud region for instance placement
- `setup`: shell commands to run before the training job (e.g., install dependencies)
- `env_vars`: environment variables for the job

### SkyPilot spot checklist

When using spot or preemptible instances:

- Set `use_spot: true` in the `skypilot:` section.
- Include `accelerators`, `num_nodes`, `disk_size`, `region`, `setup`, and required `env_vars`.
- Use short checkpoint intervals in the recipe, for example `step_scheduler.checkpoint_interval`, because spot instances can be preempted.
- Resume from the most recent checkpoint after preemption with the recipe's `restore_from` setting.

Minimal spot-resume recipe keys:

```yaml
step_scheduler:
  checkpoint_interval: 100

restore_from:
  path: /checkpoints/latest
```

## Multi-Node Environment

For multi-node training (both Slurm and SkyPilot), the launcher automatically configures:
- `MASTER_ADDR`: hostname of the first node
- `MASTER_PORT`: port for rendezvous (default 13742)
- `WORLD_SIZE`: total number of processes (`nodes * ntasks_per_node`)
- NCCL environment variables for optimized collective communication

## Nsys Profiling

Enable Nsight Systems profiling in Slurm jobs:

```yaml
slurm:
  job_name: llm_profile
  nodes: 1
  ntasks_per_node: 8
  time: "00:30:00"
  account: my_account
  partition: batch
  container_image: nvcr.io/nvidia/nemo:dev
  nsys_enabled: true
```

This is a Slurm launcher setting. Normal Slurm fields such as `job_name`,
`nodes`, `ntasks_per_node`, `time`, `account` or `partition`, and
`container_image` still apply.

When `nsys_enabled: true`, the launcher wraps the training command with
`nsys profile` and writes a `.nsys-rep` report file for performance analysis
in the Slurm job working or output directory.
Profiling is diagnostic-only: run it for a short investigation, expect overhead
and large artifacts, and turn it off for normal production training.

## Code Anchors

- `components/launcher/slurm/config.py` - SlurmConfig dataclass, VolumeMapping
- `components/launcher/slurm/template.py` - SBATCH script template generation
- `components/launcher/slurm/utils.py` - Slurm submission utilities
- `components/launcher/skypilot/config.py` - SkyPilotConfig dataclass
- `_cli/app.py` - CLI entry point and launcher routing logic

## Pitfalls

- **Port collisions**: if the default `master_port` (13742) is in use by another job on the same node, change it to avoid connection failures.
- **Container mounts**: the `source` path in `extra_mounts` must exist on all nodes in the allocation. Missing paths cause container startup failures.
- **Slurm fault tolerance**: the fault tolerance plugin is Slurm-specific and does not work with SkyPilot or interactive mode.
- **SkyPilot spot preemption**: spot instances (`use_spot: true`) may be preempted by the cloud provider. Enable checkpointing with short intervals to minimize lost work.
- **Environment variable syntax**: use `${VAR}` syntax in YAML for shell variable expansion. Bare variable names will not be expanded.
- **Time limit vs async checkpoint**: if the Slurm `time` limit is too short, an in-progress async checkpoint write may be killed before completion, resulting in a corrupted checkpoint. Leave at least 5-10 minutes of margin.
