# dask-cuDF Patterns

## Preferred API: dask.dataframe Backend (release 24.06+)

The recommended way to use dask-cuDF is via the `dask.dataframe` backend config, **not** `import dask_cudf` directly. The backend API enables the query planning optimizer (predicate pushdown, projection pushdown) introduced in release 24.06+.

```python
import dask
dask.config.set({"dataframe.backend": "cudf"})

import dask.dataframe as dd

# Read — now GPU-backed with query planning
ddf = dd.read_parquet("data/*.parquet")
ddf = dd.read_csv("data/*.csv")

# All standard dask.dataframe operations work
result = ddf.groupby("key")["value"].sum()
```

**Explicit `dask_cudf` import is still valid** but bypasses query planning:
```python
import dask_cudf   # works, but no optimizer — use for legacy code only
ddf = dask_cudf.read_parquet("data/*.parquet")
```

## Cluster Setup

Always use `LocalCUDACluster`, even for a single GPU — it pins GPU affinity, enables the dashboard, and is required for proper spill configuration:

```python
from dask_cuda import LocalCUDACluster
from dask.distributed import Client
import dask
dask.config.set({"dataframe.backend": "cudf"})

# Standard setup — one worker per GPU
cluster = LocalCUDACluster(
    enable_cudf_spill=True,    # cuDF-native spill; preferred over device_memory_limit
    rmm_pool_size=0.8,         # leave headroom for non-RMM allocations
)
client = Client(cluster)

# With UCX automatic transport selection for communication-heavy workloads
cluster = LocalCUDACluster(
    enable_cudf_spill=True,
    rmm_pool_size=0.8,
    protocol="ucx",
)
```

## Partition Sizing

Partition size is the most impactful tuning parameter:

| Workload | Target Partition Size |
|---|---|
| General ETL | 1/32 – 1/8 of single GPU memory |
| Shuffle-intensive (groupby, join, sort) | 1/32 – 1/16 of GPU memory |

```python
# Check current partitions
print(f"Partitions: {ddf.npartitions}")

# Tune at read time (most efficient)
ddf = dd.read_parquet("data/", blocksize="256MB")  # adjust to hit target partition size

# Repartition after load if needed
ddf = ddf.repartition(npartitions=64)
```

## Reading Data

### Local Parquet (Recommended)

```python
import dask.dataframe as dd

# Project only needed columns — pushed down to storage
ddf = dd.read_parquet("data/*.parquet", columns=["col1", "col2", "key"])

# aggregate_files=True merges small files into larger partitions
ddf = dd.read_parquet("data/", aggregate_files=True, blocksize="512MB")
```

### Remote Storage (S3, GCS)

```python
# Use blocksize=None to avoid slow metadata collection on remote stores
ddf = dd.read_parquet(
    "s3://bucket/prefix/",
    blocksize=None,
    filesystem="arrow",    # pyarrow filesystem for S3/GCS
    columns=["col1", "col2"],
)
```

## Aggregation Patterns

### Low-cardinality groupby

```python
# split_out=1 avoids unnecessary shuffle for few output groups
result = ddf.groupby("status_code")["amount"].sum(split_out=1)
```

### High-cardinality groupby (default)

```python
result = ddf.groupby("customer_id").agg({"amount": "sum", "count": "count"})
```

## Join / Merge Patterns

```python
# Standard join (both datasets distributed)
merged = large_ddf.merge(other_large_ddf, on="id", how="left")

# Small table join: broadcast=True avoids shuffling the large table
merged = large_ddf.merge(
    small_lookup_df,    # cuDF DataFrame or small dask-cuDF
    on="id",
    how="left",
    broadcast=True,     # sends small_lookup to all workers; no shuffle
)
```

## Sort vs. Shuffle

```python
# sort_values is expensive — triggers full shuffle + materialization
# AVOID unless you actually need a globally ordered output:
sorted_ddf = ddf.sort_values("timestamp")   # use sparingly

# If you need rows grouped by key (not sorted), use shuffle instead:
from dask_cudf import shuffle
shuffled = shuffle(ddf, on="customer_id")   # redistributes by key, much cheaper
```

## Building Distributed Collections

```python
# Preferred: from_map enables column projection pushdown
from dask.dataframe import from_map
import cudf

def load_partition(path, columns=None):
    return cudf.read_parquet(path, columns=columns)

files = ["data/part_0000.parquet", "data/part_0001.parquet"]
ddf = from_map(
    load_partition,
    files,
    meta=cudf.read_parquet(files[0], nrows=0),   # avoids eager first-partition read
)

# from_delayed works but loses projection pushdown
from dask import delayed
parts = [delayed(cudf.read_parquet)(f) for f in files]
ddf = dask_cudf.from_delayed(parts)   # fallback if from_map doesn't apply
```

## Eager Execution Traps

These calls trigger immediate computation — avoid mid-pipeline:

| Call | Why it's expensive |
|---|---|
| `.compute()` on large collection | Pulls all data to one GPU |
| `.persist()` without `client.wait()` | Silent if client not set up |
| `len(ddf)` | Full scan |
| `ddf.head()` / `ddf.tail()` | Materializes first/last partition |
| `ddf.sort_values(...)` | Full shuffle |
| `ddf.set_index(col)` | Full shuffle + sort |

**Persist pattern** (when you query the same data multiple times):
```python
ddf = ddf.persist()
client.wait(ddf)           # block until all partitions are in GPU memory
result1 = ddf[ddf["a"] > 0].compute()
result2 = ddf[ddf["b"] > 0].compute()  # fast — data already in memory
```

**Never call `.compute()` on a collection larger than single-GPU memory** — it will OOM. Instead write to Parquet and read back in pieces.

## Writing Results

```python
# Parquet (recommended — partitioned output)
ddf.to_parquet("output/", write_index=False)

# To single cuDF DataFrame — only when result fits in GPU memory
result_cudf = ddf.compute()

# To pandas — only at the very end for CPU or non-GPU handoff
result_pd = ddf.to_pandas()
```

## OOM Diagnosis

```python
# Step 1: Check worker memory pressure from dashboard
print(client.dashboard_link)   # open in browser → Workers tab

# Step 2: Increase partition count to reduce per-partition memory
ddf = ddf.repartition(npartitions=ddf.npartitions * 2)

# Step 3: If not already enabled, add cuDF-native spilling
# (restart cluster with enable_cudf_spill=True, rmm_pool_size=0.9)

# Step 4: Move filter/project before expensive operations
ddf = ddf[["needed_col1", "needed_col2", "key"]]  # project first
ddf = ddf[ddf["amount"] > 0]                      # filter early
result = ddf.groupby("key")["needed_col1"].sum().compute()
```

## Anti-Patterns

For new dask-cuDF code, use the backend setup shown in the Preferred API
section above. The examples here focus on execution and materialization
mistakes after the backend has been selected.

```python
# AVOID: calling .compute() mid-pipeline
intermediate = ddf.groupby("a")["b"].sum().compute()   # breaks lazy graph
result = intermediate.groupby("c")["b"].mean()         # now CPU pandas!

# CORRECT: chain lazily, compute once
result = (
    ddf.groupby("a")["b"].sum()
       .reset_index()
       .groupby("c")["b"].mean()
       .compute()
)

# AVOID: collecting huge dataset to display
print(ddf.compute())   # OOM risk

# CORRECT: sample or head
print(ddf.head(10))    # shows first 10 rows only
```
