// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
#[cfg(any(target_os = "linux", test))]
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
#[cfg(any(target_os = "linux", test))]
pub fn inventory(gpu: &str, processes: &str) -> Result<(String, u32, usize), Error> {
    let lines: Vec<_> = gpu.trim().lines().collect();
    if lines.len() != 1 {
        return Err(Error::State("Spark requires exactly one observable GPU"));
    }
    let fields: Vec<_> = lines[0].split(',').map(str::trim).collect();
    if fields.len() != 2 || fields[0].is_empty() {
        return Err(Error::State("GPU inventory is incomplete"));
    }
    let major = fields[1]
        .split('.')
        .next()
        .unwrap_or("")
        .parse::<u32>()
        .map_err(|_| Error::State("driver version is unobservable"))?;
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
    Ok((fields[0].into(), major, seen.len()))
}
#[cfg(test)]
mod tests {
    use super::*;
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
