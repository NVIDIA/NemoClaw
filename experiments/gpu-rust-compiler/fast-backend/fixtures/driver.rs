// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

unsafe extern "C" {
    fn experiment_sum(n: u64) -> u64;
    fn experiment_mix(x: u64) -> u64;
    fn experiment_drop(initial: u64) -> u64;
}

fn main() {
    for n in [0, 1, 3, 1000] {
        let expected = (0..n).fold(0u64, u64::wrapping_add);
        assert_eq!(unsafe { experiment_sum(n) }, expected);
    }
    for x in [0, 1, u64::MAX, 0x1234_5678_90ab_cdef] {
        let expected = x.rotate_left(13).wrapping_mul(0x9e37_79b9_7f4a_7c15);
        assert_eq!(unsafe { experiment_mix(x) }, expected);
        assert_eq!(unsafe { experiment_drop(x) }, x.wrapping_add(1));
    }
    println!(
        "captured Rust object: sums, rotates, wrapping arithmetic and normal-path drops matched"
    );
}
