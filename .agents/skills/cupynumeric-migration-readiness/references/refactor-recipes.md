# Refactor Recipes

Drop-in rewrites for the idioms cataloged in [`idioms-that-block.md`](idioms-that-block.md) — both REFACTOR-category and the BLOCKS-category patterns that have a vectorized equivalent. Each recipe preserves the original algorithm's output — no domain logic changes.

Format: **RR-name** → **idiom(s) it addresses** → **before** → **after** → **why this works**.

______________________________________________________________________

## RR-loop — Convert element-by-element loop to vectorized expression

Addresses: [R101](idioms-that-block.md#r101)

### Before

```python
n = len(arr)
for i in range(n):
    arr[i] = arr[i] * 2.0 + 1.0
```

### After

```python
arr[:] = arr * 2.0 + 1.0
# or, if arr should be reassigned:
arr = arr * 2.0 + 1.0
```

### Why it works

The whole-array expression `arr * 2.0 + 1.0` becomes a single Legate task per GPU. Each GPU runs on its own share of the array with full SM utilization.

### Less obvious case: loop with branch

```python
# Before
for i in range(n):
    if arr[i] > threshold:
        arr[i] = arr[i] * 2.0
    else:
        arr[i] = arr[i] * 0.5
```

```python
# After
arr[:] = np.where(arr > threshold, arr * 2.0, arr * 0.5)
```

### Case: loop with cumulative result

```python
# Before
total = 0.0
for i in range(n):
    total += arr[i] * weights[i]
```

```python
# After
total = np.sum(arr * weights)
# or for clarity:
total = np.dot(arr, weights)
```

______________________________________________________________________

## RR-where — Replace np.vectorize with np.where

Addresses: [R102](idioms-that-block.md#r102)

### Before

```python
f = np.vectorize(lambda x: x*x + 1.0 if x > 0 else 0.0)
out = f(arr)
```

### After

```python
out = np.where(arr > 0, arr * arr + 1, 0)
```

### Why it works

`np.where` is a vectorized ternary. Per-GPU parallel, no Python-level iteration. Both branches are evaluated (which is fine for cheap expressions); for expensive branches, use masked assignment instead.

### Variant: expensive branch

```python
# When you don't want to evaluate the false branch
out = np.zeros_like(arr)
mask = arr > 0
out[mask] = arr[mask] * arr[mask] + 1.0
```

______________________________________________________________________

## RR-sync — Move host materialization out of a hot loop

Addresses: [R104](idioms-that-block.md#r104), [R105](idioms-that-block.md#r105)

### Before

```python
for step in range(n_steps):
    u = jacobi_step(u)
    err = float(np.max(np.abs(u - u_old)))   # sync EVERY iteration
    print(f"step {step}, err = {err:.6f}")
    if err < tol:
        break
```

### After

```python
LOG_EVERY = 50
for step in range(n_steps):
    u = jacobi_step(u)
    if step % LOG_EVERY == 0:
        err = float(np.max(np.abs(u - u_old)))
        print(f"step {step}, err = {err:.6f}")
        if err < tol:
            break
```

### Why it works

Reduces the host-sync rate by `LOG_EVERY`× (typically 50–100×). The runtime can submit `LOG_EVERY` iterations' worth of tasks before the next drain. The final iteration count may be slightly higher (you discover convergence at most `LOG_EVERY-1` iterations late), but each iteration is much cheaper.

______________________________________________________________________

## RR-converge — Convergence check pattern

Addresses: [R105](idioms-that-block.md#r105)

### Before

```python
while np.max(np.abs(u - work)) > tol:
    work = jacobi_step(u)
    u, work = work, u
```

### After

```python
CHECK_EVERY = 50
converged = False
it = 0
while not converged and it < max_iter:
    work = jacobi_step(u)
    u, work = work, u
    it += 1
    if it % CHECK_EVERY == 0:
        err = float(np.max(np.abs(u - work)))
        converged = err < tol
```

### Why it works

`while` test now uses a Python `bool` (`converged`), not an array reduction. The runtime can run `CHECK_EVERY` iterations concurrently / pipelined. The only sync is the explicit `float(...)` every `CHECK_EVERY` steps.

______________________________________________________________________

## RR-alloc — Pre-allocate outside the loop

Addresses: [R201](idioms-that-block.md#r201)

### Before

```python
for step in range(n_steps):
    temp = np.zeros_like(arr)        # alloc per iter
    temp[:] = arr * coef
    arr = temp
```

### After

```python
temp = np.zeros_like(arr)
for step in range(n_steps):
    np.multiply(arr, coef, out=temp)
    arr, temp = temp, arr
```

### Why it works

One allocation, lifetime spans the whole loop. The swap pattern (double-buffering) lets each iteration write to `temp` and then "promote" it to `arr` for the next iteration without copying.

### Variant: when you need a fresh zero array each iteration

```python
# Often you don't actually need to reset to zero — verify
temp.fill(0.0)        # in-place zero, no allocation
```

______________________________________________________________________

## RR-inplace — Replace rebind with `out=` ufunc

Addresses: [R202](idioms-that-block.md#r202)

### Before

```python
for _ in range(n_steps):
    x = x + y
```

### After

```python
for _ in range(n_steps):
    np.add(x, y, out=x)
```

### Why it works

`x = x + y` allocates a new buffer for the result and abandons the old `x`. The old `x` may still be referenced by pending tasks, delaying its actual freeing. `np.add(x, y, out=x)` writes the result directly into `x`'s existing storage — no allocation, no garbage.

### Generalized form

| Before | After |
|---|---|
| `x = x + y` | `np.add(x, y, out=x)` |
| `x = x * y` | `np.multiply(x, y, out=x)` |
| `x = x - y` | `np.subtract(x, y, out=x)` |
| `x = np.sin(x) + y` | `np.sin(x, out=x); np.add(x, y, out=x)` |
| `c = a * x + b * y` | `np.multiply(a, x, out=c); np.multiply(b, y, out=tmp); np.add(c, tmp, out=c)` (one preallocated `tmp`) |

______________________________________________________________________

## RR-stack — Avoid `vstack` / `hstack` / `concatenate` in a loop

Addresses: [R203](idioms-that-block.md#r203)

### Before — quadratic copy

```python
arr = np.zeros((1, cols))
for i in range(n_rows):
    new_row = compute_row(i)
    arr = np.vstack([arr, new_row])
```

### After (preferred) — pre-allocate

```python
arr = np.zeros((n_rows, cols))
for i in range(n_rows):
    arr[i, :] = compute_row(i)
```

### After (fallback) — accumulate then stack once

```python
parts = []
for i in range(n_rows):
    parts.append(compute_row(i))
arr = np.stack(parts)
```

### Why it works

Pre-allocation: total memory written = `n_rows * cols` once. Quadratic version writes `1 + 2 + ... + n_rows = O(n_rows²)` rows. For 1000 rows, that's a 500× difference.

Even the "accumulate to list" fallback is much better than per-iteration `vstack` because the final stack is a single bulk copy.

______________________________________________________________________

## RR-mask — Use a boolean mask instead of nonzero+index

Addresses: [R204](idioms-that-block.md#r204), [R007 (positive equivalent)](idioms-that-scale.md#r007)

### Before

```python
idx = np.nonzero(condition)
arr[idx] = 0.0
```

### After

```python
arr[condition] = 0.0
# or for assigning a value derived from arr:
np.putmask(arr, condition, replacement_value)
```

### Why it works

`arr[condition] = ...` and `np.putmask` apply the mask in place, per GPU — no index array is materialized and no inter-GPU scatter is needed. (For the distributed-scaling rationale behind boolean-mask indexing, see [`idioms-that-scale.md`](idioms-that-scale.md).)

### Variant: extract masked values

```python
# Before
idx = np.nonzero(arr > 0)
positive = arr[idx]

# After
positive = arr[arr > 0]
```

______________________________________________________________________

## RR-reshape — Hoist reshape out of a hot loop

Addresses: [R206](idioms-that-block.md#r206)

### Before

```python
for step in range(steps):
    work = data.reshape(rows, cols)
    do_step(work)
```

### After

```python
work = data.reshape(rows, cols)
for step in range(steps):
    do_step(work)
```

### Why it works

The reshape — possibly a copy in cuPyNumeric — happens once. Inside the loop, all operations on `work` reuse the same partitioning.

### Variant: when reshape is needed every iteration

If the shape genuinely changes, reconsider the algorithm. Often, working on a higher-dimensional array directly via broadcasting avoids the reshape entirely:

```python
# Before
for step in range(steps):
    flat = data.reshape(-1)
    flat *= scale[step]

# After — broadcasting
scales = np.array(scale_values)        # (steps,) array
data *= scales[:, np.newaxis]          # broadcast across rows
# (no loop at all)
```

______________________________________________________________________

## RR-broadcast — Replace Python loop with broadcasting

Addresses: [R101](idioms-that-block.md#r101) for common loop shapes

### Before

```python
for i in range(rows):
 out[i, :] = data[i, :] * row_weights[i]
```

### After

```python
out[:] = data * row_weights[:, np.newaxis]
```

### Why it works

NumPy broadcasting converts per-row scaling into a single elementwise operation over the whole array. Per-GPU parallel; no loop in user code.

______________________________________________________________________

## RR-batch — Replace loops over independent items with a batched op

Addresses: [R101](idioms-that-block.md#r101), some [R302](idioms-that-scale.md#r302)/[R303](idioms-that-scale.md#r303) cases

### Before

```python
results = []
for i in range(n_items):
    results.append(np.linalg.solve(A_list[i], b_list[i]))
results = np.stack(results)
```

### After

```python
A_batch = np.stack(A_list)          # (n_items, m, m)
b_batch = np.stack(b_list)          # (n_items, m)
results = np.linalg.solve(A_batch, b_batch)
```

### Why it works

`linalg.solve` is single-device for one matrix, but **data-parallel across the batch dimension** for stacked matrices. Same logic for QR, SVD, eig, FFT — stacking many small problems gives you multi-GPU parallelism along the batch axis.

______________________________________________________________________

## RR-mpi → cupynumeric — Remove mpi4py from a distributed algorithm

Addresses: [R108](idioms-that-block.md#r108)

### Before (mpi4py)

```python
from mpi4py import MPI
import numpy as np

comm = MPI.COMM_WORLD
rank = comm.Get_rank()
size = comm.Get_size()

local_n = N // size
local_arr = np.zeros(local_n)
# ... compute local_arr ...

global_sum = comm.allreduce(local_arr.sum(), op=MPI.SUM)
```

### After (cuPyNumeric)

```python
import cupynumeric as np

arr = np.zeros(N)                  # one global array
# ... compute arr ... (no rank-aware code)
global_sum = float(np.sum(arr))
```

Run with:

```bash
legate main.py --nodes 4 --gpus 8 --launcher mpirun
```

### Why it works

Legate distributes the global `arr` across ranks automatically. The `np.sum` triggers an internal NCCL allreduce. Your code stays serial-looking; the runtime is parallel.

This is the single biggest simplification you can get from migrating to cuPyNumeric.

______________________________________________________________________

## RR-host-fallback — Isolate calls to libraries that need host arrays

Addresses: [R301 (scipy interop)](idioms-that-scale.md#r301)

### Before — implicit fallback every call

```python
import cupynumeric as np
import scipy.signal

for i in range(n_steps):
    arr = scipy.signal.fftconvolve(arr, kernel)   # forces host trip every iter
```

### After — explicit boundary

```python
import cupynumeric as np
import numpy as onp                    # host NumPy
import scipy.signal

# Stay on host for the SciPy work
arr_host = onp.asarray(arr)             # one-time copy to host
for i in range(n_steps):
    arr_host = scipy.signal.fftconvolve(arr_host, kernel)
arr = np.asarray(arr_host)              # one-time copy back

# Continue with cuPyNumeric ops...
```

### Why it works

Stages the host work outside the cuPyNumeric pipeline. One round trip rather than `n_steps`. If `fftconvolve` is the bottleneck and a cuPyNumeric equivalent exists, prefer that — but when the host library is required, batch the work.

______________________________________________________________________

## Recipe selection rules

When multiple patterns appear in the same hot path, apply recipes in this priority order:

1. **R108 mpi4py** → must remove (RR-mpi)
1. **R101 / R103 / R110 element loops** → vectorize (RR-loop, RR-broadcast)
1. **R102 np.vectorize** → RR-where
1. **R104 / R105 host syncs in loops** → RR-sync / RR-converge
1. **R203 stack in loop** → RR-stack
1. **R201 / R202 alloc / rebind** → RR-alloc / RR-inplace
1. **R204 nonzero+index** → RR-mask
1. **R206 reshape in loop** → RR-reshape
1. **R106 strided slicing** → bool mask
1. **R107 object dtype** → restructure to numeric

Apply roughly in this order, since each later step assumes the earlier issues are resolved. For example, `np.add(x, y, out=x)` only helps if `x` is no longer being rebuilt every iteration.

After applying the recipes, **walk through the code again.** Aim for a READY verdict before benchmarking on real hardware. Then enable [cuPyNumeric Doctor](https://docs.nvidia.com/cupynumeric/latest/user/doctor.html) (`CUPYNUMERIC_DOCTOR=1`) on the first real run to confirm at runtime that no overlooked patterns remain.
