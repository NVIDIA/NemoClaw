# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
#

# Parallel sharded .npy loader -> cupynumeric array.
#
# Audience for these comments. The block comments throughout this file
# document the example for *human readers* (the user reading the
# skill's reference implementation, and contributors maintaining it) —
# they describe the runtime model, the DLPack vs __array_interface__
# split between variants, and the layout assumptions. The companion
# SKILL.md is the surface the agent reads first; this script is its
# worked, runnable example.
#
# Three subcommands plus a no-subcommand "demo" mode that runs all three
# in sequence (write -> read -> clean) against a temp directory. The
# demo mode exists so the example is runnable as a smoke test by the
# cupynumeric examples test harness (which invokes every example with
# no required args, plus harmless pytest-style flags like
# `-p no:faulthandler` that this script silently drops).
#
# Subcommands, run as separate invocations for the real two-phase
# workflow:
#
#   write   - generate NUM_SHARDS .npy files plus a small optional
#             _meta.json (only used to remember the RNG seed for later
#             verification). Pure NumPy + filesystem; no Legate task
#             launches. On multi-node runs this is gated to rank 0, so the
#             files are only ever written once. SHARD_DIR must point at a
#             path visible to every rank (shared filesystem) for the
#             subsequent read.
#
#   read    - scan SHARD_DIR for shard_*.npy files, infer num_shards /
#             shard_shape / dtype by peeking at the .npy headers, allocate
#             `cn.empty(total_shape)` along axis 0, and launch a Legate
#             Python task that reads the shards into the destination in
#             parallel. The driver builds a LogicalStorePartition with
#             tile shape == shard_shape -- one tile per file -- and
#             dispatches num_shards task points via
#             runtime.create_manual_task. Each task therefore sees a tile
#             that is exactly one shard and reads exactly one file with no
#             overlap math. Works for any per-shard rank (1D, 2D, N-D);
#             only axis 0 is sharded across tasks. No divisibility
#             constraint between num_shards and the processor count.
#
#             The leaf task registers CPU / OMP / GPU variants, so the
#             read phase runs unchanged on any Legate machine: GPU
#             nodes consume the OutputStore via cupy DLPack and a
#             cudaMemcpyAsync H2D; CPU / OMP nodes consume the
#             OutputStore via np.asarray (zero-copy numpy view of the
#             sysmem-resident tile) and a numpy write.
#
#             The read phase needs no command-line parameters beyond
#             --shard-dir, and it works on shards produced by anything
#             (not just this script's `write` subcommand) as long as they
#             follow the shard_NNNN.npy convention.
#
# The two phases are deliberately split so that one shard generation can
# feed many `read` runs at different scales without re-doing the I/O.
#
# This script lives next to the SKILL.md it documents, at
# skills/cupynumeric-parallel-data-load/assets/examples/parallel_npy_load.py
# (referred to below as $EX for brevity).
#
# Run (single-node, end-to-end demo with all defaults, GPU):
#   legate --cpus 1 --gpus 4 --fbmem 4000 --min-gpu-chunk 1 $EX
#
# Run (single-node, end-to-end demo on CPU only):
#   legate --cpus 4 --sysmem 4000 $EX
#
# Run (single-node, two-phase explicit):
#   legate --cpus 1 $EX write
#   legate --cpus 1 --gpus 4 --fbmem 4000 --min-gpu-chunk 1 $EX read
#
# Run (multi-node, e.g. 2 nodes x 4 GPUs, shared filesystem at SHARD_DIR):
#   legate --nodes 2 --launcher srun --cpus 1 $EX \
#       write --shard-dir /shared/scratch/demo
#   legate --nodes 2 --launcher srun --gpus 4 --fbmem 4000 --min-gpu-chunk 1 \
#       $EX read --shard-dir /shared/scratch/demo

import argparse
import bisect
import json
import shutil
import sys
import tempfile
from pathlib import Path

import numpy as np

# cupy is imported lazily inside the GPU branch of the leaf task so
# that this script runs on CPU-only / OMP-only machines where cupy is
# not installed. The CPU / OMP variants consume the OutputStore via
# np.asarray instead of cupy.from_dlpack, so cupy is never imported
# on those code paths.
import cupynumeric as cn
from legate.core import (
    TaskContext,
    TaskTarget,
    VariantCode,
    get_legate_runtime,
)
from legate.core.data_interface import as_logical_array
from legate.core.task import OutputStore, task


DEFAULT_SHARD_DIR = (
    Path(tempfile.gettempdir()) / "cupynumeric_parallel_npy_demo"
)
META_NAME = "_meta.json"

# Defaults for the `write` subcommand. The `read` subcommand discovers the
# actual values from the filesystem and ignores these.
#
# The destination cupynumeric array has shape DEFAULT_TOTAL_SHAPE; the
# `write` subcommand splits axis 0 into DEFAULT_NUM_SHARDS shards with
# *non-uniform* row counts (deterministically derived from --seed), so
# the reference example exercises the heterogeneous-shard recipe in
# SKILL.md by default.
DEFAULT_NUM_SHARDS = 4
DEFAULT_TOTAL_SHAPE: tuple[int, ...] = (4_000_000, 8)
DEFAULT_DTYPE = "float32"
DEFAULT_SEED = 0


def _parse_shape(s: str) -> tuple[int, ...]:
    # argparse type: parse "ROWS,..." into a tuple of positive ints.
    # Axis 0 is the sharded axis (rows per shard); trailing axes are
    # the inner shape of each shard (cols, channels, etc.).
    parts = [p.strip() for p in s.split(",") if p.strip()]
    if not parts:
        raise argparse.ArgumentTypeError(f"empty shape: {s!r}")
    try:
        dims = tuple(int(p) for p in parts)
    except ValueError as e:
        raise argparse.ArgumentTypeError(
            f"shape components must be ints, got {s!r}"
        ) from e
    if any(d <= 0 for d in dims):
        raise argparse.ArgumentTypeError(
            f"shape components must be positive, got {dims}"
        )
    return dims


# Populated by the `read` driver from discover_layout() before launching
# the task. Control replication runs main() on every rank against the
# same shard directory, so every rank sets these to identical values.
#
#   _PATHS:     ordered list of shard files (length num_shards)
#   _CUM_ROWS:  cumulative axis-0 row offsets, length num_shards + 1,
#               with _CUM_ROWS[0] = 0 and _CUM_ROWS[-1] = total_rows
#   _TILE_ROWS: axis-0 tile size used by the partition; matches
#               view.shape[0] for every task except possibly the last
_PATHS: list[Path] = []
_CUM_ROWS: list[int] = [0]
_TILE_ROWS: int = 0


def _node_id() -> int:
    return get_legate_runtime().node_id


SHARD_GLOB = "shard_*.npy"


def plan_shard_rows(total_rows: int, num_shards: int, seed: int) -> list[int]:
    # Deterministically partition `total_rows` along axis 0 into
    # `num_shards` *non-uniform* contiguous chunks of size >= 1. The
    # heterogeneous schedule is the entire point of this example -- it
    # exercises the cum_rows + bisect path inside load_tile.
    if num_shards <= 0:
        raise ValueError(f"num_shards must be > 0, got {num_shards}")
    if total_rows < num_shards:
        raise ValueError(
            f"total_rows ({total_rows}) must be >= num_shards "
            f"({num_shards}) so every shard has at least 1 row"
        )
    if num_shards == 1:
        return [total_rows]
    rng = np.random.default_rng(seed=seed)
    # Choose num_shards - 1 distinct internal split points in
    # [1, total_rows - 1] (sorted). Boundary[0] = 0, boundary[-1] = total_rows.
    splits = np.sort(
        rng.choice(total_rows - 1, size=num_shards - 1, replace=False) + 1
    ).tolist()
    boundaries = [0] + splits + [total_rows]
    return [int(boundaries[i + 1] - boundaries[i]) for i in range(num_shards)]


def build_reference(
    seed: int, total_shape: tuple[int, ...], dtype: str
) -> np.ndarray:
    # Pure numpy, deterministic. Used by `write` to populate the shards,
    # and (optionally) by `read` to verify the loaded array. The
    # destination array has shape `total_shape`; axis 0 is the sharded
    # axis (split by plan_shard_rows in `write`), trailing axes ride
    # along unchanged.
    rng = np.random.default_rng(seed=seed)
    return rng.standard_normal(tuple(total_shape), dtype=np.dtype(dtype))


def save_shards(
    reference: np.ndarray,
    shard_dir: Path,
    per_shard_rows: list[int],
    seed: int,
) -> None:
    shard_dir.mkdir(parents=True, exist_ok=True)

    # Re-runnability: scrub any stale shard_*.npy / _meta.json from a
    # previous `write` call before laying down the new set. Without
    # this, re-running with fewer shards (or a different shape /
    # dtype) leaves the old files behind, and `read` would then pick
    # up a mixed-generation directory and either reject the layout
    # (mismatched dtype/trailing shape) or silently include the stale
    # tail (same dtype/trailing shape, different content).
    stale = sorted(shard_dir.glob(SHARD_GLOB))
    meta_path = shard_dir / META_NAME
    if stale or meta_path.exists():
        print(
            f"  scrubbing {len(stale)} stale shard file(s)"
            + (f" + {META_NAME}" if meta_path.exists() else "")
            + f" from {shard_dir}"
        )
        for p in stale:
            p.unlink()
        if meta_path.exists():
            meta_path.unlink()

    if sum(per_shard_rows) != reference.shape[0]:
        raise ValueError(
            f"per_shard_rows sum ({sum(per_shard_rows)}) does not match "
            f"reference axis 0 ({reference.shape[0]})"
        )

    cum = 0
    for i, rows in enumerate(per_shard_rows):
        shard = reference[cum : cum + rows]
        path = shard_dir / f"shard_{i:04d}.npy"
        np.save(path, shard)
        print(
            f"  wrote {path.name}: shape={shard.shape}, "
            f"first_row_sum={float(shard[0].sum()):+.4f}"
        )
        cum += rows
    meta = {
        "seed": seed,
        "num_shards": len(per_shard_rows),
        "per_shard_rows": list(per_shard_rows),
        "trailing_shape": list(reference.shape[1:]),
        "dtype": str(reference.dtype),
    }
    (shard_dir / META_NAME).write_text(json.dumps(meta, indent=2))
    print(f"  wrote {META_NAME}: {meta}")


def discover_layout(shard_dir: Path) -> dict:
    # Scan SHARD_DIR for shard_NNNN.npy files and recover the layout by
    # peeking at the .npy headers (mmap_mode="r" reads only the header,
    # not the data). Per-shard row counts (axis 0) may differ across
    # files; only `dtype` and trailing axes (`shape[1:]`) must match.
    # The folder is the source of truth; the optional _meta.json is
    # only consulted for the verification seed.
    if not shard_dir.is_dir():
        raise FileNotFoundError(
            f"{shard_dir} does not exist. Run the `write` subcommand first, "
            f"or point --shard-dir at a directory containing {SHARD_GLOB} "
            f"files."
        )
    paths = sorted(shard_dir.glob(SHARD_GLOB))
    if not paths:
        raise FileNotFoundError(f"No {SHARD_GLOB} files found in {shard_dir}.")

    per_file_rows: list[int] = []
    trailing_shape: tuple[int, ...] | None = None
    dtype: np.dtype | None = None
    for p in paths:
        a = np.load(p, mmap_mode="r")
        if a.ndim < 1:
            raise RuntimeError(
                f"{p.name}: scalar array (ndim=0); expected at least 1D."
            )
        if trailing_shape is None:
            trailing_shape = tuple(int(x) for x in a.shape[1:])
            dtype = a.dtype
        else:
            cur_trailing = tuple(int(x) for x in a.shape[1:])
            if cur_trailing != trailing_shape or a.dtype != dtype:
                raise RuntimeError(
                    f"{p.name}: trailing shape / dtype mismatch — "
                    f"expected trailing={trailing_shape} dtype={dtype}, "
                    f"got trailing={cur_trailing} dtype={a.dtype}. "
                    "All shards must share dtype and shape[1:] (axis 0 "
                    "may vary across files)."
                )
        per_file_rows.append(int(a.shape[0]))

    # Sanity-check: filenames must form the contiguous sequence
    # shard_0000.npy, shard_0001.npy, ... so that load_tile(t) can
    # index them by integer when bisecting cum_rows.
    num_shards = len(paths)
    expected = [shard_dir / f"shard_{i:04d}.npy" for i in range(num_shards)]
    missing = [p.name for p in expected if p not in paths]
    if missing:
        raise RuntimeError(
            f"Expected a contiguous shard_NNNN.npy sequence in {shard_dir}; "
            f"missing: {missing[:5]}"
            + (f" (... +{len(missing) - 5} more)" if len(missing) > 5 else "")
        )

    cum_rows = [0]
    for r in per_file_rows:
        cum_rows.append(cum_rows[-1] + r)

    assert trailing_shape is not None
    assert dtype is not None

    return {
        "paths": paths,
        "per_file_rows": per_file_rows,
        "cum_rows": cum_rows,
        "total_rows": cum_rows[-1],
        "trailing_shape": trailing_shape,
        "dtype": str(dtype),
    }


def load_seed_if_present(shard_dir: Path) -> int | None:
    # _meta.json is purely optional. We only use it to recover the seed
    # for verification; layout always comes from discover_layout().
    meta_path = shard_dir / META_NAME
    if not meta_path.exists():
        return None
    try:
        meta = json.loads(meta_path.read_text())
        return int(meta["seed"])
    except (json.JSONDecodeError, KeyError, TypeError, ValueError):
        return None


# The parallel reader task. CPU / OMP / GPU variants.
#
# Launch model: manual partition + manual launch, sized to the
# *machine*, not the file count. The driver picks
#   tile_rows = ceil(total_rows / num_processors)
# and partitions axis 0 of `out` by `(tile_rows,) + trailing_shape`.
# This produces ceil(total_rows / tile_rows) tiles -- the last is
# allowed to be short (partition_by_tiling supports it). The launch
# domain is sized to that exact tile count, so partition and launch
# always agree.
#
# Each task body:
#   1. Builds the consumer view (cupy on GPU, numpy on CPU/OMP),
#      reads the tile's actual row count from view.shape[0]
#      (PhysicalStore itself has no .shape), and computes its global
#      axis-0 row range [row_start, row_end) from the launch
#      coordinate (task_index[0]) and that row count.
#      view.shape[0] is _TILE_ROWS for every task except possibly the
#      last, which may be short.
#   2. Bisects _CUM_ROWS to find the first/last file overlapping that
#      row range -- the inner loop typically iterates 1-2 times since
#      tiles usually live in or straddle at most two files.
#   3. For each overlapping file, reads only the slice that intersects
#      the tile (np.load mmap then numpy slice) and copies it into the
#      matching slice of the destination view.
#
# DLPack / __array_interface__ consumers. PhysicalStore exposes both
# producers and the right one depends on where the store is resident:
#
#   * GPU variant -> store is FBMEM-resident. `cp.from_dlpack(dst)`
#     gives a zero-copy cupy.ndarray view of the local tile;
#     `view[lo:hi].set(host_np)` is a single cudaMemcpyAsync H2D into
#     the slice.
#   * CPU / OMP variants -> store is SYSMEM-resident. `np.asarray(dst)`
#     gives a zero-copy numpy view of the local tile via
#     `PhysicalStore.__array_interface__`; assigning into the slice
#     writes directly into the store's buffer.
#
# We deliberately do NOT use `cn.asarray(dst)` in any variant -- it
# tries to register a fresh cupynumeric logical store, and any
# cupynumeric runtime call from inside a leaf task is rejected by
# Legion as an Invalid task context. The same restriction applies to
# slice assignment into a cupynumeric view (`cn_dst[s] = ...`). The
# inline-task examples (examples/inline_task/test_*.py) can use
# cn.asarray because they run in the top-level runtime context, not
# as leaf tasks.
#
# The task reads _PATHS, _CUM_ROWS, and _TILE_ROWS from module
# globals. The driver populates them from discover_layout() before
# launching, and because Legate control-replicates the driver on every
# rank against the same shard directory, every rank's worker sees
# identical values.
#
# Three variants are registered so this example runs unchanged on any
# Legate machine -- CPU-only nodes, OpenMP-only nodes, and GPU nodes.
# cupy is imported lazily inside the GPU branch only -- that keeps the
# example loadable on machines without cupy installed.
@task(variants=(VariantCode.CPU, VariantCode.OMP, VariantCode.GPU))
def load_tile(ctx: TaskContext, dst: OutputStore) -> None:
    t = ctx.task_index[0]
    num_tasks = ctx.launch_domain.hi[0] + 1

    # Build the consumer view first. PhysicalStore itself has no .shape
    # attribute, so we read the tile's actual row count off the view
    # (numpy.ndarray.shape / cupy.ndarray.shape) below.
    variant = ctx.get_variant_kind()
    if variant == VariantCode.GPU:
        import cupy as cp

        view = cp.from_dlpack(dst)
        where = f"on device {view.device}"
    else:
        # CPU / OMP: SYSMEM-resident store. np.asarray() consumes
        # PhysicalStore.__array_interface__ and gives a zero-copy numpy
        # view of the local tile; assigning into a slice of the view
        # writes directly into the store's buffer.
        view = np.asarray(dst)
        where = "on host (sysmem)"

    tile_rows_actual = view.shape[0]  # short on the last tile
    row_start = t * _TILE_ROWS
    row_end = row_start + tile_rows_actual

    # Find the half-open file index range [first_file, last_file] that
    # overlaps [row_start, row_end). bisect_right(cum, k) - 1 returns
    # the file whose [cum[i], cum[i+1]) range covers row k.
    first_file = bisect.bisect_right(_CUM_ROWS, row_start) - 1
    last_file = bisect.bisect_right(_CUM_ROWS, row_end - 1) - 1

    files_touched: list[str] = []
    for f in range(first_file, last_file + 1):
        # Intersect tile [row_start, row_end) with file [cum[f], cum[f+1]).
        lo = max(row_start, _CUM_ROWS[f])
        hi = min(row_end, _CUM_ROWS[f + 1])
        file_lo = lo - _CUM_ROWS[f]
        file_hi = hi - _CUM_ROWS[f]
        dst_lo = lo - row_start
        dst_hi = hi - row_start
        # mmap'd host view; np.ascontiguousarray is needed because
        # cupy.ndarray.set() and the numpy write below want a
        # C-contiguous source, and mmap slices are not always
        # contiguous on file-stride boundaries.
        chunk = np.ascontiguousarray(
            np.load(_PATHS[f], mmap_mode="r")[file_lo:file_hi]
        )
        if variant == VariantCode.GPU:
            view[dst_lo:dst_hi].set(chunk)  # cudaMemcpyAsync H2D
        else:
            view[dst_lo:dst_hi] = chunk
        files_touched.append(
            f"{_PATHS[f].name}[{file_lo}:{file_hi}]->dst[{dst_lo}:{dst_hi}]"
        )

    print(
        f"  task {t}/{num_tasks}: rows [{row_start}:{row_end}) "
        f"({tile_rows_actual} of tile_rows={_TILE_ROWS}) "
        f"{where} [{variant.name} variant]; "
        f"files: {', '.join(files_touched)}"
    )


def write_phase(args: argparse.Namespace) -> None:
    rank = _node_id()
    if rank != 0:
        # Other ranks just no-op; the next collective op in the surrounding
        # workflow (or simply program exit) is the barrier point.
        print(f"[rank {rank}] write phase: skipped (rank 0 owns the I/O)")
        return

    total_shape = tuple(args.shape)
    total_rows = total_shape[0]
    trailing_shape = total_shape[1:]
    per_shard_rows = plan_shard_rows(total_rows, args.num_shards, args.seed)
    print(
        f"[rank 0] writing {args.num_shards} shards to {args.shard_dir} "
        f"(seed={args.seed}, total_shape={total_shape} "
        f"-> per-shard rows={per_shard_rows} (sum={sum(per_shard_rows)}), "
        f"trailing={trailing_shape}, dtype={args.dtype}) ..."
    )
    reference = build_reference(args.seed, total_shape, args.dtype)
    save_shards(reference, args.shard_dir, per_shard_rows, args.seed)
    print("[rank 0] write phase complete.")


def read_phase(args: argparse.Namespace) -> None:
    global _PATHS, _CUM_ROWS, _TILE_ROWS

    rank = _node_id()
    if rank == 0:
        # Print the layout the loader is going to insist on, before
        # discover_layout() has a chance to reject the directory. If
        # the user's data doesn't match (e.g. different naming
        # convention, mismatched dtype/trailing axes), this is the
        # line that tells them what to bring instead.
        print(
            "[rank 0] read phase: expecting shard_NNNN.npy files (NNNN = "
            "0,1,...) in --shard-dir; per-file row counts may differ but "
            "all shards must share dtype and shape[1:]; directory must "
            "be visible to every rank."
        )
    layout = discover_layout(args.shard_dir)
    paths = layout["paths"]
    per_file_rows = layout["per_file_rows"]
    cum_rows = layout["cum_rows"]
    total_rows = layout["total_rows"]
    trailing_shape: tuple[int, ...] = layout["trailing_shape"]
    dtype = np.dtype(layout["dtype"])
    num_shards = len(paths)

    # Verification seed precedence: --seed CLI > _meta.json > skip.
    seed: int | None
    if args.seed is not None:
        seed = args.seed
    else:
        seed = load_seed_if_present(args.shard_dir)
    can_verify = args.verify and seed is not None

    total_shape = (total_rows,) + trailing_shape
    if rank == 0:
        # Per-shard row counts can be long; show the first few and a sum.
        head_rows = per_file_rows[:8]
        tail_note = f", ... (+{num_shards - 8} more)" if num_shards > 8 else ""
        print(
            f"[rank 0] discovered {num_shards} shards in {args.shard_dir}: "
            f"per_file_rows={head_rows}{tail_note} sum={total_rows}, "
            f"trailing_shape={trailing_shape}, dtype={dtype}"
        )
        print(
            f"[rank 0] allocating cn.empty({total_shape}, dtype={dtype}) "
            f"(~{np.prod(total_shape) * dtype.itemsize / 1e6:.1f} MB)"
        )
    out = cn.empty(total_shape, dtype=dtype)

    runtime = get_legate_runtime()
    machine = runtime.get_machine()
    n_gpus = machine.count(TaskTarget.GPU)
    n_omps = machine.count(TaskTarget.OMP)
    n_cpus = machine.count(TaskTarget.CPU)
    # Drive `tile_rows` from whichever target kind has the most processors
    # available; falls back to 1 on machines that report none of the
    # three (so the launch still executes a single task).
    num_processors = max(n_gpus, n_omps, n_cpus, 1)

    tile_rows = max(1, (total_rows + num_processors - 1) // num_processors)
    num_tasks = (total_rows + tile_rows - 1) // tile_rows
    tile_shape = (tile_rows,) + trailing_shape

    # Populate the module globals the leaf task reads. Control
    # replication runs read_phase() on every rank against the same
    # discovered layout, so every rank sets these to identical values.
    _PATHS = paths
    _CUM_ROWS = cum_rows
    _TILE_ROWS = tile_rows

    if rank == 0:
        proc_summary = (
            ", ".join(
                f"{n} {kind}"
                for n, kind in (
                    (n_gpus, "GPU(s)"),
                    (n_omps, "OMP proc(s)"),
                    (n_cpus, "CPU(s)"),
                )
                if n > 0
            )
            or "no processors?"
        )
        print(
            f"[rank 0] tile_rows={tile_rows} (total_rows={total_rows} / "
            f"num_processors={num_processors}, ceil); "
            f"launch={num_tasks} task points across {proc_summary} "
            f"(processor-count-driven, tiles may span >=1 file each) ..."
        )
    partition = as_logical_array(out).data.partition_by_tiling(tile_shape)
    manual_task = runtime.create_manual_task(
        load_tile.library,
        load_tile.task_id,
        (num_tasks,),  # launch domain == partition tile count
    )
    manual_task.add_output(partition)
    manual_task.execute()

    runtime.issue_execution_fence(block=True)

    if rank == 0:
        print(f"[rank 0] out.shape = {out.shape}, out.dtype = {out.dtype}")

    if can_verify:
        assert seed is not None
        reference = build_reference(seed, total_shape, str(dtype))
        ref_cn = cn.asarray(reference)
        ok = bool(cn.array_equal(out, ref_cn))
        if rank == 0:
            print(
                f"[rank 0] verification (seed={seed}): "
                f"{'pass' if ok else 'FAIL'}"
            )
        assert ok, "loaded array did not match reference"
    elif rank == 0:
        if not args.verify:
            print("[rank 0] verification: skipped (--no-verify)")
        else:
            print(
                "[rank 0] verification: skipped (no seed available; pass "
                "--seed N or include _meta.json in the shard dir)"
            )


def cleanup_phase(args: argparse.Namespace) -> None:
    rank = _node_id()
    if rank != 0:
        return
    if args.shard_dir.exists():
        shutil.rmtree(args.shard_dir, ignore_errors=True)
        print(f"[rank 0] removed {args.shard_dir}")


def demo_phase() -> None:
    # No-subcommand mode: end-to-end smoke test against a temp dir,
    # using the same defaults the `write` subcommand would use. Exists
    # so the script is runnable with no args (which is what the
    # cupynumeric examples test harness does). Works on any Legate
    # machine -- CPU / OMP / GPU -- because load_tile registers a
    # variant for each. Per-shard row counts are non-uniform (driven
    # by plan_shard_rows + DEFAULT_SEED), so the demo also exercises
    # the cum_rows + bisect path inside the leaf task.
    rank = _node_id()
    shard_dir = DEFAULT_SHARD_DIR
    if rank == 0:
        print(
            "[rank 0] no subcommand given; running end-to-end demo "
            f"(write -> read -> clean) in {shard_dir}"
        )

    write_args = argparse.Namespace(
        shard_dir=shard_dir,
        num_shards=DEFAULT_NUM_SHARDS,
        shape=DEFAULT_TOTAL_SHAPE,
        dtype=DEFAULT_DTYPE,
        seed=DEFAULT_SEED,
    )
    read_args = argparse.Namespace(
        shard_dir=shard_dir, seed=DEFAULT_SEED, verify=True
    )
    cleanup_args = argparse.Namespace(shard_dir=shard_dir)

    write_phase(write_args)
    read_phase(read_args)
    cleanup_phase(cleanup_args)


SUBCOMMANDS = ("write", "read", "clean")


_LAYOUT_NOTE = (
    "Layout assumed by both `write` and `read`: a directory containing "
    "files named shard_0000.npy, shard_0001.npy, ... in a contiguous "
    "integer sequence (zero-padded width 4); all shards share dtype "
    "and shape[1:] (axis-0 row counts may differ across files); "
    "SHARD_DIR is visible to every rank (shared filesystem for "
    "multi-node runs). `read` rejects the directory if any of these "
    "are violated."
)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Parallel sharded .npy loader for cupynumeric. Run with no "
            "subcommand to do an end-to-end demo on defaults, or use "
            "`write` once to generate the shards followed by any number "
            "of `read` invocations at different scales. " + _LAYOUT_NOTE
        )
    )
    sub = parser.add_subparsers(dest="cmd", required=False)

    w = sub.add_parser(
        "write",
        help=(
            "Generate the .npy shard files (and a small optional _meta.json "
            "remembering the seed). Multi-node: only rank 0 writes; "
            "SHARD_DIR must be on a shared filesystem for later `read` "
            "invocations. Re-running the `write` subcommand scrubs any "
            "stale shard_*.npy / _meta.json from SHARD_DIR before laying "
            "down the new set, so changing --num-shards / --shape / --dtype "
            "across runs is safe. " + _LAYOUT_NOTE
        ),
    )
    w.add_argument("--shard-dir", type=Path, default=DEFAULT_SHARD_DIR)
    w.add_argument("--num-shards", type=int, default=DEFAULT_NUM_SHARDS)
    w.add_argument(
        "--shape",
        type=_parse_shape,
        default=DEFAULT_TOTAL_SHAPE,
        metavar="TOTAL_ROWS,...",
        help=(
            "Comma-separated *total* destination shape (the cupynumeric "
            "array's shape, NOT the per-shard shape). Axis 0 is the total "
            "row count across all shards; trailing axes are the inner "
            "shape inherited by every shard. The `write` subcommand "
            "splits axis 0 into --num-shards non-uniform contiguous "
            "chunks (deterministic given --seed). Examples: "
            "'4000000,8' (2D), '16384,3,224,224' (4D), '4000000' (1D). "
            f"Default: {','.join(map(str, DEFAULT_TOTAL_SHAPE))}."
        ),
    )
    w.add_argument("--dtype", default=DEFAULT_DTYPE)
    w.add_argument("--seed", type=int, default=DEFAULT_SEED)

    r = sub.add_parser(
        "read",
        help=(
            "Scan SHARD_DIR, infer the layout from the .npy headers, and "
            "load the shards in parallel into a cupynumeric array via a "
            "Legate Python task. " + _LAYOUT_NOTE
        ),
    )
    r.add_argument("--shard-dir", type=Path, default=DEFAULT_SHARD_DIR)
    r.add_argument(
        "--seed",
        type=int,
        default=None,
        help=(
            "RNG seed to use when reconstructing the reference array for "
            "verification. Overrides the seed stored in _meta.json. If "
            "neither is supplied, verification is skipped."
        ),
    )
    r.add_argument(
        "--no-verify",
        dest="verify",
        action="store_false",
        help="Skip the deterministic-RNG verification of the loaded array.",
    )
    r.set_defaults(verify=True)

    c = sub.add_parser(
        "clean", help="Remove SHARD_DIR (rank 0 only). Convenience helper."
    )
    c.add_argument("--shard-dir", type=Path, default=DEFAULT_SHARD_DIR)

    return parser


def main() -> None:
    # Scan argv for a known subcommand. Anything before it -- typically
    # pytest-style flags like `-p no:faulthandler` injected by the
    # cupynumeric examples test harness -- is silently dropped. With no
    # subcommand at all, fall through to the end-to-end demo.
    argv = sys.argv[1:]
    cmd_idx = next((i for i, a in enumerate(argv) if a in SUBCOMMANDS), None)
    if cmd_idx is None:
        if argv and _node_id() == 0:
            print(
                f"[rank 0] ignoring unrecognized args: {argv}", file=sys.stderr
            )
        demo_phase()
        return

    if cmd_idx > 0 and _node_id() == 0:
        dropped = argv[:cmd_idx]
        print(
            f"[rank 0] ignoring unrecognized args before subcommand: {dropped}",
            file=sys.stderr,
        )

    args = build_parser().parse_args(argv[cmd_idx:])
    if args.cmd == "write":
        write_phase(args)
    elif args.cmd == "read":
        read_phase(args)
    elif args.cmd == "clean":
        cleanup_phase(args)
    else:
        raise ValueError(f"unknown subcommand: {args.cmd}")


if __name__ == "__main__":
    main()
