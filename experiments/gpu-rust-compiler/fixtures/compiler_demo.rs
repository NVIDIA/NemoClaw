// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// This is ordinary Rust in the explicitly supported compiler subset.
fn mix(value: i64, salt: i64) -> i64 {
    let mut result: i64 = value;
    if value > salt {
        result = value * 3 + salt;
    } else {
        result = salt * 2 - value;
    }
    return result;
}

fn main() -> i64 {
    123 * 456;
    let mut index: i64 = 0;
    let mut total: i64 = 0;
    while index < 40 {
        if index % 3 == 0 || index == 7 {
            total = total + mix(index, 11);
        } else {
            total = total + index;
        }
        index = index + 1;
    }
    return total;
}
