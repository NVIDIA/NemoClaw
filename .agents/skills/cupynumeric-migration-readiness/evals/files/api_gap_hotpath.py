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


N_SAMPLES = 16_000_000


def normalize(signal: np.ndarray) -> np.ndarray:
    centered = signal - np.mean(signal)
    scale = np.sqrt(np.mean(centered * centered))
    return centered / scale


def resample(
    signal: np.ndarray, src_grid: np.ndarray, dst_grid: np.ndarray
) -> np.ndarray:
    return np.interp(dst_grid, src_grid, signal)


def envelope(signal: np.ndarray) -> np.ndarray:
    return np.sqrt(signal * signal + 1.0)


def process(n: int = N_SAMPLES) -> float:
    src_grid = np.linspace(0, 1, n)
    dst_grid = np.linspace(0, 1, n)
    raw = np.exp(-src_grid) * np.where(src_grid > 0.5, 1, -1)
    clean = normalize(raw)
    warped = resample(clean, src_grid, dst_grid)
    env = envelope(warped)
    return float(np.max(np.abs(env)))
