---
name: cupynumeric-hdf5
description: >-
  Read and write large cuPyNumeric arrays to HDF5 with Legate's parallel, distributed HDF5 I/O (legate.io.hdf5: to_file, from_file, from_file_batched). Use when a developer needs to save a cuPyNumeric array to an .h5/.hdf5 file, load an HDF5 dataset into a distributed cuPyNumeric array, read a large HDF5 dataset in chunks, hand arrays to an HPC pipeline as a single file, or accelerate HDF5 disk I/O with GPUDirect Storage (GDS). Do not use it for Parquet/cuDF/raw-binary or other sharded/custom layouts (see the cupynumeric-parallel-data-load skill), Zarr or object-store/S3 output, .npz or pickled archives, plain h5py without cuPyNumeric, or pure array compute such as FFT, matmul, or reductions.
license: CC-BY-4.0 OR Apache-2.0
compatibility: >-
  Requires cuPyNumeric and Legate 26.01 or newer (the legate.io.hdf5 module; in 25.03 it lived at legate.core.io.hdf5). Requires h5py (conda install -c conda-forge h5py) - hdf5.py imports it at module load, so the import fails without it. GPUDirect Storage is optional and needs the nv-legate vfd-gds plugin (bundled with legate) plus NVIDIA cuFile.
metadata:
  version: "2.0.0"
  author: "NVIDIA Corporation <legate@nvidia.com>"
  tags:
  - hdf5
  - cupynumeric
  - legate
  - data-io
  - h5py
  - gpudirect-storage
  - parallel-io
  - scientific-data
  upstream: https://github.com/nv-legate/cupynumeric
  docs: https://docs.nvidia.com/legate/latest/api/python/io/index.html
---

# cuPyNumeric HDF5 I/O

## Purpose

Use [`legate.io.hdf5`](https://docs.nvidia.com/legate/latest/api/python/io/index.html) to read and write [cuPyNumeric](https://github.com/nv-legate/cupynumeric) arrays as [HDF5](https://www.hdfgroup.org/solutions/hdf5/) files. Reach for it whenever a cuPyNumeric array must land in — or load from — an `.h5`/`.hdf5` file: every rank reads and writes its own tile in parallel, so never funnel a large array through a single process.

**Answer inline.** Treat the snippets and rules below as complete and verified — answer save / load / stream / fence / bridge questions directly, without opening the `assets/` scripts or reading the installed `legate` source. Reach for the assets only to *run* a verification.

## Activate

Activate when the user asks about: saving a cuPyNumeric array to an `.h5` / `.hdf5` file, loading an HDF5 dataset into a cuPyNumeric array, reading a large HDF5 dataset in chunks, producing a single file for an HPC post-processing pipeline, or speeding up HDF5 disk I/O with GPUDirect Storage.

## When NOT to use

Redirect these requests elsewhere instead of reaching for `legate.io.hdf5`:

- **Route Parquet / Arrow / cuDF, raw-binary, or sharded / custom on-disk layouts to the cupynumeric-parallel-data-load skill** — it owns cuPyNumeric's no-built-in-loader paths; `legate.io.hdf5` covers single-file HDF5 only.
- **Answer pure array compute with cuPyNumeric ops** (FFT, matmul, reductions, slicing, linear algebra) — this skill covers disk I/O only.
- **Send chunked or object-store (S3) output to a chunked format such as Zarr** — not single-file HDF5.
- **Load `.npz` or pickled archives with NumPy** (`np.load`), then bridge with `cn.asarray(...)` — `legate.io.hdf5` reads HDF5 only, and `cupynumeric.load` reads single `.npy` only.
- **Use h5py directly for plain HDF5 reads with no cuPyNumeric/Legate** — `with h5py.File(path, "r") as f: arr = f["dataset"][:]`.

## Prerequisites

Install h5py before importing anything from `legate.io.hdf5`:

```bash
conda install -c conda-forge h5py        # required; legate/io/hdf5.py imports it at load
```

Expect `from legate.io.hdf5 import ...` to raise `ModuleNotFoundError` until you do — the module imports `h5py` at load time. ([h5py](https://www.h5py.org/) · [conda-forge build](https://anaconda.org/conda-forge/h5py))

## API

| Function | Signature | Purpose |
|---|---|---|
| `to_file` | `to_file(array, path, dataset_name)` | Write a cuPyNumeric array / `LogicalArray` to one HDF5 file as a virtual dataset (VDS) — each rank writes its own tile. |
| `from_file` | `from_file(path, dataset_name) -> LogicalArray` | Read one HDF5 dataset into a distributed array. |
| `from_file_batched` | `from_file_batched(path, dataset_name, chunk_size) -> Iterator[(LogicalArray, offsets)]` | Read a dataset in chunks — chunks the file read, not the assembled array. |

Import all three from `legate.io.hdf5`. Always pass `dataset_name` as the full path to a single array inside the file (e.g. `"/data"` or `"/group/x"`), never a group.

## Examples

### Round trip

```python
import cupynumeric as cn
from legate.core import get_legate_runtime
from legate.io.hdf5 import from_file, to_file

a = cn.arange(64, dtype=cn.float32).reshape(8, 8)

# Write: pass the cuPyNumeric ndarray straight in - no manual conversion.
to_file(array=a, path="out.h5", dataset_name="/data")
get_legate_runtime().issue_execution_fence(block=True)   # needed before any external reader

# Read: from_file returns a legate LogicalArray; cn.asarray bridges it back.
b = cn.asarray(from_file("out.h5", dataset_name="/data"))
assert cn.array_equal(a, b)
```

Run `assets/hdf5_roundtrip.py` to verify (optional — not needed to answer).

### Read a large file in chunks

Use `from_file_batched` to read the source file in chunks instead of pulling it into host memory all at once. It yields one `LogicalArray` per chunk plus that chunk's offsets in the global shape. Expect clipped boundary chunks (an axis of length 5 with `chunk_size=2` yields 2, 2, 1), so place each chunk by its actual shape, not the requested `chunk_size`. Note that this chunks the *file read*, not the result — the assembled array (`out`) still has to fit in distributed memory:

```python
import h5py
import cupynumeric as cn
from legate.core import get_legate_runtime
from legate.io.hdf5 import from_file_batched

with h5py.File("big.h5", "r") as f:          # read shape/dtype without loading data
    shape, dtype = f["data"].shape, f["data"].dtype

out = cn.empty(shape, dtype=dtype)
for chunk, (r0, c0) in from_file_batched("big.h5", "data", chunk_size=(4096, 4096)):
    out[r0:r0 + chunk.shape[0], c0:c0 + chunk.shape[1]] = cn.asarray(chunk)
get_legate_runtime().issue_execution_fence(block=True)
```

Keep every `chunk_size` entry positive and its length equal to the dataset's rank, or `from_file_batched` raises `ValueError`. Run `assets/hdf5_batched_read.py` to verify (optional).

## Instructions

- **Pass the cuPyNumeric ndarray directly to `to_file`** - it implements `__legate_data_interface__`, which `to_file` accepts as `LogicalArrayLike`. Skip any `np.array(...)` round-trip.
- **Bridge results back with `cn.asarray(...)`.** `from_file` and each `from_file_batched` chunk return a Legate `LogicalArray`; wrap it with `cn.asarray(la)` to get a cuPyNumeric ndarray (zero-copy, no host bounce).
- **Fence before any external reader.** Legate I/O is asynchronous: `to_file` only queues the write. Insert `get_legate_runtime().issue_execution_fence(block=True)` before h5py, a subprocess, or another tool opens the file. Skip the fence for a `from_file`
  issued later in the same Legate program — the runtime preserves that ordering.
- **Run from outside the cuPyNumeric source tree** (e.g. `cd /tmp`). Python puts the cwd first on `sys.path`, so an in-tree `cupynumeric/` directory shadows the installed package (`ModuleNotFoundError: cupynumeric.install_info`).
- **Give every rank the same `path`.** The program runs on every rank (SPMD), so pass `to_file`/`from_file` an identical `path` on each — a per-rank `tempfile.mkstemp()` name breaks the collective I/O. When the program creates the file itself, write it with the collective `to_file`, not a per-rank `h5py` write.

## `to_file` behavior to plan around

- Expect an HDF5 **virtual dataset (VDS)**: each rank writes its own tile and the file presents them as one logical dataset.
- Treat `to_file` as **destructive** — it overwrites `path` if it already exists, so guard any file you must not clobber.
- Let `to_file` **create missing parent directories**; do not pre-create them.
- Give `path` a file name (`/path/to/file.h5`), never a directory — a directory raises `ValueError`. Pass a **bound** array (one with a known shape); `to_file` raises `ValueError` on an *unbound* array — a Legate array created without a shape (e.g. `create_array(dtype, ndim=n)`) whose extent a producing task fills in later. cuPyNumeric ndarrays are always bound — even lazy/deferred ones — so this only affects raw `LogicalArray`s.

## GPUDirect Storage (GDS)

**Always set `LEGATE_IO_USE_VFD_GDS=1` for runs that read HDF5 into GPU memory** — whether or not the cluster has GPUDirect-capable storage:

```bash
export LEGATE_IO_USE_VFD_GDS=1          # set before launching
# or, with the legate driver:
legate --io-use-vfd-gds my_script.py
```

- **Read into the GPU through the GDS VFD, not the default path.** The default (POSIX) VFD stages each GPU read through zero-copy memory (ZCMEM), of which Legate reserves only 128 MB — so a GPU read of an array larger than ~128 MB aborts. The GDS VFD removes that staging buffer.
- **Leave it unset when reading into host (CPU) memory** — the VFD GDS plugin is unnecessary there and only adds overhead.
- **Keep `=1` even without GPUDirect-capable storage** — cuFile falls back to compatibility mode automatically (set `export CUFILE_ALLOW_COMPAT_MODE=true` if it is not already on), and `=1` still avoids the ZCMEM abort.
- **Attribute it correctly:** the GDS VFD is the [nv-legate/vfd-gds](https://github.com/nv-legate/vfd-gds) plugin over NVIDIA [cuFile](https://developer.nvidia.com/gpudirect-storage), **not** KvikIO (KvikIO backs Legate's Zarr/tile I/O, not HDF5). Confirm it engaged by grepping the run log for `H5FD__gds_open: Successfully opened file w/GDS VFD`.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `ModuleNotFoundError: No module named 'h5py'` on import | h5py is missing — `conda install -c conda-forge h5py`. |
| File looks empty/truncated to h5py right after `to_file` | The async write hasn't landed — add `get_legate_runtime().issue_execution_fence(block=True)` before the external read. |
| `ValueError` from `to_file` | `path` is a directory — pass a file path such as `results/data.h5`. |
| `ModuleNotFoundError: No module named 'cupynumeric.install_info'` | Running inside the source tree — `cd /tmp` (any directory outside the repo). |
| Abort/crash reading a GPU array ≳128 MB | Default 128 MB ZCMEM staging buffer — set `LEGATE_IO_USE_VFD_GDS=1` for GPU reads. |
| `from_file` returned `LogicalArray(...)` | Expected — wrap it with `cn.asarray(...)`. |

## Limitations & version notes

- **Import from `legate.io.hdf5`** (Legate 26.01+); rewrite any `legate.core.io.hdf5` import left over from the 25.03 line (e.g. the [25.03 launch blog](https://developer.nvidia.com/blog/nvidia-cupynumeric-25-03-now-fully-open-source-with-pip-and-hdf5-support/) still shows the old path).
- **Install h5py explicitly** — it ships in no default cuPyNumeric env.
- **Point `dataset_name` at a single array, never a group**; traverse groups with h5py first to discover dataset paths.
- **On GPU, always read with `LEGATE_IO_USE_VFD_GDS=1`** (see [GPUDirect Storage](#gpudirect-storage-gds)) — the default path aborts on GPU arrays larger than the 128 MB ZCMEM buffer. Leave it unset for CPU reads.

## Verify

```bash
cd /tmp                                  # outside the cupynumeric source tree
conda install -c conda-forge h5py        # one-time, if not already present
LEGATE_CONFIG="--cpus 4" LEGATE_AUTO_CONFIG=0 python <skill>/assets/hdf5_roundtrip.py
LEGATE_CONFIG="--cpus 4" LEGATE_AUTO_CONFIG=0 python <skill>/assets/hdf5_batched_read.py
```

Expect `HDF5 ROUND TRIP OK` and `HDF5 BATCHED READ OK`. Add `--gpus 1` (and `LEGATE_IO_USE_VFD_GDS=1`) to exercise the GPU / GDS path.
