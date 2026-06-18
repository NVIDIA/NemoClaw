# Legate Execution Model

cuPyNumeric is a NumPy-compatible API on top of the Legate runtime. The execution model is **lazy / deferred**, asynchronous, and task-parallel. If you understand only this document, you can predict which of your NumPy idioms will translate cleanly and which won't.

## 1. Every NumPy call becomes a Legate task

When you write `c = a + b` in cuPyNumeric:

1. The Python call enters `cupynumeric/_thunk/deferred.py`.
1. A `DeferredArray` thunk for `c` is created. It is "backed by either a Legion logical region or a Legion future" — but **no data is computed yet**.
1. A task object is built via `_create_auto_task()` with `align(a, b)` (co-partition the inputs), `broadcast(...)` constraints where appropriate, and the elementwise add task body.
1. `task.execute()` submits the task to the Legate runtime.

The Python call returns immediately, holding a thunk for `c`. The actual computation happens later — possibly on a different thread, definitely on different processors.

## 2. When does work actually run?

Legate's docs: *"Leaf tasks are assumed to execute completely asynchronously from the top-level program."* The runtime decides scheduling. Useful mental model:

- **Submission**: synchronous from Python's POV (the API returns).
- **Execution**: asynchronous; the mapper picks processors, the runtime dispatches CUDA kernels / OMP tasks.
- **Completion**: invisible to Python, **until** something forces materialization.

### Sync points (the thing that drains the queue)

| Trigger | What happens |
|---|---|
| `.item()`, `int(x)`, `float(x)`, `bool(x)`, `complex(x)` | Runtime drains every pending task that produced the array's value; data moves to host. |
| `if x:` or `while x:` where `x` is a 0-d cuPyNumeric array | Python truthiness → drain → bool. |
| `print(x)`, `f"{x}"`, `repr(x)`, `str(x)` | Formatting requires the data on host → drain. |
| `np.asarray(x)` where x is cuPyNumeric and the result is host NumPy | Explicit host materialization. |
| Comparison `x == y` *used in a Python `if`* | The `if` forces drain. |
| `for elem in arr` | Iterator requires host data. |
| `legate.timing.time()` | Returns a future; reading the future forces drain at that point. Better than `time.perf_counter()` for measuring real cuPyNumeric work. |
| Program exit | Final flush. |

The asynchronous model is the reason `time.perf_counter()` deceives: it measures *task dispatch time*, not *task execution time*, unless you force a sync at the end of the timed region.

### Sync points that look innocent

- `total = np.sum(arr)` — returns immediately (deferred 0-d). No sync.
- `print(total)` — formats `total` → **sync**.
- `f"loss = {total:.4f}"` — same — **sync**.
- `total > 0` evaluated in a Python `if` — **sync**.
- `total > 0` used as a cuPyNumeric expression that goes into `np.where(...)` — no sync (still in array world).

The pattern: **sync happens when the value enters Python.** Stay in arrays until you absolutely need a host value.

## 3. Standard vs streaming execution

[Standard execution](https://docs.nvidia.com/legate/latest/manual/runtime/standard_execution.html): tasks are submitted and scheduled as blocks. Dependencies are enforced *transitively* — every leaf of task A finishes before any leaf of task B begins. Collective tasks (NCCL operations) "must execute the tasks at the same time as one giant block."

[Streaming execution](https://docs.nvidia.com/legate/latest/manual/runtime/streaming.html) (experimental): producer-consumer chains can be batched, allowing a downstream consumer to start working on partial results before the producer finishes. Useful for relieving memory pressure when chaining transformations of huge arrays. Has restrictions: same workers, single partition access per sub-task, partition stability, associative reductions only.

**Practical implication for migration.** Don't rely on streaming today. Your design should assume standard execution: graph submission is cheap, then *blocks* of work execute end-to-end.

## 4. The mapper — who decides what runs where

The mapper is a Legate-level component that, for each submitted task:

- Picks the **processor variant** (GPU > OMP > CPU by default).
- Decides the **partitioning** of inputs and outputs.
- Allocates **physical memory** in the chosen target (FBMEM by default for GPU tasks).

The mapper runs in a dedicated thread concurrent with the main Python thread. You generally don't interact with it; default decisions are appropriate for the vast majority of code.

Two ways your code influences the mapper:

1. **Operation shape and dtype.** Determines which variant is available (some ops have no GPU variant; some are GPU-only above a size threshold like `MIN_SOLVE_MATRIX_SIZE = 512`).
1. **Array provenance.** The mapper prefers to keep operations on processors that already own the input. Long chains of operations on the same array stay co-located.

## 5. Auto-parallelization heuristics — the "key array" rule

From the [Legate NumPy SC'19 paper](https://research.nvidia.com/publication/2019-11_Legate-NumPy:-Accelerated): the partitioner picks the **key array** (largest input/output) for an operation and derives partitions for all other operands from the key's natural partition. This avoids two pathologies:

- **Over-decomposing small arrays** across too many processors.
- **Over-decomposing large arrays** into too many tiles.

**Implication.** If your hot loop chains operations whose key arrays have *incompatible* partitions, the runtime re-partitions between them. Common offenders: `transpose` followed by elementwise on the original axis; `reshape` to a shape that doesn't divide the existing tiles; `hstack` and friends. These show up as the REFACTOR-category idioms in [`idioms-that-block.md`](idioms-that-block.md).

## 6. Async ≠ Multithreaded Python

The Python program itself is single-threaded. The mapper, Legate runtime, and CUDA streams are concurrent C++/CUDA threads. So:

- Two `np.sum` calls in a row from Python *do not* execute in parallel from each other's perspective — they're submitted in order, and the runtime decides ordering based on dependencies.
- Independent operations (no data dependency) can execute concurrently in the runtime.
- The Python GIL is irrelevant: no Python-level threading is needed to get parallel execution.

This means: **multi-threading your Python code does not help cuPyNumeric.** The runtime already exploits all available parallelism.

## 7. mpi4py is incompatible

If your existing NumPy code uses mpi4py for inter-rank communication, *you must remove it before migrating*. Legate manages its own communication (NCCL/UCX). The `cuPyNumeric Doctor` explicitly diagnoses this: *"using mpi4py with cuPyNumeric is not permitted."* Identify any `mpi4py` import as the [R108](idioms-that-block.md#r108) idiom.

The migration pattern: rewrite the algorithm to operate on a single global cuPyNumeric array. Let `legate --nodes N --gpus M --launcher mpirun` handle the rank distribution. You write the same code; the launcher distributes it.

## 8. Timing correctly

```python
# WRONG — measures dispatch only
import time
t0 = time.perf_counter()
y = expensive_compute(x)
print(time.perf_counter() - t0)   # too small to be true

# RIGHT — force sync at end
t0 = time.perf_counter()
y = expensive_compute(x)
_ = float(y.sum())                # forces queue drain
print(time.perf_counter() - t0)

# BEST — use Legate's timing
from legate.timing import time
t0 = time()
y = expensive_compute(x)
t1 = time()
print((t1 - t0) / 1e6, "ms")     # times in microseconds; reads of t0/t1
                                  # force ordering at submission-time
```

`legate.timing.time()` returns a future; reading the futures forces drains *at the boundaries you specified*, not at any other point. This is the recommended timing API.

## 9. What this means for migration assessment

When evaluating whether a NumPy file will scale:

1. **Identify hot loops.** Iteration-bound execution is the #1 risk.
1. **Find sync points inside those loops.** `.item()`, `bool(arr)`, `print`, `if reduce(...) < tol:` — every one is a full pipeline drain per iteration.
1. **Find partition-breaking operations** in hot paths. `hstack`/`vstack`, `reshape` with re-layout, fancy indexing with non-local destinations.
1. **Count tasks per second of wall time.** If your code submits >10,000 tasks/sec, you're likely creating sub-millisecond tasks; performance will be poor.

Catalog (1)–(3); (4) requires runtime instrumentation — collect with `legate --profile` and consult upstream [profiling and debugging guidance](https://docs.nvidia.com/cupynumeric/latest/user/profiling_debugging.html) once the readiness assessment is done and the code actually runs.

## Authoritative sources

- [Legate runtime — standard execution](https://docs.nvidia.com/legate/latest/manual/runtime/standard_execution.html)
- [Legate runtime — streaming execution](https://docs.nvidia.com/legate/latest/manual/runtime/streaming.html)
- [Legate tasks](https://docs.nvidia.com/legate/latest/manual/tasks/index.html)
- [Legate mappers](https://docs.nvidia.com/legate/latest/manual/mappers/index.html)
- [cuPyNumeric benchmarking guide](https://docs.nvidia.com/cupynumeric/latest/user/howtos/benchmarking.html)
- [cuPyNumeric source: `cupynumeric/_thunk/deferred.py`](https://github.com/nv-legate/cupynumeric/blob/main/cupynumeric/_thunk/deferred.py)
- [Legate NumPy SC'19](https://research.nvidia.com/publication/2019-11_Legate-NumPy:-Accelerated)
