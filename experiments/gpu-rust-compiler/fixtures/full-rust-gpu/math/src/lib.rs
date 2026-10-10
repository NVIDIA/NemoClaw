// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
#![no_std]

// This is a normal Rust dependency compiled by rustc. In the explicitly selected
// release overflow contract, its arithmetic wraps. Debug/checked variants are
// outside the GPU leaf contract and must take the attributed CPU path.
#[unsafe(no_mangle)]
#[inline(never)]
pub extern "C" fn rust_gpu_math(value: i64) -> i64 {
    value * 7 + 3
}
