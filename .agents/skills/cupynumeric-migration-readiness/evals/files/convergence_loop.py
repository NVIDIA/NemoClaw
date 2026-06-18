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


def jacobi_step(u: np.ndarray, work: np.ndarray) -> None:
    work[1:-1, 1:-1] = 0.25 * (
        u[:-2, 1:-1] + u[2:, 1:-1] + u[1:-1, :-2] + u[1:-1, 2:]
    )


def solve(n: int, tol: float) -> np.ndarray:
    u = np.zeros((n, n), dtype=np.float32)
    work = np.zeros_like(u)
    u[0, :] = 1.0
    work[0, :] = 1.0
    jacobi_step(u, work)
    while np.max(np.abs(u - work)) > tol:
        u, work = work, u
        jacobi_step(u, work)
    return work
