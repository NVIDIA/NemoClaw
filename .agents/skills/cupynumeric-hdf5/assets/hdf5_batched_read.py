#!/usr/bin/env python
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
# http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
"""Stream a large HDF5 dataset in chunks with from_file_batched (multi-rank safe).

Each yielded chunk arrives with the offsets where it belongs in the global
shape, so the caller places it into a preallocated array.

The input file is created with Legate's collective ``to_file`` so that every
rank writes one consistent file. Legate runs this program on every rank (SPMD);
writing the fixture with per-rank ``h5py`` + ``tempfile`` would race (all ranks
writing) and use a different path on each rank. The path is fixed for the same
reason — every rank must agree on it.

Requires h5py in the conda environment (from_file_batched reads via h5py):
    conda install -c conda-forge h5py

Run (single rank):
    cd /tmp
    LEGATE_CONFIG="--cpus 4" LEGATE_AUTO_CONFIG=0 python hdf5_batched_read.py

Run (multi rank):
    cd /tmp
    legate --launcher mpirun --ranks-per-node 2 --cpus 2 --gpus 0 hdf5_batched_read.py
    # On GPUs, give each rank its own with --gpus 1 (avoids framebuffer contention).
"""

from __future__ import annotations

import math
from pathlib import Path

import cupynumeric as cn
from legate.core import get_legate_runtime
from legate.io.hdf5 import from_file_batched, to_file

# Fixed path: identical on every rank (never tempfile.mkstemp() under SPMD).
PATH = "hdf5_batched_demo.h5"


def main() -> None:
    runtime = get_legate_runtime()
    try:
        shape = (10, 10)
        src = cn.arange(math.prod(shape), dtype=cn.float32).reshape(shape)

        # Collective, multi-rank-safe creation of the on-disk dataset.
        to_file(array=src, path=PATH, dataset_name="data")
        runtime.issue_execution_fence(block=True)

        out = cn.empty(shape, dtype=cn.float32)
        chunk_size = (4, 4)
        for chunk, offsets in from_file_batched(PATH, "data", chunk_size):
            r0, c0 = offsets
            r1, c1 = r0 + chunk.shape[0], c0 + chunk.shape[1]
            out[r0:r1, c0:c1] = cn.asarray(chunk)

        runtime.issue_execution_fence(block=True)
        assert cn.array_equal(out, src), "round trip mismatch"
        print("HDF5 BATCHED READ OK")
    finally:
        runtime.issue_execution_fence(block=True)
        if runtime.node_id == 0:
            Path(PATH).unlink(missing_ok=True)


if __name__ == "__main__":
    main()
