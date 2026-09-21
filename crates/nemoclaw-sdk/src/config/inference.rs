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
        self.spec.gateway.as_managed().is_some() || crate::services::has_runtime(self)
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
        let endpoint = crate::services::resolve(self, provider)?
            .map_or_else(|| provider.endpoint.clone(), |service| service.endpoint);
        Ok(InferenceConnection {
            endpoint,
            credential: provider.credential.clone(),
        })
    }
}
