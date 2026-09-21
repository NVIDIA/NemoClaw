// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::*;

#[test]
fn watchdog_requires_consecutive_pressure_and_latches_until_explicit_restart() {
    let policy = || ProtectionPolicy::new(8 * GIB, 3 * GIB, 12 * GIB, 5).unwrap();
    let mut watch = Watchdog::from_policy(policy());
    for _ in 0..4 {
        assert!(!watch.sample(7 * GIB, 4 * GIB));
    }
    assert!(!watch.sample(20 * GIB, GIB));
    for _ in 0..4 {
        assert!(!watch.sample(11 * GIB, 2 * GIB));
    }
    assert!(watch.sample(11 * GIB, 2 * GIB));
    assert!(watch.sample(100 * GIB, 90 * GIB));
    assert!(!Watchdog::from_policy(policy()).sample(100 * GIB, 90 * GIB));
}

#[test]
fn memory_requires_complete_consistent_observation() {
    let valid = b"MemTotal: 120 kB\nMemAvailable: 100 kB\nMemFree: 20 kB\n";
    let capacity = read_memory(valid.as_slice()).unwrap();
    assert_eq!(capacity.available, 100 * 1024);
    for text in [
        "MemTotal: 120 kB\nMemFree: 20 kB\n",
        "MemTotal: 120 kB\nMemAvailable: 130 kB\nMemFree: 20 kB\n",
        "MemTotal: 120 kB\nMemAvailable: 100 kB\nMemFree: 20 kB\nMemFree: 30 kB\n",
    ] {
        assert!(read_memory(text.as_bytes()).is_err());
    }
}

#[test]
fn available_memory_may_be_below_free_memory_after_kernel_reserves() {
    let capacity =
        read_memory(b"MemTotal: 120 kB\nMemAvailable: 90 kB\nMemFree: 100 kB\n".as_slice())
            .unwrap();
    assert_eq!(capacity.available, 90 * 1024);
    assert_eq!(capacity.free, 100 * 1024);
    assert!(
        read_memory(b"MemTotal: 120 kB\nMemAvailable: 90 kB\nMemFree: 130 kB\n".as_slice())
            .is_err()
    );
}
