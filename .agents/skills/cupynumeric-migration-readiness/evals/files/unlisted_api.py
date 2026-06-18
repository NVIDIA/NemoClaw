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


def build_grid(n: int, extent: float) -> tuple[np.ndarray, np.ndarray]:
    step = (2.0 * extent) / (n - 1)
    ys, xs = np.mgrid[
        -extent : extent + step : step, -extent : extent + step : step
    ]
    return xs.astype(np.float32), ys.astype(np.float32)


def wavepacket(
    xs: np.ndarray, ys: np.ndarray, k: float, sigma: float
) -> np.ndarray:
    r2 = np.add(np.square(xs), np.square(ys))
    envelope = np.exp(-0.5 * r2 / (sigma * sigma))
    phase = np.cos(k * xs) * np.cos(k * ys)
    return np.multiply(envelope, phase)


def normalize(field: np.ndarray) -> np.ndarray:
    energy = np.sqrt(np.sum(np.square(field)))
    return np.where(energy > 0.0, field / energy, field)


def evaluate(n: int, extent: float, k: float, sigma: float) -> dict:
    xs, ys = build_grid(n, extent)
    field = wavepacket(xs, ys, k, sigma)
    field = normalize(field)
    return {
        "mean": float(np.mean(field)),
        "peak": float(np.sqrt(np.sum(np.square(field)))),
    }


if __name__ == "__main__":
    print(evaluate(3500, 8, 4, 2.5))
