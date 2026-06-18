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
from scipy import signal


def design_taps(cutoff: float, order: int) -> np.ndarray:
    b, a = signal.butter(order, cutoff, btype="low")
    return np.asarray(b / a[0], dtype=np.float64)


def fir_smooth(
    x: np.ndarray, taps: np.ndarray, acc: np.ndarray, scratch: np.ndarray
) -> np.ndarray:
    n_taps = taps.shape[0]
    valid = x.shape[1] - n_taps + 1
    acc[:, :valid] = 0.0
    for k in range(n_taps):
        np.multiply(x[:, k : k + valid], taps[k], out=scratch[:, :valid])
        np.add(acc[:, :valid], scratch[:, :valid], out=acc[:, :valid])
    return acc


def normalize_rows(x: np.ndarray, out: np.ndarray) -> np.ndarray:
    energy = np.sqrt(np.sum(x * x, axis=1, keepdims=True))
    np.divide(x, energy, out=out)
    return out


def band_energy(signals: np.ndarray, cutoff: float, order: int) -> np.ndarray:
    taps = design_taps(cutoff, order)
    valid = signals.shape[1] - taps.shape[0] + 1
    acc = np.zeros_like(signals)
    scratch = np.zeros_like(signals)
    smoothed = fir_smooth(signals, taps, acc, scratch)
    band = smoothed[:, :valid]
    return np.mean(np.square(band), axis=1)
