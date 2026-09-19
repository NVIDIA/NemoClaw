// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::Spec;
use crate::{
    Error, ObservationError,
    backend::Backend,
    compile,
    config::Document,
    docker::{Connections, Engine, fixture::Fixture},
    hardware::{Capacity, GIB, HostObservation, HostObserver},
    services::BackendRegistry,
};
use serde_json::json;
use std::sync::Arc;

struct Host(bool);
#[async_trait::async_trait]
impl HostObserver for Host {
    async fn observe(&self, _: &Engine) -> Result<HostObservation, Error> {
        if self.0 {
            return Err(ObservationError::Transport.into());
        }
        Ok(HostObservation {
            engine_id: "selected-engine".into(),
            capacity: Capacity {
                architecture: "arm64".into(),
                gpu: "NVIDIA GB10".into(),
                compute_capability: 121,
                driver_major: 570,
                total: 128 * GIB,
                available: 120 * GIB,
                disk_free: 500 * GIB,
                ..Default::default()
            },
        })
    }
}

struct OccupiedHost;
#[async_trait::async_trait]
impl HostObserver for OccupiedHost {
    async fn observe(&self, _: &Engine) -> Result<HostObservation, Error> {
        Ok(HostObservation {
            engine_id: "selected-engine".into(),
            capacity: Capacity {
                architecture: "arm64".into(),
                gpu: "NVIDIA GB10".into(),
                compute_capability: 121,
                driver_major: 610,
                total: 128 * GIB,
                available: 0,
                disk_free: 0,
                ..Default::default()
            },
        })
    }
}

#[tokio::test]
async fn replacement_creation_plan_checks_hardware_without_requiring_resources_to_be_released() {
    // OpenTofu plans a replacement again with null prior state while the old
    // process still owns its memory. Startup headroom must be checked later.
    let fixture = Fixture::start(|request| {
        assert_eq!(request.method, "GET");
        assert_eq!(
            request.path, "/info",
            "hardware planning inspected a process or model artifact"
        );
        Some((
            200,
            serde_json::to_vec(&json!({"ID":"selected-engine"})).unwrap(),
        ))
    })
    .await;
    let document =
        Document::parse(include_bytes!("../../../../examples/spark/vllm.yaml").as_slice()).unwrap();
    let generations = [
        ("managed_gateway".into(), "a".repeat(32)),
        ("inference_service".into(), "b".repeat(32)),
    ]
    .into();
    let target = compile::runtime_targets(&document, &generations)
        .unwrap()
        .into_iter()
        .find(|target| target.kind == "inference_service")
        .unwrap();
    let spec: Spec = serde_json::from_str(&target.values["spec"]).unwrap();
    let connections = Connections::fixed([fixture
        .engine_for(spec.engine())
        .with_host_observer(Arc::new(OccupiedHost))])
    .unwrap();
    let backend = BackendRegistry::new(&connections)
        .resolve(&target.kind, &target.values)
        .unwrap()
        .unwrap();
    backend
        .plan(&target.kind, &target.values, None)
        .await
        .unwrap();
}

#[tokio::test]
async fn planning_observes_the_selected_engine_and_rejects_hardware_without_mutations() {
    let fixture = Fixture::start(|request| {
        assert_eq!(request.method, "GET", "planning mutated Docker");
        let (status, body) = if request.path == "/info" {
            (
                200,
                json!({"ID":"selected-engine", "DockerRootDir":"/var/lib/docker"}),
            )
        } else {
            (404, json!({"message":"absent"}))
        };
        Some((status, serde_json::to_vec(&body).unwrap()))
    })
    .await;
    for source in [
        include_bytes!("../../../../examples/spark/vllm.yaml").as_slice(),
        include_bytes!("../../../../examples/managed-ollama-gpu.yaml").as_slice(),
    ] {
        let document = Document::parse(source).unwrap();
        let generations = [
            ("managed_gateway".into(), "a".repeat(32)),
            ("inference_service".into(), "b".repeat(32)),
            ("ollama_service".into(), "c".repeat(32)),
        ]
        .into();
        let target = compile::runtime_targets(&document, &generations)
            .unwrap()
            .into_iter()
            .find(|target| matches!(target.kind.as_str(), "inference_service" | "ollama_service"))
            .unwrap();
        let spec: Spec = serde_json::from_str(&target.values["spec"]).unwrap();
        for unavailable in [false, true] {
            let connections = Connections::fixed([fixture
                .engine_for(spec.engine())
                .with_host_observer(Arc::new(Host(unavailable)))])
            .unwrap();
            let backend = BackendRegistry::new(&connections)
                .resolve(&target.kind, &target.values)
                .unwrap()
                .unwrap();
            let error = backend
                .plan(&target.kind, &target.values, None)
                .await
                .unwrap_err();
            assert_eq!(
                error.to_string(),
                if unavailable {
                    "observation transport failed"
                } else {
                    "hardware.minDriverMajor requires at least 580; observed 570"
                }
            );
        }
    }
}
