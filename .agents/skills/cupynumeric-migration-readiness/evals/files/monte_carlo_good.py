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


def black_scholes_mc(S0, K, r, sigma, T, n_paths, n_steps):
    dt = T / n_steps
    drift = (r - 0.5 * sigma * sigma) * dt
    vol = sigma * np.sqrt(dt)
    z = np.random.randn(n_steps, n_paths)
    s = np.full(n_paths, S0, dtype=np.float64)
    step = np.empty(n_paths, dtype=np.float64)
    for t in range(n_steps):
        np.multiply(z[t], vol, out=step)
        np.add(step, drift, out=step)
        np.exp(step, out=step)
        np.multiply(s, step, out=s)
    payoff = np.maximum(s - K, 0.0)
    price = np.exp(-r * T) * np.mean(payoff)
    return price


def antithetic_payoff(s_up: np.ndarray, s_down: np.ndarray, K: float) -> float:
    up = np.maximum(s_up - K, 0.0)
    down = np.maximum(s_down - K, 0.0)
    return np.mean(0.5 * (up + down))
