// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
#[cfg(test)]
mod tests;

use crate::{
    Error,
    config::{Memory, Service},
    snapshot::Manifest,
};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, io::Read};

pub const GIB: u64 = 1 << 30;
pub const BACKEND: &str = "vllm-qwen38-spark-v1";
pub const MODEL_NAME: &str = "qwen3.8-flash-next";
pub const RECIPE_REVISION: &str = "d03809008834124e80223c3482f2ddb59577a48f";
pub const PREPARER_SHA256: &str =
    "35da4312f5c9c442eea85445d6f6712c9bb3a3b7c6caccec412da57000b02475";
pub const PREPARED_FILE: &str =
    "language_model.model.layers.1.ple.ple_embedding.ngram_embedding.packed_u8";
pub const PREPARED_BYTES: u64 = 28 * GIB;
pub const VERIFIER_SOURCE: &[u8] = include_bytes!("verify_packed.py");
fn hex(bytes: impl AsRef<[u8]>) -> String {
    bytes.as_ref().iter().map(|b| format!("{b:02x}")).collect()
}
pub fn model_manifest() -> Manifest {
    serde_json::from_slice(include_bytes!("model.json")).expect("pinned model manifest")
}
pub fn verifier_sha256() -> String {
    hex(Sha256::digest(VERIFIER_SOURCE))
}
pub fn preparation_key() -> String {
    hex(Sha256::digest(format!(
        "{}{}{}{}",
        model_manifest().key(),
        RECIPE_REVISION,
        PREPARER_SHA256,
        verifier_sha256()
    )))
}

#[derive(Clone, Debug, Default)]
pub struct Capacity {
    pub architecture: String,
    pub gpu: String,
    pub driver_major: u32,
    pub total: u64,
    pub available: u64,
    pub free: u64,
    pub disk_free: u64,
    pub foreign_gpu_processes: usize,
}
pub fn read_memory(reader: impl Read) -> Result<Capacity, Error> {
    let mut text = String::new();
    reader
        .take((1 << 20) + 1)
        .read_to_string(&mut text)
        .map_err(|_| Error::State("host memory observation failed"))?;
    if text.len() > 1 << 20 {
        return Err(Error::State("host memory observation exceeds limit"));
    }
    let mut values = BTreeMap::new();
    for line in text.lines() {
        let fields: Vec<_> = line.split_whitespace().collect();
        if fields
            .first()
            .is_some_and(|key| ["MemTotal:", "MemAvailable:", "MemFree:"].contains(key))
        {
            if fields.len() != 3 || fields[2] != "kB" {
                return Err(Error::State("incomplete host memory observation"));
            }
            let number = fields[1]
                .parse::<u64>()
                .map_err(|_| Error::State("invalid host memory observation"))?;
            if number > 1 << 40 || values.insert(fields[0], number * 1024).is_some() {
                return Err(Error::State("invalid host memory observation"));
            }
        }
    }
    if values.len() != 3 {
        return Err(Error::State("incomplete host memory observation"));
    }
    let result = Capacity {
        total: values["MemTotal:"],
        available: values["MemAvailable:"],
        free: values["MemFree:"],
        ..Default::default()
    };
    if result.total == 0 || result.available > result.total || result.free > result.available {
        return Err(Error::State("inconsistent host memory observation"));
    }
    Ok(result)
}
impl Service {
    pub fn gpu_bytes(&self) -> Result<u64, Error> {
        self.validate()?;
        Ok(155 * GIB / 2
            + self.memory.kv_cache_gib as u64 * GIB
            + if self.serving.speculative_tokens > 0 {
                2 * GIB
            } else {
                0
            })
    }
    pub fn check_capacity(
        &self,
        c: &Capacity,
        starting: bool,
        download_remaining: u64,
        preparation_remaining: u64,
    ) -> Result<(), Error> {
        self.validate()?;
        if c.architecture != "arm64"
            || c.gpu != "NVIDIA GB10"
            || c.driver_major < 580
            || c.total < 118 * GIB
        {
            return Err(Error::Conflict(
                "backend requires ARM64 GB10 Spark with at least 118 GiB RAM and NVIDIA driver 580 or newer",
            ));
        }
        let disk = download_remaining
            .checked_add(preparation_remaining)
            .and_then(|n| n.checked_add(16 * GIB))
            .ok_or(Error::State("invalid remaining storage capacity"))?;
        if c.disk_free < disk {
            return Err(Error::Conflict(
                "insufficient disk for remaining pinned model, packed PLE, and 16 GiB working reserve",
            ));
        }
        if starting && c.foreign_gpu_processes != 0 {
            return Err(Error::Conflict(
                "GPU is in use by an unrelated process; service was not started",
            ));
        }
        if self.gpu_bytes()? + self.memory.host_reserve_gib as u64 * GIB > c.total {
            return Err(Error::Conflict(
                "requested GPU budget leaves less than declared host memory reserve",
            ));
        }
        if starting && c.available < self.gpu_bytes()? + 20 * GIB {
            return Err(Error::Conflict(
                "insufficient startup memory headroom; service was not started",
            ));
        }
        Ok(())
    }
    pub fn arguments(&self, model_directory: &str, total: u64) -> Result<Vec<String>, Error> {
        self.validate()?;
        if total == 0 || self.gpu_bytes()? > total {
            return Err(Error::Conflict("invalid total memory for inference budget"));
        }
        let v = &self.serving;
        let utilization = (self.gpu_bytes()? as f64 / total as f64 * 1000.0).floor() / 1000.0;
        let mut args = vec![
            "-m".into(),
            "vllm.entrypoints.openai.api_server".into(),
            "--model".into(),
            model_directory.into(),
            "--served-model-name".into(),
            MODEL_NAME.into(),
            "--host".into(),
            "0.0.0.0".into(),
            "--port".into(),
            v.port.to_string(),
            "--tensor-parallel-size".into(),
            "1".into(),
            "--gpu-memory-utilization".into(),
            format!("{utilization:.3}"),
            "--max-num-seqs".into(),
            v.max_sequences.to_string(),
            "--max-num-batched-tokens".into(),
            v.batch_tokens.to_string(),
            "--max-model-len".into(),
            v.context_tokens.to_string(),
        ];
        args.extend(["--kv-cache-dtype","fp8","--mamba-ssm-cache-dtype","bfloat16","--load-format","safetensors","--safetensors-load-strategy","lazy","--enable-chunked-prefill","--reasoning-parser","qwen3","--enable-auto-tool-choice","--tool-call-parser","qwen3_coder","--distributed-executor-backend","mp","--compilation-config",r#"{"mode":0,"cudagraph_mode":"FULL_DECODE_ONLY","cudagraph_capture_sizes":[1,2,4,8]}"#].map(String::from));
        if v.speculative_tokens > 0 {
            args.extend([
                "--speculative-config".into(),
                format!(
                    r#"{{"method":"mtp","num_speculative_tokens":{}}}"#,
                    v.speculative_tokens
                ),
            ]);
        }
        Ok(args)
    }
}
pub struct Watchdog {
    policy: Memory,
    low_samples: u64,
    tripped: bool,
}
impl Watchdog {
    pub fn new(service: &Service) -> Result<Self, Error> {
        service.validate()?;
        Ok(Self {
            policy: service.memory.clone(),
            low_samples: 0,
            tripped: false,
        })
    }
    pub fn sample(&mut self, available: u64, free: u64) -> bool {
        let low = available < self.policy.min_available_gib as u64 * GIB
            || (free < self.policy.min_free_gib as u64 * GIB
                && available < self.policy.free_gate_gib as u64 * GIB);
        self.low_samples = if low {
            self.low_samples.saturating_add(1)
        } else {
            0
        };
        self.tripped |= self.low_samples >= self.policy.consecutive_samples as u64;
        self.tripped
    }
}

mod preparation;
pub use preparation::*;
