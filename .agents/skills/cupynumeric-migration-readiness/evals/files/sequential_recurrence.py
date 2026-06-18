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


def iir_lowpass(x: np.ndarray, b0: float, b1: float, a1: float) -> np.ndarray:
    y = np.zeros_like(x)
    y[0] = b0 * x[0]
    for n in range(1, x.shape[0]):
        y[n] = b0 * x[n] + b1 * x[n - 1] - a1 * y[n - 1]
    return y


def ewma(x: np.ndarray, alpha: float) -> np.ndarray:
    s = np.empty_like(x)
    s[0] = x[0]
    for n in range(1, x.shape[0]):
        s[n] = alpha * x[n] + (1.0 - alpha) * s[n - 1]
    return s


def detector(x: np.ndarray, alpha: float, threshold: float) -> np.ndarray:
    baseline = ewma(x, alpha)
    return np.abs(x - baseline) > threshold
