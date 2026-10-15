// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Inference catalog requests and observations, and direct credential availability.
use crate::{
    Error, ObservationError, Secrets,
    config::{Credential, Document, InferenceApi, InferenceProvider, InferenceTarget},
    discovery::ObservationStatus,
};
use serde::{Deserialize, Serialize};

pub use crate::inference_catalog::{observe_endpoint, observe_server};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct EndpointRequest {
    pub endpoint: String,
    pub api: InferenceApi,
    pub credential_env: Option<String>,
}
impl EndpointRequest {
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
    /// Check only the request's shape: an http or https URL with a host and
    /// no credentials, query, or fragment, and a valid credential name. Unlike
    /// [`Self::validate`], it leaves which destinations are allowed to OpenShell.
    pub fn validate_shape(&self) -> Result<(), Error> {
        let invalid = || {
            Error::Configuration(crate::config::ConfigError::new(
                "inference server endpoint must be an http or https URL with a host, without credentials, query, or fragment",
            ))
        };
        let url = url::Url::parse(&self.endpoint).map_err(|_| invalid())?;
        if !matches!(url.scheme(), "http" | "https")
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(invalid());
        }
        self.validate_credential()
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
/// Read every external endpoint's model catalog, named `endpoint_0`,
/// `endpoint_1`, ... in [`endpoint_requests`] order. Reads run together, each
/// bounded by its own timeout, and report failures as observations; only an
/// invalid document fails.
pub async fn observe_endpoints(
    document: &Document,
    secrets: &dyn Secrets,
) -> Result<Vec<(String, EndpointRequest, EndpointObservation)>, Error> {
    let requests = endpoint_requests(document)?;
    let observed = futures_util::future::join_all(
        requests
            .iter()
            .map(|request| observe_endpoint(request, secrets)),
    )
    .await;
    Ok(requests
        .into_iter()
        .zip(observed)
        .enumerate()
        .map(|(index, (request, observation))| (format!("endpoint_{index}"), request, observation))
        .collect())
}
/// Resolve every selected route through the configuration owner's scoped providers.
/// Shared external endpoint/API/reference tuples are read only once. Managed
/// services retain their owning readiness checks and generated credentials.
pub fn endpoint_requests(document: &Document) -> Result<Vec<EndpointRequest>, Error> {
    document.validate()?;
    let mut requests = Vec::new();
    for sandbox in &document.spec.sandboxes {
        for provider in document.sandbox_inference_providers(sandbox)? {
            let Some(request) = EndpointRequest::for_external_provider(provider.definition)? else {
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
