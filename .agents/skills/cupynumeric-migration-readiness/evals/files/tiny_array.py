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


FRAME_SIZE = 8192
N_TAPS = 64


def make_lowpass(n_taps: int = N_TAPS) -> np.ndarray:
    n = np.arange(n_taps)
    h = np.sinc(0.25 * (n - (n_taps - 1) / 2.0))
    h *= np.hanning(n_taps)
    return h / h.sum()


def fir_filter(frame: np.ndarray, h: np.ndarray) -> np.ndarray:
    return np.convolve(frame, h, mode="same")


def short_time_energy(frame: np.ndarray, window: int = 256) -> np.ndarray:
    sq = frame * frame
    kernel = np.ones(window) / window
    return np.convolve(sq, kernel, mode="same")


def zero_crossings(frame: np.ndarray) -> int:
    return int(np.sum(np.diff(np.signbit(frame).astype(np.int8)) != 0))


def process_frame(frame: np.ndarray) -> dict:
    h = make_lowpass()
    filtered = fir_filter(frame, h)
    energy = short_time_energy(filtered)
    return {
        "filtered": filtered,
        "energy": energy,
        "zcr": zero_crossings(filtered),
    }
