// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Passive target inventory and explicitly requested, daemon-bound host measurements.
use crate::discovery::ObservationStatus;
use bollard_stubs::models::SystemInfo;
use serde::{Deserialize, Serialize};

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
    pub fn unknown() -> Self {
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

    pub fn from_info(info: SystemInfo) -> Self {
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
