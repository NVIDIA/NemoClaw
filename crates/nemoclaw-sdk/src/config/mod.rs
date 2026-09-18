// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

mod agent_inference;
pub(crate) mod constraints;
mod execution;
pub(crate) mod integration_policy;
mod integrations;
pub use integrations::*;
mod observability;
mod ollama_proxy;
pub use observability::*;
pub use ollama_proxy::*;
mod inference;
mod interfaces;
mod providers;
mod references;
pub use agent_inference::*;
pub use execution::*;
pub use interfaces::*;
mod image_pull_policy;
pub use image_pull_policy::ImagePullPolicy;
mod management;
pub use management::*;
mod network;
pub use network::*;
#[doc(hidden)]
pub mod schema;
mod types;
pub use inference::InferenceConnection;
mod validation;
use sha2::{Digest, Sha256};
use std::{fmt, io::Read};
pub use types::*;
pub use validation::{is_fabric_harness, validate_endpoint};

pub const API_VERSION: &str = "nemoclaw.nvidia.com/v1alpha1";
pub const MAX_DOCUMENT_BYTES: u64 = 1 << 20;
pub use crate::artifact_pins::DEFAULT_AGENT_IMAGE;
pub use crate::artifact_pins::DEFAULT_GATEWAY_IMAGE;

/// Configuration diagnostics omit credentials and arbitrary source values.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConfigError(pub String);
impl ConfigError {
    pub fn new(message: &'static str) -> Self {
        Self(message.into())
    }
}
impl fmt::Display for ConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for ConfigError {}

impl Document {
    /// Read, default, and validate a configuration document.
    ///
    /// # Errors
    /// Returns an error for unreadable, oversized, malformed, or invalid input.
    pub fn parse(input: impl Read) -> Result<Self, ConfigError> {
        let mut bytes = Vec::new();
        input
            .take(MAX_DOCUMENT_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| ConfigError::new("cannot read configuration"))?;
        if bytes.len() as u64 > MAX_DOCUMENT_BYTES {
            return Err(ConfigError::new("configuration exceeds 1 MiB"));
        }
        let text = std::str::from_utf8(&bytes)
            .map_err(|_| ConfigError::new("configuration must be UTF-8"))?;
        let mut options = serde_saphyr::Options::default();
        let mut budget = serde_saphyr::Budget::default();
        budget.max_aliases = 0;
        budget.max_anchors = 0;
        budget.max_merge_keys = 0;
        options.budget = Some(budget);
        options.merge_keys = serde_saphyr::MergeKeyPolicy::Error;
        options.reject_unsupported_tags = true;
        let tree: serde_json::Value = serde_saphyr::from_str_with_options(text, options)
            .map_err(|_| ConfigError::new("invalid or unsupported YAML document"))?;
        fn has_null(value: &serde_json::Value) -> bool {
            match value {
                serde_json::Value::Null => true,
                serde_json::Value::Array(values) => values.iter().any(has_null),
                serde_json::Value::Object(values) => values.values().any(has_null),
                _ => false,
            }
        }
        // The agent owns values inside its opaque model object, including null.
        // Keep the existing null policy everywhere else in deployment intent.
        fn omit_model_metadata(inference: &mut serde_json::Value) {
            if let Some(routes) = inference
                .get_mut("routes")
                .and_then(serde_json::Value::as_array_mut)
            {
                for route in routes {
                    if let Some(overrides) = route
                        .get_mut("overrides")
                        .and_then(serde_json::Value::as_object_mut)
                        && overrides
                            .get("piModel")
                            .is_some_and(serde_json::Value::is_object)
                    {
                        overrides.remove("piModel");
                    }
                }
            }
        }
        fn omit_shared_metadata(scope: &mut serde_json::Value) {
            if let Some(inferences) = scope
                .get_mut("inferences")
                .and_then(serde_json::Value::as_object_mut)
            {
                for inference in inferences.values_mut() {
                    omit_model_metadata(inference);
                }
            }
        }
        let mut structural = tree.clone();
        if let Some(spec) = structural.get_mut("spec") {
            omit_shared_metadata(spec);
            if let Some(sandboxes) = spec
                .get_mut("sandboxes")
                .and_then(serde_json::Value::as_array_mut)
            {
                for sandbox in sandboxes {
                    omit_shared_metadata(sandbox);
                    if let Some(inference) = sandbox
                        .get_mut("agent")
                        .and_then(|agent| agent.get_mut("inference"))
                    {
                        omit_model_metadata(inference);
                    }
                }
            }
        }
        if has_null(&structural) {
            return Err(ConfigError::new(
                "omit optional fields instead of using null",
            ));
        }
        let mut document: Self = serde_json::from_value(tree).map_err(|_| {
            ConfigError::new("configuration contains an unknown field or invalid field type")
        })?;
        document.defaults();
        document.validate()?;
        Ok(document)
    }
    /// Serialize a valid configuration to YAML.
    ///
    /// # Errors
    /// Returns an error if validation or serialization fails.
    pub fn yaml(&self) -> Result<String, ConfigError> {
        self.validate()?;
        serde_saphyr::to_string(self)
            .map_err(|_| ConfigError::new("cannot serialize configuration"))
    }
    pub fn digest(&self) -> String {
        // Named declaration order is not deployment intent; retain authored order on export.
        let mut canonical = self.clone();
        canonical.spec.sandboxes.sort_by(|a, b| a.name.cmp(&b.name));
        canonical
            .spec
            .inference_providers
            .sort_by(|a, b| a.name.cmp(&b.name));
        for inference in canonical.spec.inferences.values_mut() {
            inference.routes.sort_by(|a, b| a.name.cmp(&b.name));
        }
        for sandbox in &mut canonical.spec.sandboxes {
            sandbox
                .inference_providers
                .sort_by(|a, b| a.name.cmp(&b.name));
            for inference in sandbox
                .inferences
                .values_mut()
                .chain(sandbox.agent.inference.iter_mut())
            {
                inference.routes.sort_by(|a, b| a.name.cmp(&b.name));
            }
        }
        let json = serde_json::to_string(&canonical)
            .expect("configuration contains only serializable values")
            .replace('&', "\\u0026")
            .replace('<', "\\u003c")
            .replace('>', "\\u003e")
            .replace('\u{2028}', "\\u2028")
            .replace('\u{2029}', "\\u2029");
        hex(&Sha256::digest(json.as_bytes()))
    }
    pub fn workspace(&self) -> String {
        format!(
            "nc-{}",
            &hex(&Sha256::digest(self.metadata.uid.as_bytes()))[..16]
        )
    }
    /// Resolve the validated inference endpoint without probing it.
    ///
    /// # Errors
    /// Returns configuration or bridge resolution errors from `inference_connection`.
    pub fn inference_endpoint(&self) -> Result<String, ConfigError> {
        Ok(self.inference_connection()?.endpoint)
    }
    pub fn credential_names(&self) -> Vec<&str> {
        let g = &self.spec.gateway;
        let mut names = Vec::new();
        if let Some(c) = &g.credential {
            names.push(c.env.as_str());
        }
        if let Some(tls) = &g.tls {
            names.extend([
                tls.ca.env.as_str(),
                tls.certificate.env.as_str(),
                tls.key.env.as_str(),
            ]);
        }
        if let Ok(providers) = self.selected_inference_providers() {
            for provider in providers {
                if let Some(credential) = &provider.credential {
                    names.push(credential.env.as_str());
                }
            }
        }
        for sandbox in &self.spec.sandboxes {
            for binding in sandbox
                .integration_bindings(&self.spec.integrations)
                .expect("validated integration references")
            {
                match binding.definition {
                    Integration::WebSearch(search) => names.push(&search.credential.env),
                }
            }
        }
        names.sort_unstable();
        names.dedup();
        names
    }
    pub fn defaults(&mut self) {
        let gateway = &mut self.spec.gateway;
        if gateway.management == "managed" {
            default_string(&mut gateway.endpoint, constraints::GATEWAY_ENDPOINT);
            default_string(&mut gateway.engine, constraints::GATEWAY_ENGINE);
            default_string(&mut gateway.image, DEFAULT_GATEWAY_IMAGE);
            default_string(
                &mut gateway.network_cidr,
                &format!(
                    "172.30.{}.0/24",
                    Sha256::digest(self.metadata.uid.as_bytes())[0]
                ),
            );
        }
        for provider in self.provider_definitions_mut() {
            if let Some(service) = &mut provider.service {
                service.defaults();
            }
        }
        for sandbox in &mut self.spec.sandboxes {
            default_string(&mut sandbox.image.ref_, DEFAULT_AGENT_IMAGE);
            default_string(&mut sandbox.runtime.provider, constraints::RUNTIME);
            if sandbox.network.policy.is_none() {
                default_string(&mut sandbox.network.tier, constraints::NETWORK_TIER);
            }
        }
    }
}
fn default_string(value: &mut String, default: &str) {
    if value.is_empty() {
        *value = default.into();
    }
}
pub(crate) fn bridge_address(cidr: &str) -> Result<String, ConfigError> {
    let network = cidr
        .parse::<ipnet::Ipv4Net>()
        .map_err(|_| ConfigError::new("invalid bridge network"))?;
    let address = u32::from(network.network())
        .checked_add(1)
        .ok_or(ConfigError::new("bridge address exceeds IPv4 range"))?;
    Ok(std::net::Ipv4Addr::from(address).to_string())
}
impl Gateway {
    /// Resolve the first address after the configured network address.
    ///
    /// # Errors
    /// Returns an error for malformed IPv4 CIDRs or an address overflow.
    pub fn bridge(&self) -> Result<String, ConfigError> {
        bridge_address(&self.network_cidr)
    }
}
impl Service {
    pub fn served_model(&self) -> &str {
        if let Some(recipe) = &self.recipe {
            return &recipe.serving.model_name;
        }
        if self.serving.model_name.is_empty() {
            &self.model.repository
        } else {
            &self.serving.model_name
        }
    }

    pub fn defaults(&mut self) {
        for (value, default) in [
            (&mut self.serving.port, constraints::PORT.default),
            (
                &mut self.serving.context_tokens,
                constraints::CONTEXT_TOKENS.default,
            ),
            (
                &mut self.serving.max_sequences,
                constraints::MAX_SEQUENCES.default,
            ),
            (
                &mut self.serving.batch_tokens,
                constraints::BATCH_TOKENS.default,
            ),
            (
                &mut self.serving.startup_timeout_seconds,
                constraints::STARTUP_TIMEOUT.default,
            ),
            (
                &mut self.memory.host_reserve_gib,
                constraints::HOST_RESERVE.default,
            ),
            (
                &mut self.memory.kv_cache_gib,
                if self.memory.gpu_memory_utilization.is_some() {
                    0
                } else {
                    constraints::KV_CACHE.default
                },
            ),
            (
                &mut self.memory.min_available_gib,
                constraints::MIN_AVAILABLE.default,
            ),
            (&mut self.memory.min_free_gib, constraints::MIN_FREE.default),
            (
                &mut self.memory.free_gate_gib,
                constraints::FREE_GATE.default,
            ),
            (
                &mut self.memory.consecutive_samples,
                constraints::CONSECUTIVE_SAMPLES.default,
            ),
        ] {
            if *value == 0 {
                *value = default;
            }
        }
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

mod service_hardware;
pub use service_hardware::{ServiceContainer, ServiceHardware, ServiceIpc};
