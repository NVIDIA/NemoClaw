<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Agent-Orchestrated Batch Mode

This is Phase 4b of the canonical workflow. It is an agent orchestration
pattern, not a wrapper flag. Optional helper wrappers accept one asset path;
the agent invokes the single-asset runner per target.

Do not serialize independent optimization targets by default. Run them in
adaptive batches sized by target weight and available system resources, then
adjust concurrency after each completed batch.

## Targets

Targets come from:

- `apply-restructure` mode=`restructure`: prototype USDs, shared layers, and
  newly loadable sub-assets recorded in
  `<output_dir>/apply-restructure-manifest.json` `phase4_targets[]`, plus any
  `target_class: "assembly_root"` entry for mesh data retained in the assembly.
  Do not filter the manifest to prototype files only.
- Composed stages with no restructure: referenced sub-assets from
  `usd-structure-assessment` Phase 1.2 `assets.manifest`.
- Monolithic-as-is: the original stage (`N=1`).

## Adaptive Concurrency

Use target count only after estimating target weight. A fixed target-count cap
is too conservative for small mechanical parts and too aggressive for large
floor-scale facility sections.

Before the first batch, build a lightweight batch manifest:

- Independent target list, grouped by dependency class.
- Per-target weight signals: file size, mesh count, vertex/face count,
  material/texture count, prototype/instance count, and expected op-chain cost.
- Resource budget: CPU cores, available RAM, available VRAM when Kit/rendering
  is involved, free disk, and expected log/artifact volume.
- Initial concurrency choice and reason.

Initial concurrency guidance:

| Target class | Starting point |
|---|---|
| Monolithic target | `1` |
| Heavy facility/floor-scale target, multi-GB target, or high mesh/texture count | `1`, then increase only after a healthy pilot |
| Medium sub-assets | `2-4` depending on memory and disk headroom |
| Small mechanical parts or small fixture libraries | Start above `5` when resources allow; use CPU, memory, disk, and log headroom rather than the old fixed cap |
| Unknown weight | Start conservatively at `2`, or `1` if opening one target already consumes significant memory |

After each batch, inspect duration, failed targets, peak RAM/VRAM if available,
disk growth, log size, and output count. Increase concurrency when the pilot is
healthy and targets are small. Decrease concurrency or switch to serial when a
batch hits memory pressure, GPU pressure, disk/log pressure, runtime crashes,
or long-tail target variance.

If the remaining work is likely to exceed the user's time/resource budget, pause
and ask whether to continue, generate a remainder script, or stop. Do not pause
solely because target count exceeds five; pause because the observed budget or
risk says continuing automatically is unsafe.

## Prototype-First Ordering

When targets include prototypes and non-prototype assets, run prototypes first,
wait for completion, then run non-prototype assets. Parallelize within each
dependency group according to the adaptive concurrency policy. Prototype changes
propagate to instances, so running instance-site work first wastes time. Treat
an `assembly_root` target with retained meshes as a non-prototype mesh target:
run the evidence-selected per-target mesh op chain on it before final
assembled-root cleanup.

## Output Naming

Hash the absolute input path in every per-target output, summary, and log
filename. Basename-only naming is unsafe because many industrial scenes contain
repeated names such as `Body.usd` or `Default_V5.usd`.

Recommended pattern:

```text
<stem>.<sha1-absolute-path-prefix-12>.optimized.usdc
<stem>.<sha1-absolute-path-prefix-12>.summary.json
<stem>.<sha1-absolute-path-prefix-12>.log
```

After every batch, verify that the number of produced optimized files matches
the number of targets in that batch. If not, report a collision or failed write
instead of declaring success.

## Remainder Prompt

When the adaptive budget says the remaining work should not continue
automatically, show:

- Already optimized targets.
- Deferred targets.
- Observed runtime/resource pressure from completed batches.
- Remainder script path, if generated.
- Options: run the remainder script now, stop here, or explicitly optimize all
  remaining targets anyway.

Default behavior is to stop until the user chooses; the resource budget is the
guardrail.

## Failure Handling

Aggregate per-target summaries into one batch summary. Surface failed targets
with log and summary paths. Do not auto-retry failed targets.

The final batch manifest should record every batch's target list, concurrency,
duration, output paths, summary/log paths, failures, resource observations, and
the reason for any concurrency adjustment.
