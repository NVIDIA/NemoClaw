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
pub(crate) async fn recheck(
    connections: &Connections,
    rows: &BTreeMap<String, Row>,
) -> Result<(), Error> {
    for (engine, specs) in groups(rows.iter().map(|(address, row)| (address.as_str(), row)))? {
        observe_service_capacity(connections, &engine, &specs)
            .await?
            .require()?;
    }
    Ok(())
}

struct Accounting {
    total: ServiceCapacity,
    startup_fits: bool,
}
fn account(services: &[(CapacityService, bool)], capacity: &Capacity) -> Result<Accounting, Error> {
    let mut total_budget = 0_u64;
    let mut new_budget = 0_u64;
    let mut reserve = 0_u64;
    let mut startup = 0_u64;
    let mut architecture = None;
    for (service, starting) in services {
        let (kind, budget, host_reserve, headroom) = match service {
            CapacityService::Ollama(service) => {
                installers::ollama::hardware_capacity::check_memory(service, capacity, *starting)?;
                (
                    service.memory_architecture()?,
                    installers::ollama::hardware_capacity::budget(service, capacity)?,
                    service.memory.host_reserve_gib as u64 * crate::hardware::GIB,
                    20 * crate::hardware::GIB,
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
                let headroom = service.recipe.as_ref().map_or(20, |recipe| {
                    recipe
                        .resources
                        .startup_headroom_gi_b
                        .max(recipe.resources.preparation_memory_gi_b)
                }) * crate::hardware::GIB;
                (
                    service.memory_architecture()?,
                    budget,
                    service.memory.host_reserve_gib as u64 * crate::hardware::GIB,
                    headroom,
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
        if *starting {
            new_budget = new_budget
                .checked_add(budget)
                .ok_or(crate::Error::State("combined GPU budget overflow"))?;
            startup = startup
                .checked_add(headroom)
                .ok_or(crate::Error::State("combined startup budget overflow"))?;
        }
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
    let startup_fits = if dedicated {
        new_budget <= capacity.gpu_memory.as_ref().unwrap().free
            && (new_budget == 0
                || reserve
                    .checked_add(startup)
                    .is_some_and(|required| required <= capacity.available))
    } else {
        new_budget
            .checked_add(startup)
            .is_some_and(|required| required <= capacity.available)
    };
    Ok(Accounting {
        total,
        startup_fits,
    })
}

/// Opaque installer capacity input retained between per-runtime and combined-engine checks.
pub(crate) struct RuntimeCapacity {
    engine: String,
    service: CapacityService,
    starting: bool,
}

enum CapacityService {
    Ollama(ManagedOllama),
    Vllm(installers::vllm::Service),
}

pub(crate) async fn check_process_capacity(
    engine: &crate::docker::Engine,
    spec: &crate::managed::Spec,
    observed: Option<&crate::managed::RuntimeObservation>,
) -> Result<(), crate::Error> {
    match spec.kind.as_str() {
        installers::vllm::SERVICE_KIND => engine.check_capacity(spec, observed).await,
        installers::ollama::SERVICE_KIND => {
            installers::ollama::capacity::check(engine, spec, observed).await
        }
        _ => Err(crate::Error::Conflict(
            "managed process kind has no registered capacity check",
        )),
    }
}

pub(crate) async fn check_runtime_capacity(
    engine: &crate::docker::Engine,
    spec: &crate::managed::Spec,
    observed: Option<&crate::managed::RuntimeObservation>,
) -> Result<Option<RuntimeCapacity>, crate::Error> {
    let service = match spec.kind.as_str() {
        installers::vllm::SERVICE_KIND => {
            CapacityService::Vllm(installers::vllm::configured_service(spec)?)
        }
        installers::ollama::SERVICE_KIND => {
            CapacityService::Ollama(installers::ollama::configured_service(spec)?)
        }
        _ => return Ok(None),
    };
    check_process_capacity(engine, spec, observed).await?;
    Ok(Some(RuntimeCapacity {
        engine: spec.engine().into(),
        service,
        starting: observed.is_none_or(|runtime| !runtime.running),
    }))
}

pub(crate) async fn check_combined_capacity(
    connections: &crate::docker::Connections,
    checks: Vec<RuntimeCapacity>,
) -> Result<(), crate::Error> {
    let mut grouped: BTreeMap<String, Vec<(CapacityService, bool)>> = BTreeMap::new();
    for check in checks {
        grouped
            .entry(check.engine)
            .or_default()
            .push((check.service, check.starting));
    }
    for (endpoint, services) in grouped {
        if services.len() < 2 {
            continue;
        }
        let engine = crate::managed::service_engine(connections, &endpoint)?;
        let capacity = tokio::time::timeout(std::time::Duration::from_secs(30), async {
            let host = engine.host_observer.observe(&engine).await?;
            let info = engine.info().await?;
            host.for_engine(info.id.as_deref().unwrap_or(""))
        })
        .await
        .map_err(|_| Error::State("combined capacity observation timed out"))??;
        let accounting = account(&services, &capacity)?;
        accounting.total.require()?;
        if !accounting.startup_fits {
            return Err(crate::Error::Conflict(
                "combined service budgets exceed available GPU or host startup memory",
            ));
        }
    }
    Ok(())
}

#[cfg(all(test, unix))]
mod tests;
