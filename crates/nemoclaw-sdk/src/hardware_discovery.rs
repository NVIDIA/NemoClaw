// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Passive target inventory and explicitly requested, daemon-bound host measurements.
use crate::{
    discovery::ObservationStatus,
    docker::{Connections, Engine},
    hardware::HostObserver,
};
use bollard::models::SystemInfo;
use serde::{Deserialize, Serialize};
use std::time::Duration;

/// Advertised daemon features; missing fields do not imply lack of support.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct EngineFeatures {
    pub rootless: Option<bool>,
    pub runtimes: Option<Vec<String>>,
    pub network_drivers: Option<Vec<String>>,
    pub volume_drivers: Option<Vec<String>>,
    pub cgroup_version: Option<String>,
    pub kernel_version: Option<String>,
    pub memory_limit: Option<bool>,
    pub swap_limit: Option<bool>,
    pub ipv4_forwarding: Option<bool>,
}

/// Shared projection for engine and hardware discovery from the same target read.
pub fn engine_features(info: &SystemInfo) -> EngineFeatures {
    EngineFeatures {
        rootless: info.security_options.as_ref().map(|options| {
            options.iter().any(|option| {
                option
                    .split(',')
                    .any(|part| part == "name=rootless" || part == "rootless")
            })
        }),
        runtimes: info.runtimes.as_ref().map(|runtimes| {
            let mut names: Vec<_> = runtimes.keys().cloned().collect();
            names.sort();
            names
        }),
        network_drivers: info
            .plugins
            .as_ref()
            .and_then(|plugins| plugins.network.clone()),
        volume_drivers: info
            .plugins
            .as_ref()
            .and_then(|plugins| plugins.volume.clone()),
        cgroup_version: info
            .cgroup_version
            .map(|version| version.to_string())
            .filter(|version| !version.is_empty()),
        kernel_version: info.kernel_version.clone(),
        memory_limit: info.memory_limit,
        swap_limit: info.swap_limit,
        ipv4_forwarding: info.ipv4_forwarding,
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct GpuObservation {
    pub id: Option<String>,
    pub name: Option<String>,
    pub memory_total_bytes: Option<u64>,
    pub memory_free_bytes: Option<u64>,
    /// None means unobserved; false means the host collector reported unsupported counters.
    pub memory_supported: Option<bool>,
    pub driver_major: Option<u32>,
    /// Major times ten plus minor, matching the runtime's hardware contract.
    pub compute_capability: Option<u32>,
}

/// Missing measurements remain unknown; an empty advertisement is not GPU absence.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct HardwareObservation {
    pub status: ObservationStatus,
    pub reason: Option<String>,
    pub source: String,
    pub engine_id: Option<String>,
    pub architecture: Option<String>,
    pub operating_system: Option<String>,
    pub memory_bytes: Option<u64>,
    pub available_memory_bytes: Option<u64>,
    pub cpus: Option<u64>,
    pub disk_free_bytes: Option<u64>,
    pub gpu_status: ObservationStatus,
    pub gpu_inventory_complete: bool,
    pub gpus: Vec<GpuObservation>,
    pub engine_features: EngineFeatures,
}

impl HardwareObservation {
    fn unknown() -> Self {
        Self {
            status: ObservationStatus::Unknown,
            reason: None,
            source: "engine_info".into(),
            engine_id: None,
            architecture: None,
            operating_system: None,
            memory_bytes: None,
            available_memory_bytes: None,
            cpus: None,
            disk_free_bytes: None,
            gpu_status: ObservationStatus::Unknown,
            gpu_inventory_complete: false,
            gpus: Vec::new(),
            engine_features: EngineFeatures::default(),
        }
    }

    fn from_info(info: SystemInfo) -> Self {
        let mut observation = Self::unknown();
        observation.status = ObservationStatus::Available;
        observation.engine_features = engine_features(&info);
        observation.engine_id = info.id;
        observation.architecture = info.architecture;
        observation.operating_system = info.os_type;
        observation.memory_bytes = info
            .mem_total
            .and_then(|bytes| bytes.try_into().ok())
            .filter(|bytes| *bytes > 0);
        observation.cpus = info
            .ncpu
            .and_then(|cpus| cpus.try_into().ok())
            .filter(|cpus| *cpus > 0);
        for resource in info.generic_resources.unwrap_or_default() {
            if let Some(named) = resource.named_resource_spec
                && named.kind.as_deref() == Some("NVIDIA-GPU")
                && let Some(id) = named.value.filter(|value| !value.is_empty())
                && !observation
                    .gpus
                    .iter()
                    .any(|gpu| gpu.id.as_ref() == Some(&id))
            {
                observation.gpus.push(GpuObservation {
                    id: Some(id),
                    name: None,
                    memory_total_bytes: None,
                    memory_free_bytes: None,
                    memory_supported: None,
                    driver_major: None,
                    compute_capability: None,
                });
            }
        }
        if !observation.gpus.is_empty() {
            observation.gpu_status = ObservationStatus::Available;
        }
        observation.reason = Some("Engine advertisements do not establish complete GPU inventory, driver, compute capability, or memory capacity.".into());
        observation
    }
}

/// Read only the selected engine API. Never run a collector, inspect the client's
/// host, start a probe container, or infer GPU absence from missing advertisements.
pub async fn observe_hardware(connections: &Connections, endpoint: &str) -> HardwareObservation {
    let work = async { connections.resolve(endpoint)?.info().await };
    match tokio::time::timeout(Duration::from_secs(5), work).await {
        Ok(Ok(info)) => HardwareObservation::from_info(info),
        _ => {
            let mut observation = HardwareObservation::unknown();
            observation.reason =
                Some("Hardware information from the selected engine is unobservable.".into());
            observation
        }
    }
}

/// Explicit direct operation using the existing hardware collector contract.
/// Callers select the observer; provider refresh never invokes this operation.
/// A failed or mismatched collector never falls back to measurements on this client.
pub async fn observe_host_hardware(
    engine: &Engine,
    observer: &dyn HostObserver,
) -> HardwareObservation {
    let work = async {
        let info = engine.info().await?;
        let host = observer.observe(engine).await?;
        let capacity = host.for_engine(info.id.as_deref().unwrap_or(""))?;
        if capacity.architecture.is_empty()
            || capacity.total == 0
            || capacity.available > capacity.total
            || capacity.free > capacity.total
            || capacity
                .gpu_memory
                .as_ref()
                .is_some_and(|memory| memory.total == 0 || memory.free > memory.total)
        {
            return Err(crate::Error::State(
                "host hardware measurements are incomplete or inconsistent",
            ));
        }
        Ok::<_, crate::Error>((info, capacity))
    };
    match tokio::time::timeout(Duration::from_secs(30), work).await {
        Ok(Ok((info, capacity))) => {
            let mut observation = HardwareObservation::from_info(info);
            observation.source = "explicit_host_observer".into();
            observation.reason = None;
            observation.architecture = Some(capacity.architecture);
            observation.memory_bytes = Some(capacity.total);
            observation.available_memory_bytes = Some(capacity.available);
            observation.disk_free_bytes = Some(capacity.disk_free);
            if !capacity.gpu.is_empty() {
                observation.gpu_status = ObservationStatus::Available;
                observation.gpu_inventory_complete =
                    capacity.driver_major > 0 && capacity.compute_capability > 0;
                observation.gpus = vec![GpuObservation {
                    id: None,
                    name: Some(capacity.gpu),
                    memory_total_bytes: capacity.gpu_memory.as_ref().map(|memory| memory.total),
                    memory_free_bytes: capacity.gpu_memory.as_ref().map(|memory| memory.free),
                    memory_supported: Some(capacity.gpu_memory.is_some()),
                    driver_major: (capacity.driver_major > 0).then_some(capacity.driver_major),
                    compute_capability: (capacity.compute_capability > 0)
                        .then_some(capacity.compute_capability),
                }];
            }
            observation
        }
        _ => {
            let mut observation = HardwareObservation::unknown();
            observation.source = "explicit_host_observer".into();
            observation.reason =
                Some("Host hardware could not be verified against the selected engine.".into());
            observation
        }
    }
}
