// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::{ConfigError, Credential, Document, InferenceProvider};

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
                .selected_inference_providers()
                .is_ok_and(|providers| providers.iter().any(|p| p.service.is_some()))
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
        self.provider_connection(self.inference_provider()?)
    }

    pub(crate) fn provider_connection(
        &self,
        provider: &InferenceProvider,
    ) -> Result<InferenceConnection, ConfigError> {
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

impl InferenceProvider {
    pub(crate) fn authenticated(&self) -> bool {
        self.credential.is_some()
            || self
                .service
                .as_ref()
                .is_some_and(|service| service.authentication.is_some())
            || self.ollama_proxy.is_some()
    }
}
