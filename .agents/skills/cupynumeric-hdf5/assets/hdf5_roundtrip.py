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
"""End-to-end round trip: cupynumeric ndarray <-> HDF5 (multi-rank safe).

Legate runs this program on every rank (SPMD), so the file path must be the
same on all ranks. We use a fixed, shared path on purpose: a per-rank
``tempfile.mkstemp()`` name would differ on each rank and break the collective
``to_file`` / ``from_file``. ``to_file`` and ``from_file`` are themselves
collective, so call them on every rank with identical arguments.

With GPUDirect Storage enabled, reads/writes go directly between GPU memory and
disk (always set this when reading into GPU memory):

    LEGATE_IO_USE_VFD_GDS=1 legate --gpus 1 hdf5_roundtrip.py

Requires h5py in the conda environment:
    conda install -c conda-forge h5py

Run (single rank):
    cd /tmp
    LEGATE_CONFIG="--cpus 4" LEGATE_AUTO_CONFIG=0 python hdf5_roundtrip.py

Run (multi rank):
    cd /tmp
    legate --launcher mpirun --ranks-per-node 2 --cpus 2 --gpus 0 hdf5_roundtrip.py
    # On GPUs, give each rank its own with --gpus 1 (avoids framebuffer contention).
"""

from __future__ import annotations

from pathlib import Path

import cupynumeric as cn
from legate.core import get_legate_runtime
from legate.io.hdf5 import from_file, to_file

# Fixed path: identical on every rank (never tempfile.mkstemp() under SPMD).
PATH = "hdf5_roundtrip_demo.h5"


def main() -> None:
    runtime = get_legate_runtime()
    try:
        a = cn.arange(64, dtype=cn.float32).reshape(8, 8)

        to_file(array=a, path=PATH, dataset_name="/data")
        runtime.issue_execution_fence(block=True)

        b = cn.asarray(from_file(PATH, dataset_name="/data"))

        assert cn.array_equal(a, b), "round trip mismatch"
        print("HDF5 ROUND TRIP OK")
    finally:
        # Barrier so every rank's read finishes before the shared file is
        # removed, then let a single rank delete it.
        runtime.issue_execution_fence(block=True)
        if runtime.node_id == 0:
            Path(PATH).unlink(missing_ok=True)


if __name__ == "__main__":
    main()
