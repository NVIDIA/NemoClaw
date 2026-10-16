// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Inference catalog requests and observations, and direct credential availability.
use crate::{
    Error, ObservationError, Secrets,
    config::{Credential, Document, InferenceApi, InferenceProvider, InferenceTarget},
    discovery::ObservationStatus,
};
use serde::{Deserialize, Serialize};

pub use crate::inference_catalog::observe_endpoint;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct EndpointRequest {
    pub endpoint: String,
    pub api: InferenceApi,
    pub credential_env: Option<String>,
}
impl EndpointRequest {
    /// The catalog read the control host makes for `provider` in `document`,
    /// as [`Self::for_external_provider`] selects it, except for a Service in
    /// the cluster of a Kubernetes or OpenShift gateway: the control host
    /// cannot resolve its cluster DNS name, and OpenShell carries the
    /// sandboxes' requests to it, so that endpoint has no catalog read.
    pub fn for_provider(
        document: &Document,
        provider: &InferenceProvider,
    ) -> Result<Option<Self>, crate::config::ConfigError> {
        let in_cluster = document.spec.gateway.runtime().provider.is_kubernetes();
        Ok(Self::for_external_provider(provider)?
            .filter(|request| !(in_cluster && is_cluster_service_endpoint(&request.endpoint))))
    }
    /// The catalog read for a provider with an external endpoint.
    /// A service-backed provider returns `None`: its owner checks readiness.
    /// An omitted API takes the provider's protocol default. The result is not
    /// validated, so callers choose whether an unusable endpoint is an error.
    pub fn for_external_provider(
        provider: &InferenceProvider,
    ) -> Result<Option<Self>, crate::config::ConfigError> {
        if provider.service_ref.is_some() {
            return Ok(None);
        }
        let InferenceTarget::External {
            endpoint,
            credential,
        } = provider.target()?
        else {
            return Ok(None);
        };
        Ok(Some(Self {
            endpoint: endpoint.into(),
            api: provider
                .api
                .unwrap_or(InferenceApi::for_provider(provider.provider)),
            credential_env: credential.map(|credential| credential.env.clone()),
        }))
    }
    fn validate_credential(&self) -> Result<(), Error> {
        if let Some(reference) = &self.credential_env {
            crate::config::schema::validate_definition(
                "Credential",
                &Credential {
                    env: reference.clone(),
                },
            )?;
        }
        Ok(())
    }
    pub fn validate(&self) -> Result<(), Error> {
        crate::config::validate_endpoint(&self.endpoint, false)?;
        self.validate_credential()
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthenticationStatus {
    Unknown,
    Required,
    Accepted,
    NotRequired,
    Denied,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct EndpointObservation {
    pub status: ObservationStatus,
    pub reason: Option<String>,
    pub source: String,
    pub reachable: Option<bool>,
    pub authentication: AuthenticationStatus,
    pub models: Vec<String>,
    /// A catalog never establishes that generation, tools or streaming work.
    pub api_verified: bool,
}
impl EndpointObservation {
    /// A read that could not be made, recorded as unknown rather than absent.
    pub fn unknown(reason: &str) -> Self {
        Self {
            status: ObservationStatus::Unknown,
            reason: Some(reason.into()),
            source: "control_host_http_models".into(),
            reachable: None,
            authentication: AuthenticationStatus::Unknown,
            models: Vec::new(),
            api_verified: false,
        }
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CredentialObservation {
    pub reference: String,
    pub status: ObservationStatus,
    pub reason: Option<String>,
}
/// Direct local availability check. This reports reference resolution only;
/// authentication and certificate validity require their owning client checks.
pub fn observe_credential(secrets: &dyn Secrets, reference: &str) -> CredentialObservation {
    let (status, reason) = match secrets.resolve(reference) {
        Ok(value) if !value.is_empty() => (ObservationStatus::Available, None),
        Ok(_) | Err(ObservationError::Authentication) => (
            ObservationStatus::Unavailable,
            Some("credential reference is not available".into()),
        ),
        Err(_) => (
            ObservationStatus::Unknown,
            Some("credential reference could not be resolved".into()),
        ),
    };
    CredentialObservation {
        reference: reference.into(),
        status,
        reason,
    }
}
/// Reuse the configuration owner's deduplicated list of required references.
/// No returned observation contains resolved values or local file paths.
pub fn observe_credentials(
    document: &Document,
    secrets: &dyn Secrets,
) -> Result<Vec<CredentialObservation>, Error> {
    document.validate()?;
    Ok(document
        .credential_names()
        .into_iter()
        .map(|reference| observe_credential(secrets, reference))
        .collect())
}
/// Resolve every selected route through the configuration owner's scoped providers.
/// Shared external endpoint/API/reference tuples are read only once. Managed
/// services retain their owning readiness checks and generated credentials,
/// and an in-cluster Service has no read; see [`EndpointRequest::for_provider`].
pub fn endpoint_requests(document: &Document) -> Result<Vec<EndpointRequest>, Error> {
    document.validate()?;
    let mut requests = Vec::new();
    for sandbox in &document.spec.sandboxes {
        for provider in document.sandbox_inference_providers(sandbox)? {
            let Some(request) = EndpointRequest::for_provider(document, provider.definition)?
            else {
                continue;
            };
            request.validate()?;
            if !requests.contains(&request) {
                requests.push(request);
            }
        }
    }
    requests.sort_by_cached_key(|request| {
        serde_json::to_string(request).expect("serializable endpoint request")
    });
    Ok(requests)
}

/// Whether `endpoint` names a Kubernetes Service by its cluster DNS name:
/// `http://<service>.<namespace>.svc.cluster.local:<port>`, optionally with a
/// path. As Kubernetes requires, the service name is a DNS-1035 label and the
/// namespace a DNS-1123 label. The port is explicit, nonzero, and unpadded.
/// Nothing else matches: no other scheme, cluster domain, or host form, and no
/// credentials, query, fragment, or characters endpoint validation rejects.
pub fn is_cluster_service_endpoint(endpoint: &str) -> bool {
    fn alphanumeric(byte: &u8) -> bool {
        byte.is_ascii_lowercase() || byte.is_ascii_digit()
    }
    fn label(text: &str, first: fn(&u8) -> bool) -> bool {
        (1..=63).contains(&text.len())
            && text.as_bytes().first().is_some_and(first)
            && text.as_bytes().last().is_some_and(alphanumeric)
            && text.bytes().all(|byte| alphanumeric(&byte) || byte == b'-')
    }
    let Some(rest) = endpoint.strip_prefix("http://") else {
        return false;
    };
    let authority = rest.split('/').next().unwrap_or_default();
    let Some((host, port)) = authority.rsplit_once(':') else {
        return false;
    };
    let Some((service, namespace)) = host
        .strip_suffix(".svc.cluster.local")
        .and_then(|name| name.split_once('.'))
    else {
        return false;
    };
    label(service, u8::is_ascii_lowercase)
        && label(namespace, alphanumeric)
        && !port.starts_with('0')
        && port.bytes().all(|byte| byte.is_ascii_digit())
        && port.parse::<u16>().is_ok()
        && crate::config::validate_endpoint_url(endpoint).is_ok()
}
