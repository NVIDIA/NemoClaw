// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use crate::{Error, docker::Connections, hardware::Capacity};
use nemoclaw_runtime::{RuntimeSpec, ollama::ManagedOllama};

/// Total serving memory required by the selected services on one execution engine.
/// Unified memory includes the largest host reserve once; dedicated memory uses
/// each selected GPU's VRAM, and the bytes describe the GPU with the least room.
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
    if let Some(devices) = gpu_devices {
        validate_capacity_gpu_devices(
            &devices
                .iter()
                .map(|device| Some(device.as_str()))
                .collect::<Vec<_>>(),
        )?;
    }
    let engine = crate::managed::service_engine(connections, endpoint)?;
    let work = async {
        let capacity = observe_selected(&engine, gpu_devices).await?;
        Ok(account(&services, &capacity)?.total)
    };
    tokio::time::timeout(std::time::Duration::from_secs(30), work)
        .await
        .map_err(|_| Error::State("combined capacity observation timed out"))?
}

/// Observe the engine's host in one read and resolve each `gpu_devices`
/// entry, an index or a UUID, to the GPU the host reports for it, so two
/// entries that name one GPU are refused. A single entry is read alone through
/// `nvidia-smi --id`. Without the list, the host must show one GPU.
async fn observe_selected(
    engine: &crate::docker::Engine,
    gpu_devices: Option<&[String]>,
) -> Result<Capacity, Error> {
    let only = match gpu_devices {
        Some([device]) => Some(device.as_str()),
        _ => None,
    };
    let observation = engine.host_observer.observe(engine, only).await?;
    let info = engine.info().await?;
    let mut host = observation.for_engine(info.id.as_deref().unwrap_or(""))?;
    let Some(devices) = gpu_devices else {
        host.require_one_gpu()?;
        return Ok(host);
    };
    let mut selected: Vec<crate::hardware::Gpu> = Vec::new();
    for device in devices {
        let gpu = host
            .gpus
            .iter()
            .find(|gpu| gpu.uuid == *device || gpu.index.to_string() == *device)
            .ok_or(Error::Conflict(
                "a gpu_devices entry names no GPU on the engine's host",
            ))?;
        if selected.iter().any(|seen| seen.uuid == gpu.uuid) {
            return Err(Error::Conflict("gpu_devices lists one GPU twice"));
        }
        selected.push(gpu.clone());
    }
    host.set_gpus(selected);
    Ok(host)
}

struct Accounting {
    total: ServiceCapacity,
}
/// Add up the budgets on each selected GPU. A dedicated-memory budget applies to
/// each GPU the services select, so every selected GPU must hold the sum of
/// the services' budgets on it; unified memory budgets host memory, with the
/// largest host reserve once.
fn account(services: &[(CapacityService, bool)], capacity: &Capacity) -> Result<Accounting, Error> {
    use nemoclaw_runtime::{ollama::hardware_capacity as ollama, vllm::hardware_capacity as vllm};
    let mut reserve = 0_u64;
    let mut architecture = None;
    for (service, starting) in services {
        let (kind, host_reserve) = match service {
            CapacityService::Ollama(service) => {
                ollama::check_memory(service, capacity, *starting)?;
                (
                    service.memory_architecture()?,
                    service.memory.host_reserve_gib,
                )
            }
            CapacityService::Vllm(service) => {
                vllm::check_memory(service, capacity, *starting)?;
                (
                    service.memory_architecture()?,
                    service.memory.host_reserve_gib,
                )
            }
        };
        if architecture.is_some_and(|expected| expected != kind) {
            return Err(crate::Error::Conflict(
                "services sharing an engine must use the same GPU memory contract",
            ));
        }
        architecture = Some(kind);
        reserve = reserve.max(host_reserve as u64 * crate::hardware::GIB);
    }
    let overflow = || Error::State("combined GPU budget overflow");
    // The services' budgets on memory of `total` bytes: a vLLM utilization is
    // taken of each GPU's own total; Ollama's budget is one amount on every GPU.
    let budgets = |total: u64| {
        services.iter().try_fold(0_u64, |sum, (service, _)| {
            let budget = match service {
                CapacityService::Ollama(service) => ollama::budget(service, capacity)?,
                CapacityService::Vllm(service) => vllm::gpu_budget(service, total)?,
            };
            sum.checked_add(budget).ok_or_else(overflow)
        })
    };
    let dedicated = architecture == Some(nemoclaw_runtime::vllm::MemoryArchitecture::Dedicated);
    // Each selected GPU's required and observed bytes.
    let gpus = capacity
        .selected_gpus()?
        .iter()
        .map(|gpu| {
            if dedicated {
                let total = gpu
                    .memory
                    .as_ref()
                    .ok_or(Error::State("dedicated GPU memory is unobservable"))?
                    .total;
                Ok((budgets(total)?, total))
            } else {
                Ok((
                    budgets(capacity.total)?
                        .checked_add(reserve)
                        .ok_or_else(overflow)?,
                    capacity.total,
                ))
            }
        })
        .collect::<Result<Vec<(u64, u64)>, Error>>()?;
    // The totals describe the GPU with the least room, so they're compatible
    // exactly when every GPU is.
    let (required_bytes, observed_bytes) = gpus
        .into_iter()
        .min_by_key(|(required, observed)| i128::from(*observed) - i128::from(*required))
        .ok_or(Error::State("no GPU was observed"))?;
    let total = ServiceCapacity {
        required_bytes,
        observed_bytes,
    };
    Ok(Accounting { total })
}

enum CapacityService {
    Ollama(ManagedOllama),
    Vllm(nemoclaw_runtime::vllm::Service),
}

#[cfg(test)]
pub(crate) mod tests;
