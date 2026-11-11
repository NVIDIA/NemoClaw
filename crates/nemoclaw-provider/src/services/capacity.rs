// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use crate::{Error, docker::Connections, hardware::Capacity};
use nemoclaw_runtime::{RuntimeSpec, ollama::ManagedOllama};

/// Total serving memory required by the selected services on one execution engine.
/// Unified memory includes the largest host reserve once; dedicated memory uses VRAM.
#[derive(Debug)]
pub struct ServiceCapacity {
    pub required_bytes: u64,
    pub observed_bytes: u64,
}
impl ServiceCapacity {
    pub fn compatible(&self) -> bool {
        self.required_bytes <= self.observed_bytes
    }
    pub fn require(&self) -> Result<(), Error> {
        crate::hardware::at_least(
            "combined service memory (bytes)",
            self.required_bytes,
            self.observed_bytes,
        )
        .map_err(Into::into)
    }
}

/// Each runtime contract is one service; engine placement is the caller's.
fn parse(
    engine: Option<&str>,
    contracts: &[String],
) -> Result<Vec<(CapacityService, bool)>, Error> {
    if contracts.is_empty() {
        return Err(Error::Conflict(
            "service capacity requires at least one runtime contract",
        ));
    }
    if let Some(engine) = engine {
        crate::config::validate_engine_endpoint(engine)?;
    }
    // Two services cannot share a contract: each serves its own port.
    let mut seen = std::collections::BTreeSet::new();
    contracts
        .iter()
        .map(|encoded| {
            if !seen.insert(encoded) {
                return Err(Error::Conflict(
                    "duplicate runtime contract in capacity requirements",
                ));
            }
            let service = match RuntimeSpec::decode(encoded)? {
                RuntimeSpec::Vllm(service) => CapacityService::Vllm(*service),
                RuntimeSpec::Ollama(service) => CapacityService::Ollama(*service),
            };
            Ok((service, false))
        })
        .collect()
}
/// Validate capacity inputs without contacting hosts or resolving credentials.
pub fn validate_capacity_contracts(
    engine: Option<&str>,
    contracts: &[String],
) -> Result<(), Error> {
    parse(engine, contracts).map(|_| ())
}
/// The error for a `gpu_devices` entry that names no single GPU.
pub(crate) const GPU_DEVICES_ENTRY: &str =
    "each gpu_devices entry must be a lowercase GPU UUID or an index from \"0\" to \"999\"";
/// Accept the GPUs a capacity read observes as `container.gpuDevices` lists them:
/// UUIDs or indexes, without repeats, and exactly one for now. `None` is an
/// entry not yet known.
pub fn validate_capacity_gpu_devices(devices: &[Option<&str>]) -> Result<(), Error> {
    let pattern =
        regex::Regex::new(nemoclaw_sdk::config::GPU_DEVICE).expect("the GPU pattern compiles");
    let mut seen = std::collections::BTreeSet::new();
    for device in devices.iter().flatten() {
        if !pattern.is_match(device) {
            return Err(Error::Conflict(GPU_DEVICES_ENTRY));
        }
        if !seen.insert(device) {
            return Err(Error::Conflict("gpu_devices must not repeat a GPU"));
        }
    }
    // Serving one model across several GPUs will lift this limit; the rules
    // above already refuse repeats.
    if devices.len() != 1 {
        return Err(Error::Conflict(
            "gpu_devices must list exactly one GPU: serving one model across several GPUs isn't implemented yet",
        ));
    }
    Ok(())
}
/// Read total capacity without treating an existing process's allocations as new demand.
/// With `gpu_devices`, only the listed GPU is observed.
pub async fn observe_service_capacity(
    connections: &Connections,
    endpoint: &str,
    contracts: &[String],
    gpu_devices: Option<&[String]>,
) -> Result<ServiceCapacity, Error> {
    let services = parse(Some(endpoint), contracts)?;
    let gpu = match gpu_devices {
        Some(devices) => {
            validate_capacity_gpu_devices(
                &devices
                    .iter()
                    .map(|device| Some(device.as_str()))
                    .collect::<Vec<_>>(),
            )?;
            devices.first().map(String::as_str)
        }
        None => None,
    };
    let engine = crate::managed::service_engine(connections, endpoint)?;
    let work = async {
        let host = engine.host_observer.observe(&engine, gpu).await?;
        let info = engine.info().await?;
        let capacity = host.for_engine(info.id.as_deref().unwrap_or(""))?;
        Ok(account(&services, &capacity)?.total)
    };
    tokio::time::timeout(std::time::Duration::from_secs(30), work)
        .await
        .map_err(|_| Error::State("combined capacity observation timed out"))?
}

struct Accounting {
    total: ServiceCapacity,
}
fn account(services: &[(CapacityService, bool)], capacity: &Capacity) -> Result<Accounting, Error> {
    let mut total_budget = 0_u64;
    let mut reserve = 0_u64;
    let mut architecture = None;
    for (service, starting) in services {
        let (kind, budget, host_reserve) = match service {
            CapacityService::Ollama(service) => {
                nemoclaw_runtime::ollama::hardware_capacity::check_memory(
                    service, capacity, *starting,
                )?;
                (
                    service.memory_architecture()?,
                    nemoclaw_runtime::ollama::hardware_capacity::budget(service, capacity)?,
                    service.memory.host_reserve_gib as u64 * crate::hardware::GIB,
                )
            }
            CapacityService::Vllm(service) => {
                nemoclaw_runtime::vllm::hardware_capacity::check_memory(
                    service, capacity, *starting,
                )?;
                let total =
                    nemoclaw_runtime::vllm::hardware_capacity::serving_memory(service, capacity)?;
                let budget = service
                    .memory
                    .gpu_memory_utilization
                    .as_ref()
                    .and_then(serde_json::Number::as_f64)
                    .map_or(service.gpu_bytes()?, |ratio| {
                        (total as f64 * ratio).floor() as u64
                    });
                (
                    service.memory_architecture()?,
                    budget,
                    service.memory.host_reserve_gib as u64 * crate::hardware::GIB,
                )
            }
        };
        if architecture.is_some_and(|expected| expected != kind) {
            return Err(crate::Error::Conflict(
                "services sharing an engine must use the same GPU memory contract",
            ));
        }
        architecture = Some(kind);
        total_budget = total_budget
            .checked_add(budget)
            .ok_or(crate::Error::State("combined GPU budget overflow"))?;
        reserve = reserve.max(host_reserve);
    }
    let dedicated = architecture == Some(nemoclaw_runtime::vllm::MemoryArchitecture::Dedicated);
    let total = ServiceCapacity {
        required_bytes: if dedicated {
            total_budget
        } else {
            total_budget
                .checked_add(reserve)
                .ok_or(Error::State("combined GPU budget overflow"))?
        },
        observed_bytes: if dedicated {
            capacity
                .gpu_memory
                .as_ref()
                .ok_or(Error::State("dedicated GPU memory is unobservable"))?
                .total
        } else {
            capacity.total
        },
    };
    Ok(Accounting { total })
}

enum CapacityService {
    Ollama(ManagedOllama),
    Vllm(nemoclaw_runtime::vllm::Service),
}

#[cfg(test)]
pub(crate) mod tests;
