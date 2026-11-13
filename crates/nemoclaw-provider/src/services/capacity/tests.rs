// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::*;
use crate::{
    ObservationError, compile,
    config::Document,
    docker::{Engine, fixture::Fixture},
    hardware::{GIB, Gpu, GpuMemory, HostObservation, HostObserver},
    managed::Spec,
};
use serde_json::json;
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

pub(crate) fn specs() -> Vec<String> {
    let document =
        Document::parse(include_bytes!("../../../../../examples/spark/two-models.yaml").as_slice())
            .unwrap();
    specs_for(&document)
}
fn specs_for(document: &Document) -> Vec<String> {
    let generations = [
        ("managed_gateway".into(), "a".repeat(32)),
        ("inference_service".into(), "b".repeat(32)),
    ]
    .into();
    compile::runtime_targets(document, &generations)
        .unwrap()
        .into_iter()
        .filter(|target| nemoclaw_sdk::services::resource_behavior(&target.kind).runtime_process)
        .map(|target| {
            serde_json::from_str::<Spec>(&target.values["spec"])
                .unwrap()
                .runtime_configuration()
                .unwrap()
                .to_owned()
        })
        .collect()
}
pub(crate) fn capacity() -> Capacity {
    Capacity {
        architecture: "arm64".into(),
        gpu: "NVIDIA GB10".into(),
        compute_capability: 121,
        driver_major: 580,
        total: 128 * GIB,
        available: 120 * GIB,
        gpus: vec![Gpu {
            index: 0,
            uuid: "GPU-00000000-0000-0000-0000-000000000000".into(),
            name: "NVIDIA GB10".into(),
            driver_major: 580,
            compute_capability: 121,
            memory: None,
        }],
        ..Default::default()
    }
}
fn vllm(service: &mut CapacityService) -> &mut nemoclaw_runtime::vllm::Service {
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
    assert!(observed.total.compatible());
    services[0].1 = true;
    assert!(account(&services, &host).is_err());
    host.available = 50 * GIB;
    assert!(account(&services, &host).unwrap().total.compatible());
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
        include_bytes!("../../../../nemoclaw-sdk/tests/fixtures/config/managed-ollama.yaml")
            .as_slice(),
    )
    .unwrap();
    let nemoclaw_sdk::services::ServiceDefinition::Ollama(service) =
        document.spec.services.into_values().next().unwrap()
    else {
        panic!("expected Ollama")
    };
    services[1].0 = CapacityService::Ollama(service.runtime);
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
    let mut host = Capacity {
        architecture: "amd64".into(),
        available: 0,
        ..capacity()
    };
    host.set_gpus(vec![Gpu {
        name: "NVIDIA H100".into(),
        compute_capability: 90,
        memory: Some(GpuMemory {
            total: 80 * GIB,
            free: 0,
        }),
        ..host.gpus[0].clone()
    }]);
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

/// A GPU's UUID in these tests, by index.
fn uuid(index: u32) -> String {
    format!(
        "GPU-{0}{0}{0}{0}{0}{0}{0}{0}-0000-0000-0000-000000000000",
        index
    )
}
/// An H100 with `total_gib` GiB, all of it free.
fn h100(index: u32, total_gib: u64) -> Gpu {
    Gpu {
        index,
        uuid: uuid(index),
        name: "NVIDIA H100 80GB HBM3".into(),
        driver_major: 580,
        compute_capability: 90,
        memory: Some(GpuMemory {
            total: total_gib * GIB,
            free: total_gib * GIB,
        }),
    }
}
/// The two spark services moved to H100s, with fixed per-GPU budgets of 30
/// and 40 GiB.
fn h100_services() -> Vec<(CapacityService, bool)> {
    let mut services = parse(None, &specs()).unwrap();
    for ((service, _), budget) in services.iter_mut().zip([30, 40]) {
        let service = vllm(service);
        service.hardware =
            Some(serde_json::from_value(json!({"profile":"h100","architecture":"amd64"})).unwrap());
        service.memory.gpu_memory_gib = budget;
        service.memory.kv_cache_gib = 8;
    }
    services
}
fn h100_host(gpus: Vec<Gpu>) -> Capacity {
    let mut host = Capacity {
        architecture: "amd64".into(),
        total: 512 * GIB,
        available: 400 * GIB,
        ..Default::default()
    };
    host.set_gpus(gpus);
    host
}

#[test]
fn accounting_adds_the_budgets_of_the_services_on_each_selected_gpu() {
    let services = h100_services();
    let totals = |host: &Capacity| {
        let observed = account(&services, host).unwrap().total;
        (
            observed.required_bytes / GIB,
            observed.observed_bytes / GIB,
            observed.compatible(),
        )
    };
    // Each GPU holds both budgets, 70 GiB.
    assert_eq!(
        totals(&h100_host(vec![h100(0, 80), h100(1, 80)])),
        (70, 80, true)
    );
    // A smaller GPU doesn't; the totals report the GPU with the least room,
    // wherever it is in the list.
    for gpus in [
        vec![h100(0, 80), h100(1, 64)],
        vec![h100(0, 64), h100(1, 80)],
    ] {
        assert_eq!(totals(&h100_host(gpus)), (70, 64, false));
    }
    // A utilization fraction is taken of each GPU's own total.
    let mut services = h100_services();
    let service = vllm(&mut services[0].0);
    service.hardware = Some(
        serde_json::from_value(
            json!({"profile":"h100","architecture":"amd64","minGpuMemoryBytes":64*GIB}),
        )
        .unwrap(),
    );
    service.memory.gpu_memory_gib = 0;
    service.memory.kv_cache_gib = 0;
    service.memory.gpu_memory_utilization = Some(serde_json::Number::from_f64(0.5).unwrap());
    let totals = |host: &Capacity| {
        let observed = account(&services, host).unwrap().total;
        (
            observed.required_bytes / GIB,
            observed.observed_bytes / GIB,
            observed.compatible(),
        )
    };
    // Half of 80 GiB plus 40 fits the first GPU exactly; half of 64 plus 40
    // doesn't fit the second.
    assert_eq!(
        totals(&h100_host(vec![h100(0, 80), h100(1, 96)])),
        (80, 80, true)
    );
    assert_eq!(
        totals(&h100_host(vec![h100(0, 80), h100(1, 64)])),
        (72, 64, false)
    );
}

/// A fake host with `gpus` that reads only the GPU `--id` names, by index or
/// UUID, as `nvidia-smi` does.
struct Gpus {
    reads: Arc<AtomicUsize>,
    gpus: Vec<Gpu>,
}
#[async_trait::async_trait]
impl HostObserver for Gpus {
    async fn observe(&self, _: &Engine, id: Option<&str>) -> Result<HostObservation, Error> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        let gpus: Vec<_> = self
            .gpus
            .iter()
            .filter(|gpu| id.is_none_or(|id| id == gpu.uuid || id == gpu.index.to_string()))
            .cloned()
            .collect();
        if gpus.is_empty() {
            return Err(Error::State("GPU observation failed or exceeded limit"));
        }
        Ok(HostObservation {
            engine_id: "engine".into(),
            capacity: h100_host(gpus),
        })
    }
}

#[tokio::test]
async fn capacity_reads_resolve_each_listed_gpu_by_index_or_uuid() {
    let fixture = Fixture::engine(|request| {
        assert_eq!(request.path, "/info");
        Some((200, json!({"ID":"engine"}).to_string().into_bytes()))
    })
    .await;
    let reads = Arc::new(AtomicUsize::new(0));
    let connections = Connections::fixed([fixture
        .engine_for("ssh://operator@gpu-box")
        .with_host_observer(Arc::new(Gpus {
            reads: reads.clone(),
            gpus: vec![h100(0, 80), h100(1, 80), h100(2, 96)],
        }))])
    .unwrap();
    let engine = crate::managed::service_engine(&connections, "ssh://operator@gpu-box").unwrap();
    let devices = |devices: &[&str]| devices.iter().map(|d| d.to_string()).collect::<Vec<_>>();
    let host = observe_selected(&engine, Some(&devices(&["2", &uuid(1)])))
        .await
        .unwrap();
    assert_eq!(
        host.gpus
            .iter()
            .map(|gpu| (gpu.index, gpu.uuid.clone()))
            .collect::<Vec<_>>(),
        [(2, uuid(2)), (1, uuid(1))]
    );
    let error = observe_selected(&engine, Some(&devices(&["0", &uuid(0)])))
        .await
        .unwrap_err()
        .to_string();
    assert!(error.contains("gpu_devices lists one GPU twice"), "{error}");
    let error = observe_selected(&engine, Some(&devices(&["0", "7"])))
        .await
        .unwrap_err()
        .to_string();
    assert!(error.contains("names no GPU"), "{error}");
    // Through the data source's read, the one listed GPU is checked alone.
    let observed = observe_service_capacity(
        &connections,
        "ssh://operator@gpu-box",
        &specs_for_h100(),
        Some(&devices(&["2"])),
    )
    .await
    .unwrap();
    assert_eq!(
        (observed.required_bytes, observed.observed_bytes),
        (70 * GIB, 96 * GIB)
    );
}

/// The runtime contracts of [`h100_services`].
fn specs_for_h100() -> Vec<String> {
    let mut document =
        Document::parse(include_bytes!("../../../../../examples/spark/two-models.yaml").as_slice())
            .unwrap();
    for (service, budget) in document
        .spec
        .services
        .values_mut()
        .filter_map(|service| match service {
            nemoclaw_sdk::services::ServiceDefinition::Vllm(service) => Some(service),
            _ => None,
        })
        .zip([30, 40])
    {
        service.hardware =
            Some(serde_json::from_value(json!({"profile":"h100","architecture":"amd64"})).unwrap());
        service.memory.gpu_memory_gib = budget;
        service.memory.kv_cache_gib = 8;
        service.memory.host_reserve_gib = 6;
    }
    specs_for(&document)
}

struct Host {
    reads: Arc<AtomicUsize>,
    mode: &'static str,
    capacity: Capacity,
}
#[async_trait::async_trait]
impl HostObserver for Host {
    async fn observe(&self, _: &Engine, _: Option<&str>) -> Result<HostObservation, Error> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        if self.mode == "unavailable" {
            return Err(ObservationError::Transport.into());
        }
        let mut host = self.capacity.clone();
        if self.mode == "incomplete" {
            let mut gpus = host.gpus.clone();
            gpus[0].compute_capability = 0;
            host.set_gpus(gpus);
        }
        if self.mode == "two-gpus" {
            let mut second = host.gpus[0].clone();
            second.index = 1;
            second.uuid = "GPU-11111111-1111-1111-1111-111111111111".into();
            host.gpus.push(second);
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
    let fixture = Fixture::engine(|request| {
        assert_eq!(request.method, "GET");
        assert_eq!(request.path, "/info");
        Some((200, json!({"ID":"engine"}).to_string().into_bytes()))
    })
    .await;
    let specs = specs();
    for mode in ["normal", "unavailable", "foreign", "incomplete", "two-gpus"] {
        let reads = Arc::new(AtomicUsize::new(0));
        let connections = Connections::fixed([fixture
            .engine_for("ssh://operator@gpu-box")
            .with_host_observer(Arc::new(Host {
                reads: reads.clone(),
                mode,
                capacity: Capacity {
                    available: 0,
                    ..capacity()
                },
            }))])
        .unwrap();
        let observed =
            observe_service_capacity(&connections, "ssh://operator@gpu-box", &specs, None).await;
        if mode == "normal" {
            assert!(observed.unwrap().compatible());
        } else {
            let Err(error) = observed else {
                panic!("{mode}")
            };
            let error = error.to_string();
            if mode == "two-gpus" {
                assert!(error.contains("exactly one observable GPU"), "{error}");
            }
        }
        assert_eq!(reads.load(Ordering::SeqCst), 1);
        assert!(
            observe_service_capacity(&connections, "ssh://other", &specs, None)
                .await
                .is_err()
        );
        assert!(
            observe_service_capacity(
                &connections,
                "ssh://operator@gpu-box",
                &[specs[0].clone(), specs[0].clone()],
                None,
            )
            .await
            .is_err()
        );
        for gpu_devices in [vec![], vec!["all"], vec!["0", "1"], vec!["0", "0"]] {
            let gpu_devices: Vec<String> = gpu_devices.into_iter().map(Into::into).collect();
            assert!(
                observe_service_capacity(
                    &connections,
                    "ssh://operator@gpu-box",
                    &specs,
                    Some(&gpu_devices)
                )
                .await
                .is_err()
            );
        }
        assert_eq!(
            reads.load(Ordering::SeqCst),
            1,
            "invalid inputs reached host"
        );
    }
}

#[tokio::test]
async fn capacity_observation_counts_combined_budgets_and_largest_reserve_once() {
    let fixture = Fixture::engine(|request| {
        assert_eq!(request.method, "GET");
        assert_eq!(request.path, "/info");
        Some((200, json!({"ID":"engine"}).to_string().into_bytes()))
    })
    .await;
    let mut document =
        Document::parse(include_bytes!("../../../../../examples/spark/two-models.yaml").as_slice())
            .unwrap();
    let nemoclaw_sdk::services::ServiceDefinition::Vllm(service) =
        document.spec.services.get_mut("smart").unwrap()
    else {
        panic!("expected vLLM");
    };
    service.memory.host_reserve_gib = 48;
    service.memory.gpu_memory_gib = 52;
    let specs = specs_for(&document);
    let required = (20 + 52 + 48) * GIB;
    for total in [required, required - 1] {
        let reads = Arc::new(AtomicUsize::new(0));
        let connections = Connections::fixed([fixture
            .engine_for("ssh://operator@gpu-box")
            .with_host_observer(Arc::new(Host {
                reads: reads.clone(),
                mode: "normal",
                capacity: Capacity {
                    total,
                    available: 0,
                    ..capacity()
                },
            }))])
        .unwrap();
        let observed =
            observe_service_capacity(&connections, "ssh://operator@gpu-box", &specs, None)
                .await
                .unwrap();
        assert_eq!(observed.required_bytes, required);
        assert_eq!(observed.observed_bytes, total);
        assert_eq!(observed.compatible(), total == required);
        assert_eq!(observed.require().is_ok(), total == required);
        assert_eq!(reads.load(Ordering::SeqCst), 1);
    }
}
