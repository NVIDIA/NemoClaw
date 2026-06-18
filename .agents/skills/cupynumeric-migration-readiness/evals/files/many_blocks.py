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


def scale_each_element(arr: np.ndarray) -> np.ndarray:
    n = arr.shape[0]
    out = np.zeros_like(arr)
    for i in range(n):
        out[i] = arr[i] * 2.0 + 1.0
    return out


def converge_with_item(u: np.ndarray, tol: float) -> int:
    work = np.zeros_like(u)
    for step in range(10_000):
        work[1:-1] = 0.5 * (u[:-2] + u[2:])
        err = float(np.max(np.abs(u - work)))
        if err < tol:
            return step
        u, work = work, u
    return step


def sum_rows(arr: np.ndarray) -> float:
    total = 0.0
    for row in arr:
        total += float(np.sum(row))
    return total


def downsample_blend(arr: np.ndarray) -> np.ndarray:
    return arr[::2] + arr[1::2]
