// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
#[cfg(any(unix, test))]
use crate::Error;
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
#[cfg(any(unix, test))]
pub fn inventory(gpu: &str, processes: &str) -> Result<(String, u32, usize), Error> {
    let (name, major) = single_gpu(gpu.trim().lines())?;
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
    Ok((name, major, seen.len()))
}
#[cfg(any(unix, test))]
fn single_gpu<'a>(mut lines: impl Iterator<Item = &'a str>) -> Result<(String, u32), Error> {
    let Some(line) = lines.next() else {
        return Err(Error::State(
            "managed inference requires exactly one observable GPU",
        ));
    };
    if lines.next().is_some() {
        return Err(Error::State(
            "managed inference requires exactly one observable GPU",
        ));
    }
    let mut fields = line.split(',').map(str::trim);
    let (Some(name), Some(version), None) = (fields.next(), fields.next(), fields.next()) else {
        return Err(Error::State("GPU inventory is incomplete"));
    };
    if name.is_empty() {
        return Err(Error::State("GPU inventory is incomplete"));
    }
    let major = version
        .split('.')
        .next()
        .unwrap_or("")
        .parse::<u32>()
        .map_err(|_| Error::State("driver version is unobservable"))?;
    Ok((name.into(), major))
}
/// Decode one GPU's compute capability independently of its memory counters.
#[cfg(any(unix, test))]
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
#[cfg(any(unix, test))]
pub fn framebuffer_memory(text: &str) -> Result<Option<super::GpuMemory>, Error> {
    let error = || Error::State("GPU framebuffer memory observation is incomplete");
    let mut lines = text.trim().lines();
    let line = lines.next().ok_or_else(error)?;
    if lines.next().is_some() {
        return Err(error());
    }
    let fields: Vec<_> = line.split(',').map(str::trim).collect();
    if fields.len() != 2 {
        return Err(error());
    }
    if fields.iter().all(|field| matches!(*field, "N/A" | "[N/A]")) {
        return Ok(None);
    }
    let bytes = |s: &str| {
        s.parse::<u64>()
            .ok()
            .filter(|n| *n <= 4 * (1 << 20))
            .and_then(|n| n.checked_mul(1 << 20))
            .ok_or_else(error)
    };
    let total = bytes(fields[0])?;
    let free = bytes(fields[1])?;
    if total == 0 || free > total {
        return Err(error());
    }
    Ok(Some(super::GpuMemory { total, free }))
}

#[cfg(any(unix, test))]
pub(super) fn apply_observations(
    capacity: &mut super::Capacity,
    gpu: &str,
    processes: &str,
    compute: &str,
    memory: &str,
) -> Result<(), Error> {
    (
        capacity.gpu,
        capacity.driver_major,
        capacity.foreign_gpu_processes,
    ) = inventory(gpu, processes)?;
    capacity.compute_capability = compute_capability(compute)?;
    capacity.gpu_memory = framebuffer_memory(memory)?;
    Ok(())
}

#[cfg(target_os = "linux")]
pub async fn populate(capacity: &mut super::Capacity) -> Result<(), Error> {
    capacity.architecture = match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "amd64",
        other => other,
    }
    .into();
    populate_with(capacity, query).await
}

#[cfg(target_os = "linux")]
async fn populate_with<F, Fut>(capacity: &mut super::Capacity, mut query: F) -> Result<(), Error>
where
    F: FnMut(&'static str) -> Fut,
    Fut: std::future::Future<Output = Result<String, Error>>,
{
    let gpu = query("--query-gpu=name,driver_version").await?;
    let processes = query("--query-compute-apps=pid").await?;
    let compute = query("--query-gpu=compute_cap").await?;
    let memory = query("--query-gpu=memory.total,memory.free").await?;
    apply_observations(capacity, &gpu, &processes, &compute, &memory)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn native_collector_observes_compute_with_both_memory_modes_and_propagates_query_errors()
    {
        for (gpu, compute, memory) in [
            ("NVIDIA GB10, 580.0", "12.1", "[N/A], [N/A]"),
            ("NVIDIA H100, 580.0", "9.0", "81920, 71680"),
        ] {
            let observations = [
                ("--query-gpu=name,driver_version", gpu),
                ("--query-compute-apps=pid", ""),
                ("--query-gpu=compute_cap", compute),
                ("--query-gpu=memory.total,memory.free", memory),
            ];
            let mut seen = Vec::new();
            let mut capacity = super::super::Capacity::default();
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
            assert_eq!(seen.len(), 4);
            assert_eq!(
                capacity.compute_capability,
                compute_capability(compute).unwrap()
            );
            assert_eq!(capacity.gpu_memory, framebuffer_memory(memory).unwrap());
            for failure in [
                "--query-gpu=compute_cap",
                "--query-gpu=memory.total,memory.free",
            ] {
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
    #[test]
    fn framebuffer_parser_preserves_unsupported_counters_and_rejects_incomplete_observations() {
        let gpu = framebuffer_memory("98304, 90112\n").unwrap().unwrap();
        assert_eq!(gpu.total, 96 * super::super::GIB);
        for unsupported in ["N/A, N/A\n", "[N/A], [N/A]\n"] {
            assert_eq!(framebuffer_memory(unsupported).unwrap(), None);
        }
        for text in [
            "",
            "[N/A], 100",
            "100, [N/A]",
            "Unknown, Unknown",
            "1, 2",
            "0, 0",
            "98304",
            "98304, 90112, extra",
            "98304, 90112\n98304, 90112",
            "999999999999, 0",
        ] {
            assert!(framebuffer_memory(text).is_err(), "{text}");
        }
    }
    #[test]
    fn gpu_parser_rejects_extra_lines_without_consuming_the_rest() {
        let lines = ["NVIDIA GB10, 580", "NVIDIA GB10, 580"]
            .into_iter()
            .chain(std::iter::from_fn(|| panic!("read past the second GPU")));
        assert!(single_gpu(lines).is_err());
        assert_eq!(
            single_gpu(std::iter::once(" NVIDIA GB10 , 580.142 ")).unwrap(),
            ("NVIDIA GB10".into(), 580)
        );
        for line in ["", "NVIDIA GB10", ", 580", "NVIDIA GB10, 580, extra"] {
            assert!(single_gpu(std::iter::once(line)).is_err());
        }
        assert!(single_gpu(std::iter::empty()).is_err());
    }

    #[test]
    fn gpu_inventory_requires_one_gpu_and_complete_process_metadata() {
        assert_eq!(
            inventory("NVIDIA GB10, 580.142\n", "12\n34\n").unwrap(),
            ("NVIDIA GB10".into(), 580, 2)
        );
        assert_eq!(inventory("NVIDIA GB10, 580.142\n", "").unwrap().2, 0);
        for (gpu, processes) in [
            ("", ""),
            ("NVIDIA GB10, unknown", ""),
            ("NVIDIA GB10, 580\nNVIDIA GB10, 580", ""),
            ("NVIDIA GB10, 580", "unknown"),
            ("NVIDIA GB10, 580", "12\n12"),
            ("NVIDIA GB10, 580", "0"),
        ] {
            assert!(inventory(gpu, processes).is_err());
        }
    }
}
