// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use crate::{
    Error,
    hardware::{Capacity, Gpu},
    ollama::{ManagedOllama, hardware_capacity},
};
use process_wrap::tokio::CommandWrap;
use std::{collections::BTreeMap, path::Path, process::Stdio, time::Duration};

pub(crate) struct Readiness {
    endpoint: String,
    service: ManagedOllama,
    resident: u64,
}

/// Ollama's GPU memory settings for a budget that applies to each GPU.
#[derive(Debug, PartialEq, Eq)]
struct GpuLimits {
    /// `OLLAMA_GPU_OVERHEAD`, which Ollama holds back on every GPU it sees.
    overhead: u64,
    /// The most GPU memory the loaded model may hold, summed over the GPUs.
    resident: u64,
}

/// Ollama loads a model on one GPU when it fits there and splits it across
/// the GPUs it sees otherwise. A reserve of the largest free memory minus the
/// budget leaves no GPU more than the budget, and every GPU must have the
/// budget free. Ollama's `/api/ps` reports one total instead of each GPU's
/// share, so the resident bound is the budget times the number of GPUs.
fn gpu_limits(budget: u64, gpus: &[Gpu]) -> Result<GpuLimits, Error> {
    let count = u64::try_from(gpus.len())
        .ok()
        .filter(|count| *count > 0)
        .ok_or(Error::State("GPU inventory is unobservable"))?;
    let resident = budget
        .checked_mul(count)
        .ok_or(Error::Conflict("invalid Ollama serving budget"))?;
    // Unified-memory GPUs report no framebuffer counters, and Ollama gets no reserve.
    if gpus.iter().all(|gpu| gpu.memory.is_none()) {
        return Ok(GpuLimits {
            overhead: 0,
            resident,
        });
    }
    let mut largest = 0;
    for gpu in gpus {
        let memory = gpu
            .memory
            .as_ref()
            .ok_or(Error::State("dedicated GPU memory is unobservable"))?;
        if memory.free < budget {
            return Err(Error::Conflict(
                "available GPU memory does not satisfy the Ollama budget",
            ));
        }
        largest = largest.max(memory.free);
    }
    Ok(GpuLimits {
        overhead: largest - budget,
        resident,
    })
}

pub(crate) fn launch(
    service: &ManagedOllama,
    model: &Path,
    capacity: &Capacity,
) -> Result<(CommandWrap, Readiness), Error> {
    let directory = model
        .to_str()
        .ok_or(Error::State("invalid Ollama model storage path"))?;
    let total = hardware_capacity::serving_memory(service, capacity)?;
    let budget = hardware_capacity::budget(service, capacity)?;
    let limits = gpu_limits(budget, &capacity.gpus)?;
    if budget > total {
        return Err(Error::Conflict("invalid Ollama serving budget"));
    }
    let environment: BTreeMap<String, String> = [
        ("OLLAMA_HOST", format!("0.0.0.0:{}", service.serving.port)),
        ("OLLAMA_MODELS", directory.into()),
        (
            "OLLAMA_CONTEXT_LENGTH",
            service.serving.context_tokens.to_string(),
        ),
        (
            "OLLAMA_NUM_PARALLEL",
            service.serving.max_sequences.to_string(),
        ),
        ("OLLAMA_MAX_LOADED_MODELS", "1".into()),
        ("OLLAMA_KEEP_ALIVE", "-1".into()),
        ("OLLAMA_GPU_OVERHEAD", limits.overhead.to_string()),
        (
            "OLLAMA_LOAD_TIMEOUT",
            format!("{}s", service.serving.startup_timeout_seconds),
        ),
        ("OLLAMA_NOPRUNE", "true".into()),
        ("OLLAMA_NO_CLOUD", "true".into()),
        ("OLLAMA_VULKAN", "false".into()),
    ]
    .into_iter()
    .map(|(key, value)| (key.into(), value))
    .collect();
    let command = CommandWrap::with_new("/bin/ollama", |command| {
        command
            .arg("serve")
            .envs(environment)
            .stdin(Stdio::null())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit());
    });
    Ok((
        command,
        Readiness {
            endpoint: format!("http://127.0.0.1:{}", service.serving.port),
            service: service.clone(),
            resident: limits.resident,
        },
    ))
}

pub(crate) async fn wait_ready(
    readiness: Readiness,
    ready: tokio::sync::mpsc::Sender<bool>,
) -> Result<(), Error> {
    let client = reqwest::Client::builder()
        .no_proxy()
        .connect_timeout(Duration::from_secs(2))
        .timeout(Duration::from_secs(
            readiness.service.serving.startup_timeout_seconds as u64,
        ))
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .build()
        .map_err(|_| Error::State("cannot initialize Ollama readiness transport"))?;
    super::observation::load(&client, &readiness.endpoint, &readiness.service).await?;
    super::observation::check(
        &client,
        &readiness.endpoint,
        &readiness.service,
        readiness.resident,
    )
    .await?;
    let _ = ready.send(true).await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        hardware::{GIB, Gpu, GpuMemory, nvidia},
        vllm::{DedicatedHardware, ServiceHardware},
    };

    fn gpu(index: u32, memory: Option<(u64, u64)>) -> Gpu {
        Gpu {
            index,
            uuid: format!("GPU-{index}"),
            name: "NVIDIA H100 80GB HBM3".into(),
            driver_major: 580,
            compute_capability: 90,
            memory: memory.map(|(total, free)| GpuMemory { total, free }),
        }
    }

    #[test]
    fn ollama_keeps_the_budget_free_on_every_gpu_and_holds_the_model_within_each_gpus_budget() {
        let budget = 16 * GIB;
        let one = [gpu(0, Some((80 * GIB, 70 * GIB)))];
        assert_eq!(
            gpu_limits(budget, &one).unwrap(),
            GpuLimits {
                overhead: 54 * GIB,
                resident: budget,
            }
        );
        let unified = [gpu(0, None)];
        assert_eq!(
            gpu_limits(budget, &unified).unwrap(),
            GpuLimits {
                overhead: 0,
                resident: budget,
            }
        );
        let two = [
            gpu(0, Some((80 * GIB, 70 * GIB))),
            gpu(1, Some((80 * GIB, 30 * GIB))),
        ];
        assert_eq!(
            gpu_limits(budget, &two).unwrap(),
            GpuLimits {
                overhead: 54 * GIB,
                resident: 2 * budget,
            }
        );
        let short = [
            gpu(0, Some((80 * GIB, 70 * GIB))),
            gpu(1, Some((80 * GIB, 15 * GIB))),
        ];
        let error = gpu_limits(budget, &short).unwrap_err().to_string();
        assert!(
            error.contains("does not satisfy the Ollama budget"),
            "{error}"
        );
        let partly_unobservable = [gpu(0, Some((80 * GIB, 70 * GIB))), gpu(1, None)];
        assert!(gpu_limits(budget, &partly_unobservable).is_err());
        assert!(gpu_limits(budget, &[]).is_err());
    }

    #[test]
    fn one_gpu_keeps_its_overhead_and_ollama_keeps_its_own_placement() {
        let mut service = ManagedOllama {
            hardware: Some(ServiceHardware::Dedicated(DedicatedHardware {
                architecture: "amd64".into(),
                min_compute_capability: 90,
                min_gpu_memory_bytes: 4 * GIB,
                min_driver_major: 580,
            })),
            ..Default::default()
        };
        service.defaults();
        let mut capacity = Capacity::default();
        nvidia::apply_observations(
            &mut capacity,
            "0, GPU-b1b1b1b1-0000-0000-0000-000000000000, NVIDIA H100 80GB HBM3, 9.0, 81920, 71680, 580.65.06",
            "",
        )
        .unwrap();
        let (command, readiness) = launch(&service, Path::new("/data/ollama"), &capacity).unwrap();
        let environment: BTreeMap<_, _> = command
            .command()
            .as_std()
            .get_envs()
            .map(|(key, value)| {
                (
                    key.to_string_lossy().into_owned(),
                    value.map(|value| value.to_string_lossy().into_owned()),
                )
            })
            .collect();
        assert_eq!(
            environment["OLLAMA_GPU_OVERHEAD"],
            Some((54 * GIB).to_string())
        );
        assert!(!environment.contains_key("OLLAMA_SCHED_SPREAD"));
        assert_eq!(readiness.resident, 16 * GIB);
    }
}
