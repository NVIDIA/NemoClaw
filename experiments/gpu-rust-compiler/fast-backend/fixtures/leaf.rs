// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

#![no_std]

#[unsafe(no_mangle)]
pub extern "C" fn gpu_leaf_math(x: i64) -> i64 {
    // Capture under an explicit release contract with overflow checks disabled.
    x * 7 + 3
}

#[unsafe(no_mangle)]
pub extern "C" fn gpu_leaf_constant() -> i64 {
    42
}
