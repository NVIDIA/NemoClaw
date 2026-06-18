---
name: cupynumeric-parallel-data-load
description: Load a sharded, on-disk dataset (sharded .npy, Parquet/Arrow, raw binary, sharded HDF5, custom layouts) into a distributed cuPyNumeric ndarray via a manual partition + leaf @task launch with CPU/OMP/GPU variants. Use when no single-call loader fits, including when per-shard row counts differ across files. Prefer cupynumeric.load or legate.io.hdf5.from_file when they apply.
license: CC-BY-4.0 OR Apache-2.0
compatibility: linux-x86_64, linux-aarch64, darwin-aarch64, wsl-x86_64
metadata:
  version: "1.0.0"
  author: "NVIDIA Corporation <legate@nvidia.com>"
  upstream: https://github.com/nv-legate/cupynumeric
  docs: https://docs.nvidia.com/cupynumeric/latest/
  tags:
    - cupynumeric
    - legate
    - data-loading
    - io
    - distributed
    - parallel
    - gpu
    - sharded-data
---

# Parallel sharded data -> cupynumeric load

**Why this skill exists.** cupynumeric mirrors NumPy's array API,
including `cupynumeric.load` for a single `.npy` file. Beyond that,
file *loading* lives in Legate, not cupynumeric:

| Format | Built-in loader |
|---|---|
| Single `.npy` | `cupynumeric.load(path)` (NumPy-API parity) |
| HDF5 (single file) | `legate.io.hdf5.from_file` / `from_file_batched` |
| Sharded multi-file (any format), Parquet/Arrow, raw binary, custom layouts | **No built-in loader — this skill.** |

This skill shows the canonical way to fill the gap in the last row:
write a Legate Python task that calls the third-party reader the
format needs (`h5py`, `pyarrow`, `np.memmap`, ...) inside the
task body, and let Legate distribute the reads across GPUs / nodes.
For the formats with a built-in loader, prefer it unless you need a
custom in-task body (mmap-based loader, format-specific decoder,
sidecar metadata, partial / sharded reads).

Canonical pattern: **manual partition + manual task launch, sized to
the machine, not the files.** Only axis 0 is sharded; trailing axes
ride along inside each tile. Per-shard row counts may differ across
files (only `dtype` and trailing axes must match); the launch fills
every available processor regardless of how many files there are.

`.npy` is the worked example because the header carries shape and
dtype on disk, but the skeleton applies to any format with cheap
range/slice reads (raw binary, HDF5, Parquet/Arrow — see "Other
formats" below). Reference implementation:
[`assets/examples/parallel_npy_load.py`](assets/examples/parallel_npy_load.py).

## Data layout assumption

This skill is purely about **loading** — it assumes the data is already
laid out on a shared filesystem in some predictable, indexable way.
Producing those files is out of scope (the example ships a `write`
subcommand for convenience, but real users bring their own).

The worked example assumes one specific layout:

- A directory containing files named `shard_0000.npy`, `shard_0001.npy`,
  ... in a contiguous integer sequence (zero-padded width 4).
- All shards share the same `dtype` and the same trailing axes
  (`shape[1:]`); **axis 0 (rows per shard) may differ across files** —
  the recipe builds a cumulative row-offset table and reads each
  file's overlapping slice from inside the leaf task.
- The directory is visible to every rank (shared filesystem for
  multi-node runs).

The example's `discover_layout()` prints what it found and hard-fails
with a descriptive error when the layout is wrong (missing directory,
no shards, mismatched `dtype` / trailing axes, or a hole in the
contiguous `shard_NNNN.npy` sequence).

If your data lives in a different layout — fixed-stride raw binary, an
HDF5 file with one dataset per shard, a directory tree, ... — only the
glob pattern, the per-file reader (step 4 below), and the metadata
discovery (step 1 below) change. The partitioning and launch machinery
is layout-agnostic.

## When to use

See the format table above for the routing decision (built-in loader
vs. this skill). Beyond that, two additional cues that this skill is
the right fit:

- Replacing sequential `np.concatenate([read(f) for f in files])` with
  parallel per-GPU reads.
- Demonstrating how a user-defined Legate Python task writes into a
  cupynumeric output array via a manual launch.

## Examples

Paths below are written relative to this skill's directory (the script
ships at `assets/examples/parallel_npy_load.py`). Adjust the prefix to
match wherever your skill is installed (e.g.
`skills/cupynumeric-parallel-data-load/assets/...` if the skill lives
under a top-level `skills/` directory).

```bash
# Single-node, 4 GPUs.
legate --gpus 4 --fbmem 4000 --min-gpu-chunk 1 \
    assets/examples/parallel_npy_load.py \
    read --shard-dir /shared/scratch/demo
```

```bash
# Multi-node, 2 nodes x 4 GPUs (slurm), shared filesystem at --shard-dir.
# Generate the shards once on rank 0, then re-run `read` at any scale.
legate --launcher srun --nodes 2 --cpus 1 \
    assets/examples/parallel_npy_load.py \
    write --shard-dir /shared/scratch/demo

legate --launcher srun --nodes 2 --ranks-per-node 4 \
    --gpus 4 --fbmem 4000 --min-gpu-chunk 1 \
    assets/examples/parallel_npy_load.py \
    read --shard-dir /shared/scratch/demo
```

No layout flags — the read driver walks every `.npy` header to recover
per-file row counts, the trailing shape, and the dtype, then derives
`tile_rows` from the available processor count.

`--min-gpu-chunk 1` is only needed when the per-tile element count is
below Legate's default minimum chunk size for GPU launches (e.g. the
worked example's defaults — total rows split across 4 GPUs at
`~1M` per tile — fall below the threshold and would otherwise be
folded onto a single GPU). For production-sized datasets (tens of
millions of elements per tile or larger) you can drop the flag and
let Legate use its default. Bumping it to a moderate value (e.g.
`--min-gpu-chunk 1024`) is fine when each tile is large enough that
per-task overhead matters more than getting *every* GPU a tile.

## Instructions

Five steps from a `.npy` worked example; only step 1 (parsing the
format header) and step 4 (the per-file reader inside the task body)
are format-specific. The other three (allocate destination, partition,
fence) are reused unchanged across formats — see "Other formats" below
for the swap-points.

### 1. Read the metadata from every shard

Scan the directory and peek at every `.npy` header (`mmap_mode="r"`
reads only the header). The header carries the per-shard shape and
dtype, so the driver can recover total rows, trailing shape, and a
cumulative row-offset table without ever loading the data:

```python
paths = sorted(SHARD_DIR.glob("shard_*.npy"))

per_file_rows = []                       # rows along axis 0 per file
trailing_shape = None                    # shape[1:], must match across files
dtype = None
for p in paths:
    hdr = np.load(p, mmap_mode="r")
    if trailing_shape is None:
        trailing_shape = tuple(hdr.shape[1:])
        dtype = hdr.dtype
    elif tuple(hdr.shape[1:]) != trailing_shape or hdr.dtype != dtype:
        raise RuntimeError(
            f"{p.name}: trailing shape / dtype mismatch "
            f"({hdr.shape[1:]}/{hdr.dtype} vs {trailing_shape}/{dtype})"
        )
    per_file_rows.append(int(hdr.shape[0]))

cum_rows = np.cumsum([0] + per_file_rows, dtype=np.int64)  # length N+1
total_rows = int(cum_rows[-1])
```

The snippet above enforces matching `dtype` and `trailing_shape` (i.e.
`shape[1:]`) across files. **Per-shard row counts may differ** — the
cum-rows table handles that. Production code should also verify that
names form a contiguous `shard_0000.npy ... shard_NNNN.npy` sequence
(omitted from the snippet for brevity; see `discover_layout()` in the
worked example). Discovery relies only on what the
on-disk format itself exposes (the `.npy` header here, `.shape` /
`.dtype` for HDF5, etc.); any sidecar (manifest, content hashes) is a
separate verification step on top.

### 2. Create the cupynumeric output store from the metadata

The total array spans `total_rows` along axis 0; trailing axes come
from `trailing_shape` unchanged. Use `cn.empty` — the task overwrites
every cell, zero-init would be wasted.

```python
import cupynumeric as cn

total_shape = (total_rows,) + trailing_shape
out = cn.empty(total_shape, dtype=dtype)
```

### 3. Tile the store by processor count

The launch shape is sized to the **available processors**, not to the
file count. Pick `tile_rows = ceil(total_rows / num_processors)` and
partition axis 0 by that tile size. Trailing axes are not partitioned
(tile spans the full extent there). The last tile is allowed to be
short — that's exactly what `partition_by_tiling` supports — so the
recipe needs no divisibility constraint.

```python
from legate.core import TaskTarget, get_legate_runtime
from legate.core.data_interface import as_logical_array

runtime = get_legate_runtime()
machine = runtime.get_machine()
num_processors = max(
    machine.count(TaskTarget.GPU),
    machine.count(TaskTarget.OMP),
    machine.count(TaskTarget.CPU),
    1,
)

tile_rows = max(1, (total_rows + num_processors - 1) // num_processors)
tile_shape = (tile_rows,) + trailing_shape
partition = as_logical_array(out).data.partition_by_tiling(tile_shape)

num_tasks = (total_rows + tile_rows - 1) // tile_rows  # match partition tile count
```

### 4. Define the leaf task and launch it manually

`PATHS` and `CUM_ROWS` (the file paths and cumulative row-offset
table from step 1) plus `TILE_ROWS` are populated as module globals
by the driver before launching; control replication runs the driver
on every rank, so every worker sees identical values.

Each task builds its consumer view first (cupy on GPU, numpy on
CPU/OMP) and reads the tile's actual row count from `view.shape[0]`
— `PhysicalStore` itself has no `.shape` attribute, so going through
the view is required. It then computes its global row range from its
launch coordinate and that row count, bisects `cum_rows` for the
overlapping file(s), and copies each overlapping file slice into the
matching destination slice. Register CPU, OMP, and GPU variants so
the same launch runs unchanged anywhere; dispatch on
`ctx.get_variant_kind()` picks the consumer matching where the
`OutputStore` is resident (`cp.from_dlpack(dst)` for FBMEM,
`np.asarray(dst)` for SYSMEM). cupy is imported inside the GPU
branch only, so the task body loads on machines without cupy.

```python
import bisect
from legate.core import TaskContext, VariantCode
from legate.core.task import OutputStore, task

@task(variants=(VariantCode.CPU, VariantCode.OMP, VariantCode.GPU))
def load_tile(ctx: TaskContext, dst: OutputStore) -> None:
    t = ctx.task_index[0]                              # tile index 0..num_tasks-1

    variant = ctx.get_variant_kind()
    if variant == VariantCode.GPU:
        import cupy as cp                              # lazy: only on GPU
        view = cp.from_dlpack(dst)
    else:
        view = np.asarray(dst)                         # zero-copy numpy view

    tile_rows_actual = view.shape[0]                   # short on the last tile
    row_start = t * TILE_ROWS                          # global axis-0 start
    row_end = row_start + tile_rows_actual

    # Find the half-open range of file indices that overlap [row_start, row_end).
    first_file = bisect.bisect_right(CUM_ROWS, row_start) - 1
    last_file = bisect.bisect_right(CUM_ROWS, row_end - 1) - 1

    for f in range(first_file, last_file + 1):
        # Intersection of tile [row_start, row_end) with file [cum[f], cum[f+1]).
        lo = max(row_start, int(CUM_ROWS[f]))
        hi = min(row_end, int(CUM_ROWS[f + 1]))
        file_lo = lo - int(CUM_ROWS[f])
        file_hi = hi - int(CUM_ROWS[f])
        dst_lo = lo - row_start
        dst_hi = hi - row_start
        chunk = np.ascontiguousarray(
            np.load(PATHS[f], mmap_mode="r")[file_lo:file_hi]
        )
        if variant == VariantCode.GPU:
            view[dst_lo:dst_hi].set(chunk)             # cudaMemcpyAsync H2D
        else:
            view[dst_lo:dst_hi] = chunk                # zero-copy numpy write

manual_task = runtime.create_manual_task(
    load_tile.library,
    load_tile.task_id,
    (num_tasks,),                                      # launch domain == tile count
)
manual_task.add_output(partition)
manual_task.execute()
```

Both consumers go through `PhysicalStore`'s native producers
(`__dlpack__` for cupy, `__array_interface__` for `np.asarray`) —
zero-copy views of the local tile. Bisect cost is `O(log num_shards)`
and the inner loop typically iterates 1–2 times (tiles overlap at
most a couple of files).

### 5. Fence and verify

```python
get_legate_runtime().issue_execution_fence(block=True)
```

## Hard constraints

1. **All shards must share `dtype` and trailing axes (`shape[1:]`).**
   The recipe stacks shards along axis 0; the destination's trailing
   axes come from `trailing_shape`, which the discovery step locks to
   the value of the first file. Per-shard row counts (`shape[0]`) may
   freely differ — the cumulative-offset table handles them. The
   example rejects any shard whose `dtype` or trailing shape differs
   from the first one with a descriptive error.

2. **Pick the consumer that matches the variant.** `cp.from_dlpack`
   rejects SYSMEM-resident stores; `np.asarray` silently returns a
   host view of an FBMEM-resident store you can't actually write
   through. Dispatch on `ctx.get_variant_kind()` so each variant uses
   its own consumer — see step 4.

3. **mmap views aren't always C-contiguous** — wrap each per-file
   slice with `np.ascontiguousarray(arr[file_lo:file_hi])` before
   `.set()` or the numpy in-place write.

4. **Multi-node: `SHARD_DIR` must be on a shared filesystem.** Every
   worker (on every rank) opens shards by path; node-local `/tmp` paths
   only work for single-node demos.

## Variants

### Uniform-shard fast path (one task per file)

When every shard already has the same `(shape, dtype)` and you happen
to have `num_shards` processors available, the cum-rows / bisect
machinery is overhead. Set `tile_rows = shard_shape[0]` and
`num_tasks = num_shards`; the partition then has one tile per file
and each task reads exactly one file end-to-end (no bisect, no inner
loop). The driver-side switch is a one-liner:

```python
if all(r == per_file_rows[0] for r in per_file_rows) and num_shards == num_processors:
    tile_rows = per_file_rows[0]
else:
    tile_rows = max(1, (total_rows + num_processors - 1) // num_processors)
```

The same `load_tile` task body still works in either mode — the inner
loop just happens to iterate exactly once per task. There's no need
for a separate task body for the fast path.

### Over-decompose for better load balancing

The default `tile_rows = ceil(total_rows / num_processors)` gives one
tile per processor. To over-decompose by a factor `K` (smaller tiles,
more point tasks, finer-grained queueing), divide by `K * num_processors`
instead:

```python
tile_rows = max(1, (total_rows + K * num_processors - 1) // (K * num_processors))
```

`num_tasks = ceil(total_rows / tile_rows)` then expands to roughly
`K * num_processors`. The same task body still works — bisect just lands
on more tasks per file.

### Other formats

Only the per-file reader inside `load_tile` changes. The reader's
contract: given a file path and a half-open row range
`[file_lo, file_hi)` along axis 0, return a numpy array of shape
`(file_hi - file_lo,) + trailing_shape` that can be made C-contiguous.
Cheap range/slice reads are required — formats that only support
"read the whole file" defeat the partial-overlap case (a tile that
covers only part of one file).

| Format | Reader inside the leaf task |
|---|---|
| **`.npy`** (worked example) | `host = np.ascontiguousarray(np.load(p, mmap_mode="r")[file_lo:file_hi])` |
| **Raw binary** (fixed-shape) | `arr = np.memmap(p, dtype=DTYPE, mode="r", shape=(rows_in_file, *trailing_shape)); host = np.ascontiguousarray(arr[file_lo:file_hi])` |
| **HDF5** | `with h5py.File(p, "r") as f: host = np.ascontiguousarray(f["data"][file_lo:file_hi])` |
| **Parquet / Arrow** | `tbl = pq.read_table(p, columns=..., use_threads=False).slice(file_lo, file_hi - file_lo); host = tbl.to_pandas().values` |

(For built-in single-call loaders per format, see the "Why this skill
exists" table at the top of this file.)

The discovery step (step 1) parses each format's metadata: `.npy` /
HDF5 / Parquet all carry per-file row count + dtype on disk.
Raw binary doesn't — sidecar or derive from file size.

## Common pitfalls

### `cn.asarray(dst)` is illegal in a leaf task

Inside a `@task` body, any cupynumeric op that touches the top-level
runtime — `cn.asarray(store)`, slice assignment `cn_dst[s] = host_np` —
triggers `create_index_space` from the wrong context and Legion aborts:

```
LEGION API USAGE EXCEPTION: Invalid task context passed to runtime call
create_index_space
```

Fix: consume the DLPack capsule with a **third-party** library (cupy /
torch / numpy) inside leaf tasks. `cn.asarray` is fine in the driver,
just not in leaf tasks. See `examples/dlpack/leaf_task_interop.py` for
the torch-flavoured workaround.

### In-task `assert` aborts the runtime

Legate treats unraised exceptions in a `@task` as a contract violation
and aborts unless the task was registered with `throws_exception()`.
Sanity-check on the host before launching.

### Launch domain must match the partition tile count

`create_manual_task(launch_shape=...)` and `partition_by_tiling(...)`
are independent — the runtime doesn't catch a mismatch. Larger launch
domain → out-of-range tiles; smaller → unwritten tiles. Always derive
both from the same `(total_rows, tile_rows)` via two separate `ceil`
divisions (sizing the launch domain to `num_processors` directly
would over-launch when `num_processors > total_rows`):

```python
tile_rows = max(1, (total_rows + num_processors - 1) // num_processors)
num_tasks = (total_rows + tile_rows - 1) // tile_rows
partition = ...partition_by_tiling((tile_rows,) + trailing_shape)
runtime.create_manual_task(load_tile.library, load_tile.task_id, (num_tasks,))
```
