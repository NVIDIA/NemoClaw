// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Integration tests consume the normal library, without its cfg(test) escape hatch.
#![cfg(unix)]

#[test]
fn unix_clients_parse_remote_gpu_inventory_without_a_local_gpu() {
    let inventory = nemoclaw_runtime::hardware::nvidia::inventory;
    let gb10 =
        "0, GPU-a0a0a0a0-0000-0000-0000-000000000000, NVIDIA GB10, 12.1, [N/A], [N/A], 580.142\n";
    let (gpus, processes) = inventory(gb10, "12\n34\n").unwrap();
    assert_eq!(
        (gpus[0].name.as_str(), gpus[0].driver_major, processes),
        ("NVIDIA GB10", 580, 2)
    );
    assert_eq!(inventory(gb10, "").unwrap().1, 0);
    assert!(inventory(&gb10.replace("580.142", "unknown"), "").is_err());
    assert!(inventory(gb10, "12\n12\n").is_err());
}
