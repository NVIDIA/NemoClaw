---
name: accelerated-computing-cudf
description: Official NVIDIA-authored guidance for NVIDIA cuDF GPU DataFrames, pandas acceleration, dask-cuDF, ETL, joins, groupby, CSV/Parquet I/O, nullable semantics, and multi-GPU DataFrame workloads.
license: CC-BY-4.0 AND Apache-2.0
metadata:
  author: NVIDIA
  tags:
    - cudf
    - dataframes
    - pandas
    - dask-cudf
    - etl
---

# cuDF & dask-cuDF Implementer's Guide

## Compatibility

- Release tracked by this skill: 26.04.
- Requires NVIDIA Volta or newer on CUDA 12, or Turing or newer on CUDA 13. Release 26.04 supports CUDA 12.2-12.9 with driver 535+ or CUDA 13.0-13.1 with driver 580+, and Python 3.11-3.14. cuDF sweet spot: >100K rows.

## Naming

Use NVIDIA library-first wording in user-facing answers. Keep literal RAPIDS/rapidsai URLs, package names, and release metadata when citing sources.

## Role

You are a cuDF expert helping an implementer work with GPU DataFrames. The user understands pandas and their data — your job is to get them to correct, fast GPU code with minimal friction. Choose the path from the user's intent: `cudf.pandas` for broad compatibility or minimal-change acceleration, explicit cuDF for named DataFrame migrations, hot ETL paths, and parity-sensitive work. Treat source schema, row counts, null placement, ordering, and numeric tolerances as user-visible behavior.

## Critical Rules

1. **Choose the right cuDF path.** Use `cudf.pandas` for broad compatibility or minimal-change acceleration. Use explicit cuDF when the user asks to migrate DataFrame code, inspect parity, optimize a visible ETL hot path, or control unsupported operations.
2. **Size gate: 100K rows minimum.** Below that, GPU transfer overhead usually beats the speedup; use small data for correctness and benchmark larger working sets for performance.
3. **Keep conversions at boundaries.** Use `.to_pandas()`, `.values`, or `.numpy()` for display, plotting, CPU-only libraries, or final output boundaries. Keep intermediate ETL data on GPU.
4. **Float32 is your friend.** cuDF operations on float64 are slower; cast early when precision allows.
5. **Validate semantics on representative slices.** For null handling, joins, time series, reshape, or grouped logic, keep a small pandas reference path and compare shape, labels, null counts, ordering, and representative values before claiming parity.
6. **For data > GPU memory**, move to dask-cuDF with `enable_cudf_spill=True`. See `references/dask-cudf-patterns.md`.

## Three Paths to GPU DataFrames

### Path 1: cudf.pandas Accelerator (Compatibility / Minimal Change)

Use when the user needs a small code change, third-party pandas compatibility,
or one code path that can keep running while unsupported operations fall back.

**Jupyter/IPython:**
```python
%load_ext cudf.pandas
import pandas as pd   # now GPU-backed; falls back silently for unsupported ops
```

**Script:**
```bash
python -m cudf.pandas my_script.py
```

**With multiprocessing:**
```python
import cudf.pandas
cudf.pandas.install()   # must come BEFORE pandas import, before Pool creation
from multiprocessing import Pool
```

Confirm acceleration with the cudf.pandas profiler before claiming speedup.
For notebook, CLI, and stats examples, read
`references/cudf-pandas-accelerator.md`. If the profile shows the hot path
running on CPU, use Path 2 for explicit cuDF control.

### Path 2: Explicit cuDF API

For full control, hot-path optimization, named DataFrame migrations, and
parity-sensitive operations:

```python
import cudf

# Read data directly to GPU
df = cudf.read_parquet("data.parquet")

# Operations mirror pandas
result = df.groupby("key")["value"].sum()
merged = df.merge(lookup, on="id", how="left")
filtered = df[df["amount"] > 1000]

# String operations
df["clean"] = df["name"].str.strip().str.lower()

# To check API coverage before committing to migration:
# See references/api-patterns.md for known gaps and workarounds
```

**Keep data on GPU end-to-end.** Only call `.to_pandas()` at the very end for display or CPU or non-GPU handoff.

Prefer explicit cuDF for tasks involving `read_csv`/`read_parquet`, joins,
groupby, reshape, nullable types, `fillna`/`where`, time buckets, rolling
windows, or CPU/GPU parity checks. Add a small CPU/GPU validation path when
semantics matter instead of relying on successful execution alone.

For pandas code with null handling, reshape, or time-series behavior, read
`references/api-patterns.md` for the relevant semantic checklist before
rewriting. A `cudf.pandas` bootstrap is enough for a minimal-change request; an
implementation request should make the hot path explicit and observable.

For reshape-heavy pandas code (`pivot_table`, `melt`, `stack`/`unstack`,
`crosstab`), keep the source schema as part of the contract: index labels,
column labels or levels, `fill_value`, `aggfunc`, margins, and normalization.
Use explicit cuDF where the equivalent is supported; use `cudf.pandas` or a
narrow compatibility boundary when exact pandas reshape semantics matter more
than rewriting every operation. Add a small pandas-reference parity check for
shape, labels, and representative values before finalizing. See
`references/api-patterns.md`.

### Path 3: dask-cuDF (Multi-GPU / Large Data)

When dataset exceeds GPU memory. See `references/dask-cudf-patterns.md` for full patterns.

```python
from dask_cuda import LocalCUDACluster
from dask.distributed import Client
import dask_cudf

cluster = LocalCUDACluster(enable_cudf_spill=True)  # one worker per GPU
client = Client(cluster)

ddf = dask_cudf.read_parquet("s3://bucket/data/*.parquet")
result = ddf.groupby("key").agg({"value": "sum"}).compute()
```

## Memory Management

**Enable spill before OOM happens** (not after):
```python
import cudf
cudf.set_option("spill", True)   # spill to host RAM when GPU is full
```

**RMM pool allocator** (reduces cudaMalloc overhead in pipelines with many allocations):
```python
import rmm
rmm.set_current_device_resource(rmm.mr.CudaAsyncMemoryResource())
# Must be called BEFORE any cuDF operations
```

| GPU Free vs Dataset | Strategy |
|---|---|
| Free > 2× dataset | Single GPU cuDF |
| Free 1–2× dataset | cuDF + `cudf.set_option("spill", True)` |
| Dataset > GPU mem | dask-cuDF |
| Dataset > node mem | dask-cuDF + multi-node (see accelerated-computing-mpf) |

## Troubleshooting

**No speedup vs pandas:**
- Data < 100K rows? GPU overhead dominates, so treat the run as correctness validation and measure speedup on a larger working set.
- Run `%%cudf.pandas.profile` — high CPU % means many fallbacks. Identify and fix those ops.
- Check `references/api-patterns.md` for known gaps.

**OOM (CUDA out of memory):**
1. Enable spill: `cudf.set_option("spill", True)`
2. If allocator fragmentation or repeated allocation overhead is visible, use the `accelerated-computing-rmm` memory-resource setup guidance before GPU allocations
3. Still failing: move to dask-cuDF

**AttributeError / NotImplementedError:**
- Check `references/api-patterns.md` for the specific operation
- Keep that one operation on CPU at a narrow boundary and continue the supported pipeline on GPU
- Use `.to_pandas()` only for the unsupported op, then `.from_pandas()` back

**Wrong results vs pandas:**
- Null/NaN handling differs: cuDF uses `<NA>` (nullable) by default, pandas uses `NaN`. See `references/api-patterns.md`.
- Sort stability: cuDF sort is not guaranteed stable unless `stable=True` is passed
- If the difference is due to floating point differences, try casting to higher precision floats (e.g. `float64` instead of `float32`). If the results are still different, stop. GPU and CPU algorithms will always produce different results on floating point numbers due to the non-associativity of floating point arithmetic and that cannot be fixed.

## Nullable and Fill Semantics

When the user explicitly cares about pandas nullable dtypes, `fillna`,
`where`/`mask`, or grouped null behavior, treat parity checks as part of the
implementation. See `references/api-patterns.md` for nullable dtype examples.

- Preserve nullable integer/string columns instead of filling them with sentinel
  values unless the source code already did that.
- Keep `where`/`mask` semantics when they encode a condition. Use broad
  `fillna` only when the condition is exactly null-only.
- Compare with `to_pandas(nullable=True)` when the pandas reference uses
  nullable extension dtypes.
- Put the parity check in a reusable helper next to the GPU path, so future
  changes exercise the same nullable conversion and aggregation checks.
- Validate row counts, null counts, mask truth tables, grouped aggregates, and
  representative dtypes before claiming semantic parity.

## Reference Files

- `references/cudf-pandas-accelerator.md` — Profiling, fallback detection, cudf.pandas deep dive
- `references/api-patterns.md` — Known API gaps, workarounds, semantic differences
- `references/dask-cudf-patterns.md` — Multi-GPU patterns, best practices, partition tuning

## External Documentation

Use WebFetch to retrieve detailed API signatures, parameter descriptions, and examples on demand.

- **cuDF Documentation:** https://docs.rapids.ai/api/cudf/stable/
- **dask-cuDF API Reference:** https://docs.rapids.ai/api/dask-cudf/stable/api/
- **GitHub:** https://github.com/rapidsai/cudf
- **CHANGELOG:** https://github.com/rapidsai/cudf/blob/main/CHANGELOG.md
