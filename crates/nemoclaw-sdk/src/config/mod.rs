// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

mod agent_inference;
pub(crate) mod constraints;
mod execution;
pub(crate) mod integration_policy;
mod integrations;
pub use integrations::*;
mod inference;
mod providers;
pub(crate) mod references;
mod source;
pub use crate::services::ServiceDefinition;
pub use agent_inference::*;
pub use execution::*;
mod image_pull_policy;
pub use image_pull_policy::ImagePullPolicy;
mod network;
pub use network::*;
mod kinds;
#[doc(hidden)]
pub mod schema;
pub use kinds::{ComputeDriver, HarnessKind, InferenceProviderKind};
mod types;
pub use inference::{InferenceConnection, InferenceTarget};
pub(crate) mod validation;
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
        schema::validate_input(&tree)?;
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
        if let Some(c) = g.credential() {
            names.push(c.env.as_str());
        }
        if let Some(tls) = g.tls() {
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
        if let Gateway::Managed(gateway) = gateway {
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
        for service in self.spec.services.values_mut() {
            crate::services::defaults(service);
        }
        for sandbox in &mut self.spec.sandboxes {
            default_string(&mut sandbox.image.ref_, DEFAULT_AGENT_IMAGE);
        }
    }
}
fn default_string(value: &mut String, default: &str) {
    if value.is_empty() {
        *value = default.into();
    }
}
pub(crate) fn bridge_address(cidr: &str) -> Result<String, ConfigError> {
    network_address(
        cidr,
        1,
        "invalid bridge network",
        "bridge address exceeds IPv4 range",
    )
}
pub(crate) fn gateway_address(cidr: &str) -> Result<String, ConfigError> {
    network_address(
        cidr,
        2,
        "invalid gateway network",
        "gateway address exceeds IPv4 range",
    )
}
fn network_address(
    cidr: &str,
    offset: u32,
    invalid: &'static str,
    overflow: &'static str,
) -> Result<String, ConfigError> {
    let network = cidr
        .parse::<ipnet::Ipv4Net>()
        .map_err(|_| ConfigError::new(invalid))?;
    let address = u32::from(network.network())
        .checked_add(offset)
        .ok_or_else(|| ConfigError::new(overflow))?;
    Ok(std::net::Ipv4Addr::from(address).to_string())
}
impl ManagedGateway {
    pub(crate) fn runtime_settings(&self) -> Self {
        let mut settings = self.clone();
        // Acquisition policy is a mutable provider attribute, not container identity.
        settings.image_pull_policy = None;
        settings
    }
    /// Resolve the first address after the configured network address.
    ///
    /// # Errors
    /// Returns an error for malformed IPv4 CIDRs or an address overflow.
    pub fn bridge(&self) -> Result<String, ConfigError> {
        bridge_address(&self.network_cidr)
    }
}
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

impl Gateway {
    /// The endpoint used to connect to either gateway configuration.
    pub fn endpoint(&self) -> &str {
        match self {
            Self::Managed(gateway) => &gateway.endpoint,
            Self::External(gateway) => &gateway.endpoint,
        }
    }
    /// Change the connection endpoint without changing gateway management.
    pub fn endpoint_mut(&mut self) -> &mut String {
        match self {
            Self::Managed(gateway) => &mut gateway.endpoint,
            Self::External(gateway) => &mut gateway.endpoint,
        }
    }
    /// Installation settings, when this deployment manages the gateway.
    pub fn as_managed(&self) -> Option<&ManagedGateway> {
        match self {
            Self::Managed(gateway) => Some(gateway),
            Self::External(_) => None,
        }
    }
    /// Mutable installation settings, when this deployment manages the gateway.
    pub fn as_managed_mut(&mut self) -> Option<&mut ManagedGateway> {
        match self {
            Self::Managed(gateway) => Some(gateway),
            Self::External(_) => None,
        }
    }
    pub(crate) fn managed(&self) -> Result<&ManagedGateway, ConfigError> {
        self.as_managed()
            .ok_or(ConfigError::new("operation requires a managed gateway"))
    }
    pub(crate) fn credential(&self) -> Option<&Credential> {
        match self {
            Self::Managed(_) => None,
            Self::External(gateway) => gateway.credential.as_ref(),
        }
    }
    pub(crate) fn tls(&self) -> Option<&TLS> {
        match self {
            Self::Managed(_) => None,
            Self::External(gateway) => gateway.tls.as_ref(),
        }
    }
}
