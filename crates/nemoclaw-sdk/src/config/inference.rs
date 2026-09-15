// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::{ConfigError, Credential, Document};

/// Upstream connection as used by OpenShell routing, independent of the sandbox
/// engine. Credentials remain references. Resolution performs no reachability probe.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InferenceConnection {
    pub endpoint: String,
    pub credential: Option<Credential>,
}
impl Document {
    pub fn has_runtime(&self) -> bool {
        self.spec.gateway.management == "managed"
            || self
                .spec
                .inference_providers
                .iter()
                .any(|p| p.service.is_some())
    }
    /// Validate the document and resolve its inference connection.
    /// Managed inference retains its publication; external inference uses its explicit URL.
    /// Reachability must be checked through the sandbox, not the CLI host.
    ///
    /// # Errors
    /// Returns an error if the document is invalid or its managed bridge address
    /// cannot be resolved. This operation does not contact external services.
    pub fn inference_connection(&self) -> Result<InferenceConnection, ConfigError> {
        self.validate()?;
        let [provider] = self.spec.inference_providers.as_slice() else {
            return Err(ConfigError("exactly one inference provider is required"));
        };
        let endpoint = match &provider.service {
            None => provider
                .ollama_proxy
                .as_ref()
                .map_or_else(|| provider.endpoint.clone(), |proxy| proxy.endpoint.clone()),
            Some(service) => match &service.publication {
                Some(publication) => publication.endpoint.clone(),
                None => format!(
                    "http://{}:{}/v1",
                    self.spec.gateway.bridge()?,
                    service.serving.port
                ),
            },
        };
        Ok(InferenceConnection {
            endpoint,
            credential: provider.credential.clone(),
        })
    }
}
