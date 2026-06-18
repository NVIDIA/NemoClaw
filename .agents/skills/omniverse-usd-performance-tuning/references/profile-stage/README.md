# Profile Stage

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

## When to Use

Use when profiling a USD stage before/after optimization; do not use to interpret regressions alone.

## Instructions

1. Confirm the target asset, artifact, or user intent and check the prerequisites listed below.
2. Read only the referenced files needed for the current phase, failure mode, or output contract.
3. Follow the workflow, rules, and safety gates in this reference before invoking downstream references or shell commands.
4. Return the result using the Output Format section and name any blocked prerequisite or unresolved user decision.


## Pre-flight Checklist

Before running profile measurements, re-read and confirm:

- [ ] `references/runtime-artifact-token-budget.md` — keep raw profile output
  on disk, read bounded summaries only.
- [ ] Output workspace policy from `references/output-workspace.md`.
- [ ] Profiling mode (quick vs full) matches what was used for baseline —
  never compare across modes.
- [ ] For full mode: multi-sample warm protocol (discard first, average rest).
## Output Format

Return a concise status or report that names the input, selected runtime or evidence source, actions planned or performed, artifacts written, blockers, and the next validation or user-decision step. When a schema or template is referenced below, conform to that contract.

Use this reference to capture measurable performance data. Run it **before**
optimization to establish a baseline, and **after** to verify improvement.

## Purpose

Capture repeatable quick or full performance metrics for a USD stage so
optimization decisions and before/after comparisons are evidence-based.

## Runtime artifact token budget

Follow
`skills/omniverse-usd-performance-tuning/references/runtime-artifact-token-budget.md`
for Kit logs, Tracy captures, and CSV exports. Do not load full `.tracy` files,
Tracy CSVs, or Kit logs into context. Extract compact metrics and keep the raw
captures on disk.

## Prerequisites

- A readable USD stage path.
- `pxr` Python API for quick mode.
- Kit, Isaac Sim, or compatible runtime plus Tracy support for full mode.
- Same profiling mode and environment for any baseline/after comparison.

## Examples

- "Profile this USD stage in quick mode before optimization."
- "Capture a full Kit runtime profile after mesh cleanup."

## Quick Mode (USD-level, always available)

Requires only the `pxr` Python API. No Kit, no GPU needed. Measures:

- **Stage open time** (cold + warm) — composition cost.
- **Prim traversal time** — scene graph complexity.
- **Attribute resolution time** — value resolution across composition arcs.
- **Transform computation time** — XformCache world transforms.
- **Material binding resolution time** — ComputeBoundMaterial cost.

### Usage

```python
from pxr import Usd, UsdGeom, UsdShade, UsdUtils
from statistics import median
import gc
import time

stage_path = "/path/to/stage.usd"

def open_once_ms(path):
    t0 = time.perf_counter()
    stage = Usd.Stage.Open(path)
    elapsed_ms = (time.perf_counter() - t0) * 1000
    del stage
    gc.collect()
    return elapsed_ms

# Stage-open timing. Prefer running this script in a fresh process for each
# baseline/after capture. Treat cold_open_ms as the first measured open in this
# capture process, not a guaranteed OS-cold read.
cold_open_ms = open_once_ms(stage_path)
_warmup_open_ms = open_once_ms(stage_path)
warm_open_samples_ms = [open_once_ms(stage_path) for _ in range(5)]
warm_open_ms = median(warm_open_samples_ms)
warm_open_spread_pct = (
    (max(warm_open_samples_ms) - min(warm_open_samples_ms)) / warm_open_ms * 100
    if warm_open_ms
    else 0.0
)

stage = Usd.Stage.Open(stage_path)

# Traversal — measure only the default-prim hierarchy (authored scene graph),
# excluding prototype prims (/__Prototype_*). Prototypes are internal to USD
# instancing and their traversal cost is a composition-setup cost, not a
# scene-graph complexity cost. Comparing before/after traversal is only
# meaningful when both measurements cover the same logical scope.
all_prims = list(stage.Traverse())

# Filter out prototype prims for the traversal measurement.
# stage.Traverse() DOES visit /__Prototype_* prims when prototype_count > 0,
# so we must exclude them to measure authored scene-graph complexity only.
def is_prototype_prim(prim):
    """Return True if prim lives under a /__Prototype_* root."""
    path_str = str(prim.GetPath())
    return path_str.startswith("/__Prototype_")

authored_prims = [p for p in all_prims if not is_prototype_prim(p)]

t0 = time.perf_counter()
for _ in range(10):
    # Re-traverse but measure only authored scope traversal time
    prims = [p for p in stage.Traverse() if not is_prototype_prim(p)]
traverse_ms = (time.perf_counter() - t0) * 1000 / 10

# Full traversal including prototypes (for reference / completeness)
traverse_full_ms_t0 = time.perf_counter()
for _ in range(10):
    list(stage.Traverse())
traverse_full_ms = (time.perf_counter() - traverse_full_ms_t0) * 1000 / 10

# Instance-proxy traversal (only meaningful when instance_count > 0).
all_prims_with_proxies = list(stage.Traverse(Usd.TraverseInstanceProxies()))

# Attribute resolution
t0 = time.perf_counter()
for prim in authored_prims:
    for attr in prim.GetAttributes():
        attr.Get()
resolve_ms = (time.perf_counter() - t0) * 1000

# Transform computation
xf_cache = UsdGeom.XformCache()
xformable = [p for p in authored_prims if p.IsA(UsdGeom.Xformable)]
t0 = time.perf_counter()
for prim in xformable:
    xf_cache.GetLocalToWorldTransform(prim)
xform_ms = (time.perf_counter() - t0) * 1000

# Stage stats
stats = UsdUtils.ComputeUsdStageStats(stage)
```

### Quick mode output

```json
{
  "mode": "quick",
  "stage_path": "/path/to/stage.usd",
  "cold_open_ms": 485.2,
  "warm_open_ms": 104.1,
  "warm_open_samples_ms": [106.2, 101.9, 104.1, 103.8, 105.0],
  "warm_open_sample_count": 5,
  "warm_open_spread_pct": 4.1,
  "open_timing_context": "fresh_process",
  "traverse_ms": 0.84,
  "traverse_full_ms": 1.02,
  "attribute_resolution_ms": 169.9,
  "transform_ms": 10.2,
  "prim_count": 2742,
  "prim_count_authored": 2742,
  "prim_count_with_instance_proxies": 2742,
  "layer_count": 230,
  "instance_count": 0,
  "prototype_count": 0,
  "total_attributes": 62076
}
```

`traverse_ms` measures only authored prims (excludes `/__Prototype_*` subtrees);
`traverse_full_ms` measures the full `stage.Traverse()` including prototypes.
Use `traverse_ms` for before/after comparisons — it represents the user-visible
scene graph complexity. `traverse_full_ms` is diagnostic-only (composition setup
cost).

`prim_count` is the total from `stage.Traverse()` (includes prototype prims);
`prim_count_authored` excludes `/__Prototype_*` subtrees (the authored scene graph);
`prim_count_with_instance_proxies` is the rendered-geometry footprint (what
Hydra walks). When `instance_count > 0` these three diverge — report all so
the optimization-report can attribute regressions to the right axis.

### Stage-open Timing Protocol

Use this protocol for `cold_open_ms` and `warm_open_ms`; do not treat a single
post-optimization warm open as a verdict.

- Prefer a fresh process for each baseline and after capture. If the capture
  must run inside the same long-running process that performed optimization,
  set `open_timing_context` to `same_process_warm` and lower confidence.
- For each stage path, record one first-open timing, run one unreported warmup
  open, then measure at least five warm opens. Set `warm_open_ms` to the
  median and include `warm_open_samples_ms`, `warm_open_sample_count`, and
  `warm_open_spread_pct` when possible.
- If the optimized file was just written, run the same warmup/sample protocol
  before comparing it to the baseline. Do not compare a first after-write open
  to a warmed baseline.
- If warm samples are noisy (for example, max-min exceeds 15% of median) or the
  before/after delta is within the measured spread, mark warm-load evidence as
  inconclusive in `compare-profiles` rather than a regression.

## Full Mode (Kit runtime, requires Isaac Sim + GPU)

Captures actual rendering performance via Tracy. Measures everything in
quick mode plus:

- **FPS** (steady-state frame rate).
- **Frame time** (mean, p50, p95, min, max).
- **Hydra sync time** — USD → Hydra scene population.
- **RTX render time** — GPU rendering passes.
- **Shader compilation time** — first-run shader cache cost.
- **Stage load event timing** — from Kit's internal instrumentation.

### Prerequisites

- Isaac Sim or Kit SDK with RTX renderer.
- Kit `omni.kit.profiler.tracy` profiler extension (Tracy is a Kit profiler, not a Scene Optimizer component).
- GPU with display (headless with virtual display works).

### Usage

Launch Isaac Sim with Tracy profiler:

```python
from isaacsim import SimulationApp
app = SimulationApp({
    'headless': True,
    'extra_args': [
        '--/app/profilerBackend=tracy',
        '--/app/profileFromStart=true',
        '--/profiler/enabled=true',
        '--/profiler/gpu=true',
        '--/profiler/gpu/tracyInject/enabled=true',
        '--/app/profilerMask=1',
        '--enable', 'omni.kit.profiler.tracy',
    ]
})
```

Capture the trace with the Tracy `capture` binary bundled in
`omni.kit.profiler.tracy` extension. Export with `csvexport`.

Treat Tracy CSV exports as large artifacts: run an analyzer that emits compact
startup/runtime summaries, or read only bounded heads/tails and targeted zone
matches. Never paste the full CSV into the report.

For detailed capture procedure and analysis, refer to the external
profiling skills at `NVIDIA/omniperf/.agents/skills/profiling/SKILL.md`
and `NVIDIA/omniperf/.agents/skills/nsys-analyze/SKILL.md`.

### Full mode output

```json
{
  "mode": "full",
  "stage_path": "/path/to/stage.usd",
  "quick_metrics": { "...same as quick mode..." },
  "kit_metrics": {
    "fps_mean": 43.2,
    "frame_time_mean_ms": 23.1,
    "frame_time_p95_ms": 25.8,
    "hydra_sync_ms": 4.4,
    "rtx_render_ms": 3.1,
    "stage_load_ms": 580,
    "shader_compile_ms": 8200,
    "tracy_zone_count": 101707,
    "trace_file": "/path/to/trace.tracy"
  }
}
```


## Full mode: startup vs runtime separation

When capturing Tracy data, separate the zone report into two sections:

- **Startup zones** — count=1 or proportional to extension/device count.
  Report total startup time.
- **Runtime zones** — count matches frame count. Report per-frame averages.

Classification: if zone count is within ±10% of the rendered frame count,
it is a runtime zone. Otherwise it is startup.

Output should include:

```json
{
  "startup_zones": [
    {"name": "compileShaderGroupForDevice", "total_ms": 6998, "count": 178}
  ],
  "runtime_zones": [
    {"name": "App Update", "mean_ms": 15.7, "count": 139},
    {"name": "hydraRenderViews", "mean_ms": 9.6, "count": 104}
  ],
  "startup_total_ms": 25646,
  "runtime_mean_frame_ms": 15.7
}
```

This separation enables `compare-profiles` to correctly classify tradeoffs
(startup cost increase + runtime improvement = net positive, not a regression).

## When to use which mode

- **Quick mode** for structural optimization (instancing, layer packaging,
  reference remapping). Measures composition cost which is what these changes affect.
- **Full mode** for geometry optimization (mesh cleanup, decimation, material
  consolidation). Measures rendering cost which is what these changes affect.
- **Always run the same mode before and after** for a valid comparison.

## What quick mode can and cannot prove (standalone-path caveat)

Quick mode is the only available mode when the Phase 0 runtime is
standalone Scene Optimizer (no Kit). The agent must be explicit in the
final `optimization-report` about which claims quick-mode metrics support
and which they do not.

**Quick mode CAN prove:**

- Stage open time (cold + warm) — composition + I/O cost.
- Prim / layer / instance / prototype counts — structural complexity.
- Attribute resolution + transform compute — composition-arc evaluation cost.
- Aggregate disk-size deltas on prototype / sub-asset files (compared
  separately, not part of quick mode itself).

**Quick mode CANNOT prove:**

- Steady-state FPS or frame time (no renderer).
- VRAM footprint (no GPU allocator).
- Hydra sync / RTX render / shader compile costs.
- Real draw-call count under the renderer (SO analysis-mode
  `rtxMeshCount` reports a count, but the renderer's actual draw-call
  count depends on Hydra batching, instance promotion, and material
  switch grouping that only the runtime sees).

When this reference ran in quick mode only, **the report's `verdict` should
explicitly note that render-time claims (FPS, frame time, VRAM, draw-call
count) are unmeasured**. Improvements predicted by `rtxMeshCount` or
prototype sharing are plausible but not verified. See
`skills/omniverse-usd-performance-tuning/references/optimization-report/references/optimization-report-template.md` §"Structural-only path (SO
unavailable)" and §"Quick-mode-only caveat" for the report wording.

## Rules

- Use the Stage-open Timing Protocol above for `cold_open_ms` and
  `warm_open_ms`.
- Do not compare quick mode baseline to full mode post-optimization (or vice versa).
- Store profile results as JSON for the compare-profiles skill.
## Limitations

- Quick mode measures USD-level structure and composition, not rendered FPS.
- Full mode requires a compatible Kit runtime, GPU/display setup, and Tracy capture tooling.
- A single profile cannot determine improvement; compare matching baseline and after results.

## Troubleshooting

- If `pxr` imports fail, run setup to choose a Kit or standalone USD Python runtime.
- If full mode cannot load Tracy, verify `omni.kit.profiler.tracy` is enabled in the selected Kit runtime.
- If warm-open samples vary widely, rerun the protocol in fresh processes; if
  variance persists, mark warm-load evidence inconclusive.
