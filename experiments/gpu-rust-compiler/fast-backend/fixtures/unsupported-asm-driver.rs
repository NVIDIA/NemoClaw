// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

unsafe extern "C" {
    fn experiment_inline_asm() -> u64;
}

fn main() {
    assert_eq!(unsafe { experiment_inline_asm() }, 42);
    println!("captured Rust inline assembly: fallback result matched");
}
