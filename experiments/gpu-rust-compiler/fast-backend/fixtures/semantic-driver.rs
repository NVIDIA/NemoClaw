// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

unsafe extern "C" {
    fn experiment_generic_atomic(first: u32, second: u32) -> u64;
    fn experiment_unwind_drop() -> u64;
}

fn main() {
    std::panic::set_hook(Box::new(|_| {}));
    for (first, second) in [(0, 0), (1, 2), (u32::MAX, u32::MAX)] {
        let expected = u64::from(first)
            .wrapping_add(u64::from(second))
            .rotate_left(7)
            ^ 1;
        assert_eq!(
            unsafe { experiment_generic_atomic(first, second) },
            expected
        );
    }
    for _ in 0..3 {
        assert_eq!(unsafe { experiment_unwind_drop() }, 101);
    }
    println!(
        "captured Rust object: generic calls, atomics, caught panics and unwind drops matched"
    );
}
