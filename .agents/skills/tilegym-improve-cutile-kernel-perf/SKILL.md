---
name: tilegym-improve-cutile-kernel-perf
description: Iteratively optimize cuTile kernel performance through systematic profiling, bottleneck analysis, IR comparison, and targeted tuning. Covers tile sizes, occupancy, autotune configs, TMA, latency hints, persistent scheduling, num_ctas, flush_to_zero, and IR-level debugging. Use when asked to "optimize cutile kernel", "improve kernel perf", "tune cutile performance", "make kernel faster", or iteratively benchmark and refine a cuTile GPU kernel in the TileGym project.
version: 2026.04.11
environment:
  IDE:
  - Claude Code
  - Cursor (Agent mode)
  model:
  - Opus 4.6
requires:
- GPU node Blackwell, Hopper and Ampere for benchmarking
license: CC-BY-4.0 AND Apache-2.0
metadata:
  author: "TileGym Team <TileGym@nvidia.com>"
  tags:
    - cutile
    - performance
    - optimization
    - kernel
    - profiling
---

# Iterative cuTile Kernel Performance Optimization
Systematically profile, diagnose bottlenecks, and iteratively tune a cuTile kernel's performance in the TileGym repository.

## Instructions

Follow the three phases in order: **Setup** the environment and baseline, run the **Experimentation** loop with a tracked log, then iterate **The experiment loop** until perf goals are met or further gains plateau.

## Setup
Work with user to prepare optimization environment:
1. Create a fresh git branch: Propose a branch name, e.g., `cutile-perf-<kernel_name>-<date>` from current branch. Checkout `git checkout -b <branch name>`
2. Locate the target kernel:
   - cuTile kernels live under `src/tilegym/suites/<suite>/cutile/` or `src/tilegym/ops/cutile/`
   - Read the kernel file and identify: the `@ct.kernel` decorated function(s), the launch wrapper (`ct.launch()` or `ct_experimental.autotune_launch()`), the `@register_impl` registration, and current autotune configs (if any)
3. Classify the kernel:
   - Arithmetic Intensity < 10 -> Memory-bound
   - Arithmetic Intensity 10-50 -> Balanced
   - Arithmetic Intensity > 50 -> Compute-bound

   Note: classification is only used to pick the optimization priority order in the experiment loop. The **core metric** is always `latency (ms)`.
4. Check GPU environment:
   - Ensure a GPU node (Blackwell or Ampere GPU) is available
   - All subsequent benchmark commands should run on the GPU node
5. Study related references:
   - `references/optimization-playbook.md`: Step-by-step recipes for each optimization (A through J) with before/after code examples
   - `references/perf-knobs-catalog.md`: Complete catalog of all tunable parameters (TMA, persistent scheduling, occupancy, tile sizes, latency hints, etc.)
   - `references/cutile-api-reference.md`: cuTile API reference and 18 critical rules
   - `references/performance-model.md`: Roofline/performance model, bottleneck diagnosis, autotuning
   - `references/ir-dump-guide.md`: IR dump, analysis, and error diagnosis
   - `references/cutile-patterns-reference.md`: Common cuTile patterns and conversion quick-reference
6. Create @sandbox/perf_results.md to track progress. The first run will write a baseline
7. Confirm and go: Once you get confirmation, kick off the experimentation

## Experimentation
Every experiment iteration applies ONE optimization to the target kernel, verifies correctness, re-benchmarks, and records results. Each iteration should be enforced to finish within 10 minutes.

### The goal
- Improve the **core metric**: reduce `latency (ms)`
- Subject to the **core constraint**: Correctness shall not regress — every optimization MUST preserve numerical correctness. `latency (ms)` shall not regress > 2% compared to baseline.

### What you can change
- The target kernel file under `src/tilegym/suites/<suite>/cutile/` or `src/tilegym/ops/cutile/`: kernel body, tile sizes, occupancy, num_ctas, TMA usage, latency hints, flush_to_zero, autotune configs, persistent scheduling, and other cuTile-specific parameters
- The kernel's launch wrapper: grid computation, autotune config space
- @sandbox/: Feel free to add new files or modify files created by you, but don't check to git

### What you can NOT change
- Kernel functional semantics (inputs, outputs, and numerical behavior within tolerance)
- Test infrastructure and benchmark harness
- Anything not listed above

### What to expect from experiment outputs

#### Correctness test:
```bash
python -m pytest tests/suites/.../test_<kernel_name>.py -k "test_ and cutile and not test_perf" -v
```

#### Performance benchmark:
For each iteration:
1. Run pytest benchmark: `python -m pytest ... --print-record` → extract latency (ms)
2. Record latency in perf_results.md

Benchmark cmdlines:
```bash
python -m pytest tests/suites/.../test_<kernel_name>.py -k "test_perf and cutile" --print-record -v
```

latency sample:
```
Cutile: {'forward': {'mean': 3.7903138461538455, 'std': 0.0016941310873207053, 'rel_std': 0.044696327430505396, 'median': 3.789880999999999, 'min': 3.7883389999999992, 'max': 3.7941230000000004, 'nrep': 13, 'peak_mem_mb': 913}} ms
```

### Track experiment progress
Use @sandbox/perf_results.md to record each iteration's results. It should only contain a Markdown table with 5 columns:
- `iteration`: iteration number, starting from 0 (baseline)
- `optimization`: what was applied (e.g., "baseline", "TMA replace gather", "persistent scheduling")
- `latency_ms`: kernel latency in milliseconds, six decimal points
- `correctness`: PASS or FAIL
- `status`: Whether this iteration was `keep`, `revert`, or `crash`

Example content:

```markdown
| iteration | optimization       | latency_ms | correctness | status |
|----------:|:-------------------|-----------:|:------------|-------:|
| 0         | baseline           |   0.820000 | PASS        | keep   |
| 1         | TMA replace gather |   0.390000 | PASS        | keep   |
```

Create the tabular header if the file was empty. Append one line for each iteration.

### The baseline
The first iteration (iteration 0) will not change any code and simply run the correctness test and performance benchmark. Results will be listed at the first row as baseline.

## The experiment loop
Core methodology is to apply ONE optimization per iteration from the playbook, verify correctness, benchmark, and decide whether to keep or revert. Try one optimization at a time, and have clean experiment records.

LOOP:
1. Check git status: Current git branch/commit we're on
2. Select and apply ONE optimization from `references/optimization-playbook.md`:
3. Verify correctness — if fails, **revert immediately**. Common causes: `flush_to_zero`/`rounding_mode=APPROX` changed results, tile size OOB, `allow_tma=False` semantics, persistent loop bound error
4. Re-benchmark and compare against current baseline
5. Git commit
6. Record results to @sandbox/perf_results.md
7. Decision rules:

   | Outcome | Action |
   |---------|--------|
   | Improvement(`latency (ms)`) >= 5% | Accept as new baseline, continue |
   | Improvement 2-5% | Accept, lower priority for next iteration |
   | Improvement < 2% | Accept but stop unless user wants more |
   | Regression on any config | Revert immediately, try next optimization |
   | No improvement after 2 consecutive iterations | Stop |
   | Root cause is `scheduling` or `unknown` | Escalate to user |

9. If keeping, advance the baseline numbers and continue loop
10. If reverting, git reset back to where you started and try the next optimization in priority order
UNTIL: all attempts are finished, or more than 25 iterations have occurred, or the user interrupts

*Be autonomous*: Ask user clarifications at setup phase. Once stepped into the experiment loop, do not pause to ask user feedback: Use your best judgement for decision making, consult the optimization playbook and perf knobs catalog promptly, and think harder if stuck.
