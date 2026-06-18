# Idioms That Block Scaling

These NumPy patterns will **not** scale on cuPyNumeric without refactoring. Each pattern below is an idiom to look for when reading user code. The `R10…` / `R20…` headers are stable anchors used throughout this skill's references and recipes — they are *categories*, not analyzer rule IDs. The "Why it blocks" sections reference [`gpu-stack.md`](gpu-stack.md) and [`execution-model.md`](execution-model.md) for the underlying mechanism.

**BLOCKS** = will not scale until you remove the pattern.
**REFACTOR** = fixable with a known recipe; see [`refactor-recipes.md`](refactor-recipes.md).

Worked examples bundling several of these patterns are in [`assets/examples/blocks_scaling.py`](../assets/examples/blocks_scaling.py) (BLOCKS) and [`assets/examples/needs_refactor.py`](../assets/examples/needs_refactor.py) (REFACTOR).

______________________________________________________________________

## R101 — Python loop with array indexing _(BLOCKS)_

```python
for i in range(n):
    arr[i] = arr[i] * 2.0 + 1.0

# or
for i, j in product(range(rows), range(cols)):
    out[i, j] = some_function(arr[i, j])
```

### Why it blocks

Each iteration becomes a separate Legate task. Per-task work is one scalar; dispatch overhead (high microseconds) dwarfs compute (nanoseconds). The 1-ms task-granularity rule: each task must do ≥1 ms of work. A per-element loop does ~5 orders of magnitude less.

The runtime has no way to fuse Python-level iteration into a single kernel. From its point of view, you submitted *n* independent operations.

### Why it can't auto-fix itself

The loop body sees `i` as a Python int and `arr[i]` as a deferred scalar. Even if the body itself were vectorizable, the Python control flow forces sequential evaluation.

### Fix

Vectorize:

```python
arr[:] = arr * 2.0 + 1.0
```

See [`refactor-recipes.md#rr-loop`](refactor-recipes.md#rr-loop) for the full recipe with cases for non-trivial loop bodies.

### Exception — looping over a small leading axis

A Python loop over a **small leading-axis dimension** where each iteration body is itself a vectorized sub-array operation does **not** trip R101. Example, with a 3-channel velocity field `v[3, 1_000_000, 1_000_000]`:

```python
# Fine: 3 outer iterations, each body is a 1M×1M vectorized expression.
for axis in range(3):
    work[axis] = c1 * v[axis] + c2 * np.roll(v[axis], 1, axis=-1)
```

The discriminator is the per-iteration work, not the presence of a `for`: each iteration here submits a single Legate task that operates on a full 1M×1M slab (≫ the 1-ms task-granularity floor). The "elements vs. axes" distinction matters — iterating *elements* always blocks; iterating a handful of *axes* (3, 4, a small constant) is the same pattern as a time-stepping outer loop and is fine.

______________________________________________________________________

## R102 — np.vectorize _(BLOCKS)_

```python
f = np.vectorize(lambda x: x * x + 1.0 if x > 0 else 0.0)
out = f(arr)
```

### Why it blocks

`np.vectorize` is documented as a "convenience function… provided primarily for convenience, not for performance. The implementation is essentially a for loop." cuPyNumeric inherits this: there's no path to GPU acceleration from a Python-level function called per element.

### Fix

Express the same logic with `np.where`:

```python
out = np.where(arr > 0, arr * arr + 1, 0)
```

Or split into masked region updates:

```python
out = np.zeros_like(arr)
mask = arr > 0
out[mask] = arr[mask] * arr[mask] + 1.0
```

See [`refactor-recipes.md#rr-where`](refactor-recipes.md#rr-where).

______________________________________________________________________

## R103 — Iterating over an ndarray _(BLOCKS)_

```python
total = 0.0
for row in arr:
    total += float(np.sum(row))
```

### Why it blocks

`for x in arr` invokes Python iteration on the array, which materializes each row in turn. This is a host-side loop driven by host-materialized data. In cuPyNumeric, each iteration forces a sync to produce the next `row`.

### Fix

Operate on whole arrays:

```python
total = np.sum(arr)
# or, if per-row work is intrinsic:
row_sums = np.sum(arr, axis=1)
total = np.sum(row_sums)
```

______________________________________________________________________

## R104 — `.item()` / `.tolist()` / `int(arr)` / `float(arr)` / `bool(arr)` _(BLOCKS in hot loops)_

```python
for step in range(n_steps):
    err = np.max(np.abs(u - work)).item()   # host materialization every iter
    if err < tol:
        break
```

### Why it blocks

Host materialization drains every pending task that produced the value. On GPU, the data is then copied over PCIe (~64 GB/s Gen5, vs FBMEM bandwidth ~3 TB/s on H100 — a **~50× cliff**). Inside a hot loop, every iteration pays the drain cost. The pipeline is constantly stalling. (On CPU there's no PCIe trip, but the materialization still forces the runtime to drain pending tasks; the loop body becomes sequential.)

Compare to leaving the value as a deferred 0-d array: the runtime can submit the next iteration's tasks while still computing the previous one's reduction.

### Why it's catastrophic vs. just slow

The drain isn't just "wait for this one value" — it's "wait for *all* tasks that contribute to this value, including all the elementwise ops earlier in the iteration." A single `.item()` per iteration serializes the whole iteration.

### Fix

If you need the value to control flow (convergence check), check less often:

```python
CHECK_EVERY = 50
for step in range(n_steps):
    work = jacobi_step(u, work)
    u, work = work, u
    if step % CHECK_EVERY == 0:
        err = float(np.max(np.abs(u - work)))
        if err < tol:
            break
```

See [`refactor-recipes.md#rr-sync`](refactor-recipes.md#rr-sync) and [`refactor-recipes.md#rr-converge`](refactor-recipes.md#rr-converge).

______________________________________________________________________

## R105 — If/While branching on a reduction or array element _(BLOCKS)_

```python
while np.max(np.abs(u - work)) > tol:
    ...

for step in range(steps):
    if np.sum(violations) > 0:
        ...
```

### Why it blocks

Same root cause as [R104](#r104): the truthiness check on a 0-d cuPyNumeric array forces a host sync. cuPyNumeric Doctor explicitly flags this.

### Fix

Same as [R104](#r104). Pull the check out of the hot path or do it every N iterations. If the comparison should produce a *mask* used in further computation, keep it in array form:

```python
violations_mask = np.where(condition, 1, 0)
# now use violations_mask in subsequent ops — no sync needed
```

See [`refactor-recipes.md#rr-converge`](refactor-recipes.md#rr-converge).

______________________________________________________________________

## R106 — Non-unit step slicing (`arr[::2]`) _(BLOCKS — unsupported)_

```python
evens = arr[::2]
downsampled = data[::4]
mixed = arr[::2] + arr[1::2]
```

### Why it blocks

cuPyNumeric does not support non-unit strides in slicing. Documented in [Differences with NumPy](https://docs.nvidia.com/cupynumeric/latest/user/differences.html).

The slice is not available on the distributed path: depending on the cuPyNumeric version the runtime either materializes the array on the host and runs the slice in NumPy (D2H copy + host op + possible H2D copy back, all per call) or raises. Either way, hot-path `arr[::2]` is a migration blocker — don't promise a silent host-NumPy fallback.

### Fix

For periodic selection, build the mask with host NumPy under an explicit alias so the `[::2]` write happens on a host array, then hand the finished mask to cuPyNumeric:

```python
import numpy as onp           # host NumPy, explicit alias
import cupynumeric as np      # distributed array runtime

host_mask = onp.zeros(arr.shape[0], dtype=bool)
host_mask[::2] = True         # non-unit stride on a HOST array — fine
mask = np.asarray(host_mask)  # hand the finished mask to cuPyNumeric
evens = arr[mask]             # boolean indexing on the distributed array
```

The `onp` alias is essential — `np.zeros(..., dtype=bool)[::2] = True` would *itself* be a non-unit-stride write on a cuPyNumeric array, i.e. another R106 on the fix recipe. Build the mask once outside the hot loop and reuse it.

______________________________________________________________________

## R107 — object-dtype arrays _(BLOCKS — unsupported)_

```python
arr = np.array(mixed_python_objects, dtype=object)
results = np.array([func(x) for x in args], dtype=object)
```

### Why it blocks

cuPyNumeric supports only numeric dtypes natively. Per [Differences with NumPy](https://docs.nvidia.com/cupynumeric/latest/user/differences.html): *"natively supports only numerical datatypes, and doesn't support extended-precision floats (e.g. np.float128)."*

Object-dtype arrays are not supported on the distributed path. Behavior is version-specific — some calls route through host NumPy (single-threaded; no GPU benefit, no parallelism), others raise. Either outcome is a hot-path migration blocker.

### Fix

Restructure to a numeric representation. Common patterns:

- Variable-length strings → fixed-width or pad with sentinel + lengths array.
- Heterogeneous records → structure-of-arrays (one numeric array per field).
- Variable-length sequences → flat concatenation + offsets array.

______________________________________________________________________

## R108 — mpi4py import alongside cuPyNumeric _(BLOCKS — forbidden)_

```python
import mpi4py
import cupynumeric as np
```

### Why it blocks

The Legate runtime manages its own MPI / NCCL / UCX coordination. Mixing in mpi4py creates incompatible state. cuPyNumeric Doctor errors on this: *"using mpi4py with cuPyNumeric is not permitted."*

### Fix

Remove mpi4py. Express your algorithm on a single global cuPyNumeric array. Then launch with the multi-node flags:

```bash
legate main.py --nodes 4 --gpus 8 --launcher mpirun
```

Legate distributes the work across ranks. Where you previously had explicit `comm.Scatter` and `comm.Gather` calls, the global cuPyNumeric array now provides the same semantics — the runtime handles partitioning and communication.

This is sometimes a significant rewrite, but it usually simplifies the code substantially.

______________________________________________________________________

## R109 — `order=` keyword to reshape / ravel / asarray _(BLOCKS — unsupported / fallback)_

```python
arr = np.asarray(data, order='F')
flat = arr.flatten(order='F')
reshaped = arr.reshape((m, n), order='F')
```

### Why it blocks

cuPyNumeric does not support `order=` on the distributed path. From [Differences with NumPy](https://docs.nvidia.com/cupynumeric/latest/user/differences.html): *"the order argument is generally not implemented, because it doesn't make sense in a distributed setting."*

The behavior is **API-specific** — verify on your installed version rather than assuming:

- `reshape(..., order='F')` — current cuPyNumeric emits a runtime warning and falls back (the layout you asked for isn't what you get on the distributed array).
- `flatten(order='F')` / `ravel(order='F')` / `asarray(..., order='F')` — historically silent no-ops; some versions now warn. Either way, the kwarg does not produce a Fortran-contiguous distributed buffer.

Either path is wrong for downstream code that depends on Fortran or C contiguity (a C extension via ctypes, a view on raw bytes). Treat any `order=` on a hot-path cuPyNumeric array as unsupported and remove it.

### Fix

Drop the `order=` kwarg where you can. If you genuinely need a specific layout for a host-side interop, do it explicitly at the boundary:

```python
host_arr = onp.asarray(cupy_arr)
host_arr_f = onp.asfortranarray(host_arr)
some_c_extension(host_arr_f)
```

______________________________________________________________________

## R110 — Python builtins on arrays _(BLOCKS)_

```python
total = sum(arr)
peak  = max(arr)
ok    = any(mask)
```

### Why it blocks

Python's `min`, `max`, `sum`, `any`, `all`, `iter`, `reversed`, `sorted`, `tuple(arr)`, `list(arr)` and similar builtins go through the array's Python protocol methods (`__iter__`, `__contains__`, …). cuPyNumeric implements those protocols by host-side iteration over elements — the same host-iteration anti-pattern as [R103](#r103).

**General rule:** if a Python builtin reduces or iterates an array's contents and lacks a corresponding `__dunder__` on `cupynumeric.ndarray` (or has one that delegates to `__iter__`), it cannot be evaluated in distributed task-graph form and will silently fall back to host iteration. Use the NumPy function (`np.sum`, `np.max`, `np.any`, `np.all`, etc.) — those compile to Legate tasks and stay distributed.

`len(arr)` is **not** in this category. cuPyNumeric's `__len__` is a shape lookup (returns `shape[0]`) — no iteration, no sync, no task graph. cuPyNumeric Doctor's discouraged-builtin check explicitly excludes `len`. Prefer `arr.shape[0]` or `arr.size` only when the array might be 0-d (where `len()` raises).

For the upstream-maintained list of which Python builtins are known to fall back and which NumPy functions replace them, see [cuPyNumeric best practices: avoid Python builtins](https://nv-legate.github.io/cupynumeric/user/practices.html#use-numpy-s-functions-avoid-using-python-s-built-in-functions). When in doubt about a builtin not enumerated here (or in the upstream page), assume it falls back unless a doc explicitly confirms otherwise.

cuPyNumeric Doctor flags the `min` / `max` / `sum` instances directly; the rest of the builtin family is caught by the broader host-iteration check.

### Fix

Use the NumPy / cuPyNumeric equivalent:

```python
total = np.sum(arr)
peak  = np.max(arr)
ok    = np.any(mask)
```

If you really need a Python scalar at the boundary:

```python
total_py = float(np.sum(arr))
```

(One sync is fine at a boundary; the disaster is element-by-element iteration.)

______________________________________________________________________

## R111 — Mixing cuPyNumeric and CuPy arrays in the same hot loop _(BLOCKS)_

```python
import cupynumeric as np
import cupy as cp

for step in range(n_steps):
    x_cpn = np.add(a_cpn, b_cpn)              # cuPyNumeric task graph
    y_cp  = cp.fft.fft(cp.asarray(x_cpn))     # forced D2H+H2D round-trip
    a_cpn = np.asarray(cp.asnumpy(y_cp))      # and back again, every step
```

### Why it blocks

cuPyNumeric and CuPy are independent runtimes. They allocate from **separate GPU memory pools** and do not share device pointers — a `cupynumeric.ndarray` is opaque to CuPy and vice versa. The only way to move data between them is the **host-NumPy boundary**:

```
cupynumeric.ndarray  →  numpy.ndarray (host RAM)  →  cupy.ndarray
                  ^                                       |
                  +------- and the reverse trip back ------+
```

Each cross-runtime hop is `D2H copy + H2D copy + synchronisation point`. Inside a loop body that's a per-iteration host round-trip — the same scaling killer as [R104](#r104) (`.item()` in a hot loop), just with a much fatter payload.

cuPyNumeric Doctor flags this pattern.

### Fix

Pick one runtime for the hot loop. If both are genuinely needed, do the conversion **once outside the loop** (one host trip up front, one host trip at the end) and operate on the chosen runtime inside.

If the only reason CuPy was reached for is a function cuPyNumeric is missing on the hot path, check the [`assets/api-support.md`](../assets/api-support.md) manifest first — many functions appear under `✓✓` (multi-GPU) now and the cross-runtime hop is unnecessary. Mirrors the [R108](#r108) "Legate runtime owns the parallelism layer" principle: don't smuggle a second runtime in alongside it.

______________________________________________________________________

# REFACTOR-category — fixable patterns

These are not blockers; they have known recipes. After applying the recipe (no domain logic change), the code scales.

______________________________________________________________________

## R201 — Allocation inside a loop _(REFACTOR)_

```python
for step in range(n_steps):
    temp = np.zeros(n)
    temp[:] = arr * coef
    arr = temp
```

### Why it hurts

Each iteration allocates memory of a **fixed size that doesn't change inside the loop** — `np.zeros(n)` returns the same shape every step — yet the allocate + free cycle happens once per iteration. That work can be done once outside the loop instead.

The cost has two pieces, each of which independently slows the loop down:

1. **The allocation itself.** On GPU the buffer lives in **framebuffer memory (FBMEM** — the Legate term for the GPU memory partition; on H100 the underlying hardware is HBM, but FBMEM is the runtime-level name); on CPU it lives in system memory. Either way, allocating and discarding the same-sized buffer N times costs N allocator round-trips that one outside-the-loop allocation would replace. On GPU it also churns the CUDA caching memory pool that backs the Legate deferred allocator, fragments free space, and produces small short-lived tasks that compete for scheduling slots.
1. **Implicit temporaries inside cuPyNumeric APIs.** Many ops (`np.add`, `np.multiply`, `np.matmul`, `np.sum`, most ufuncs) accept an `out=` parameter. When you supply a pre-allocated buffer via `out=`, the API writes results directly into it instead of allocating an additional temporary buffer internally. Without `out=`, even after you hoist `np.zeros(n)` out of the loop, the per-iteration ufunc calls can still spin up their own scratch.

So the fix is two-step: hoist the explicit allocation, then thread `out=` through the inner ops. See [R006](idioms-that-scale.md#r006) for the `out=` pattern and [`refactor-recipes.md#rr-alloc`](refactor-recipes.md#rr-alloc) for the full recipe.

### Fix

Hoist the allocation out:

```python
temp = np.zeros(n)
for step in range(n_steps):
    np.multiply(arr, coef, out=temp)
    arr, temp = temp, arr      # swap buffers
```

See [`refactor-recipes.md#rr-alloc`](refactor-recipes.md#rr-alloc).

______________________________________________________________________

## R202 — Rebind pattern: `x = x + y` inside a loop _(REFACTOR)_

```python
for _ in range(n):
    x = x + y
```

### Why it hurts

Each `x + y` allocates a new array. The old `x` (which has tasks queued behind it) can't be freed immediately because pending tasks reference it. Heap pressure compounds.

### Fix

```python
for _ in range(n):
    np.add(x, y, out=x)
```

See [`refactor-recipes.md#rr-inplace`](refactor-recipes.md#rr-inplace).

______________________________________________________________________

## R203 — concatenate / hstack / vstack / stack inside a loop _(REFACTOR)_

```python
arr = np.zeros((1, cols))
for _ in range(rows):
    new_row = compute_row()
    arr = np.vstack([arr, new_row])
```

### Why it hurts

Each call copies all prior rows into a new buffer. **Quadratic** memory and bandwidth growth in the loop iteration count. cuPyNumeric Doctor flags this. Best practices: *"There is a performance penalty to stacking arrays using hstack or vstack because they incur additional copies of data."*

### Fix

Pre-allocate the final shape and write rows by index (`arr[i, :] = compute_row(i)`), or accumulate into a list and `np.stack` once at the end. Full before/after in [`refactor-recipes.md#rr-stack`](refactor-recipes.md#rr-stack).

______________________________________________________________________

## R204 — `nonzero()` followed by indexing _(REFACTOR)_

```python
idx = np.nonzero(condition)
arr[idx] = 0.0
```

### Why it hurts

`nonzero()` materializes the index array. Subsequent fancy-indexing can require NCCL all2all when destinations span GPUs. Boolean masking does the same work without the intermediate index materialization.

### Fix

```python
arr[condition] = 0.0
# or
np.putmask(arr, condition, 0.0)
```

See [`refactor-recipes.md#rr-mask`](refactor-recipes.md#rr-mask).

______________________________________________________________________

## R205 — `np.diag` / `np.flip` / `.flat` / `.flatten()` / `.ravel()` _(REFACTOR — semantic shift)_

```python
d = np.diag(matrix)
d[0] = 5          # NumPy: matrix[0,0] is now 5. cuPyNumeric: matrix unchanged.

reversed = np.flip(arr)
flat_view = arr.flat
```

### Why it hurts

These return **views** in NumPy and **copies** in cuPyNumeric. Mutating the result expecting a view will silently fail.

This is a correctness issue, not just a performance one. Read-only uses are fine (slightly more memory).

### Fix

If you only read: leave it.
If you mutate: write through to the original.

```python
matrix[range(n), range(n)] = 5.0   # explicit diagonal write
```

______________________________________________________________________

## R206 — Reshape inside a hot loop _(REFACTOR)_

```python
for step in range(steps):
    work = data.reshape(2, -1)
    work[:] = ...
```

### Why it hurts

`reshape` in cuPyNumeric triggers a copy more often than in NumPy (more situations where the new shape doesn't compose with the existing partition). In a hot loop, the per-iteration copy is wasted work — and may trigger repartition (see [`partitioning-and-balance.md`](partitioning-and-balance.md#repartition-inducing-operations)).

### Fix

Reshape once outside the loop, or restructure to operate on the existing shape. Often the algorithm doesn't actually need the reshape — the broadcasting rules already handle the case.

```python
work = data.reshape(2, -1)      # once
for step in range(steps):
    work[:] = ...
```

______________________________________________________________________

## Patterns to audit manually (data- or runtime-dependent)

Some scaling-killers depend on data or runtime context that isn't visible from source alone:

1. **Implicit syncs in logging frameworks.** `logger.info(f"loss = {loss:.4f}")` formats `loss`, forcing a sync. Lift the format only to iterations where you actually log.
1. **Decorators that wrap arrays in custom containers.** If `@my_decorator` calls `.tolist()` to validate, every call syncs.
1. **DataFrame interop.** `pandas` will call `np.asarray` on cuPyNumeric arrays. The boundary is unavoidable; minimize crossings.
1. **f-string formatting inside f-strings.** The outer format forces inner evaluation. Same fix: format less often.
1. **Loops over Python-level meta-state (epochs, hyperparameters) — these are fine.** Only loops over *array elements* are problematic.

## Authoritative sources

- [cuPyNumeric best practices](https://docs.nvidia.com/cupynumeric/latest/user/practices.html)
- [cuPyNumeric differences with NumPy](https://docs.nvidia.com/cupynumeric/latest/user/differences.html)
- [cuPyNumeric Doctor module: `cupynumeric/_array/doctor.py`](https://github.com/nv-legate/cupynumeric/blob/main/cupynumeric/_array/doctor.py)
