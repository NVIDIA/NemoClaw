// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use crate::{
    Error,
    hardware::Capacity,
    ollama::{ManagedOllama, hardware_capacity},
};
use process_wrap::tokio::CommandWrap;
use std::{collections::BTreeMap, path::Path, process::Stdio, time::Duration};

pub(crate) struct Readiness {
    endpoint: String,
    service: ManagedOllama,
    /// The most GPU memory the loaded model may hold, summed over the GPUs.
    resident: u64,
}
/// llama.cpp's own per-device `--fit` margin, `fit_params_target` in
/// `common/common.h` of the llama.cpp revision Ollama v0.40.14 pins (b11963).
/// NemoClaw never sets a smaller one.
const LLAMA_FIT_TARGET_MIB: u64 = 1024;

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
    // `ollama serve --help` documents OLLAMA_GPU_OVERHEAD as a reserve on each
    // GPU, so the GPU with the most free memory sets it. Unified-memory GPUs
    // report no framebuffer counters and get no reserve. Ollama v0.40.14 reads
    // it only for logs, the default context size, and its MLX runner; GGUF
    // layer fitting uses llama.cpp's margin, LLAMA_ARG_FIT_TARGET, below.
    let overhead = capacity
        .gpus
        .iter()
        .filter_map(|gpu| gpu.memory.as_ref().map(|memory| memory.free))
        .max()
        .map_or(Ok(0), |free| {
            free.checked_sub(budget).ok_or(Error::Conflict(
                "available GPU memory does not satisfy the Ollama budget",
            ))
        })?;
    // Ollama's /api/ps reports one total, not each GPU's share.
    let resident = u64::try_from(capacity.gpus.len())
        .ok()
        .and_then(|gpus| budget.checked_mul(gpus))
        .ok_or(Error::Conflict("invalid Ollama serving budget"))?;
    if budget > total {
        return Err(Error::Conflict("invalid Ollama serving budget"));
    }
    let mut environment: BTreeMap<String, String> = [
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
        ("OLLAMA_GPU_OVERHEAD", overhead.to_string()),
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
    // The same reserve, rounded up to whole MiB, as llama.cpp's per-device
    // margin. Below llama.cpp's own margin, upstream's default applies.
    let fit_target = overhead.div_ceil(1 << 20);
    if fit_target >= LLAMA_FIT_TARGET_MIB {
        environment.insert("LLAMA_ARG_FIT_TARGET".into(), fit_target.to_string());
    }
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
            resident,
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
        hardware::{GIB, GpuMemory, nvidia},
        vllm::{DedicatedHardware, HardwareProfile, ServiceHardware},
    };

    const H100: &str = "0, GPU-b1b1b1b1-0000-0000-0000-000000000000, NVIDIA H100 80GB HBM3, 9.0, 81920, 71680, 580.65.06";

    /// A dedicated-memory service with the default 16 GiB budget.
    fn service() -> ManagedOllama {
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
        service
    }

    fn launched(capacity: &Capacity) -> (BTreeMap<String, Option<String>>, u64) {
        launched_with(&service(), capacity)
    }

    fn launched_with(
        service: &ManagedOllama,
        capacity: &Capacity,
    ) -> (BTreeMap<String, Option<String>>, u64) {
        let (command, readiness) = launch(service, Path::new("/data/ollama"), capacity).unwrap();
        let environment = command
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
        (environment, readiness.resident)
    }

    #[test]
    fn one_gpu_keeps_its_overhead_and_llama_cpp_keeps_the_same_margin() {
        let mut capacity = Capacity::default();
        nvidia::apply_observations(&mut capacity, H100, "").unwrap();
        let (environment, resident) = launched(&capacity);
        assert_eq!(
            environment["OLLAMA_GPU_OVERHEAD"],
            Some((54 * GIB).to_string())
        );
        assert_eq!(
            environment["LLAMA_ARG_FIT_TARGET"],
            Some((54 * 1024).to_string())
        );
        assert!(!environment.contains_key("OLLAMA_SCHED_SPREAD"));
        assert_eq!(resident, 16 * GIB);
    }

    #[test]
    fn a_reserve_below_llama_cpps_own_margin_leaves_its_default() {
        let barely = "0, GPU-b1b1b1b1-0000-0000-0000-000000000000, NVIDIA H100 80GB HBM3, 9.0, 81920, 17407, 580.65.06";
        let unified = "0, GPU-a0a0a0a0-0000-0000-0000-000000000000, NVIDIA GB10, 12.1, [N/A], [N/A], 580.95.05";
        let mut spark = service();
        spark.hardware = Some(ServiceHardware::Profile {
            profile: HardwareProfile::DgxSpark,
            architecture: None,
            min_gpu_memory_bytes: None,
        });
        for (gpu, service, overhead) in [(barely, service(), 1023 << 20), (unified, spark, 0)] {
            let mut capacity = Capacity {
                total: 128 * GIB,
                ..Default::default()
            };
            nvidia::apply_observations(&mut capacity, gpu, "").unwrap();
            let (environment, _) = launched_with(&service, &capacity);
            assert_eq!(
                environment["OLLAMA_GPU_OVERHEAD"],
                Some(u64::to_string(&overhead)),
                "{gpu}"
            );
            assert!(!environment.contains_key("LLAMA_ARG_FIT_TARGET"), "{gpu}");
        }
    }

    /// `populate` still refuses two GPUs, so this capacity is built by hand:
    /// the inventory of two GPUs, and one GPU's counters for the budget.
    #[test]
    fn several_gpus_take_the_overhead_from_the_most_free_memory_and_bound_the_total() {
        let mut capacity = Capacity::default();
        nvidia::apply_observations(
            &mut capacity,
            &format!(
                "{H100}\n1, GPU-c2c2c2c2-0000-0000-0000-000000000000, NVIDIA H100 80GB HBM3, 9.0, 81920, 30720, 580.65.06"
            ),
            "",
        )
        .unwrap();
        capacity.gpu_memory = Some(GpuMemory {
            total: 80 * GIB,
            free: 70 * GIB,
        });
        let (environment, resident) = launched(&capacity);
        assert_eq!(
            environment["OLLAMA_GPU_OVERHEAD"],
            Some((54 * GIB).to_string())
        );
        assert_eq!(
            environment["LLAMA_ARG_FIT_TARGET"],
            Some((54 * 1024).to_string())
        );
        assert!(!environment.contains_key("OLLAMA_SCHED_SPREAD"));
        assert_eq!(resident, 2 * 16 * GIB);
    }
}
