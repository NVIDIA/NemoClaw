// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use std::sync::atomic::{AtomicU64, Ordering};

static NORMAL_DROPS: AtomicU64 = AtomicU64::new(0);
static UNWIND_DROPS: AtomicU64 = AtomicU64::new(0);

struct Tracked(&'static AtomicU64);
impl Drop for Tracked {
    fn drop(&mut self) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}

fn combine<T: Into<u64>>(first: T, second: T) -> u64 {
    first.into().wrapping_add(second.into()).rotate_left(7)
}

#[unsafe(no_mangle)]
pub extern "C" fn experiment_generic_atomic(first: u32, second: u32) -> u64 {
    let before = NORMAL_DROPS.load(Ordering::SeqCst);
    {
        let _guard = Tracked(&NORMAL_DROPS);
    }
    let after = NORMAL_DROPS.load(Ordering::SeqCst);
    combine(first, second) ^ after.wrapping_sub(before)
}

#[unsafe(no_mangle)]
pub extern "C" fn experiment_unwind_drop() -> u64 {
    let before = UNWIND_DROPS.load(Ordering::SeqCst);
    let result = std::panic::catch_unwind(|| {
        let _guard = Tracked(&UNWIND_DROPS);
        panic!("intentional backend unwind fixture");
    });
    let after = UNWIND_DROPS.load(Ordering::SeqCst);
    u64::from(result.is_err()) * 100 + after.wrapping_sub(before)
}
