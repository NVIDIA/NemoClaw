# Getting Started: First-Time Migration Orientation

Start here if you are evaluating cuPyNumeric for the first time, before you read any other reference doc. The rest of the skill drills into the mechanism; this page is the map.

## The one question this skill answers

*Which of my NumPy idioms will scale on cuPyNumeric, and which need refactoring, before I commit engineer-weeks to porting?*

cuPyNumeric is a drop-in NumPy API that runs on the Legate distributed-array runtime — same arrays, same operators, multi-GPU and multi-node execution underneath. The migration story is "swap `import numpy as np` for `import cupynumeric as np`," but the **scaling** story depends entirely on which idioms your code uses.

Some idioms (vectorized elementwise, reductions, matmul, stencils) translate cleanly and scale to 1000+ GPUs. Some idioms (Python loops over array elements, `.item()` in hot loops, `mpi4py`, `np.vectorize`) silently destroy scaling. The skill teaches you to tell them apart *before* you write the migration PR.

## 6-step first-migration checklist

Walk these in order. Each one cuts off a class of migration that would have failed.

1. **Count the loops.** For every `for` / `while` in your code, ask: does the body iterate over array *elements*, or over *epochs / steps / files / hyperparameters*? Elementwise iteration is the #1 scaling killer; outer-step iteration is fine when the body is vectorized. See [`idioms-that-block.md#r101`](idioms-that-block.md#r101).

1. **Size the arrays.** Estimate the per-GPU size of your hot-path arrays at runtime. The hard floor is **65,536 elements per GPU**; meaningful speedup starts around **10M per GPU**. If your arrays are smaller, cuPyNumeric will be *slower* than NumPy. See [`gpu-stack.md`](gpu-stack.md#the-65536-element-floor) and [`decision-framework.md`](decision-framework.md#gate-2-problem-size).

1. **Identify the compute pattern.** Stencils on regular grids, dense linear algebra (GEMM, batched solve), reductions over large arrays, Monte Carlo with independent samples, and batched FFT scale well. Sparse, graph, ML, and sequential workloads do not. See [`decision-framework.md`](decision-framework.md#gate-4-compute-pattern).

1. **Spot-check the unusual APIs.** For any NumPy function in your code beyond elementwise ops, reductions, matmul, slicing, and `np.where`, look it up in [`assets/api-support.md`](../assets/api-support.md) (the committed snapshot of the upstream NumPy-vs-cuPyNumeric comparison table). A `✗` glyph on its line means the API is not supported on the cuPyNumeric distributed path; behavior on call is version-specific (some unsupported APIs route through host NumPy, others raise an exception) — either way, hot-path use is a migration blocker. A `✓` (single check, not double) means it works on one GPU but has caveats for multi-node. Refresh with `python scripts/fetch_api_support.py --default-path`.

1. **Pick one module as a pilot.** Don't migrate the whole codebase at once. Choose the hottest module with the cleanest array math. Walk through it, apply recipes from [`refactor-recipes.md`](refactor-recipes.md), benchmark single-GPU vs NumPy, then expand. See the pilot-scope template in [`decision-framework.md`](decision-framework.md#pilot-scope-template).

1. **Plan to enable cuPyNumeric Doctor on the first real run.** Set `CUPYNUMERIC_DOCTOR=1` (optionally `CUPYNUMERIC_DOCTOR_FORMAT=json`, `CUPYNUMERIC_DOCTOR_FILENAME=report.txt`) before benchmarking. cuPyNumeric Doctor is the runtime cross-check on the patterns this skill identifies statically. See [upstream docs](https://docs.nvidia.com/cupynumeric/latest/user/doctor.html).

## Must-read references in order

Read straight through these three before writing any migration code:

1. **[`idioms-that-block.md`](idioms-that-block.md)** — the red list. Every pattern that destroys scaling, with the GPU-stack reasoning. Reading this teaches you what to look for in your own code.
1. **[`refactor-recipes.md`](refactor-recipes.md)** — drop-in before/after rewrites for each blocking idiom. Most fixes are mechanical.
1. **[`decision-framework.md`](decision-framework.md)** — the 7-gate go/no-go assessment. Run through every gate before scoping the migration.

Read when needed:

- **[`idioms-that-scale.md`](idioms-that-scale.md)** — confirm a specific pattern is fine.
- **[`gpu-stack.md`](gpu-stack.md)** — the *why* behind every idiom; memory hierarchy, SM utilization, communication fabric, dispatch.
- **[`execution-model.md`](execution-model.md)** — Legate's lazy execution, sync points, mapper, key-array rule.
- **[`partitioning-and-balance.md`](partitioning-and-balance.md)** — how arrays split, what triggers repartition, load imbalance.
- **[`case-studies.md`](case-studies.md)** — three worked assessments (stencil = strong-go, Monte Carlo = light refactor, sparse+sklearn = no-go).

## Canonical in-repo examples worth reading

These ship with the cuPyNumeric repo at `examples/` and demonstrate idioms that scale cleanly:

- `examples/stencil.py`, `examples/jacobi.py`, `examples/cfd.py` — stencil solvers (the canonical scaling story; `cfd.py` uses `array.stencil_hint` for explicit halo annotation).
- `examples/gemm.py`, `examples/einsum.py` — dense linalg with `out=` to avoid intermediates.
- `examples/cholesky.py`, `examples/qr.py`, `examples/svd.py`, `examples/solve.py` — distributed linear algebra (note the size thresholds in [`partitioning-and-balance.md`](partitioning-and-balance.md#8-linear-algebra-specific-thresholds)).
- `examples/kmeans.py`, `examples/cg.py` — bulk reductions with the "convergence check every S iterations" pattern (vs. every iteration, which would block).
- `examples/black_scholes.py`, `examples/logreg.py`, `examples/linreg.py` — pure elementwise + reductions.

And one "what *not* to do" exhibit:

- `examples/lstm_forward.py` — Python loop over time steps with index-based access. Useful as a canonical anti-pattern when explaining R101 to a user.

## Upstream docs to read alongside this skill

Ground your claims in these authoritative pages. Read them once at the start:

- [Best practices](https://docs.nvidia.com/cupynumeric/latest/user/practices.html) — the canonical anti-pattern list (vectorize, boolean masks vs. nonzero, putmask, avoid Python builtins, `out=`, task granularity).
- [Profiling and debugging](https://docs.nvidia.com/cupynumeric/latest/user/profiling_debugging.html) — exhaustive lane-by-lane profiler guide; what each profiler row means and how to read it.
- [cuPyNumeric Doctor](https://docs.nvidia.com/cupynumeric/latest/user/doctor.html) — the runtime anti-pattern detector; env vars and output format.
- [Differences with NumPy](https://docs.nvidia.com/cupynumeric/latest/user/differences.html) — compatibility gaps (reshape returns copies, `order=` not supported on the distributed path, reductions non-deterministic, 0d not scalar, no float128).
- [API comparison table](https://docs.nvidia.com/cupynumeric/latest/api/comparison.html) — the upstream source for `assets/api-support.md`.
- [Benchmarking guide](https://docs.nvidia.com/cupynumeric/latest/user/howtos/benchmarking.html) — timing with `legate.timing.time()`, not `time.perf_counter()`.

When you finish this orientation, return to [`../SKILL.md`](../SKILL.md) for the full workflow.
