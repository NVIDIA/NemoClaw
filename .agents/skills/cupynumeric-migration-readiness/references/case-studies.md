# Case Studies: Three Workloads, Three Verdicts

Worked migration assessments for representative NumPy codes. Each one walks through: is seen in the source, what the GPU stack predicts, and what the realistic outcome is.

These are illustrative; treat them as templates for assessing real workloads.

> The `R0xx` / `R1xx` / `R2xx` / `R3xx` codes and `RR-*` recipes named below are defined in `idioms-that-scale.md`, `idioms-that-block.md`, and `refactor-recipes.md` — read those via the reading order in [`../SKILL.md`](../SKILL.md). They are named here rather than deep-linked so this worked-examples doc stays one hop from SKILL.md.

______________________________________________________________________

## Case 1: 2D Heat-Equation Solver (Jacobi) → **READY** (with problem-size-per-GPU caveat)

### The code

```python
import numpy as np

def solve(n, n_iter):
    u = np.zeros((n, n), dtype=np.float32)
    work = np.zeros_like(u)
    u[0, :] = 1.0          # boundary condition
    for _ in range(n_iter):
        work[1:-1, 1:-1] = 0.25 * (
            u[:-2, 1:-1] + u[2:, 1:-1] +
            u[1:-1, :-2] + u[1:-1, 2:]
        )
        u, work = work, u
    return u
```

### Verdict

**READY** *when the problem size per GPU is large enough that halo exchange and per-step runtime overhead don't dominate the kernel time.* For small `n` (or many GPUs over a small grid) the workload can become runtime-dominated; see R005 for the conditions that make stencils work and the conditions that don't.

### What works (SCALES findings)

| Location | Idiom | Note |
|---|---|---|
| Lines 17-18 | R001 vectorized elementwise (the `0.25 * (… + … + …)` expression) | Per-GPU parallel, no host round-trip |
| Lines 17-22 | R005 stencil slicing — five constant-offset slice expressions on `u` and one slice write on `work` | Partitioner derives halo from the ±1 offsets automatically |
| Line 25 | Buffer swap `u, work = work, u` (R006 pattern) | Avoids per-iter allocation, keeps `work` and `u` resident |

### What blocks (BLOCKS findings)

None for this code.

### What's fixable (REFACTOR findings)

None for this code as written. If the user later adds a convergence check on `np.max(np.abs(u - work))`, that becomes R105 and needs RR-converge (periodic check, not every iteration).

### Compatibility / cost notes (INFO findings)

- **Per-GPU problem size dependence.** Two arrays of `n × n × 4` bytes (for `n = 4096`, 67 MB each; comfortably fits in FBMEM on any modern GPU). At `n = 4096` each step is ~33M element updates ≈ 0.1 ms at FBMEM bandwidth (~3 TB/s on H100) per GPU — slightly under the 1 ms target task granularity. Use `n ≥ 8192` for real workloads to keep runtime overhead < kernel time.
- **Halo cost.** 1 row × 4096 × 4 bytes ≈ 16 KB per neighbor per step. Sub-microsecond on NVLink intra-node; ~1 µs at IB rate inter-node. Vanishing fraction of step time *when the interior is large enough*.

### API support gaps

No gaps. Every routine this solver calls — `np.zeros`, `np.zeros_like`, slicing, and the `+` / `*` operators — is on a `✓✓` (multi-GPU) line in [`api-support.md`](../assets/api-support.md).

### Decision-framework summary

| Gate | Status | Reason |
|---|---|---|
| 1. Hardware | ✓ | H100 ≥ 7.0 cap, CUDA 12.x, Linux |
| 2. Problem size | ✓ when `n ≥ 4096`; ✗ when `n × n / G < 65,536` per GPU | Driven by the 65K-element floor |
| 3. Workload shape | ✓ | One outer time-step loop with a vectorized body |
| 4. Compute pattern | ✓ | Dense stencil |
| 5. Boundary cost | ✓ | No SciPy / sklearn / CuPy on the hot path |
| 6. Operational readiness | partial | Enable cuPyNumeric Doctor on the first run |

### Recommended next steps

1. Swap the import.
1. Run with `legate --gpus 1` first; verify `allclose` with NumPy on a small `n`.
1. **Estimate the problem size per GPU at the target GPU count.** If the interior is < ~1M elements per GPU, scaling will be runtime-dominated; size up `n` before measuring.
1. Scale to `--gpus 8` and confirm intra-node scaling at large `n`. The 1,024-H100 Eos result is the upper bound under favourable per-GPU problem sizes, not a guarantee.
1. Add a convergence check via RR-converge (every 50 iterations) if needed.

______________________________________________________________________

## Case 2: Monte-Carlo Option Pricing → **GO AFTER LIGHT REFACTOR**

### The code

```python
import numpy as np

def black_scholes_mc(S0, K, r, sigma, T, n_paths, n_steps):
    dt = T / n_steps
    paths = np.zeros((n_paths, n_steps + 1))
    paths[:, 0] = S0
    for t in range(1, n_steps + 1):
        z = np.random.standard_normal(n_paths)
        paths[:, t] = paths[:, t - 1] * np.exp(
            (r - 0.5 * sigma * sigma) * dt + sigma * np.sqrt(dt) * z
        )
    payoff = np.maximum(paths[:, -1] - K, 0.0)
    price = np.exp(-r * T) * np.mean(payoff)
    return price
```

### What is seen

| Idiom | Category | Count |
|---|---|---|
| R001 (vectorized elementwise) | SCALES | 4 |
| R002 (reduction) | SCALES | 1 |
| R201 (alloc in loop — `np.random.standard_normal` per step) | REFACTOR | 1 |
| R304 (RNG layout vs `--gpus`) | INFO | 1 |

Verdict: **LIGHT REFACTOR**.

### GPU-stack reading

- **Memory hierarchy.** `paths` is `n_paths × (n_steps+1) × 8` bytes. For `n_paths = 10M`, `n_steps = 252` (one year of daily): 20 GB. Fits on one H100 with room. For `n_paths = 100M`: 200 GB → multi-GPU required.
- **SM utilization.** Each step is one row of `n_paths` elements — for 10M paths × 8 B = 80 MB, ~30 µs at FBMEM bandwidth (~3 TB/s on H100). At 252 steps that's 8 ms total compute. Under the 1 ms threshold per step, dispatch overhead may show up at 10M paths — bump to 100M for cleaner timing.
- **Communication.** Random number generation: per-GPU cuRAND, no cross-rank comm. Reduction at the end: single allreduce of one scalar. Tiny.
- **Partitioning.** `paths` is partitioned along the leading axis (paths) — perfect, each GPU does its share independently.
- **The R201 issue.** `np.random.standard_normal(n_paths)` allocates a fresh array each iteration. Refactor:

```python
# Before
for t in range(1, n_steps + 1):
    z = np.random.standard_normal(n_paths)
    ...
```

```python
# After
rng = np.random.default_rng(seed=42)
z_buf = np.empty(n_paths)
for t in range(1, n_steps + 1):
    z_buf[:] = rng.standard_normal(n_paths)        # no fresh alloc
    paths[:, t] = paths[:, t - 1] * np.exp(...)
```

Even better: vectorize across time when memory allows:

```python
# Vectorize all steps
z_all = rng.standard_normal((n_steps, n_paths))   # one alloc
log_returns = (r - 0.5 * sigma * sigma) * dt + sigma * np.sqrt(dt) * z_all
paths[:, 1:] = paths[:, 0:1] * np.exp(np.cumsum(log_returns, axis=0).T)
```

But this only works if `(n_steps, n_paths)` fits in FBMEM — for 252 × 100M × 8 B = 200 GB it doesn't on one GPU, so use the loop form with `out=`.

### Predicted outcome

After light refactor:

- Single H100, 10M paths × 252 steps: ~5–10× NumPy.
- 8 H100s, 100M paths × 252 steps: ~6–7× the single-GPU number.
- 32 H100s, 1B paths: ~20–25× single-GPU.

This is a "MC is embarrassingly parallel" workload. Reductions are tiny. Per-path independence is perfect.

### Recommended next steps

1. Apply RR-alloc for the per-step `np.random.standard_normal`.
1. Run with `--gpus 1`, verify the Monte-Carlo statistic matches NumPy within statistical tolerance.
1. Scale up paths *and* GPU count together (weak scaling) for cleanest results.

______________________________________________________________________

## Case 3: Sequence Tagger with SciPy / sklearn → **NOT RECOMMENDED**

### The code

```python
import numpy as np
from scipy import sparse
from sklearn.metrics.pairwise import cosine_similarity

def tag_sequences(sequences, vocab):
    # Build a sparse term-frequency matrix
    rows, cols, vals = [], [], []
    for i, seq in enumerate(sequences):
        for token in seq:
            if token in vocab:
                rows.append(i)
                cols.append(vocab[token])
                vals.append(1.0)
    tf = sparse.csr_matrix((vals, (rows, cols)), shape=(len(sequences), len(vocab)))

    # Compute pairwise cosine similarity
    sim = cosine_similarity(tf)

    # Tag based on nearest neighbor
    tags = []
    for i in range(len(sequences)):
        nearest = np.argsort(sim[i])[-5:]
        tags.append(majority_vote(nearest))
    return tags
```

### Verdict

**NOT RECOMMENDED.** Gate 4 (compute pattern) fails. The workload is fundamentally **sparse + sklearn** — cuPyNumeric is a dense-array runtime and has no GPU path for `scipy.sparse` or `sklearn` estimators. Swapping the import would force every `tf` operation through the SciPy fallback on the host and provide no parallelism benefit.

### What works (SCALES findings)

n/a — see verdict. The CSR-building loops and the sklearn similarity call are host-side Python/SciPy; nothing in this hot path is a dense cuPyNumeric array op that would scale.

### What blocks (BLOCKS findings)

| Location | Idiom | Note |
|---|---|---|
| Lines 9-15 | R101 Python loops over `sequences` and tokens building the CSR triplet | The loop iterates over Python objects (strings, dict lookups), not arrays — vectorising it wouldn't help; the data structure itself isn't suited |
| Line 16 | R107-adjacent: `scipy.sparse.csr_matrix` is not a `cupynumeric.ndarray` | cuPyNumeric has no first-class sparse support |
| Line 19 | `sklearn.metrics.pairwise.cosine_similarity` on sparse input | Runs on host SciPy/sklearn regardless of what `np` aliases to |
| Lines 22-24 | Another R101 Python loop over rows | Same problem; sparse rows aren't dense arrays |

These are not recipe-fixable — the workload's compute pattern is the wrong shape for cuPyNumeric, not a fixable idiom.

### What's fixable (REFACTOR findings)

n/a — see verdict. The blockers here are a wrong-workload-class problem (sparse + sklearn), not recipe-fixable dense-array idioms.

### Compatibility / cost notes (INFO findings)

- **Sparse types don't interoperate with `cupynumeric.ndarray`.** A `scipy.sparse.csr_matrix` and a `cupynumeric.ndarray` cannot share storage. Converting CSR → dense round-trips per call would inflate memory by 10–1000× (depending on density) and still leave the math on host SciPy.
- **sklearn pipelines are inherently Python-orchestrated.** Even if individual leaf ops were dense, cuPyNumeric wouldn't change the orchestration. `RAPIDS cuML` is purpose-built for this case.
- **Sparse partitioning doesn't fit Legate's model.** Row counts per partition vary wildly with token frequency, defeating the auto-partitioner's load-balance assumptions.

### API support gaps

[`api-support.md`](../assets/api-support.md) does not list `scipy.sparse.*` or `sklearn.*` — they were never candidates for porting. `np.argsort` on a sparse row is supported on dense input only; the call here passes a sparse row slice that has already been materialised by sklearn on host.

### Decision-framework summary

| Gate | Status | Reason |
|---|---|---|
| 1. Hardware | ✓ | Any modern GPU is fine — irrelevant once Gate 4 fails |
| 2. Problem size | n/a | Skipped — Gate 4 disqualifies before size matters |
| 3. Workload shape | n/a | Skipped |
| 4. Compute pattern | ✗ | Sparse + sklearn pipeline; wrong runtime |
| 5. Boundary cost | n/a | Skipped |
| 6. Operational readiness | n/a | Skipped |

### Recommended next steps

1. **Do not port to cuPyNumeric.** For sparse + ML workloads.
1. If the dense-numeric portion is significant *and* separable from the sparse/ML pipeline, that isolated module could still be a cuPyNumeric candidate — assess it separately as its own case.
1. Do not consult cuPyNumeric Doctor for this assessment; cuPyNumeric Doctor measures runtime patterns of a cuPyNumeric program, and this workload should not become one.

______________________________________________________________________

## Patterns from these cases

### What strong cases share

- ≥ 10M elements per array in the hot path.
- The work is array math (no graph traversal, no string processing).
- Reductions are over the full array, not per-row Python loops.
- Communication needs are halo-style (small) or final-reduction-style (also small).
- Numerical results tolerate ULP-level differences.

### What weak cases share

- Significant Python loops over data structures other than arrays.
- Sparse data structures dominant.
- External libraries (SciPy, sklearn) on the critical path.
- Operations on small arrays (< 1M elements at runtime).

### How to position your code

Print out a snapshot of your hot-path data flow. For each operation:

1. **What array sizes does it touch?** Above 10M → cuPyNumeric likely helps.
1. **Is it array math, or does it need a domain-specific library?** Pure array math → cuPyNumeric. Domain library → use that library's GPU variant.
1. **Does it iterate or is it vectorized?** Vectorized → cuPyNumeric. Iterative → vectorize first, or use a different runtime.

Answer (3) by reading the code; (1) and (2) need human judgment based on profiling and the dependency graph.

## Authoritative sources

- [Effortlessly Scale NumPy from Laptops to Supercomputers](https://developer.nvidia.com/blog/effortlessly-scale-numpy-from-laptops-to-supercomputers-with-nvidia-cupynumeric/) — case studies including TorchSWE and stencil workloads
- [cuPyNumeric FAQ](https://docs.nvidia.com/cupynumeric/latest/faqs.html) — compute-pattern guidance
- [RAPIDS cuML](https://docs.rapids.ai/api/cuml/stable/) — GPU sklearn
- [CuPy](https://docs.cupy.dev/en/stable/) — direct GPU array library
