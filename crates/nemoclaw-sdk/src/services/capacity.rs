// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::{ManagedOllama, installers};
use crate::{Error, backend::Row, docker::Connections, hardware::Capacity, managed::Spec};
use std::collections::{BTreeMap, BTreeSet};

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
    }
}

fn service(spec: &Spec) -> Result<CapacityService, Error> {
    match spec.kind.as_str() {
        installers::vllm::SERVICE_KIND => Ok(CapacityService::Vllm(
            installers::vllm::configured_service(spec)?,
        )),
        installers::ollama::SERVICE_KIND => Ok(CapacityService::Ollama(
            installers::ollama::configured_service(spec)?,
        )),
        _ => Err(Error::Conflict("runtime has no hardware contract")),
    }
}
fn parse(engine: Option<&str>, specs: &[String]) -> Result<Vec<(CapacityService, bool)>, Error> {
    if specs.is_empty() {
        return Err(Error::Conflict(
            "service capacity requires at least one specification",
        ));
    }
    if let Some(engine) = engine {
        crate::docker::Engine::validate_endpoint(engine)?;
    }
    let mut names = BTreeSet::new();
    specs
        .iter()
        .map(|encoded| {
            let spec: Spec = serde_json::from_str(encoded)
                .map_err(|_| Error::State("invalid capacity specification"))?;
            super::validate_resource_spec(&spec.kind, encoded)?;
            if engine.is_some_and(|engine| spec.engine() != engine) {
                return Err(Error::Conflict(
                    "capacity engine differs from runtime specification",
                ));
            }
            if !names.insert((spec.kind.clone(), spec.name.clone())) {
                return Err(Error::Conflict(
                    "duplicate service in capacity requirements",
                ));
            }
            Ok((service(&spec)?, false))
        })
        .collect()
}
/// Validate capacity inputs without contacting hosts or resolving credentials.
pub fn validate_capacity_specs(engine: Option<&str>, specs: &[String]) -> Result<(), Error> {
    parse(engine, specs).map(|_| ())
}
/// Read total capacity without treating an existing process's allocations as new demand.
pub async fn observe_service_capacity(
    connections: &Connections,
    endpoint: &str,
    specs: &[String],
) -> Result<ServiceCapacity, Error> {
    let services = parse(Some(endpoint), specs)?;
    let engine = crate::managed::service_engine(connections, endpoint)?;
    let work = async {
        let host = engine.host_observer.observe(&engine).await?;
        let info = engine.info().await?;
        let capacity = host.for_engine(info.id.as_deref().unwrap_or(""))?;
        Ok(account(&services, &capacity)?.total)
    };
    tokio::time::timeout(std::time::Duration::from_secs(30), work)
        .await
        .map_err(|_| Error::State("combined capacity observation timed out"))?
}

pub(crate) fn observation_name(engine: &str) -> String {
    use sha2::{Digest, Sha256};
    format!(
        "engine_{}",
        Sha256::digest(engine.as_bytes())
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    )
}
pub(crate) fn observation_address(engine: &str) -> String {
    format!(
        "data.nemoclaw_service_capacity.{}",
        observation_name(engine)
    )
}
/// Derive groups solely from declared managed processes, never from live inventory.
pub(crate) fn groups<'a>(
    rows: impl IntoIterator<Item = (&'a str, &'a Row)>,
) -> Result<BTreeMap<String, Vec<String>>, Error> {
    let mut groups: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for (address, row) in rows {
        let kind = address
            .split_once('.')
            .map(|(kind, _)| kind.trim_start_matches("nemoclaw_"))
            .unwrap_or("");
        if !super::resource_behavior(kind).runtime_process {
            continue;
        }
        let encoded = row
            .get("spec")
            .ok_or(Error::State("capacity specification is missing"))?;
        super::validate_resource_spec(kind, encoded)?;
        let spec: Spec = serde_json::from_str(encoded)
            .map_err(|_| Error::State("invalid capacity specification"))?;
        groups
            .entry(spec.engine().into())
            .or_default()
            .push(encoded.clone());
    }
    Ok(groups)
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
                installers::ollama::hardware_capacity::check_memory(service, capacity, *starting)?;
                (
                    service.memory_architecture()?,
                    installers::ollama::hardware_capacity::budget(service, capacity)?,
                    service.memory.host_reserve_gib as u64 * crate::hardware::GIB,
                )
            }
            CapacityService::Vllm(service) => {
                installers::vllm::hardware_capacity::check_memory(service, capacity, *starting)?;
                let total = installers::vllm::hardware_capacity::serving_memory(service, capacity)?;
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
    let dedicated = architecture == Some(installers::vllm::MemoryArchitecture::Dedicated);
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
    Vllm(installers::vllm::Service),
}

/// Planning inspects existing model data; apply also resolves missing artifacts
/// and requires free memory for a process that must start.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum CapacityCheck {
    Plan,
    Apply { starting: bool },
}
impl CapacityCheck {
    pub(crate) fn starting(self) -> bool {
        matches!(self, Self::Apply { starting: true })
    }
}

#[cfg(all(test, unix))]
mod tests;
