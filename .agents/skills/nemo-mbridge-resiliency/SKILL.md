---
name: nemo-mbridge-resiliency
description: Resiliency features in Megatron Bridge including fault tolerance, straggler detection, in-process restart, preemption, and re-run state machine.
license: Apache-2.0
when_to_use: Enabling resiliency features, or investigating a commit that caused training hangs, straggler detection failures, or broken restarts; 'fault tolerance', 'straggler detection', 'hang detection', 'automatic restart', 'in-process restart', 'preemption', 'nvidia-resiliency-ext'.
---

# Resiliency

Stable docs: @docs/training/resiliency.md, @docs/training/checkpointing.md
Card: @skills/nemo-mbridge-resiliency/card.yaml

## Enablement

### Fault tolerance (Slurm only)

#### Option 1: NeMo Run plugin (recommended)

```python
from megatron.bridge.recipes.run_plugins import FaultTolerancePlugin
import nemo_run as run

task = run.Script(...)
run_plugins = [
    FaultTolerancePlugin(
        enable_ft_package=True,
        calc_ft_timeouts=True,
        num_in_job_restarts=3,
        num_job_retries_on_failure=2,
        initial_rank_heartbeat_timeout=1800,
        rank_heartbeat_timeout=300,
    )
]
run.run(task, plugins=run_plugins, executor=executor)
```

| Plugin parameter | Default | Description |
|---|---|---|
| `num_in_job_restarts` | 3 | Max restarts within same job |
| `num_job_retries_on_failure` | 2 | Max new job launches on failure |
| `initial_rank_heartbeat_timeout` | 1800 | First heartbeat timeout (seconds) |
| `rank_heartbeat_timeout` | 300 | Subsequent heartbeat timeout (seconds) |

#### Option 2: Direct config + ft_launcher

```python
from megatron.bridge.training.config import FaultToleranceConfig

cfg.ft = FaultToleranceConfig(
    enable_ft_package=True,
    calc_ft_timeouts=True,
    simulate_fault=False,
    simulated_fault_type="random",
)
```

Launch with `ft_launcher` (not `torchrun`):

```bash
export GROUP_RANK=0  # required for non-Slurm
ft_launcher \
    --rdzv_backend=c10d --rdzv_endpoint=${MASTER_ADDR}:${MASTER_PORT} \
    --nnodes=${NUM_NODES} --nproc-per-node=${NUM_GPUS_PER_NODE} \
    --ft-rank_section_timeouts=setup:600,step:180,checkpointing:420 \
    --ft-rank_out_of_section_timeout=300 \
    your_training_script.py
```

| Config parameter | Default | Description |
|---|---|---|
| `enable_ft_package` | False | Enable fault tolerance |
| `calc_ft_timeouts` | False | Auto-compute optimal timeouts |
| `simulate_fault` | False | Enable fault simulation for testing |
| `simulated_fault_type` | `"random"` | `"rank_hung"`, `"rank_killed"`, or `"random"` |
| `simulated_fault_rank` | None | Specific rank to fault (random if None) |
| `simulated_fault_base_delay` | 0 | Base delay before simulating fault |

Section-based timeout monitoring covers setup, training steps, checkpointing,
and out-of-section time independently. Timeouts are saved to `ft_state.json`
for subsequent runs when `calc_ft_timeouts=True`.

### NVRx straggler detection

```python
from megatron.bridge.training.config import NVRxStragglerDetectionConfig

cfg.nvrx_straggler = NVRxStragglerDetectionConfig(
    enabled=True,
    report_time_interval=300.0,
    calc_relative_gpu_perf=True,
    calc_individual_gpu_perf=True,
    num_gpu_perf_scores_to_print=5,
    gpu_relative_perf_threshold=0.7,
    gpu_individual_perf_threshold=0.7,
    stop_if_detected=False,
    enable_logging=True,
)
```

| Parameter | Default | Description |
|---|---|---|
| `enabled` | False | Enable straggler detection |
| `report_time_interval` | 300.0 | Seconds between straggler checks |
| `calc_relative_gpu_perf` | True | Compare ranks against each other |
| `calc_individual_gpu_perf` | True | Track per-rank degradation over time |
| `gpu_relative_perf_threshold` | 0.7 | Threshold for relative performance (0-1) |
| `gpu_individual_perf_threshold` | 0.7 | Threshold for individual performance (0-1) |
| `stop_if_detected` | False | Terminate training on straggler |
| `num_gpu_perf_scores_to_print` | 5 | Number of best/worst scores to print |
| `profiling_interval` | 1 | Profiling interval for detector |

### Preemption

#### Plugin (Slurm)

```python
from megatron.bridge.recipes.run_plugins import PreemptionPlugin

plugins = [
    PreemptionPlugin(
        preempt_time=60,
        enable_exit_handler=True,
        enable_exit_handler_for_data_loader=False,
    )
]
```

| Plugin parameter | Default | Description |
|---|---|---|
| `preempt_time` | 60 | Seconds before job limit to send signal |
| `enable_exit_handler` | True | Enable signal handler in training |
| `enable_exit_handler_for_data_loader` | False | Enable for dataloader workers |

#### Direct config

```python
import signal
cfg.train.exit_signal_handler = True
cfg.train.exit_signal = signal.SIGTERM
cfg.train.exit_signal_handler_for_dataloader = False
```

### Re-run state machine (experimental)

```python
from megatron.bridge.training.config import RerunStateMachineConfig

cfg.rerun_state_machine = RerunStateMachineConfig(
    rerun_mode="validate_results",
    check_for_nan_in_loss=True,
    check_for_spiky_loss=False,
    spiky_loss_factor=10.0,
)
```

| Parameter | Default | Description |
|---|---|---|
| `rerun_mode` | `"disabled"` | `"disabled"`, `"validate_results"`, `"report_determinism_stats"` |
| `check_for_nan_in_loss` | True | Check for NaN in loss |
| `check_for_spiky_loss` | False | Check for unexpectedly large loss |
| `spiky_loss_factor` | 10.0 | Loss flagged if > factor * max observed (increase for large models) |

Exit codes: 16 = resume to disambiguate, 17 = failed validation.

### In-process restart (experimental)

```python
from megatron.bridge.training.config import InProcessRestartConfig

cfg.inprocess_restart = InProcessRestartConfig(
    enabled=True,
    granularity="node",
    soft_timeout=60.0,
    hard_timeout=90.0,
)
```

| Parameter | Default | Description |
|---|---|---|
| `enabled` | False | Enable in-process restart |
| `active_world_size` | None | Ranks executing workload (rest are warm reserves) |
| `granularity` | `"node"` | `"node"` or `"rank"` restart granularity |
| `max_iterations` | None | Max restart attempts (None = unlimited) |
| `soft_timeout` | 60.0 | Detect GIL-released hangs (seconds) |
| `hard_timeout` | 90.0 | Force-terminate hung ranks (seconds) |
| `heartbeat_interval` | 30.0 | Heartbeat interval (seconds) |
| `heartbeat_timeout` | 60.0 | Missing heartbeat timeout (seconds) |
| `barrier_timeout` | 120.0 | Distributed barrier timeout (seconds) |
| `completion_timeout` | 120.0 | Completion barrier timeout (seconds) |
| `empty_cuda_cache` | True | Clear CUDA cache during restart |
| `max_rank_faults` | None | Max rank faults before terminating |
| `monitor_process_logdir` | None | Directory for monitor logs |

Required environment variables:

```bash
export TORCH_CPP_LOG_LEVEL=error
export TORCH_NCCL_RETHROW_CUDA_ERRORS=0
export NCCL_NVLS_ENABLE=0
```

The PyTorch NCCL watchdog timeout must exceed `hard_timeout`. NeMo-Run's
Slurm Executor is not supported; launch directly with `srun --kill-on-bad-exit=0`.

### Async checkpoint save

```python
cfg.checkpoint.async_save = True
cfg.checkpoint.ckpt_format = "torch_dist"
```

### Local checkpointing (NVRx)

```python
cfg.checkpoint.non_persistent_local_ckpt_dir = "/local/scratch/ckpt"
cfg.checkpoint.non_persistent_local_ckpt_algo = "fully_parallel"
```

## Code Anchors

### Fault tolerance
- Config: `src/megatron/bridge/training/config.py` — `FaultToleranceConfig`
- Runtime: `src/megatron/bridge/training/fault_tolerance.py`
- Plugin: `src/megatron/bridge/recipes/run_plugins.py` — `FaultTolerancePlugin`
- Perf plugin: `scripts/performance/nemo-mbridge-resiliency_plugins.py`
- Tests: `tests/unit_tests/training/test_fault_tolerance.py`
- Example: `examples/training_features/nemo-mbridge-resiliency/fault_tolerance/`

### Straggler detection
- Config: `src/megatron/bridge/training/config.py` — `NVRxStragglerDetectionConfig`
- Runtime: `src/megatron/bridge/training/nvrx_straggler.py`
- Train loop: `src/megatron/bridge/training/train.py` — `check_nvrx_straggler_detection`
- Tests: `tests/unit_tests/training/test_nvrx_straggler.py`, `tests/functional_tests/training/test_nvrx_straggler.py`
- Example: `examples/training_features/nemo-mbridge-resiliency/straggler_detection/`

### In-process restart
- Config: `src/megatron/bridge/training/config.py` — `InProcessRestartConfig`
- Runtime: `src/megatron/bridge/training/inprocess_restart.py`
- Entry point: `src/megatron/bridge/training/pretrain.py` — `maybe_wrap_for_inprocess_restart`
- Tests: `tests/unit_tests/training/test_inprocess_restart.py`, `tests/functional_tests/training/test_inprocess_restart.py`

### Preemption
- Plugin: `src/megatron/bridge/recipes/run_plugins.py` — `PreemptionPlugin`
- Signal handler: `src/megatron/bridge/training/utils/sig_utils.py`
- Tests: `tests/unit_tests/recipes/test_run_plugins.py`

### Re-run state machine
- Config: `src/megatron/bridge/training/config.py` — `RerunStateMachineConfig`
- Init: `src/megatron/bridge/training/initialize.py` — `init_rerun_state`

### Checkpointing
- Async save: `src/megatron/bridge/training/checkpointing.py` — `schedule_async_save`
- Local ckpt: `src/megatron/bridge/training/checkpointing.py` — `LocalCheckpointManager`
- Tests: `tests/functional_tests/training/test_local_checkpointing.py`

## Pitfalls

1. **ft_launcher, not torchrun**: Direct `FaultToleranceConfig` requires
   `ft_launcher`. Using `torchrun` silently disables FT. For non-Slurm,
   set `GROUP_RANK=0`.

2. **Async save requires torch_dist**: `async_save=True` only works with
   `ckpt_format="torch_dist"`. Other formats silently fail or error.

3. **IPR + NeMo-Run**: In-process restart is not compatible with NeMo-Run
   or Slurm preemption plugins. Requires specific PyTorch/NCCL versions
   and env vars.

4. **NVRx vs legacy straggler**: Two detectors exist. Use NVRx
   (`nvrx_straggler`); do not enable both.

5. **stop_if_detected default**: NVRx logs but does not stop training by
   default. Set `stop_if_detected=True` for automatic termination.

6. **NCCL watchdog vs hard_timeout**: For IPR, NCCL watchdog timeout must
   exceed `hard_timeout` or PyTorch kills the process before recovery.

7. **Rerun state machine is alpha**: Use `check_for_nan_in_loss=True` for
   NaN detection, but don't rely on full rerun workflows yet.

## Verification

### Fault tolerance
```bash
./examples/training_features/nemo-mbridge-resiliency/fault_tolerance/run_fault_tolerance.sh
./examples/training_features/nemo-mbridge-resiliency/fault_tolerance/run_fault_tolerance.sh --simulate-fault
```
Look for `[FaultTolerance]` / `[RankMonitorServer]` log lines with section
timeouts. Simulated fault should trigger restart from checkpoint.

### Straggler detection
```bash
uv run python -m torch.distributed.run --nproc_per_node=2 \
    examples/training_features/nemo-mbridge-resiliency/straggler_detection/straggler_detection_example.py
```
Look for `GPU relative performance` and `GPU individual performance` reports
with per-rank scores.

### Async checkpoint
Look for `Scheduling async checkpoint save` in logs. Training iterations
should continue while checkpoint files are being written.

### In-process restart
```bash
pytest tests/functional_tests/training/test_inprocess_restart.py -v
```
Requires compatible PyTorch/NCCL versions.
