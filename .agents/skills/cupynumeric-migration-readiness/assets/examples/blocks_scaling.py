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
"""Idioms that block cuPyNumeric scaling.

This file illustrates BLOCKS-category patterns R101-R110 from
references/idioms-that-block.md (R111 — cuPyNumeric/CuPy mixing — is
covered in the reference but omitted here to keep the fixture
single-runtime). These are the anti-patterns to find and fix BEFORE a
migration; otherwise the cuPyNumeric run will be slower than the
NumPy original.
"""

import numpy as np

# R108: forbidden combination
try:
    import mpi4py  # noqa: F401
except ImportError:
    pass


def per_element_loop(arr: np.ndarray) -> np.ndarray:
    # R101: Python loop with array indexing
    n = len(arr)
    for i in range(n):
        arr[i] = arr[i] * 2.0 + 1.0
    return arr


def vectorize_anti_pattern(arr: np.ndarray) -> np.ndarray:
    # R102: np.vectorize is a Python loop in disguise
    f = np.vectorize(lambda x: x * x + 1.0 if x > 0 else 0.0)
    return f(arr)


def iterate_array(arr: np.ndarray) -> float:
    # R103: iteration over an ndarray
    total = 0.0
    for row in arr:
        total += float(np.sum(row))  # R104 too: float() on a reduction
    return total


def item_in_hot_loop(arr: np.ndarray, tol: float) -> int:
    # R104: .item() inside loop
    n = 0
    for _ in range(1000):
        s = np.sum(arr).item()
        if s < tol:
            n += 1
    return n


def convergence_every_iteration(u: np.ndarray, tol: float) -> np.ndarray:
    # R105: convergence check on every iteration (host sync)
    work = np.zeros_like(u)
    for _ in range(10_000):
        work[1:-1, 1:-1] = 0.25 * (
            u[:-2, 1:-1] + u[2:, 1:-1] + u[1:-1, :-2] + u[1:-1, 2:]
        )
        err = np.max(np.abs(u - work))
        if err < tol:
            break
        u, work = work, u
    return u


def strided_slicing(arr: np.ndarray) -> np.ndarray:
    # R106: non-unit step slicing
    return arr[::2] + arr[1::2]


def object_dtype(rows: list) -> np.ndarray:
    # R107: object-dtype creation
    return np.array(rows, dtype=object)


def fortran_order_reshape(arr: np.ndarray) -> np.ndarray:
    # R109: order= ignored in cuPyNumeric
    return arr.reshape((100, -1), order="F")


def python_min_max(arr: np.ndarray) -> float:
    # R110: Python builtins on arrays
    return float(min(arr)) + float(max(arr))
