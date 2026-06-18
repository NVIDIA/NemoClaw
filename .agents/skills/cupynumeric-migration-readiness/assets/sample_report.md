# Sample Migration Readiness Assessment

A worked example of what should be produced when you walk the bundled fixtures in `assets/examples/`. This is the *shape* of the output — adapt the structure to the user's real code.

## Context the user provided

| Item | Value |
|---|---|
| Source | `assets/examples/{scales_well, needs_refactor, blocks_scaling}.py` |
| Hot-path array sizes | Mid-size grids (≥10M elements per array) |
| Target hardware | Single NVIDIA H100, 80 GB FBMEM |
| Dominant compute pattern | Stencil + bulk reductions + Monte-Carlo-style elementwise |

## Verdict: **LIGHT REFACTOR**

The stencil and elementwise pipelines in `scales_well.py` translate cleanly. `needs_refactor.py` exhibits five mechanical fixes that the recipes in [`refactor-recipes.md`](../references/refactor-recipes.md) cover end-to-end. `blocks_scaling.py` is a teaching exhibit of BLOCKS-category patterns; if those patterns appear in a user's real code, they must be removed before migration. Once the recipes are applied and the BLOCKS patterns are absent, the verdict moves to READY.

## What works (SCALES findings)

These are the parts the user can swap-and-run with no expected change in scaling behavior.

| Location | Idiom | Why it scales |
|---|---|---|
| `scales_well.py:14-16` | [R005](../references/idioms-that-scale.md#r005) stencil slicing | Halo derived automatically from slice offsets; weak-scales well *when the problem size per GPU is large* (small per-GPU problem sizes can be runtime-dominated — see R005) |
| `scales_well.py:21-22` | [R002](../references/idioms-that-scale.md#r002) reduction (`np.sum`) + [R001](../references/idioms-that-scale.md#r001) elementwise (`diff * diff`) | Tree-reduce via NCCL allreduce; O(log G) communication |
| `scales_well.py:35-36` | [R004](../references/idioms-that-scale.md#r004) `np.where` | Per-GPU parallel ternary; no host round-trip |
| `scales_well.py:39-40` | [R003](../references/idioms-that-scale.md#r003) `np.matmul` chain | Per-GPU cuBLAS GEMM with allreduce |
| `scales_well.py:43-44` | [R007](../references/idioms-that-scale.md#r007) boolean mask write | Mask co-located with array; per-GPU parallel |
| `scales_well.py:48-50` | [R006](../references/idioms-that-scale.md#r006) `out=` pre-allocation | Avoids per-call allocation; critical in hot loops |

## What blocks (BLOCKS findings)

These must be removed before scaling can be assessed. Each ties to one section of [`idioms-that-block.md`](../references/idioms-that-block.md) and one recipe in [`refactor-recipes.md`](../references/refactor-recipes.md).

| Location | Idiom | Recipe |
|---|---|---|
| `blocks_scaling.py:13-16` | [R108](../references/idioms-that-block.md#r108) `mpi4py` import | [RR-mpi](../references/refactor-recipes.md#rr-mpi) — remove; rewrite on a single global array; launch with `legate --nodes --gpus --launcher mpirun` |
| `blocks_scaling.py:21-23` | [R101](../references/idioms-that-block.md#r101) Python loop with array indexing | [RR-loop](../references/refactor-recipes.md#rr-loop) — replace with vectorized expression |
| `blocks_scaling.py:29-30` | [R102](../references/idioms-that-block.md#r102) `np.vectorize` | [RR-where](../references/refactor-recipes.md#rr-where) — express as `np.where` |
| `blocks_scaling.py:36-37` | [R103](../references/idioms-that-block.md#r103) iteration over ndarray + [R104](../references/idioms-that-block.md#r104) `float()` on reduction | Vectorize: `np.sum(arr)` |
| `blocks_scaling.py:44-47` | [R104](../references/idioms-that-block.md#r104) `.item()` inside hot loop | [RR-sync](../references/refactor-recipes.md#rr-sync) — check every N iterations |
| `blocks_scaling.py:54-61` | [R105](../references/idioms-that-block.md#r105) `if reduction < tol:` every iteration | [RR-converge](../references/refactor-recipes.md#rr-converge) — periodic convergence check |
| `blocks_scaling.py:67` | [R106](../references/idioms-that-block.md#r106) non-unit step slicing `arr[::2]` | Boolean mask helper |
| `blocks_scaling.py:72` | [R107](../references/idioms-that-block.md#r107) `dtype=object` | Restructure to numeric representation |
| `blocks_scaling.py:77` | [R109](../references/idioms-that-block.md#r109) `order='F'` kwarg | Drop the kwarg; for host interop, convert at the boundary with `onp.asfortranarray` |
| `blocks_scaling.py:82` | [R110](../references/idioms-that-block.md#r110) Python builtins `min`/`max` on array | Use `np.min` / `np.max` |

## What's fixable (REFACTOR findings)

These are mechanical recipe applications; no domain-logic change.

| Location | Idiom | Recipe |
|---|---|---|
| `needs_refactor.py:14-19` | [R201](../references/idioms-that-block.md#r201) `np.zeros(n)` inside loop | [RR-alloc](../references/refactor-recipes.md#rr-alloc) — hoist allocation; swap buffers |
| `needs_refactor.py:24-25` | [R202](../references/idioms-that-block.md#r202) rebind `x = x + y` inside loop | [RR-inplace](../references/refactor-recipes.md#rr-inplace) — `np.add(x, y, out=x)` |
| `needs_refactor.py:31-34` | [R203](../references/idioms-that-block.md#r203) `np.vstack` inside loop (quadratic growth) | [RR-stack](../references/refactor-recipes.md#rr-stack) — pre-allocate final shape or stack once at the end |
| `needs_refactor.py:40-41` | [R204](../references/idioms-that-block.md#r204) `np.nonzero()` followed by indexing | [RR-mask](../references/refactor-recipes.md#rr-mask) — `arr[condition] = 0.0` |
| `needs_refactor.py:48-50` | [R206](../references/idioms-that-block.md#r206) `reshape` inside hot loop | [RR-reshape](../references/refactor-recipes.md#rr-reshape) — hoist reshape; reuse view |

## Compatibility / cost notes (INFO findings)

None in the bundled examples. In real assessments this section typically lists:

- SciPy imports on the hot path ([R301](../references/idioms-that-scale.md#r301)).
- `linalg.qr` / `linalg.svd` (single-device, [R302](../references/idioms-that-scale.md#r302)).
- `fft.*` (single-transform single-GPU, [R303](../references/idioms-that-scale.md#r303)).
- RNG layout vs `--gpus N` ([R304](../references/idioms-that-scale.md#r304)).
- `linalg.solve` / `linalg.cholesky` size thresholds ([R305](../references/idioms-that-scale.md#r305)).

## API support gaps

None for the APIs the fixtures call. Verified by looking up each NumPy function in [`api-support.md`](api-support.md): `np.zeros`, `np.zeros_like`, `np.where`, `np.matmul`, `np.add`, `np.multiply`, `np.sum`, `np.sqrt`, `np.max`, `np.abs`, `np.array`, `np.ones`, `np.vstack`, `np.nonzero`, `np.vectorize` — all appear on `✓✓` (multi-GPU) lines in the manifest (except `vectorize`, which is itself a BLOCKS-category idiom regardless of API support).

For a user's real code this section would name each unimplemented API and its location.

## Decision-framework summary

Walking the gates from [`decision-framework.md`](../references/decision-framework.md):

| Gate | Status | Reason |
|---|---|---|
| 1. Hardware | ✓ | H100 ≥ 7.0 cap, CUDA 12.x, Linux |
| 2. Problem size | ✓ | ≥10M elements per array |
| 3. Workload shape | LIGHT REFACTOR | See verdict above |
| 4. Compute pattern | ✓ | Stencil + dense linalg + reductions |
| 5. Boundary cost | uncertain | Need user input on % wall-time in array code |
| 6. Operational readiness | partial | Need a benchmark; plan to enable cuPyNumeric Doctor |

## Recommended next steps

1. **Apply the REFACTOR recipes** in `needs_refactor.py` in this order: [RR-alloc](../references/refactor-recipes.md#rr-alloc), [RR-inplace](../references/refactor-recipes.md#rr-inplace), [RR-stack](../references/refactor-recipes.md#rr-stack), [RR-mask](../references/refactor-recipes.md#rr-mask), [RR-reshape](../references/refactor-recipes.md#rr-reshape). Each is mechanical; budget ~½ day total.
1. **Walk through the code with the agent again** to confirm READY.
1. **Swap the import** (`import cupynumeric as np`) on one pilot module — the stencil solver from `scales_well.py` is the cleanest starting point.
1. **Run with `legate --gpus 1` and `CUPYNUMERIC_DOCTOR=1`** — verify `np.allclose` against the NumPy reference and inspect Doctor's output for any overlooked patterns. See [upstream Doctor docs](https://docs.nvidia.com/cupynumeric/latest/user/doctor.html).
1. **Benchmark with `legate.timing.time()`** ([upstream benchmarking guide](https://docs.nvidia.com/cupynumeric/latest/user/howtos/benchmarking.html)). If single-GPU is meaningfully faster than NumPy, scale to `--gpus 8`.
1. **Re-assess** the multi-GPU result. Strong scaling holds while problem size per GPU ≫ 65,536 elements; weak scaling holds when each GPU's interior compute meaningfully exceeds halo-exchange + per-task runtime overhead.

If the user's real code also contains BLOCKS patterns from `blocks_scaling.py`, address them in this priority order: R108 (`mpi4py`) → R101 / R103 / R110 (element loops) → R102 (`np.vectorize`) → R104 / R105 (host syncs in loops) → R109 (`order=`) → R106 / R107 (restructure).

______________________________________________________________________

# Sample Migration Readiness Assessment — NOT RECOMMENDED variant

A second worked example, for when the verdict is a no-go. The same 8 sections appear; sections without findings carry a one-line "n/a — see verdict" placeholder rather than being omitted. This is the structural contract the grader checks.

## Context the user provided

| Item | Value |
|---|---|
| Source | `assets/examples/sparse_sklearn.py` (representative of `evals/files/sparse_sklearn.py`) |
| Hot-path array sizes | Sparse CSR matrices, ~10M non-zeros over a ~1M × 1M shape |
| Target hardware | 4× NVIDIA H100, 80 GB FBMEM each |
| Dominant compute pattern | `scipy.sparse` ops + `sklearn` pipeline (`TfidfVectorizer`, `LogisticRegression`) |

## Verdict: **NOT RECOMMENDED**

Gate 4 (compute pattern) fails. cuPyNumeric is a distributed NumPy runtime for *dense* arrays; sparse linear algebra and the sklearn estimator pipeline do not have cuPyNumeric implementations and will fall back to host SciPy / sklearn on every call. The right runtime for this workload is RAPIDS cuML + cuDF.sparse (or pure CuPy with `cupyx.scipy.sparse`), not cuPyNumeric.

## What works (SCALES findings)

n/a — see verdict. No part of the hot path is a dense vectorized cuPyNumeric idiom.

## What blocks (BLOCKS findings)

| Location | Idiom | Note |
|---|---|---|
| `sparse_sklearn.py:7` | `from scipy.sparse import csr_matrix` | Sparse arrays are not a cuPyNumeric type; every op falls back to host SciPy. |
| `sparse_sklearn.py:11` | `from sklearn.feature_extraction.text import TfidfVectorizer` | sklearn estimators are not GPU-accelerated by cuPyNumeric; the whole pipeline runs on host. |

These aren't recipe-fixable — the workload's compute pattern is the wrong shape for cuPyNumeric, not a fixable idiom.

## What's fixable (REFACTOR findings)

n/a — see verdict. Recipes apply to dense-array patterns; nothing here.

## Compatibility / cost notes (INFO findings)

- `scipy.sparse` types do not interoperate with `cupynumeric.ndarray`. A conversion-to-dense round-trip per call would inflate memory by 10–1000× and still leave the math on host SciPy.
- `sklearn` pipelines are inherently Python-orchestrated; cuPyNumeric would not change that even if individual leaf ops were dense.

## API support gaps

n/a — see verdict. `scipy.sparse.*` and `sklearn.*` are out of scope for the cuPyNumeric API comparison ([`api-support.md`](api-support.md)); they aren't listed because they were never candidates for porting.

## Decision-framework summary

| Gate | Status | Reason |
|---|---|---|
| 1. Hardware | ✓ | 4× H100 is fine |
| 2. Problem size | n/a | Skipped — Gate 4 disqualifies before size matters |
| 3. Workload shape | n/a | Skipped |
| 4. Compute pattern | ✗ | Sparse + ML pipeline; wrong runtime |
| 5. Boundary cost | n/a | Skipped |
| 6. Operational readiness | n/a | Skipped |

## Recommended next steps

1. **Do not port to cuPyNumeric.** Use RAPIDS [cuML](https://docs.rapids.ai/api/cuml/stable/) for the sklearn pipeline and [`cupyx.scipy.sparse`](https://docs.cupy.dev/en/stable/reference/scipy_sparse.html) for the sparse linear algebra.
1. If a single subroutine inside this codebase is purely dense (e.g., a downstream embeddings-projection step over `np.ndarray`), it could still be a cuPyNumeric candidate as an isolated module — assess that separately, not as part of this pipeline.
1. Do not consult cuPyNumeric Doctor for this assessment; cuPyNumeric Doctor measures runtime patterns of a cuPyNumeric program, and this workload should not become one.
