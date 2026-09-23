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
        match provider.target()? {
            InferenceTarget::External {
                endpoint,
                credential,
            } => Ok(InferenceConnection {
                endpoint: endpoint.into(),
                credential: credential.cloned(),
            }),
            InferenceTarget::Service { .. } => {
                let service = crate::services::resolve(self, provider)?
                    .ok_or(ConfigError::new("missing inference service"))?;
                Ok(InferenceConnection {
                    endpoint: service.endpoint,
                    credential: None,
                })
            }
        }
    }
}

/// Source of an inference connection. This view checks field combinations;
/// document validation additionally checks URLs, credentials, and references.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InferenceTarget<'a> {
    External {
        endpoint: &'a str,
        credential: Option<&'a Credential>,
    },
    Service {
        name: &'a str,
    },
}

impl InferenceProvider {
    /// Borrow the connection choice without changing the authored representation.
    pub fn target(&self) -> Result<InferenceTarget<'_>, ConfigError> {
        match self.service_ref.as_deref() {
            Some(name)
                if !name.is_empty() && self.endpoint.is_empty() && self.credential.is_none() =>
            {
                Ok(InferenceTarget::Service { name })
            }
            None if !self.endpoint.is_empty() => Ok(InferenceTarget::External {
                endpoint: &self.endpoint,
                credential: self.credential.as_ref(),
            }),
            _ => Err(ConfigError::new(
                "declare an external endpoint or serviceRef without endpoint or credential",
            )),
        }
    }
}
