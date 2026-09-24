// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
#![cfg(unix)]
#[path = "../../test-support/docker.rs"]
mod transport;
use nemoclaw_sdk::{
    discovery::ObservationStatus,
    docker::{Connections, Engine},
    hardware::{Capacity, GpuMemory, HostObservation, HostObserver},
    hardware_discovery::{observe_hardware, observe_host_hardware},
};
use serde_json::json;

#[tokio::test]
async fn passive_inventory_uses_selected_engine_only_and_never_invents_gpu_measurements() {
    let fixture = transport::Fixture::start(|request| {
        assert_eq!(request.method, "GET");
        assert_eq!(request.path, "/info");
        assert!(request.body.is_empty());
        Some((200, serde_json::to_vec(&json!({
            "ID":"remote-daemon", "Architecture":"s390x", "OSType":"linux", "MemTotal":16000000000_u64, "NCPU":7,
            "GenericResources":[{"NamedResourceSpec":{"Kind":"NVIDIA-GPU","Value":"GPU-remote"}}]
        })).unwrap()))
    }).await;
    let observed = observe_hardware(&Connections::default(), &fixture.endpoint).await;
    assert_eq!(observed.status, ObservationStatus::Available);
    assert_eq!(observed.architecture.as_deref(), Some("s390x"));
    assert_eq!(observed.memory_bytes, Some(16000000000));
    assert_eq!(observed.cpus, Some(7));
    assert_eq!(observed.gpus.len(), 1);
    assert_eq!(observed.gpus[0].id.as_deref(), Some("GPU-remote"));
    assert!(observed.gpus[0].memory_total_bytes.is_none());
    assert!(observed.gpus[0].driver_major.is_none());
    assert!(observed.gpus[0].compute_capability.is_none());
    assert!(!observed.gpu_inventory_complete);
}

#[tokio::test]
async fn no_advertised_gpu_and_failed_target_are_unknown_not_zero_capacity() {
    let fixture = transport::Fixture::start(|request| {
        assert_eq!(request.path, "/info");
        Some((
            200,
            br#"{"ID":"remote-daemon","Architecture":"arm64"}"#.to_vec(),
        ))
    })
    .await;
    let observed = observe_hardware(&Connections::default(), &fixture.endpoint).await;
    assert_eq!(observed.gpu_status, ObservationStatus::Unknown);
    assert!(observed.gpus.is_empty());
    assert!(!observed.gpu_inventory_complete);
    assert!(observed.memory_bytes.is_none());
    let missing = observe_hardware(&Connections::default(), "unix:///missing-engine.sock").await;
    assert_eq!(missing.status, ObservationStatus::Unknown);
    assert!(missing.architecture.is_none());
    assert!(missing.memory_bytes.is_none());
}

struct FixedHost {
    daemon: &'static str,
}
#[async_trait::async_trait]
impl HostObserver for FixedHost {
    async fn observe(&self, _: &Engine) -> Result<HostObservation, nemoclaw_sdk::Error> {
        Ok(HostObservation {
            engine_id: self.daemon.into(),
            capacity: Capacity {
                architecture: "arm64".into(),
                gpu: "NVIDIA GB300".into(),
                driver_major: 610,
                compute_capability: 103,
                gpu_memory: Some(GpuMemory {
                    total: 240 << 30,
                    free: 200 << 30,
                }),
                total: 512 << 30,
                available: 400 << 30,
                free: 300 << 30,
                disk_free: 1 << 40,
                foreign_gpu_processes: 0,
            },
        })
    }
}

#[tokio::test]
async fn explicit_host_observation_reuses_collector_and_rejects_another_daemon() {
    let fixture = transport::Fixture::start(|request| {
        assert_eq!(request.method, "GET");
        assert_eq!(request.path, "/info");
        Some((
            200,
            br#"{"ID":"selected-daemon","Architecture":"arm64","OSType":"linux","NCPU":72}"#
                .to_vec(),
        ))
    })
    .await;
    let engine = Engine::connect(&fixture.endpoint).unwrap();
    let observed = observe_host_hardware(
        &engine,
        &FixedHost {
            daemon: "selected-daemon",
        },
    )
    .await;
    assert_eq!(observed.gpu_status, ObservationStatus::Available);
    assert!(observed.gpu_inventory_complete);
    assert_eq!(observed.gpus[0].compute_capability, Some(103));
    assert_eq!(observed.gpus[0].driver_major, Some(610));
    assert_eq!(observed.gpus[0].memory_total_bytes, Some(240 << 30));
    let wrong = observe_host_hardware(
        &engine,
        &FixedHost {
            daemon: "different-daemon",
        },
    )
    .await;
    assert_eq!(wrong.gpu_status, ObservationStatus::Unknown);
    assert!(wrong.gpus.is_empty());
    assert!(wrong.reason.unwrap().contains("selected engine"));
}

#[test]
fn engine_feature_projection_preserves_unknowns_and_advertises_networking_without_probing() {
    let info = serde_json::from_value(json!({
        "SecurityOptions":["name=rootless", "name=seccomp,profile=builtin"],
        "Runtimes":{"nvidia":{},"runc":{}}, "Plugins":{"Network":["bridge","host"],"Volume":["local"]},
        "CgroupVersion":"2", "MemoryLimit":true, "SwapLimit":false, "IPv4Forwarding":true
    })).unwrap();
    let features = nemoclaw_sdk::hardware_discovery::engine_features(&info);
    assert_eq!(features.rootless, Some(true));
    assert_eq!(
        features.runtimes,
        Some(vec!["nvidia".into(), "runc".into()])
    );
    assert_eq!(
        features.network_drivers,
        Some(vec!["bridge".into(), "host".into()])
    );
    assert_eq!(features.memory_limit, Some(true));
    assert_eq!(features.swap_limit, Some(false));
    let absent = nemoclaw_sdk::hardware_discovery::engine_features(&Default::default());
    assert!(absent.rootless.is_none());
    assert!(absent.runtimes.is_none());
    assert!(absent.memory_limit.is_none());
}

struct IncompleteHost;
#[async_trait::async_trait]
impl HostObserver for IncompleteHost {
    async fn observe(&self, _: &Engine) -> Result<HostObservation, nemoclaw_sdk::Error> {
        Ok(HostObservation {
            engine_id: "selected-daemon".into(),
            capacity: Capacity::default(),
        })
    }
}

#[tokio::test]
async fn explicit_observer_cannot_promote_incomplete_zero_values_to_available_hardware() {
    let fixture = transport::Fixture::start(|request| {
        assert_eq!(request.path, "/info");
        Some((200, br#"{"ID":"selected-daemon"}"#.to_vec()))
    })
    .await;
    let observed = observe_host_hardware(
        &Engine::connect(&fixture.endpoint).unwrap(),
        &IncompleteHost,
    )
    .await;
    assert_eq!(observed.status, ObservationStatus::Unknown);
    assert!(observed.gpus.is_empty());
    assert!(!observed.gpu_inventory_complete);
}

struct CpuOnlyHost;
#[async_trait::async_trait]
impl HostObserver for CpuOnlyHost {
    async fn observe(&self, _: &Engine) -> Result<HostObservation, nemoclaw_sdk::Error> {
        Ok(HostObservation {
            engine_id: "selected-daemon".into(),
            capacity: Capacity {
                architecture: "arm64".into(),
                total: 8 << 30,
                available: 4 << 30,
                free: 2 << 30,
                ..Default::default()
            },
        })
    }
}
#[tokio::test]
async fn cpu_measurements_remain_available_when_gpu_details_are_unknown() {
    let fixture = transport::Fixture::start(|request| {
        assert_eq!(request.path, "/info");
        Some((200, br#"{"ID":"selected-daemon"}"#.to_vec()))
    })
    .await;
    let observed =
        observe_host_hardware(&Engine::connect(&fixture.endpoint).unwrap(), &CpuOnlyHost).await;
    assert_eq!(observed.status, ObservationStatus::Available);
    assert_eq!(observed.memory_bytes, Some(8 << 30));
    assert_eq!(observed.gpu_status, ObservationStatus::Unknown);
    assert!(observed.gpus.is_empty());
}
