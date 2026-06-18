---
agent_context: usd-performance-workflow
agent_routes:
  - omniverse-usd-performance-tuning
agent_next:
  - README.md
  - ../so-run-operations/README.md
freshness: 2026-05-20
version: "0.1.0"
---
<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Scene Optimizer Execution Reference

This docs-class page summarizes how agents should invoke Scene Optimizer
operations after the workflow has selected a runtime and an approved operation
plan. Detailed executable guidance lives in the nested
`so-run-operations` references; this page gives repo-root agents enough shape to
avoid wrong turns before entering the skill bundle.

Use setup preflight plus live `sceneOptimizer.operationsAvailable` before
execution. Per-operation files are routing stubs; upstream `usd-optimize` docs
own parameters and defaults. Local invocation mechanics live in
`../so-run-operations/references/invocation.md`; do not invent or duplicate
Python call shapes here.

## Optional Helper Wrapper Shape

Use these wrapper paths only when the selected Scene Optimizer environment or
build checkout provides them. Do not assume a Kit or standalone install ships
`tools/perf_operations`.

```bash
tools/perf_operations/run.sh run path/to/asset.usd \
    --config '[{"operation":"meshCleanup","mergeVertices":true}]' \
    --output path/to/out.usdc

tools/perf_operations/run.sh run path/to/asset.usd \
    --config-file pipeline.json \
    --summary path/to/summary.json \
    --verbose \
    --capture-stats

tools/perf_operations/run.sh run path/to/asset.usd \
    --pipeline memory-reduction \
    --no-save
```

```powershell
& tools\perf_operations\run.bat run path\to\asset.usd `
    --config '[{"operation":"meshCleanup","mergeVertices":true}]' `
    --output path\to\out.usdc
```

`--config` is inline JSON only. Use `--config-file` for a JSON file path.
Redirect stdout/stderr or wrapper-provided logs to `<output_path>/*.log` so
the final report can cite the run.

## Python API Shape

Probe the selected runtime before writing the script. Newer Kit and standalone
environments may expose `SceneOptimizerCore.getInstance()` with
`executeOperation` or `executeConfig`; some standalone builds expose the C++
binding interface from
`omni.scene.optimizer.core.bindings._omni_scene_optimizer_core`.

Before invoking any planned operation, cross-check the operation key against
`sceneOptimizer.operationsAvailable` in `<output_path>/setup-preflight.json`.
If a key is missing, report `blocked_missing_so_operation` and do not silently
substitute another operation.

The operation key comes from `references/operations/README.md`. Arguments come
from the per-operation page's Parameters table and starting-config JSON. Invalid
keys may warn or silently no-op; do not guess argument names.

## Asset Validator Import Variant

Inside Kit, use:

```python
from omni.asset_validator.core import ValidationEngine
```

In a standalone `omniverse-asset-validator` environment, use:

```python
from omni.asset_validator import ValidationEngine
```

Select the import that matches `<output_path>/setup-preflight.json`; do not mix
Kit extension imports with standalone package runs.

## Agent-Orchestrated Batch Mode

Batch mode is an agent orchestration pattern, not a wrapper flag. The helper or
API invocation still accepts one target; the agent runs independent targets in
adaptive batches.

Choose concurrency from target weight and available resources rather than a
fixed target-count cap. File size, mesh/vertex/material counts, op-chain cost,
CPU/RAM/VRAM headroom, disk space, and log volume all matter. Start with a
pilot batch, inspect resource pressure and failures, then increase or decrease
concurrency for the next batch. Serialize only when the target is monolithic,
dependency-bound, or observed resource pressure makes parallelism unsafe.

When targets include prototypes and non-prototype assets, run prototypes first.
Parallelize within each dependency group when resources allow. Prototype
changes propagate to instances, so instance-site work before prototype work
wastes runtime and can produce misleading metrics. If the batch manifest
contains `target_class: "assembly_root"` with retained meshes, process it as a
non-prototype mesh target before final stage-level cleanup; do not reduce it to
`pruneLeaves`/`computeExtents` only.

For each target, include a stable hash of the absolute input path in optimized
USD, summary, and log filenames. After every batch, verify that produced output
count matches target count before declaring success. Record a batch manifest
with targets, chosen concurrency, resource observations, output/log paths,
failures, and any remainder-script decision.

## Save Policy

Scene Optimizer mutates the opened stage in memory. Default to exporting an
optimized `.usdc` output under `output_path`. Use in-place `Save()` only for
newly created layers or explicitly approved source edits, and use flattened
stage export only when the user asks for a flattened deliverable.

## Rules

- Confirm bounded-loss/destructive operations before mutation.
- Use selected targets from SA/validation evidence.
- Store config, log, output stage, and summary artifacts.
- If helper wrappers exist in the selected environment they may be used;
  otherwise use the Python/API executor from the invocation reference.
- Do not pass a plain `pxr.Usd.Stage` directly to Scene Optimizer operation
  APIs. Attach it to `ExecutionContext` or use the standalone JSON helper as
  described in the invocation reference.
