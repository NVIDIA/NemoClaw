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
"""Idioms that are fixable without changing domain logic.

This file illustrates REFACTOR-category patterns (R201-R206 from
references/idioms-that-block.md). Each function here has a canonical
rewrite in references/refactor-recipes.md — cross-reference the recipe
anchor noted in each comment.
"""

import numpy as np


def alloc_in_loop(steps: int, n: int) -> np.ndarray:
    # R201: np.zeros allocated every iteration
    out = np.zeros(n)
    for _ in range(steps):
        temp = np.zeros(n)
        temp[:] = out * 2.0 + 1.0
        out = temp
    return out


def rebind_in_loop(x: np.ndarray, y: np.ndarray) -> np.ndarray:
    # R202: x = x + y allocates each iteration
    for _ in range(1000):
        x = x + y
    return x


def stack_in_loop(rows: int, cols: int) -> np.ndarray:
    # R203: vstack growing inside a loop
    arr = np.zeros((1, cols))
    for _ in range(rows):
        new_row = np.ones((1, cols))
        arr = np.vstack([arr, new_row])
    return arr


def nonzero_then_index(arr: np.ndarray, condition: np.ndarray) -> np.ndarray:
    # R204: materializes index array; preferred path is boolean mask
    idx = np.nonzero(condition)
    arr[idx] = 0.0
    return arr


def reshape_in_hot_loop(data: np.ndarray, steps: int) -> np.ndarray:
    # R206: reshape inside a hot loop
    out = np.zeros_like(data)
    for _ in range(steps):
        reshaped = data.reshape(2, -1)
        out[:] = reshaped.sum(axis=0).reshape(data.shape)
    return out
