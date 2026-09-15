// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Integration tests consume the normal library, without its cfg(test) escape hatch.
#![cfg(unix)]

#[test]
fn unix_clients_parse_remote_gpu_inventory_without_a_local_gpu() {
    let inventory = nemoclaw_sdk::hardware::nvidia::inventory;
    assert_eq!(
        inventory("NVIDIA GB10, 580.142\n", "12\n34\n").unwrap(),
        ("NVIDIA GB10".into(), 580, 2)
    );
    assert_eq!(inventory("NVIDIA GB10, 580.142\n", "").unwrap().2, 0);
    assert!(inventory("NVIDIA GB10, unknown", "").is_err());
    assert!(inventory("NVIDIA GB10, 580.142", "12\n12\n").is_err());
}
