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
"""Idioms that scale cleanly on cuPyNumeric.

This file illustrates SCALES-category patterns (R001-R007 from
references/idioms-that-scale.md). Cross-reference each function with the
matching anchor in that reference.

Domain: 2D Jacobi solver on a regular grid — the canonical workload class
cuPyNumeric was built for.
"""

import numpy as np


def jacobi_step(u: np.ndarray, work: np.ndarray) -> np.ndarray:
    work[1:-1, 1:-1] = 0.25 * (
        u[:-2, 1:-1] + u[2:, 1:-1] + u[1:-1, :-2] + u[1:-1, 2:]
    )
    return work


def residual(u: np.ndarray, work: np.ndarray) -> np.ndarray:
    diff = u - work
    return np.sqrt(np.sum(diff * diff))


def solve(n: int, n_iter: int) -> np.ndarray:
    u = np.zeros((n, n), dtype=np.float32)
    work = np.zeros_like(u)
    u[0, :] = 1.0
    for _ in range(n_iter):
        work = jacobi_step(u, work)
        u, work = work, u
    return u


def vectorized_update(
    a: np.ndarray, b: np.ndarray, c: np.ndarray, alpha: float
) -> np.ndarray:
    return np.where(a > 0, alpha * a + b, c)


def matmul_chain(A: np.ndarray, B: np.ndarray, C: np.ndarray) -> np.ndarray:
    return np.matmul(A, np.matmul(B, C))


def masked_assign(
    arr: np.ndarray, mask: np.ndarray, value: float
) -> np.ndarray:
    arr[mask] = value
    return arr


def fused_with_out(
    a: np.ndarray, b: np.ndarray, out: np.ndarray
) -> np.ndarray:
    np.add(a, b, out=out)
    np.multiply(out, 0.5, out=out)
    return out
