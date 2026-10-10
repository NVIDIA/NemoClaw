// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use std::sync::atomic::{AtomicUsize, Ordering};
static DROPS: AtomicUsize = AtomicUsize::new(0);
struct Guard;
impl Drop for Guard {
    fn drop(&mut self) {
        DROPS.fetch_add(1, Ordering::SeqCst);
    }
}
fn identity<T>(value: T) -> T {
    value
}
fn main() {
    std::panic::set_hook(Box::new(|_| {}));
    let inputs = vec![0i64, 1, -1, i64::MAX, i64::MIN, 0x123456789abcdef0];
    for value in identity(inputs) {
        assert_eq!(
            gpu_rust_math_fixture::rust_gpu_math(value),
            value.wrapping_mul(7).wrapping_add(3)
        );
    }
    let caught = std::panic::catch_unwind(|| {
        let _guard = Guard;
        panic!("intentional fixture panic");
    });
    assert!(caught.is_err());
    assert_eq!(DROPS.load(Ordering::SeqCst), 1);
    println!("rust-gpu-fixture: arithmetic=verified caught=true drops=1");
}
