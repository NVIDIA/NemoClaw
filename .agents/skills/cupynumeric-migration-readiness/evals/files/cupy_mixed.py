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
import cupynumeric as np

import cupy as cp


def diffuse(
    x: np.ndarray, scratch: np.ndarray, decay: float, n_steps: int
) -> np.ndarray:
    for _ in range(n_steps):
        np.multiply(x, decay, out=scratch)
        y = cp.asarray(np.asarray(scratch))
        y = cp.sqrt(cp.add(y, 1.0))
        x = np.asarray(cp.asnumpy(y))
    return x
