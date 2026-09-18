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
/// Decode one GPU's MiB memory counters and major.minor compute capability.
#[cfg(any(unix, test))]
pub fn dedicated_memory(text: &str) -> Result<super::DedicatedGpu, Error> {
    let error = || Error::State("dedicated GPU memory or compute capability is unobservable");
    let mut lines = text.trim().lines();
    let line = lines.next().ok_or_else(error)?;
    if lines.next().is_some() {
        return Err(error());
    }
    let fields: Vec<_> = line.split(',').map(str::trim).collect();
    if fields.len() != 3 {
        return Err(error());
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
    let (major, minor) = fields[2].split_once('.').ok_or_else(error)?;
    let major = major.parse::<u32>().map_err(|_| error())?;
    let minor = minor.parse::<u32>().map_err(|_| error())?;
    if total == 0 || free > total || !(1..=99).contains(&major) || minor > 9 {
        return Err(error());
    }
    Ok(super::DedicatedGpu {
        total,
        free,
        compute_capability: major * 10 + minor,
    })
}

#[cfg(target_os = "linux")]
pub async fn populate(capacity: &mut super::Capacity) -> Result<(), Error> {
    capacity.architecture = match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "amd64",
        other => other,
    }
    .into();
    let gpu = query("--query-gpu=name,driver_version").await?;
    let processes = query("--query-compute-apps=pid").await?;
    (
        capacity.gpu,
        capacity.driver_major,
        capacity.foreign_gpu_processes,
    ) = inventory(&gpu, &processes)?;
    if capacity.gpu != "NVIDIA GB10" {
        capacity.gpu_memory = Some(dedicated_memory(
            &query("--query-gpu=memory.total,memory.free,compute_cap").await?,
        )?);
    } else {
        capacity.gpu_memory = None;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn dedicated_gpu_parser_rejects_missing_ambiguous_or_inconsistent_measurements() {
        let gpu = dedicated_memory("98304, 90112, 9.0\n").unwrap();
        assert_eq!(gpu.total, 96 * super::super::GIB);
        assert_eq!(gpu.compute_capability, 90);
        for text in [
            "",
            "[N/A], [N/A], 9.0",
            "1, 2, 9.0",
            "0, 0, 9.0",
            "98304, 90112, 9.0\n98304, 90112, 9.0",
            "98304, 90112, 9.10",
            "98304, 90112, 9",
            "999999999999, 0, 9.0",
        ] {
            assert!(dedicated_memory(text).is_err(), "{text}");
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
