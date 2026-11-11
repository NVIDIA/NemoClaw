// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::ManagedOllama;
use crate::vllm::MemoryArchitecture;
use crate::{
    Error,
    hardware::{Capacity, GIB, at_least},
};

pub fn check_memory(
    service: &ManagedOllama,
    capacity: &Capacity,
    starting: bool,
) -> Result<(), Error> {
    service.validate()?;
    check_compatibility(service, capacity)?;
    let reserve = service.memory.host_reserve_gib as u64 * GIB;
    if service.memory_architecture()? == MemoryArchitecture::Dedicated {
        check_gpus(budget(service, capacity)?, capacity, starting)?;
        at_least("host total memory (bytes)", reserve, capacity.total)?;
        if starting {
            at_least(
                "host available memory (bytes)",
                reserve + 20 * GIB,
                capacity.available,
            )?;
        }
    } else {
        let budget = service.gpu_bytes()?;
        at_least(
            "host total memory (bytes)",
            budget + reserve,
            capacity.total,
        )?;
        if starting {
            at_least(
                "host available memory (bytes)",
                budget + 20 * GIB,
                capacity.available,
            )?;
        }
    }
    Ok(())
}

/// The memory a budget fraction applies to: the smallest total among the
/// selected GPUs, so one budget fits each of them.
/// Each selected GPU must hold the budget, and at start have it free.
fn check_gpus(budget: u64, capacity: &Capacity, starting: bool) -> Result<(), Error> {
    for gpu in capacity.gpu_memories()? {
        at_least("GPU total memory (bytes)", budget, gpu.total)?;
        if starting {
            at_least("GPU free memory (bytes)", budget, gpu.free)?;
        }
    }
    Ok(())
}

pub fn serving_memory(service: &ManagedOllama, capacity: &Capacity) -> Result<u64, Error> {
    if service.memory_architecture()? == MemoryArchitecture::Dedicated {
        capacity
            .gpu_memories()?
            .iter()
            .map(|gpu| gpu.total)
            .min()
            .ok_or(Error::State("dedicated GPU memory is unobservable"))
    } else {
        Ok(capacity.total)
    }
}

/// The budget applies to each selected GPU.
pub fn budget(service: &ManagedOllama, capacity: &Capacity) -> Result<u64, Error> {
    let total = serving_memory(service, capacity)?;
    let budget = service
        .memory
        .gpu_memory_utilization
        .as_ref()
        .and_then(serde_json::Number::as_f64)
        .map_or(service.gpu_bytes()?, |ratio| {
            (total as f64 * ratio).floor() as u64
        });
    if budget == 0 || budget > total {
        return Err(Error::Conflict("invalid Ollama serving memory budget"));
    }
    Ok(budget)
}

/// What Ollama may load in all: the per-GPU budget on each selected GPU.
/// Unified memory has one pool.
pub fn total_budget(service: &ManagedOllama, capacity: &Capacity) -> Result<u64, Error> {
    let budget = budget(service, capacity)?;
    let gpus = if service.memory_architecture()? == MemoryArchitecture::Dedicated {
        capacity.gpu_memories()?.len() as u64
    } else {
        1
    };
    budget
        .checked_mul(gpus)
        .ok_or(Error::Conflict("invalid Ollama serving memory budget"))
}

/// Ollama's `OLLAMA_GPU_OVERHEAD`, which it reserves on every GPU. The
/// largest free memory minus the budget leaves no GPU offering more than the
/// budget.
pub fn overhead(service: &ManagedOllama, capacity: &Capacity) -> Result<u64, Error> {
    let budget = budget(service, capacity)?;
    if service.memory_architecture()? != MemoryArchitecture::Dedicated {
        return Ok(0);
    }
    let most = capacity
        .gpu_memories()?
        .iter()
        .map(|gpu| gpu.free)
        .max()
        .ok_or(Error::State("dedicated GPU memory is unobservable"))?;
    most.checked_sub(budget).ok_or(Error::Conflict(
        "available GPU memory does not satisfy the Ollama budget",
    ))
}

fn check_compatibility(service: &ManagedOllama, capacity: &Capacity) -> Result<(), Error> {
    if !(10..=999).contains(&capacity.compute_capability) {
        return Err(Error::State("GPU compute capability is unobservable"));
    }
    if let Some(hardware) = &service.hardware {
        hardware.check_compatibility(capacity)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hardware::{Gpu, GpuMemory};

    fn service(budget_gib: i64) -> ManagedOllama {
        let mut service = ManagedOllama::default();
        service.memory.gpu_memory_gib = budget_gib;
        service.hardware = Some(crate::vllm::ServiceHardware::Dedicated(
            crate::vllm::DedicatedHardware {
                architecture: "amd64".into(),
                min_compute_capability: 90,
                min_gpu_memory_bytes: 4 * GIB,
                min_driver_major: 580,
            },
        ));
        service
    }

    fn host(free_gib: &[u64]) -> Capacity {
        Capacity {
            architecture: "amd64".into(),
            compute_capability: 90,
            driver_major: 580,
            total: 512 * GIB,
            available: 400 * GIB,
            gpus: free_gib
                .iter()
                .enumerate()
                .map(|(index, free)| Gpu {
                    index: index as u32,
                    uuid: format!("GPU-{index}"),
                    name: "NVIDIA H200".into(),
                    driver_major: 580,
                    compute_capability: 90,
                    memory: Some(GpuMemory {
                        total: 141 * GIB,
                        free: free * GIB,
                    }),
                })
                .collect(),
            ..Default::default()
        }
    }

    #[test]
    fn one_gpu_keeps_its_overhead() {
        let capacity = host(&[130]);
        assert_eq!(overhead(&service(100), &capacity).unwrap(), 30 * GIB);
        assert_eq!(total_budget(&service(100), &capacity).unwrap(), 100 * GIB);
    }

    #[test]
    fn overhead_leaves_no_gpu_above_the_budget() {
        let capacity = host(&[120, 135, 128]);
        assert_eq!(overhead(&service(100), &capacity).unwrap(), 35 * GIB);
        assert_eq!(total_budget(&service(100), &capacity).unwrap(), 300 * GIB);
        check_gpus(100 * GIB, &capacity, true).unwrap();
    }

    #[test]
    fn every_selected_gpu_needs_the_budget_free() {
        let capacity = host(&[130, 90]);
        assert!(check_gpus(100 * GIB, &capacity, true).is_err());
        // Planning checks totals only: free memory is a start-time fact.
        check_gpus(100 * GIB, &capacity, false).unwrap();
    }

    #[test]
    fn utilization_applies_to_the_smallest_total() {
        let mut capacity = host(&[130, 130]);
        capacity.gpus[1].memory.as_mut().unwrap().total = 100 * GIB;
        let mut service = service(0);
        service.memory.gpu_memory_utilization = Some(serde_json::Number::from_f64(0.5).unwrap());
        assert_eq!(budget(&service, &capacity).unwrap(), 50 * GIB);
    }
}
