// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

#![no_std]

#[unsafe(no_mangle)]
pub extern "C" fn experiment_sum(n: u64) -> u64 {
    let mut sum = 0u64;
    let mut i = 0u64;
    while i < n {
        sum = sum.wrapping_add(i);
        i = i.wrapping_add(1);
    }
    sum
}

#[unsafe(no_mangle)]
pub extern "C" fn experiment_mix(x: u64) -> u64 {
    x.rotate_left(13).wrapping_mul(0x9e37_79b9_7f4a_7c15)
}

struct Bump<'a>(&'a mut u64);
impl Drop for Bump<'_> {
    fn drop(&mut self) {
        *self.0 = (*self.0).wrapping_add(1);
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn experiment_drop(initial: u64) -> u64 {
    let mut counter = initial;
    {
        let _guard = Bump(&mut counter);
    }
    counter
}
