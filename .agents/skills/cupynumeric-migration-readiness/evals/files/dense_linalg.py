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


def gram_matrix(X: np.ndarray, Y: np.ndarray, W: np.ndarray) -> np.ndarray:
    return np.matmul(np.matmul(X.T, W), Y)


def normal_equations(A: np.ndarray, b: np.ndarray) -> np.ndarray:
    gram = np.einsum("ij,ik->jk", A, A)
    rhs = np.matmul(A.T, b)
    return np.linalg.solve(gram, rhs)


def batched_solve(A_batch: np.ndarray, b_batch: np.ndarray) -> np.ndarray:
    return np.linalg.solve(A_batch, b_batch)


def svd_energy(A: np.ndarray) -> float:
    _, s, _ = np.linalg.svd(A)
    return float(np.sum(s * s))


def qr_factor(A: np.ndarray) -> np.ndarray:
    q, r = np.linalg.qr(A)
    return r


def residual_norms(
    A: np.ndarray, x: np.ndarray, b: np.ndarray, out: np.ndarray
) -> np.ndarray:
    pred = np.matmul(A, x)
    np.subtract(pred, b, out=out)
    np.multiply(out, out, out=out)
    per_rhs = np.sqrt(np.mean(out, axis=0))
    return np.linalg.norm(per_rhs)
