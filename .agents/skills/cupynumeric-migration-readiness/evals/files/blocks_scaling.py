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
import numpy as np
from mpi4py import MPI


def distributed_reduce(data: np.ndarray) -> float:
    comm = MPI.COMM_WORLD
    rank = comm.Get_rank()
    size = comm.Get_size()

    local_n = data.shape[0] // size
    local_chunk = np.zeros(local_n, dtype=data.dtype)
    comm.Scatter(data, local_chunk, root=0)

    partial = np.array(local_chunk.sum())
    total = np.zeros_like(partial)
    comm.Allreduce(partial, total, op=MPI.SUM)
    if rank == 0:
        return float(total)
    return float(total)


def per_element_loop(arr: np.ndarray) -> np.ndarray:
    n = len(arr)
    for i in range(n):
        arr[i] = arr[i] * 2.0 + 1.0
    return arr


def apply_vectorize(arr: np.ndarray) -> np.ndarray:
    f = np.vectorize(lambda x: x * x + 1.0 if x > 0 else 0.0)
    return f(arr)


def iterate_array(arr: np.ndarray) -> float:
    total = 0.0
    for row in arr:
        total += float(np.sum(row))
    return total


def item_in_hot_loop(arr: np.ndarray, tol: float) -> int:
    n = 0
    for _ in range(1000):
        s = np.sum(arr).item()
        if s < tol:
            n += 1
    return n


def convergence_every_iteration(u: np.ndarray, tol: float) -> np.ndarray:
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
    return arr[::2] + arr[1::2]


def object_dtype(rows: list) -> np.ndarray:
    return np.array(rows, dtype=object)


def fortran_order_reshape(arr: np.ndarray) -> np.ndarray:
    return arr.reshape((100, -1), order="F")


def python_min_max(arr: np.ndarray) -> float:
    return float(min(arr)) + float(max(arr))
