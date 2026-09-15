// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::{Credential, Document};

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
    /// Resolve an already validated document. Managed inference retains the
    /// existing same-host publication; external inference uses its explicit URL.
    /// Reachability must be checked through the sandbox, not the CLI host.
    pub fn inference_connection(&self) -> InferenceConnection {
        let provider = &self.spec.inference_providers[0];
        let endpoint = match &provider.service {
            None => provider.endpoint.clone(),
            Some(service) => service.publication.as_ref().map_or_else(
                || {
                    format!(
                        "http://{}:{}/v1",
                        self.spec.gateway.bridge(),
                        service.serving.port
                    )
                },
                |publication| publication.endpoint.clone(),
            ),
        };
        InferenceConnection {
            endpoint,
            credential: provider.credential.clone(),
        }
    }
}
