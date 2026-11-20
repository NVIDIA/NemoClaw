// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Managed, immutable, single-GPU GGUF serving with llama.cpp.
//! Launch settings adapted from Classic NemoClaw's host-local-runtime.ts at
//! 495896a404d77fb4673fc41dbf18d5e0fec91b2a; v1 adds typed settings, CUDA
//! device selection and its own cache, supervision and credential ownership.
#[cfg(any(test, all(feature = "execution", target_os = "linux")))]
mod artifact;
mod config;
#[cfg(any(test, all(feature = "execution", target_os = "linux")))]
mod readiness;
pub use config::{GgufModel, LlamaCppMemory, LlamaCppService, LlamaCppServing};
#[cfg(all(feature = "execution", target_os = "linux"))]
pub mod runtime;
pub mod schema;

use crate::{
    Error,
    config::ConfigError,
    hardware::{Capacity, GIB, at_least},
    vllm::{MemoryArchitecture, ServiceHardware},
};

impl LlamaCppService {
    pub fn validate(&self) -> Result<(), ConfigError> {
        crate::schema::validate(&crate::RuntimeSpec::LlamaCpp(Box::new(self.clone())))?;
        self.architecture()?;
        self.model.manifest().validate().map_err(|_| {
            ConfigError::new(
                "GGUF requires an immutable repository, revision, safe file, size and SHA-256",
            )
        })?;
        crate::require(
            self.model.revision.len() == 40 && self.model.file.ends_with(".gguf"),
            "GGUF requires a commit revision and a .gguf file",
        )?;
        crate::require(
            self.memory.free_gate_gib >= self.memory.min_available_gib,
            "memory free gate must be at least the available-memory threshold",
        )?;
        crate::require(
            self.serving.micro_batch_tokens <= self.serving.batch_tokens,
            "micro batch cannot exceed batch tokens",
        )?;
        crate::require(
            self.model
                .size_bytes
                .checked_add(2 * GIB)
                .is_some_and(|n| n <= self.gpu_bytes()),
            "GGUF weights and runtime reserve exceed the GPU budget",
        )
    }
    pub fn architecture(&self) -> Result<&str, ConfigError> {
        self.hardware.architecture()
    }
    pub fn served_model(&self) -> &str {
        &self.serving.model_name
    }
    pub fn gpu_bytes(&self) -> u64 {
        self.memory.gpu_memory_gib * GIB
    }
    pub fn memory_architecture(&self) -> MemoryArchitecture {
        match &self.hardware {
            ServiceHardware::Dedicated(_) => MemoryArchitecture::Dedicated,
            ServiceHardware::Profile { profile, .. } => profile.memory_architecture(),
        }
    }
    /// Admission budget, not a hard allocator limit. llama.cpp's context/KV settings govern actual allocations.
    pub fn check_memory(&self, c: &Capacity, starting: bool) -> Result<(), Error> {
        self.validate()?;
        self.memory
            .check(&self.hardware, self.memory_architecture(), c, starting)
    }

    pub fn check_capacity(
        &self,
        c: &Capacity,
        starting: bool,
        remaining: u64,
    ) -> Result<(), Error> {
        self.check_memory(c, starting)?;
        at_least(
            "model and working disk reserve (bytes)",
            remaining
                .checked_add(16 * GIB)
                .ok_or(Error::State("GGUF disk requirement overflow"))?,
            c.disk_free,
        )
    }
    /// The executable receives data as distinct arguments; no shell or arbitrary flags.
    pub fn arguments(&self, file: &str, key_file: Option<&str>) -> Result<Vec<String>, Error> {
        self.validate()?;
        if self.authentication.is_some() != key_file.is_some() {
            return Err(Error::Conflict(
                "GGUF authentication requires its credential file",
            ));
        }
        let s = &self.serving;
        let mut args: Vec<String> = [
            "--model".into(),
            file.into(),
            "--alias".into(),
            s.model_name.clone(),
            "--host".into(),
            "0.0.0.0".into(),
            "--port".into(),
            s.port.to_string(),
            "--device".into(),
            "CUDA0".into(),
            "--gpu-layers".into(),
            "all".into(),
            "--fit".into(),
            "off".into(),
            "--ctx-size".into(),
            s.context_tokens.to_string(),
            "--parallel".into(),
            "1".into(),
            "--batch-size".into(),
            s.batch_tokens.to_string(),
            "--ubatch-size".into(),
            s.micro_batch_tokens.to_string(),
            "--cache-type-k".into(),
            "f16".into(),
            "--cache-type-v".into(),
            "f16".into(),
            "--flash-attn".into(),
            "on".into(),
            "--sleep-idle-seconds".into(),
            "-1".into(),
            "--timeout".into(),
            "900".into(),
            "--jinja".into(),
            "--no-ui".into(),
            "--no-slots".into(),
            "--no-mmproj".into(),
            "--no-agent".into(),
        ]
        .into();
        if let Some(strength) = &s.reasoning_strength {
            args.extend([
                "--chat-template-kwargs".into(),
                serde_json::json!({"reasoning_strength":strength}).to_string(),
            ]);
        }
        if let Some(path) = key_file {
            args.extend(["--api-key-file".into(), path.into()]);
        }
        Ok(args)
    }
}
