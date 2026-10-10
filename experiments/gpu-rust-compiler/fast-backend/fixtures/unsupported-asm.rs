// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

#![no_std]

// Capture for x86-64 Linux; this exercises TPDE's explicit unsupported-construct route.
#[unsafe(no_mangle)]
pub extern "C" fn experiment_inline_asm() -> u64 {
    unsafe {
        core::arch::asm!("pause", options(nomem, nostack, preserves_flags));
    }
    42
}
