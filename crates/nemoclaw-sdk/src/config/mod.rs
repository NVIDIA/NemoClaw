// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

mod inference;
mod types;
pub use inference::InferenceConnection;
mod validation;
use sha2::{Digest, Sha256};
use std::{fmt, io::Read};
pub use types::*;
pub use validation::{is_fabric_harness, validate_endpoint};

pub const API_VERSION: &str = "nemoclaw.nvidia.com/v1alpha1";
pub const MAX_DOCUMENT_BYTES: u64 = 1 << 20;
pub const DEFAULT_AGENT_IMAGE: &str =
    "nc-prototype-fabric@sha256:a608340846053d881c3c6b3bdd7541d4f2f53236deaaef8e0b8f44afd8d4e8dd";
pub const DEFAULT_GATEWAY_IMAGE: &str = "ghcr.io/nvidia/openshell/gateway@sha256:3d08ad1e7d839a2ffb9ac85a66102b96dd6bc042c3a6f1eaa31351998fd65792";
pub const MODEL_NAME: &str = "qwen3.8-flash-next";

/// Configuration errors contain fixed diagnostic text, never source values.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConfigError(pub &'static str);
impl fmt::Display for ConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.0)
    }
}
impl std::error::Error for ConfigError {}

impl Document {
    pub fn parse(input: impl Read) -> Result<Self, ConfigError> {
        let mut bytes = Vec::new();
        input
            .take(MAX_DOCUMENT_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| ConfigError("cannot read configuration"))?;
        if bytes.len() as u64 > MAX_DOCUMENT_BYTES {
            return Err(ConfigError("configuration exceeds 1 MiB"));
        }
        let text =
            std::str::from_utf8(&bytes).map_err(|_| ConfigError("configuration must be UTF-8"))?;
        let mut options = serde_saphyr::Options::default();
        let mut budget = serde_saphyr::Budget::default();
        budget.max_aliases = 0;
        budget.max_anchors = 0;
        budget.max_merge_keys = 0;
        options.budget = Some(budget);
        options.merge_keys = serde_saphyr::MergeKeyPolicy::Error;
        options.reject_unsupported_tags = true;
        let tree: serde_json::Value = serde_saphyr::from_str_with_options(text, options)
            .map_err(|_| ConfigError("invalid or unsupported YAML document"))?;
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
        let mut structural = tree.clone();
        if let Some(sandboxes) = structural
            .pointer_mut("/spec/sandboxes")
            .and_then(serde_json::Value::as_array_mut)
        {
            for sandbox in sandboxes {
                if let Some(agents) = sandbox
                    .get_mut("agents")
                    .and_then(serde_json::Value::as_array_mut)
                {
                    for agent in agents {
                        if let Some(routes) = agent
                            .pointer_mut("/inference/routes")
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
                }
            }
        }
        if has_null(&structural) {
            return Err(ConfigError("omit optional fields instead of using null"));
        }
        let mut document: Self = serde_json::from_value(tree).map_err(|_| {
            ConfigError("configuration contains an unknown field or invalid field type")
        })?;
        document.defaults();
        document.validate()?;
        Ok(document)
    }
    pub fn yaml(&self) -> Result<String, ConfigError> {
        self.validate()?;
        serde_saphyr::to_string(self).map_err(|_| ConfigError("cannot serialize configuration"))
    }
    pub fn digest(&self) -> String {
        // Preserve Go encoding/json's struct order, omissions, and HTML escapes.
        let json = serde_json::to_string(self)
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
    pub fn inference_endpoint(&self) -> String {
        self.inference_connection().endpoint
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
        for provider in &self.spec.inference_providers {
            if let Some(c) = &provider.credential {
                names.push(c.env.as_str());
            }
        }
        names
    }
    pub fn defaults(&mut self) {
        let gateway = &mut self.spec.gateway;
        if gateway.management == "managed" {
            default_string(&mut gateway.endpoint, "http://127.0.0.1:17681");
            default_string(&mut gateway.engine, "unix:///var/run/docker.sock");
            default_string(&mut gateway.image, DEFAULT_GATEWAY_IMAGE);
            default_string(
                &mut gateway.network_cidr,
                &format!(
                    "172.30.{}.0/24",
                    Sha256::digest(self.metadata.uid.as_bytes())[0]
                ),
            );
        }
        for provider in &mut self.spec.inference_providers {
            if let Some(service) = &mut provider.service {
                service.defaults();
            }
        }
        for sandbox in &mut self.spec.sandboxes {
            default_string(&mut sandbox.image.ref_, DEFAULT_AGENT_IMAGE);
            default_string(&mut sandbox.runtime.provider, "docker");
            default_string(&mut sandbox.network.tier, "isolated");
        }
    }
}
fn default_string(value: &mut String, default: &str) {
    if value.is_empty() {
        *value = default.into();
    }
}
impl Gateway {
    pub fn bridge(&self) -> String {
        self.network_cidr
            .parse::<ipnet::Ipv4Net>()
            .map(|net| std::net::Ipv4Addr::from(u32::from(net.network()) + 1).to_string())
            .unwrap_or_default()
    }
}
impl Agent {
    pub fn runtime(&self) -> String {
        format!("fabric-{}", self.harness)
    }
}
impl Service {
    pub fn served_model(&self) -> &str {
        if self.backend == crate::recipes::huggingface::BACKEND {
            &self.model.repository
        } else {
            MODEL_NAME
        }
    }
    pub fn defaults(&mut self) {
        for (value, default) in [
            (&mut self.serving.port, 18888),
            (&mut self.serving.context_tokens, 32768),
            (&mut self.serving.max_sequences, 1),
            (&mut self.serving.batch_tokens, 1024),
            (&mut self.serving.startup_timeout_seconds, 1800),
            (&mut self.memory.host_reserve_gib, 32),
            (&mut self.memory.kv_cache_gib, 8),
            (&mut self.memory.min_available_gib, 8),
            (&mut self.memory.min_free_gib, 3),
            (&mut self.memory.free_gate_gib, 12),
            (&mut self.memory.consecutive_samples, 5),
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
