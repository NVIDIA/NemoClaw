// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::*;
use crate::config::Service;
fn service() -> Service {
    crate::config::Document::parse(
        include_str!("../../tests/fixtures/config/spark.yaml").as_bytes(),
    )
    .unwrap()
    .spec
    .inference_providers
    .remove(0)
    .service
    .unwrap()
}
#[test]
fn capacity_rejects_unsafe_startup_without_allocating_host_memory() {
    let service = service();
    let good = Capacity {
        architecture: "arm64".into(),
        gpu: "NVIDIA GB10".into(),
        driver_major: 580,
        gpu_memory: None,
        total: 121 * GIB,
        available: 116 * GIB,
        free: 110 * GIB,
        disk_free: 200 * GIB,
        foreign_gpu_processes: 0,
    };
    let download = service
        .recipe
        .as_ref()
        .unwrap()
        .snapshot
        .as_ref()
        .unwrap()
        .bytes()
        .unwrap();
    let prepared = service.recipe.as_ref().unwrap().resources.prepared_bytes;
    service
        .check_capacity(&good, true, download, prepared)
        .unwrap();
    let mut cached = good.clone();
    cached.free = GIB;
    service
        .check_capacity(&cached, true, download, prepared)
        .unwrap();
    for dimension in [
        "memory",
        "disk",
        "gpu",
        "architecture",
        "driver",
        "busy",
        "reserve",
    ] {
        let mut bad = good.clone();
        let mut spec = service.clone();
        match dimension {
            "memory" => bad.available = 60 * GIB,
            "disk" => bad.disk_free = 40 * GIB,
            "gpu" => bad.gpu = "unknown".into(),
            "architecture" => bad.architecture = "amd64".into(),
            "driver" => bad.driver_major = 570,
            "busy" => bad.foreign_gpu_processes = 1,
            "reserve" => spec.memory.host_reserve_gib = 64,
            _ => unreachable!(),
        }
        assert!(
            spec.check_capacity(&bad, true, download, prepared).is_err(),
            "{dimension}"
        );
    }
    let mut running = good;
    running.available = 20 * GIB;
    running.foreign_gpu_processes = 1;
    service.check_capacity(&running, false, 0, 0).unwrap();
}
#[test]
fn watchdog_requires_consecutive_pressure_and_latches_until_explicit_restart() {
    let mut watch = Watchdog::new(&service()).unwrap();
    for _ in 0..4 {
        assert!(!watch.sample(7 * GIB, 4 * GIB));
    }
    assert!(!watch.sample(20 * GIB, GIB));
    for _ in 0..4 {
        assert!(!watch.sample(11 * GIB, 2 * GIB));
    }
    assert!(watch.sample(11 * GIB, 2 * GIB));
    assert!(watch.sample(100 * GIB, 90 * GIB));
    assert!(
        !Watchdog::new(&service())
            .unwrap()
            .sample(100 * GIB, 90 * GIB)
    );
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
