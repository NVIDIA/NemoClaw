// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
mod config;
pub use config::{ManagedOllama, OllamaMemory, OllamaModel, OllamaServing};
pub mod constraints;
pub mod hardware_capacity;
pub mod model_source;
pub mod policy;
pub mod registry;
#[cfg(all(feature = "execution", target_os = "linux"))]
pub mod runtime;
pub const MODEL_PATTERN: &str = r"^[a-z0-9][a-z0-9._-]*:[a-z0-9][a-z0-9._-]*$";
impl ManagedOllama {
    pub fn validate(&self) -> Result<(), crate::config::ConfigError> {
        self.architecture()?;
        crate::schema::validate(&crate::RuntimeSpec::Ollama(Box::new(self.clone())))?;
        crate::require(
            self.memory.free_gate_gib >= self.memory.min_available_gib,
            "memory free gate must be at least the available-memory threshold",
        )
    }
}
pub fn constrain_schema(defs: &mut serde_json::Map<String, serde_json::Value>, normalized: bool) {
    crate::schema::property(
        &mut defs["OllamaModel"],
        "name",
        serde_json::json!({"pattern":MODEL_PATTERN}),
    );
    crate::schema::property(
        &mut defs["OllamaModel"],
        "digest",
        serde_json::json!({"pattern":"^[a-f0-9]{64}$"}),
    );
    let service = defs["ServiceDefinition"]["oneOf"]
        .as_array_mut()
        .expect("tagged service variants")
        .iter_mut()
        .find(|variant| variant["properties"]["kind"]["const"] == "ollama")
        .expect("Ollama service variant");
    service["allOf"] = serde_json::json!([
        {"if":crate::schema::at("memory/gpuMemoryUtilization",serde_json::json!({}),true),
         "then":{"allOf":[
             crate::schema::at("hardware/minGpuMemoryBytes",serde_json::json!({}),true),
             crate::schema::at("hardware/profile",serde_json::json!({"not":{"enum":super::vllm::HardwareProfile::UNIFIED_MEMORY}}),false),
             crate::schema::at("memory/gpuMemoryGiB",serde_json::json!({"const":0}),false)
         ]}}
    ]);
    for (name, field, rule) in [
        ("OllamaServing", "port", &constraints::PORT),
        (
            "OllamaServing",
            "contextTokens",
            &constraints::CONTEXT_TOKENS,
        ),
        ("OllamaServing", "maxSequences", &constraints::MAX_SEQUENCES),
        (
            "OllamaServing",
            "startupTimeoutSeconds",
            &constraints::STARTUP_TIMEOUT,
        ),
        ("OllamaMemory", "gpuMemoryGiB", &constraints::GPU_MEMORY),
        ("OllamaMemory", "hostReserveGiB", &constraints::HOST_RESERVE),
        (
            "OllamaMemory",
            "minAvailableGiB",
            &constraints::MIN_AVAILABLE,
        ),
        ("OllamaMemory", "minFreeGiB", &constraints::MIN_FREE),
        ("OllamaMemory", "freeGateGiB", &constraints::FREE_GATE),
        (
            "OllamaMemory",
            "consecutiveSamples",
            &constraints::CONSECUTIVE_SAMPLES,
        ),
    ] {
        crate::schema::integer(&mut defs[name], field, rule, normalized);
    }
    crate::schema::property(
        &mut defs["OllamaMemory"],
        "gpuMemoryGiB",
        serde_json::json!({
            "x-nemoclaw-default-rule":"Omitted or zero stays zero in the document. Without gpuMemoryUtilization, the installer uses 16 GiB."
        }),
    );
    crate::schema::property(
        &mut defs["OllamaMemory"],
        "gpuMemoryUtilization",
        serde_json::json!({"minimum":0.05,"maximum":0.95}),
    );
}

pub mod models;
pub use models::{Model, Models};
