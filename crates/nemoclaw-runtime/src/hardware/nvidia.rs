// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::{Capacity, Gpu, GpuMemory};
use crate::Error;

/// Reads every GPU's inventory in one call, one CSV line per GPU.
pub const GPU_QUERY: &str =
    "--query-gpu=index,uuid,name,compute_cap,memory.total,memory.free,driver_version";
/// Lists the processes that hold GPU memory.
pub const PROCESS_QUERY: &str = "--query-compute-apps=pid";

#[cfg(target_os = "linux")]
pub async fn query(query: &str) -> Result<String, Error> {
    let output = tokio::process::Command::new("nvidia-smi")
        .args([query, "--format=csv,noheader,nounits"])
        .kill_on_drop(true)
        .output()
        .await
        .map_err(|_| Error::State("GPU observation failed"))?;
    if !output.status.success() || output.stdout.len() > 1 << 20 {
        return Err(Error::State("GPU observation failed or exceeded limit"));
    }
    String::from_utf8(output.stdout).map_err(|_| Error::State("GPU inventory is incomplete"))
}

/// Decode the output of [`GPU_QUERY`] and [`PROCESS_QUERY`]: every GPU, and
/// the number of processes that hold GPU memory.
pub fn inventory(gpus: &str, processes: &str) -> Result<(Vec<Gpu>, usize), Error> {
    let gpus = self::gpus(gpus)?;
    let mut seen = std::collections::BTreeSet::new();
    for line in processes.trim().lines() {
        let pid = line
            .trim()
            .parse::<u32>()
            .map_err(|_| Error::State("GPU process inventory is incomplete"))?;
        if pid == 0 || !seen.insert(pid) {
            return Err(Error::State("GPU process inventory is ambiguous"));
        }
    }
    Ok((gpus, seen.len()))
}

/// Decode the output of [`GPU_QUERY`], one GPU per line.
pub fn gpus(text: &str) -> Result<Vec<Gpu>, Error> {
    let incomplete = || Error::State("GPU inventory is incomplete");
    let mut gpus: Vec<Gpu> = Vec::new();
    for line in text.trim().lines() {
        let fields: Vec<_> = line.split(',').map(str::trim).collect();
        let [index, uuid, name, compute, total, free, driver] = fields[..] else {
            return Err(incomplete());
        };
        if uuid.is_empty() || name.is_empty() {
            return Err(incomplete());
        }
        let index = index.parse::<u32>().map_err(|_| incomplete())?;
        if gpus
            .iter()
            .any(|gpu| gpu.index == index || gpu.uuid == uuid)
        {
            return Err(Error::State("GPU inventory is ambiguous"));
        }
        gpus.push(Gpu {
            index,
            uuid: uuid.into(),
            name: name.into(),
            driver_major: driver_major(driver)?,
            compute_capability: compute_capability(compute)?,
            memory: framebuffer_memory(total, free)?,
        });
    }
    Ok(gpus)
}

fn driver_major(version: &str) -> Result<u32, Error> {
    version
        .split('.')
        .next()
        .unwrap_or("")
        .parse::<u32>()
        .map_err(|_| Error::State("driver version is unobservable"))
}

/// Decode one GPU's compute capability independently of its memory counters.
pub fn compute_capability(text: &str) -> Result<u32, Error> {
    let error = || Error::State("GPU compute capability is unobservable");
    let (major, minor) = text.trim().split_once('.').ok_or_else(error)?;
    let major = major.parse::<u32>().map_err(|_| error())?;
    let minor = minor.parse::<u32>().map_err(|_| error())?;
    if !(1..=99).contains(&major) || minor > 9 {
        return Err(error());
    }
    Ok(major * 10 + minor)
}

/// Preserve unsupported framebuffer counters without inferring a memory architecture.
/// NVIDIA documents N/A for unsupported fields: https://docs.nvidia.com/deploy/nvidia-smi/
fn framebuffer_memory(total: &str, free: &str) -> Result<Option<GpuMemory>, Error> {
    let error = || Error::State("GPU framebuffer memory observation is incomplete");
    if [total, free]
        .iter()
        .all(|field| matches!(*field, "N/A" | "[N/A]"))
    {
        return Ok(None);
    }
    let bytes = |s: &str| {
        s.parse::<u64>()
            .ok()
            .filter(|n| *n <= 4 * (1 << 20))
            .and_then(|n| n.checked_mul(1 << 20))
            .ok_or_else(error)
    };
    let total = bytes(total)?;
    let free = bytes(free)?;
    if total == 0 || free > total {
        return Err(error());
    }
    Ok(Some(GpuMemory { total, free }))
}

/// Record every observed GPU, and fill the single-GPU fields when there's
/// exactly one. Callers that need one GPU check with
/// [`Capacity::require_one_gpu`].
pub fn apply_observations(
    capacity: &mut Capacity,
    gpus: &str,
    processes: &str,
) -> Result<(), Error> {
    let (gpus, processes) = inventory(gpus, processes)?;
    capacity.foreign_gpu_processes = processes;
    capacity.set_gpus(gpus);
    Ok(())
}

/// Observe the one GPU this container sees.
#[cfg(target_os = "linux")]
pub async fn populate(capacity: &mut Capacity) -> Result<(), Error> {
    populate_with(capacity, query).await?;
    capacity.require_one_gpu()
}

/// Observe this host's GPUs through `query`, which runs one `nvidia-smi` query
/// and returns its CSV output.
#[cfg(target_os = "linux")]
pub async fn populate_with<F, Fut>(capacity: &mut Capacity, mut query: F) -> Result<(), Error>
where
    F: FnMut(&'static str) -> Fut,
    Fut: std::future::Future<Output = Result<String, Error>>,
{
    capacity.architecture = match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "amd64",
        other => other,
    }
    .into();
    let gpus = query(GPU_QUERY).await?;
    let processes = query(PROCESS_QUERY).await?;
    apply_observations(capacity, &gpus, &processes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hardware::GIB;

    const GB10: &str =
        "0, GPU-a0a0a0a0-0000-0000-0000-000000000000, NVIDIA GB10, 12.1, [N/A], [N/A], 580.95.05";
    #[cfg(target_os = "linux")]
    const H100: &str = "0, GPU-b1b1b1b1-0000-0000-0000-000000000000, NVIDIA H100 80GB HBM3, 9.0, 81920, 71680, 580.65.06";

    /// Eight H200 NVL GPUs at indexes 0 to 7, with the display GPU of a
    /// workstation at index 3.
    fn eight_gpus() -> String {
        (0..8)
            .map(|index| {
                let (name, compute, memory) = if index == 3 {
                    ("NVIDIA RTX A400", "8.6", "4094, 3900")
                } else {
                    ("NVIDIA H200 NVL", "9.0", "143771, 143000")
                };
                format!("{index}, GPU-{index}{index}{index}{index}{index}{index}{index}{index}-0000-0000-0000-000000000000, {name}, {compute}, {memory}, 580.65.06\n")
            })
            .collect()
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn native_collector_observes_compute_with_both_memory_modes_and_propagates_query_errors()
    {
        for (gpu, compute, memory) in [
            (GB10, 121, None),
            (
                H100,
                90,
                Some(GpuMemory {
                    total: 80 * GIB,
                    free: 70 * GIB,
                }),
            ),
        ] {
            let observations = [(GPU_QUERY, gpu), (PROCESS_QUERY, "")];
            let mut seen = Vec::new();
            let mut capacity = Capacity::default();
            populate_with(&mut capacity, |query| {
                seen.push(query);
                std::future::ready(Ok(observations
                    .iter()
                    .find(|(flag, _)| *flag == query)
                    .unwrap()
                    .1
                    .into()))
            })
            .await
            .unwrap();
            assert_eq!(seen, [GPU_QUERY, PROCESS_QUERY]);
            assert_eq!(capacity.compute_capability, compute);
            assert_eq!(capacity.driver_major, 580);
            assert_eq!(capacity.gpu_memory, memory);
            assert_eq!(capacity.gpus.len(), 1);
            capacity.require_one_gpu().unwrap();
            for failure in [GPU_QUERY, PROCESS_QUERY] {
                let result = populate_with(&mut capacity, |query| {
                    std::future::ready(if query == failure {
                        Err(Error::State("fixture query failure"))
                    } else {
                        Ok(observations
                            .iter()
                            .find(|(flag, _)| *flag == query)
                            .unwrap()
                            .1
                            .into())
                    })
                })
                .await;
                assert!(result.is_err(), "{gpu}: {failure}");
            }
        }
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn native_collector_lists_every_gpu_and_managed_inference_refuses_more_than_one() {
        let two = format!(
            "{H100}\n1, GPU-c2c2c2c2-0000-0000-0000-000000000000, NVIDIA L4, 8.9, 23034, 22000, 580.65.06\n"
        );
        for (text, count) in [(two, 2), (eight_gpus(), 8)] {
            let mut capacity = Capacity::default();
            populate_with(&mut capacity, |query| {
                std::future::ready(Ok(if query == GPU_QUERY {
                    text.clone()
                } else {
                    String::new()
                }))
            })
            .await
            .unwrap();
            assert_eq!(capacity.gpus.len(), count);
            assert_eq!(capacity.gpus, gpus(&text).unwrap());
            assert!(capacity.gpu.is_empty() && capacity.gpu_memory.is_none());
            assert_eq!((capacity.driver_major, capacity.compute_capability), (0, 0));
            let error = capacity.require_one_gpu().unwrap_err().to_string();
            assert!(
                error.contains("managed inference requires exactly one observable GPU"),
                "{error}"
            );
        }
        let mut capacity = Capacity::default();
        populate_with(&mut capacity, |_| std::future::ready(Ok(String::new())))
            .await
            .unwrap();
        assert!(capacity.require_one_gpu().is_err());
    }

    #[test]
    fn gpu_parser_reads_each_gpu_with_its_own_name_and_memory() {
        let gpus = gpus(&eight_gpus()).unwrap();
        assert_eq!(
            gpus.iter().map(|gpu| gpu.index).collect::<Vec<_>>(),
            (0..8).collect::<Vec<_>>()
        );
        assert_eq!(gpus[3].name, "NVIDIA RTX A400");
        assert_eq!(gpus[3].compute_capability, 86);
        assert_eq!(gpus[3].memory.as_ref().unwrap().total, 4094 << 20);
        assert_eq!(gpus[7].name, "NVIDIA H200 NVL");
        assert_eq!(gpus[7].uuid, "GPU-77777777-0000-0000-0000-000000000000");
        assert_eq!(
            gpus[7].memory,
            Some(GpuMemory {
                total: 143771 << 20,
                free: 143000 << 20,
            })
        );
        assert!(gpus.iter().all(|gpu| gpu.driver_major == 580));
        assert_eq!(super::gpus("").unwrap(), []);
    }

    #[test]
    fn gpu_parser_preserves_unsupported_counters_and_rejects_incomplete_observations() {
        let gpu = &gpus(" 0 , GPU-x , NVIDIA GB10 , 12.1 , 98304, 90112 , 580.142 \n").unwrap()[0];
        assert_eq!(gpu.memory.as_ref().unwrap().total, 96 * GIB);
        assert_eq!(
            (gpu.uuid.as_str(), gpu.name.as_str()),
            ("GPU-x", "NVIDIA GB10")
        );
        assert_eq!(gpu.driver_major, 580);
        for unsupported in ["N/A, N/A", "[N/A], [N/A]", "N/A, [N/A]"] {
            let line = format!("0, GPU-x, NVIDIA GB10, 12.1, {unsupported}, 580");
            assert_eq!(gpus(&line).unwrap()[0].memory, None, "{line}");
        }
        for memory in [
            "[N/A], 100",
            "100, [N/A]",
            "Unknown, Unknown",
            "1, 2",
            "0, 0",
            "999999999999, 0",
        ] {
            let line = format!("0, GPU-x, NVIDIA GB10, 12.1, {memory}, 580");
            assert!(gpus(&line).is_err(), "{line}");
        }
        for line in [
            "0, GPU-x, NVIDIA GB10, 12.1, 98304, 580",
            "0, GPU-x, NVIDIA GB10, 12.1, 98304, 90112, 580, extra",
            "0, , NVIDIA GB10, 12.1, 98304, 90112, 580",
            "0, GPU-x, , 12.1, 98304, 90112, 580",
            "x, GPU-x, NVIDIA GB10, 12.1, 98304, 90112, 580",
            "0, GPU-x, NVIDIA GB10, 12.1, 98304, 90112, unknown",
            "0, GPU-x, NVIDIA GB10, [N/A], 98304, 90112, 580",
            "0, GPU-x, NVIDIA GB10, 12.10, 98304, 90112, 580",
            "0, GPU-x, NVIDIA GB10, 12.1, 98304, 90112, 580\n0, GPU-y, NVIDIA GB10, 12.1, 98304, 90112, 580",
            "0, GPU-x, NVIDIA GB10, 12.1, 98304, 90112, 580\n1, GPU-x, NVIDIA GB10, 12.1, 98304, 90112, 580",
        ] {
            assert!(gpus(line).is_err(), "{line}");
        }
    }

    #[test]
    fn gpu_inventory_requires_complete_process_metadata() {
        let (gpus, processes) = inventory(GB10, "12\n34\n").unwrap();
        assert_eq!(gpus.len(), 1);
        assert_eq!(processes, 2);
        assert_eq!(inventory(GB10, "").unwrap().1, 0);
        for (gpu, processes) in [
            ("0, GPU-x, NVIDIA GB10, 12.1, [N/A], [N/A], unknown", ""),
            (GB10, "unknown"),
            (GB10, "12\n12"),
            (GB10, "0"),
        ] {
            assert!(inventory(gpu, processes).is_err());
        }
    }
}
