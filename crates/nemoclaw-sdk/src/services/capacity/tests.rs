// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::*;
use crate::{
    ObservationError, compile,
    config::Document,
    docker::{Engine, fixture::Fixture},
    hardware::{GIB, GpuMemory, HostObservation, HostObserver},
};
use serde_json::json;
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

fn specs() -> Vec<String> {
    let document =
        Document::parse(include_bytes!("../../../../../examples/spark/two-models.yaml").as_slice())
            .unwrap();
    let generations = [
        ("managed_gateway".into(), "a".repeat(32)),
        ("inference_service".into(), "b".repeat(32)),
    ]
    .into();
    compile::runtime_targets(&document, &generations)
        .unwrap()
        .into_iter()
        .filter(|target| super::super::resource_behavior(&target.kind).runtime_process)
        .map(|target| target.values["spec"].clone())
        .collect()
}
fn capacity() -> Capacity {
    Capacity {
        architecture: "arm64".into(),
        gpu: "NVIDIA GB10".into(),
        compute_capability: 121,
        driver_major: 580,
        total: 128 * GIB,
        available: 120 * GIB,
        ..Default::default()
    }
}
fn vllm(service: &mut CapacityService) -> &mut installers::vllm::Service {
    match service {
        CapacityService::Vllm(service) => service,
        _ => panic!("expected vLLM"),
    }
}

#[test]
fn combined_accounting_preserves_running_allocations_and_counts_host_reserve_once() {
    let mut services = parse(None, &specs()).unwrap();
    let mut host = capacity();
    host.available = 0;
    let observed = account(&services, &host).unwrap();
    assert_eq!(observed.total.required_bytes, (20 + 32 + 32) * GIB);
    assert!(observed.total.compatible() && observed.startup_fits);
    services[0].1 = true;
    assert!(account(&services, &host).is_err());
    host.available = 50 * GIB;
    assert!(account(&services, &host).unwrap().startup_fits);
    services[1].1 = true;
    assert!(account(&services, &host).is_err());
    for (service, starting) in &mut services {
        vllm(service).memory.gpu_memory_gib = 64;
        *starting = false;
    }
    let observed = account(&services, &host).unwrap();
    assert!(!observed.total.compatible());
    let error = observed.total.require().unwrap_err().to_string();
    assert!(
        error.contains(&(160 * GIB).to_string()) && error.contains(&(128 * GIB).to_string()),
        "{error}"
    );
}

#[test]
fn combined_accounting_includes_mixed_installers_and_dedicated_utilization() {
    let mut services = parse(None, &specs()).unwrap();
    let document = Document::parse(
        include_bytes!("../../../tests/fixtures/config/managed-ollama.yaml").as_slice(),
    )
    .unwrap();
    let super::super::ServiceDefinition::Ollama(service) =
        document.spec.services.into_values().next().unwrap()
    else {
        panic!("expected Ollama")
    };
    services[1].0 = CapacityService::Ollama(*service);
    let observed = account(&services, &capacity()).unwrap();
    assert_eq!(observed.total.required_bytes, (20 + 16 + 32) * GIB);
    let mut services = parse(None, &specs()).unwrap();
    for (service, _) in &mut services {
        let service = vllm(service);
        service.hardware = Some(
            serde_json::from_value(
                json!({"profile":"h100","architecture":"amd64","minGpuMemoryBytes":80*GIB}),
            )
            .unwrap(),
        );
        service.memory.gpu_memory_gib = 0;
        service.memory.kv_cache_gib = 0;
        service.memory.gpu_memory_utilization = Some(serde_json::Number::from_f64(0.6).unwrap());
    }
    let host = Capacity {
        architecture: "amd64".into(),
        gpu: "NVIDIA H100".into(),
        compute_capability: 90,
        gpu_memory: Some(GpuMemory {
            total: 80 * GIB,
            free: 0,
        }),
        available: 0,
        ..capacity()
    };
    let observed = account(&services, &host).unwrap();
    assert_eq!(observed.total.required_bytes, 96 * GIB);
    assert_eq!(observed.total.observed_bytes, 80 * GIB);
    assert!(!observed.total.compatible());
    vllm(&mut services[1].0).memory.gpu_memory_utilization =
        Some(serde_json::Number::from_f64(0.3).unwrap());
    assert!(account(&services, &host).unwrap().total.compatible());
    services[0].1 = true;
    assert!(account(&services, &host).is_err());
}

struct Host {
    reads: Arc<AtomicUsize>,
    mode: &'static str,
}
#[async_trait::async_trait]
impl HostObserver for Host {
    async fn observe(&self, _: &Engine) -> Result<HostObservation, Error> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        if self.mode == "unavailable" {
            return Err(ObservationError::Transport.into());
        }
        let mut host = capacity();
        host.available = 0;
        if self.mode == "incomplete" {
            host.compute_capability = 0;
        }
        Ok(HostObservation {
            engine_id: if self.mode == "foreign" {
                "other"
            } else {
                "engine"
            }
            .into(),
            capacity: host,
        })
    }
}
#[tokio::test]
async fn capacity_observation_uses_the_selected_engine_and_preserves_failures_without_mutations() {
    let fixture = Fixture::start(|request| {
        assert_eq!(request.method, "GET");
        assert_eq!(request.path, "/info");
        Some((200, json!({"ID":"engine"}).to_string().into_bytes()))
    })
    .await;
    let mut specs = specs();
    for encoded in &mut specs {
        let mut spec: Spec = serde_json::from_str(encoded).unwrap();
        spec.process.as_mut().unwrap().engine = "ssh://operator@gpu-box".into();
        *encoded = spec.json().unwrap();
    }
    for mode in ["normal", "unavailable", "foreign", "incomplete"] {
        let reads = Arc::new(AtomicUsize::new(0));
        let connections = Connections::fixed([fixture
            .engine_for("ssh://operator@gpu-box")
            .with_host_observer(Arc::new(Host {
                reads: reads.clone(),
                mode,
            }))])
        .unwrap();
        let observed =
            observe_service_capacity(&connections, "ssh://operator@gpu-box", &specs).await;
        if mode == "normal" {
            assert!(observed.unwrap().compatible());
        } else {
            assert!(observed.is_err(), "{mode}");
        }
        assert_eq!(reads.load(Ordering::SeqCst), 1);
        assert!(
            observe_service_capacity(&connections, "ssh://other", &specs)
                .await
                .is_err()
        );
        assert!(
            observe_service_capacity(
                &connections,
                "ssh://operator@gpu-box",
                &[specs[0].clone(), specs[0].clone()]
            )
            .await
            .is_err()
        );
        assert_eq!(
            reads.load(Ordering::SeqCst),
            1,
            "invalid inputs reached host"
        );
    }
}
