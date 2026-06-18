# Decision Framework: Should We Migrate?

A structured way to decide go / no-go on a cuPyNumeric migration *before* committing engineer-weeks to the port. Apply it in this order; bail out at any failed gate.

______________________________________________________________________

## Gate 1: Hardware reality check

| Question | Pass | Fail |
|---|---|---|
| GPU compute capability ≥ 7.0 (Volta+)? | Continue | **STOP** — no Pascal or earlier support |
| CUDA 12.x or 13.x driver installed? | Continue | Fix toolchain first |
| At least 80 GB of FBMEM total across available GPUs (or equivalent system memory on CPU-only runs) for production runs? | Continue | Pilot is fine; production needs to fit |
| Linux (or WSL2)? | Continue | macOS aarch64 is CPU-only; Windows native unsupported |

**Bail condition.** Old GPUs or non-Linux production targets → defer migration; consider CPU-only Legate variant or different runtime.

______________________________________________________________________

## Gate 2: Problem size

| Per-GPU array size at runtime | Verdict |
|---|---|
| < 65,536 elements | **STOP** — below the floor; cuPyNumeric runs serial |
| 65K – 1M | Likely *slower* than NumPy on the same hardware |
| 1M – 10M | Break-even; depends on op mix |
| 10M – 100M | Beats NumPy on a single GPU |
| 100M+ | Beats NumPy substantially; multi-GPU helps |
| 1B+ | Multi-GPU strongly indicated; multi-node may be needed |

For multi-GPU, the per-GPU size is `total / num_GPUs`. Compute this first and verify it stays above the floor for the GPU count you target.

**Bail condition.** Hot-path arrays smaller than ~1M elements at runtime → migration buys little. Use NumPy + a smaller-grain optimization (Numba, Cython, native extension).

______________________________________________________________________

## Gate 3: Workload shape

Walk through the user's code and produce a verdict per the methodology in [`../SKILL.md`](../SKILL.md) — reading each hot region, cross-referencing the idiom catalogue, and naming what blocks vs. what scales.

| Verdict | Interpretation | Action |
|---|---|---|
| **READY** | No BLOCKS; few/no REFACTOR | Swap the import; benchmark. Minor sync-point cleanup may help |
| **LIGHT REFACTOR** | A small number of recipe-fixable patterns | Apply 1–3 recipes from [`refactor-recipes.md`](refactor-recipes.md); re-walk to reach READY |
| **SIGNIFICANT REFACTOR** | Multiple BLOCKS in hot paths (element loops, mpi4py, missing APIs), or major compute-pattern issues | Real engineering project; budget 1–3 engineer-weeks per significant module |
| **NOT RECOMMENDED** | Wrong compute pattern, hot arrays below the floor, or an mpi4py rewrite that blocks the pipeline | Restructure first or use a different runtime |

The verdict is a judgment call — weigh the *kinds* of findings, not their count:

- Many SCALES + few BLOCKS → good.
- Many REFACTOR → fixable with mechanical work.
- Many BLOCKS from [R101](idioms-that-block.md#r101) / [R102](idioms-that-block.md#r102) / [R103](idioms-that-block.md#r103) (element loops) → real vectorization work needed.
- Any [R108](idioms-that-block.md#r108) (mpi4py) → significant rewrite of the parallelism layer; SIGNIFICANT floor.

______________________________________________________________________

## Gate 4: Compute pattern

Map your dominant compute pattern to the table:

| Pattern | cuPyNumeric scaling | Recommendation |
|---|---|---|
| Stencils on regular grids | **Excellent** (1000+ GPUs) | Migrate first; this is the strongest case |
| Dense linear algebra (GEMM, batched solve) | Excellent for matmul; good for batched solve | Migrate; verify size thresholds |
| Reductions over large arrays | Excellent | Migrate |
| Vectorized elementwise pipelines | Excellent | Migrate |
| Monte Carlo with large independent samples | Excellent (data-parallel) | Migrate |
| FFT (batched) | Good | Migrate if you batch; single transforms = single GPU |
| Sparse matrices | Limited (mainline) | Defer; consider `legate.sparse` separately if it covers your operations |
| Graph algorithms | Poor (irregular memory access) | Don't migrate |
| ML inference / training | Out-of-scope | Restructure or don't migrate |
| String processing / NLP tokenization | Out-of-scope | Restructure or don't migrate |
| Time-series with sequential dependencies | Poor | Restructure or don't migrate |
| Pipeline with heavy SciPy / sklearn | Mixed | Migrate the array math; isolate the boundary |

**Bail condition.** Dominant compute is graph/sparse/ML/NLP/sequential → migration won't help. Use the right tool for that class.

______________________________________________________________________

## Gate 5: Boundary cost

Inventory the host-side touchpoints:

- **Loaders / data feeders** — pandas, h5py, parquet, raw I/O. Acceptable; isolate at the boundary.
- **Validators / metric loggers** — typically `.item()` or `print`. Cheap if called outside hot loops.
- **External libraries** — SciPy, sklearn, OpenCV, custom C extensions. Each call is a host round-trip.
- **Visualization** — matplotlib, etc. Always host. Acceptable if at the end of the run.
- **Test suites** — typically use NumPy as the golden reference. Keep `import numpy as onp` available for tests.

**Question to answer.** If you draw a line around the cuPyNumeric region, **how much wall-clock time is inside?** If \<30%, migration buys very little even if everything inside scales perfectly.

______________________________________________________________________

## Gate 6: Operational readiness

| Question | If yes... |
|---|---|
| Do you have a representative input than can read? | Walk the code to make Gate 3 concrete |
| Do you have a benchmark that exercises the hot path? | Measure with `legate.timing.time()` after migration to verify scaling |
| Do you have a golden-output test (small input → known good output)? | Use it to verify correctness post-migration |
| Are users / operators ready for the new launch command (`legate ...`)? | Document the migration in run scripts |
| Multi-node target? Do you have MPI + a launcher (mpirun/srun)? | Verify launcher works with a hello-world before benchmarking |
| Will you enable [cuPyNumeric Doctor](https://docs.nvidia.com/cupynumeric/latest/user/doctor.html) on the first real run? | `CUPYNUMERIC_DOCTOR=1` confirms at runtime that no overlooked patterns remain |

______________________________________________________________________

## Composite verdicts

Read across all gates:

### Strong-go ("Migrate this quarter")

- Gate 1 ✓
- Gate 2: 100M+ elements per hot-path array
- Gate 3: READY or LIGHT REFACTOR
- Gate 4: stencil / GEMM / reduction-dominated
- Gate 5: > 70% wall time in array code
- Gate 6: tolerant of ULP-level numerical differences

### Weak-go ("Pilot first")

- Gate 1 ✓
- Gate 2: ≥ 10M per array
- Gate 3: SIGNIFICANT REFACTOR with a clear list of recipes to apply
- Gate 4: mixed compute pattern
- Gate 5: 30–70% array-bound
- Gate 6: tolerant of differences

Walk the code, apply the recipes and, run a small benchmark on one GPU first. If the single-GPU result is meaningfully faster than NumPy on the same machine, expand to multi-GPU.

### No-go ("Use a different tool")

- Any Gate 1 fail
- Gate 2 < 1M per array
- Gate 3 NOT RECOMMENDED *and* the BLOCKS findings are mostly [R101](idioms-that-block.md#r101) / [R102](idioms-that-block.md#r102) / [R103](idioms-that-block.md#r103) (element loops) that can't be vectorized
- Gate 4 = graph / sparse / sequential / ML
- Gate 6 = hard determinism requirement

______________________________________________________________________

## Pilot scope template

For a "weak-go," scope the pilot like this:

1. **One module, one input.** The hottest part of the pipeline on a representative dataset.
1. **One GPU first.** Verify correctness (`allclose` against NumPy reference) and single-GPU speedup. If single-GPU doesn't beat NumPy, **stop** — multi-GPU won't fix that.
1. **Two GPUs.** Sanity-check that it scales. If not, investigate communication-heavy operations (likely a partition issue in your code).
1. **Full target GPU count.** Now compare with what success looks like.

Expected wall-clock:

| Step | Calendar time |
|---|---|
| Walk the code + plan | 1 day |
| Apply recipes for flagged patterns | 2–5 days for a medium module |
| Single-GPU correctness + benchmark (with cuPyNumeric Doctor enabled) | 1–2 days |
| Multi-GPU pilot (1 node) | 1–2 days |
| Multi-node pilot | 2–5 days (mostly toolchain / launcher debugging) |

Multiply by team familiarity. First-time cuPyNumeric users: 2–3×.

______________________________________________________________________

## What this framework intentionally doesn't decide

- **Cost** of GPU hours / cluster capacity vs. CPU compute. That's a budget question.
- **Energy efficiency.** Out of scope.
- **Whether to also rewrite for autodiff**. That's a separate decision; cuPyNumeric is not an ML framework.
- **Specific multi-node hardware choices** (Quantum-2 IB vs. Ethernet). Use the [`gpu-stack.md`](gpu-stack.md) bandwidth table to estimate.

## Authoritative sources

- [cuPyNumeric FAQ](https://docs.nvidia.com/cupynumeric/latest/faqs.html) — including the upstream "small problem sizes may be slower" guidance
- [cuPyNumeric best practices](https://docs.nvidia.com/cupynumeric/latest/user/practices.html)
- [Differences with NumPy](https://docs.nvidia.com/cupynumeric/latest/user/differences.html) — for determinism caveats
