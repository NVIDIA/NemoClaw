---
name: dali-dynamic-mode
description: "DALI imperative dynamic mode (`nvidia.dali.experimental.dynamic`, ndd): use when working on ndd code or migrating pipelines; skip pipeline-only tasks."
license: Apache-2.0
metadata:
  author: "DALI Team <dali-team@nvidia.com>"
  tags:
    - dali
    - dynamic-mode
    - ndd
    - data-loading
    - data-processing
    - gpu-processing
  languages:
    - python
  team: dali
  domain: deep-learning
---

# DALI Dynamic Mode

## Purpose

Guide AI agents in writing, reviewing, and migrating code that uses DALI's imperative dynamic-mode API, `nvidia.dali.experimental.dynamic` (`ndd`).

## Instructions

- Import dynamic mode as `nvidia.dali.experimental.dynamic as ndd` and write code as direct `ndd` calls in ordinary Python; do not use pipeline-mode APIs such as `Pipeline`, `@pipeline_def`, `pipe.build()`, or `pipe.run()`.
- Treat readers as stateful: create them once, reuse them across epochs, and pass `batch_size` to `next_epoch(...)`.
- Pass explicit `batch_size` to random ops; there is no pipeline-level batch size to inherit.
- Use dynamic-mode API conventions: `device="gpu"` instead of pipeline-mode `"mixed"`, `Batch.tensors[...]` for sample selection, and `Batch.slice[...]` for per-sample slicing.
- Use `.torch()` to convert a tensor or batch to a PyTorch tensor. Use `pad=True` for batches with variable shapes.

## Prerequisites

- To run or validate code, NVIDIA DALI must be installed with dynamic mode importable as `nvidia.dali.experimental.dynamic`.
- GPU decode or GPU operators require a CUDA-capable DALI build and an available NVIDIA GPU/driver.
- Framework conversion examples require the target framework installed, such as PyTorch for `.torch()`.

## Introduction

Dynamic mode is DALI's imperative Python API. It lets code call DALI operators directly from normal Python control flow instead of building and running a pipeline graph.

## Core Data Types

### Tensor -- single sample

```python
t = ndd.tensor(data)           # copy
t = ndd.as_tensor(data)        # wrap, no copy if possible
t.cpu()                        # move to CPU
t.gpu()                        # move to GPU
t.torch(copy=False)            # conversion to PyTorch tensor with no copy (default)
t[1:3]                         # slicing supported
np.asarray(t)                  # NumPy via __array__ (CPU only)
```

Supports `__dlpack__`, `__cuda_array_interface__`, `__array__`, arithmetic operators.

### Batch -- collection of samples (variable shapes OK)

```python
b = ndd.batch([arr1, arr2])    # copy
b = ndd.as_batch(data)         # wrap, no copy if possible
```

**Batch has no `__getitem__`** -- `batch[i]` raises `TypeError` because indexing is ambiguous (sample selection vs. per-sample slicing). Use the explicit APIs instead:

| Intent | Method | Returns |
|--------|--------|---------|
| Get sample i | `batch.tensors[i]` | `Tensor` |
| Get subset of samples | `batch.tensors[slice_or_list]` | `Batch` |
| Slice within each sample | `batch.slice[...]` | `Batch` (same batch_size) |
| Sample-wise slicing | `batch.slice[batch_of_indices]` | `Batch` (same batch_size) |

`.tensors[]` picks **which samples**. `.slice` indexes **inside each sample**.

```python
xy = ndd.random.uniform(batch_size=16, range=[0, 1], shape=2)
crop_x = xy.slice[0]       # Batch of 16 scalars, first element from each sample
crop_y = xy.slice[1]       # Batch of 16 scalars, second element from each sample
sample_0 = xy.tensors[0]   # Tensor, the entire first sample [x, y]
```

### Advanced slicing

The `.slice[]` API accepts batches of indices, allowing the user to mix and match batches and
scalar values, e.g.:
```python
imgs = ndd.imread(filenames)  # a batch of images, if `filenames` is a list
sliced = imgs.slice[
    42 :  # the range start is broadcast to all samples
    ndd.batch(imgs.shape).slice[0] // 2  # per-sample range stop (half of each image)
]
```

**PyTorch conversion:**
- `batch.torch()` -- works for uniform shapes; raises for ragged batches
- `batch.torch(pad=True)` -- zero-pads ragged batches to max shape (use for variable-length audio, detection boxes, etc.)
- `batch.torch(copy=None)` is the default (avoids copy if possible)
- Batch has **no `__dlpack__`** -- use `ndd.as_tensor(batch)` first for DLPack consumers. `ndd.as_tensor` supports `pad` as well.
- `Tensor.torch(copy=False)` is default (no copy)

**Iteration:** `for sample in batch:` yields Tensors.

## Readers

Readers are **stateful objects** -- create once, reuse across epochs. This matters because readers track internal state like shuffle order and shard position.

```python
reader = ndd.readers.File(file_root=image_dir, random_shuffle=True)

for epoch in range(num_epochs):
    for jpegs, labels in reader.next_epoch(batch_size=64):
        # jpegs, labels are Batch objects
        ...
```

Key points:
- Reader outputs (jpegs, labels, etc.) are **CPU** tensors/batches. Labels typically stay on CPU until you convert them for your framework (e.g. `labels.torch().to(device)`).
- Reader classes are **PascalCase**: `ndd.readers.File(...)`, `ndd.readers.COCO(...)`, `ndd.readers.TFRecord(...)`
- `batch_size` goes to `next_epoch()`, not to the reader constructor
- `next_epoch(batch_size=N)` yields tuples of `Batch`; `next_epoch()` without batch_size yields tuples of `Tensor`
- The iterator from `next_epoch()` must be fully consumed before calling `next_epoch()` again
- Once a reader is used with a given batch_size, it cannot be changed. Similarly, a reader used in batch mode cannot switch to sample mode or vice versa.

Sharded reading for distributed training:
```python
reader = ndd.readers.File(
    file_root=image_dir,
    shard_id=rank, num_shards=world_size,
    stick_to_shard=True,
    pad_last_batch=True,
)
```

## Device Handling

- Device is **inferred from inputs** -- GPU if any input is on GPU
- For hybrid decode: use `device="gpu"` (NOT `"mixed"`). The `"mixed"` keyword is a pipeline-mode concept for implicit CPU-to-GPU transfer; in dynamic mode, passing `device="gpu"` triggers the same hardware-accelerated decode path.
- Don't call `.cpu()` before passing to a GPU model -- `.torch()` gives you a GPU tensor directly. `.cpu()` is only needed for consumers requiring host memory (numpy, `__array__`).
- CUDA stream sync between DALI and PyTorch is **automatic via DLPack** -- no manual stream management needed.

## Execution Model

Default mode is `eager` -- async execution in a background thread, returns immediately.

**No `.evaluate()` needed in most cases.** Any data consumption (`.torch()`, `__dlpack__`, `__array__`, `.shape`, property access, iteration) triggers evaluation automatically.

For debugging, switch to synchronous mode so errors surface at the exact call site rather than later in the async queue:

```python
with ndd.EvalMode.sync_cpu:
    images = ndd.decoders.image(jpegs, device="gpu")
    images = ndd.resize(images, size=[224, 224])
    # Any error surfaces here, at the exact op that failed
```

Modes (increasing synchronicity): `deferred` < `eager` < `sync_cpu` < `sync_full`

Use `EvalMode.sync_full` for debugging instead of scattering `.evaluate()` calls -- it's cleaner and catches all issues at once. `sync_cpu` is often sufficient and lighter than `sync_full`.

## Thread Configuration

```python
ndd.set_num_threads(4)  # Call once at startup, only if necessary to override the defaults
```

Controls DALI's internal worker threads for CPU operators. Defaults to CPU affinity count or `DALI_NUM_THREADS` env var. Unrelated to Python-level threading.

## RNG

Two approaches (use one, not both):

```python
# Approach 1: set the thread-local default seed (simple, good enough for most cases)
ndd.random.set_seed(42)
angles = ndd.random.uniform(batch_size=64, range=(-30, 30))

# Approach 2: explicit RNG object (finer control, pass rng= to each op)
rng = ndd.random.RNG(seed=42)
values = ndd.random.uniform(batch_size=64, range=[0, 1], shape=2, rng=rng)
```

When `rng=` is passed to a random op, the explicit RNG overrides the default seed. Thread-local: each thread has independent random state.

Random ops need an explicit `batch_size` when working with batches -- there is no pipeline-level batch size to inherit.

## Checkpointing

Dynamic mode has **no pipeline-level checkpoint**. Checkpoints aggregate the state of individual stateful objects: readers and `RNG` instances. Stateless ops (decoders, resize, rotate, normalize, ...) are not part of a checkpoint.

```python
ckpt = ndd.checkpoint.Checkpoint()
ckpt.register(reader, "my_reader")
ckpt.register(rng, "rng")

# ... iterate for a while ...

ckpt.collect()                       # snapshot the registered objects
ckpt.save("ckpt_{seq:04d}.json")     # writes ckpt_0000.json, ckpt_0001.json, ...
```

Restoring is the symmetric operation -- build a *fresh* reader and `RNG`, then `load` + `register`. The loaded state is applied to each object at `register` time:

```python
reader = ndd.readers.File(file_root=..., enable_checkpointing=True, name="my_reader")
rng = ndd.random.RNG()

ckpt = ndd.checkpoint.Checkpoint()
ckpt.load("ckpt_{seq:04d}.json")     # picks the highest sequence number
ckpt.register(reader, "my_reader")   # state applied here
ckpt.register(rng, "rng")            # ditto

for batch in reader.next_epoch(batch_size=N):
    ...  # produces the next batch after the checkpointed iteration
```

Key rules:

- **Readers must opt in.** Construct with `enable_checkpointing=True`. Registering an already-iterated reader without it raises `RuntimeError`; if the reader has not been iterated yet, `register` enables it retroactively.
- **Reader state must be applied before the first `next_epoch` call.** The prefetch thread starts on first iteration and the snapshot queue is locked after that. `set_state` (or a `register` from a loaded checkpoint) on an already-iterated reader raises `RuntimeError`.
- **`enable_checkpointing=True` is incompatible with `compile=True`.** Calling `reader.next_epoch(..., compile=True)` on a checkpointing-enabled reader raises `NotImplementedError`.
- **Named registration is safer.** Anonymous `register(op)` uses sequential keys (`__op_0`, `__op_1`, ...) so the registration order must match between save and restore. Type tags catch cross-type swaps but not reorders of compatible types. Prefer `register(op, name)`.
- **`ndd.checkpoint.current()`** returns the `Checkpoint` bound to the current thread-local `EvalContext`. It's shared across calls -- call `ckpt.clear()` if reusing the default context for unrelated runs.
- **Filename pattern:** `save`/`load` take a Python format string with a single `{seq}` placeholder (e.g. `"ckpt_{seq:04d}.json"`). `save` picks the next free sequence; `load` picks the highest matching one on disk.
- **Format version is strict.** `deserialize` rejects payloads from a different checkpoint format version -- no automatic upgrade.
- **Not thread-safe.** One `Checkpoint` per thread.

Manual `get_state` / `set_state` is also available directly on each `Reader` and `RNG` -- the `Checkpoint` aggregator is built on top of it. Use the manual API only when integrating with an external checkpoint system.

## Examples

### Image Classification Pipeline

```python
import nvidia.dali.experimental.dynamic as ndd

reader = ndd.readers.File(file_root="/data/imagenet/train", random_shuffle=True)

for epoch in range(num_epochs):
    for jpegs, labels in reader.next_epoch(batch_size=64):
        images = ndd.decoders.image(jpegs, device="gpu")
        images = ndd.resize(images, size=[224, 224])
        images = ndd.crop_mirror_normalize(
            images,
            mean=[0.485 * 255, 0.456 * 255, 0.406 * 255],
            std=[0.229 * 255, 0.224 * 255, 0.225 * 255],
        )
        train_step(images.torch(), labels.torch())
```

## Common Mistakes

| Wrong | Right | Why |
|-------|-------|-----|
| `device="mixed"` | `device="gpu"` | `"mixed"` is pipeline mode only |
| `batch[i]` | `batch.tensors[i]` | `Batch` has no `__getitem__` |
| `batch.tensors[0]` for per-sample slicing | `batch.slice[0]` | `.tensors` pick samples; `.slice` slices within each sample |
| `.evaluate()` after every op | Let consumption trigger eval | `.torch()`, `.shape`, etc. trigger it automatically |
| `.cpu()` before GPU model | `.torch()` directly | Avoids wasteful D2H + H2D round-trip |
| Recreate reader each epoch | `reader.next_epoch()` | Readers are stateful -- create once, reuse |
| `ndd.readers.file(...)` | `ndd.readers.File(...)` | Reader classes are PascalCase |
| `break` from `next_epoch()` loop | Exhaust iterator or create new reader | Iterator must be fully consumed before next `next_epoch()` |
| No `batch_size` to random ops | `ndd.random.uniform(batch_size=N, ...)` | No pipeline-level batch size to inherit |
| `register(reader)` after first `next_epoch` to restore | Register the freshly built reader before the first iteration | Reader state can only be applied before the prefetch thread starts |
| Restoring into a reader built without `enable_checkpointing=True` after iteration | Pass `enable_checkpointing=True` at construction (or register before first iteration) | Backend doesn't keep snapshots otherwise |
| Spelling out default argument values | Skip default argument values | Very high Python-side overhead, especially when the argument accepts Tensors/Batches. Skipping arguments uses a fast path, actually passing a sentinel value. |

## Pipeline Mode Migration

| Pipeline Mode | Dynamic Mode |
|--------------|--------------|
| `@pipeline_def` / `pipe.build()` / `pipe.run()` | Direct function calls in a loop |
| `fn.readers.file(...)` | `ndd.readers.File(...)` (PascalCase, stateful) |
| `fn.decoders.image(jpegs, device="mixed")` | `ndd.decoders.image(jpegs, device="gpu")` |
| `fn.op_name(...)` | `ndd.op_name(...)` |
| Pipeline-level `batch_size=64` | `reader.next_epoch(batch_size=64)` + random ops `batch_size=64` |
| Pipeline-level `seed=42` | `ndd.random.set_seed(42)` or `ndd.random.RNG(seed=42)` |
| Pipeline-level `num_threads=4` | `ndd.set_num_threads(4)` at startup |
| `output.at(i)` | `batch.tensors[i]` |
| `output.as_cpu()` | `batch.cpu()` |
| `pipe.run()` returns tuple of `TensorList` | `reader.next_epoch(batch_size=N)` yields tuples of `Batch` |
| `Pipeline(..., enable_checkpointing=True)` + `pipe.checkpoint()` / `pipeline(checkpoint=...)` | `ndd.checkpoint.Checkpoint` + per-object `register` / `collect` / `save` / `load`; readers opt in with `enable_checkpointing=True` |

## Limitations

Dynamic mode is more flexible than pipeline mode, but can have slightly worse performance. For maximum throughput, prefer pipeline mode.

## Troubleshooting

- If errors surface later than the failing call, rerun the block under `EvalMode.sync_cpu` or `EvalMode.sync_full`.
- If a reader behaves unexpectedly across epochs, check that it is created once and each `next_epoch()` iterator is fully consumed.
