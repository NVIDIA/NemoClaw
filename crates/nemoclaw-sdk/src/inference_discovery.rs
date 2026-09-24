// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Advertised model catalogs, not inference probes or sandbox reachability.
//! Protocols: https://platform.openai.com/docs/api-reference/models/list and
//! https://platform.claude.com/docs/en/api/models/list.
use crate::{
    Error, ObservationError,
    config::{Credential, Document, InferenceApi},
    discovery::ObservationStatus,
    openshell::Secrets,
};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::{collections::BTreeSet, time::Duration};

const MAX_BYTES: usize = 2 * 1024 * 1024;
const MAX_MODELS: usize = 10_000;
const MAX_PAGES: usize = 10;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct EndpointRequest {
    pub endpoint: String,
    pub api: InferenceApi,
    pub credential_env: Option<String>,
}
impl EndpointRequest {
    pub fn validate(&self) -> Result<(), Error> {
        crate::config::validate_endpoint(&self.endpoint, false)?;
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
    fn unknown(reason: &str) -> Self {
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
/// services retain their owning readiness checks and generated credentials.
pub fn endpoint_requests(document: &Document) -> Result<Vec<EndpointRequest>, Error> {
    document.validate()?;
    let mut requests = Vec::new();
    for sandbox in &document.spec.sandboxes {
        for provider in document.sandbox_inference_providers(sandbox)? {
            if provider.definition.service_ref.is_some() {
                continue;
            }
            let connection = document.provider_connection(provider.definition)?;
            let request = EndpointRequest {
                endpoint: connection.endpoint,
                api: provider
                    .definition
                    .api
                    .unwrap_or(InferenceApi::for_provider(provider.definition.provider)),
                credential_env: connection.credential.map(|credential| credential.env),
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

/// GET model metadata with bounded responses and no redirects or generation calls.
/// A missing credential permits an anonymous catalog read; only an actual denial
/// establishes that the server requires authentication. Local availability is a
/// separate direct observation and is never persisted in provider data sources.
pub async fn observe_endpoint(
    request: &EndpointRequest,
    secrets: &dyn Secrets,
) -> EndpointObservation {
    if request.validate().is_err() {
        return EndpointObservation::unknown("invalid inference discovery request");
    }
    match tokio::time::timeout(Duration::from_secs(5), read_catalog(request, secrets)).await {
        Ok(observed) => observed,
        Err(_) => EndpointObservation::unknown("inference catalog observation timed out"),
    }
}
fn models_url(request: &EndpointRequest) -> Result<url::Url, ()> {
    let mut url = url::Url::parse(&request.endpoint).map_err(|_| ())?;
    let base = url.path().trim_end_matches('/');
    let path = if request.api == InferenceApi::AnthropicMessages && !base.ends_with("/v1") {
        format!("{base}/v1/models")
    } else {
        format!("{base}/models")
    };
    url.set_path(&path);
    if request.api == InferenceApi::AnthropicMessages {
        url.query_pairs_mut().append_pair("limit", "1000");
    }
    Ok(url)
}
fn model_request(
    client: &reqwest::Client,
    url: url::Url,
    api: InferenceApi,
    secret: Option<&str>,
) -> reqwest::RequestBuilder {
    let request = client
        .get(url)
        .header(reqwest::header::ACCEPT, "application/json");
    match api {
        InferenceApi::AnthropicMessages => {
            let request = request.header("anthropic-version", "2023-06-01");
            if let Some(secret) = secret {
                request.header("x-api-key", secret)
            } else {
                request
            }
        }
        _ => {
            if let Some(secret) = secret {
                request.bearer_auth(secret)
            } else {
                request
            }
        }
    }
}
async fn read_catalog(request: &EndpointRequest, secrets: &dyn Secrets) -> EndpointObservation {
    let mut observed = EndpointObservation::unknown("inference catalog could not be observed");
    let Ok(client) = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(5))
        .build()
    else {
        return observed;
    };
    let Ok(mut url) = models_url(request) else {
        return observed;
    };
    let secret = request
        .credential_env
        .as_ref()
        .and_then(|reference| secrets.resolve(reference).ok())
        .filter(|secret| !secret.is_empty());
    let mut models = BTreeSet::new();
    let mut cursors = BTreeSet::new();
    let mut remaining = MAX_BYTES;
    for _ in 0..MAX_PAGES {
        let response = match model_request(&client, url.clone(), request.api, secret.as_deref())
            .send()
            .await
        {
            Ok(response) => response,
            Err(_) => {
                observed.reason =
                    Some("inference endpoint could not be reached from the control host".into());
                return observed;
            }
        };
        observed.reachable = Some(true);
        if matches!(response.status().as_u16(), 401 | 403) {
            observed.status = ObservationStatus::Unavailable;
            observed.authentication = if secret.is_some() || response.status().as_u16() == 403 {
                AuthenticationStatus::Denied
            } else {
                AuthenticationStatus::Required
            };
            observed.reason = Some("inference catalog access was denied".into());
            return observed;
        }
        if !response.status().is_success() {
            observed.reason = Some("inference model catalog is unavailable or unsupported".into());
            return observed;
        }
        let mut body = Vec::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let Ok(chunk) = chunk else {
                observed.reason = Some("inference model catalog response was incomplete".into());
                return observed;
            };
            if chunk.len() > remaining {
                observed.reason =
                    Some("inference model catalog exceeds the observation limit".into());
                return observed;
            }
            remaining -= chunk.len();
            body.extend_from_slice(&chunk);
        }
        let Ok(value) = serde_json::from_slice::<serde_json::Value>(&body) else {
            observed.reason = Some("inference model catalog is malformed".into());
            return observed;
        };
        let Some(data) = value["data"].as_array() else {
            observed.reason = Some("inference endpoint did not advertise a model catalog".into());
            return observed;
        };
        if data.len() > MAX_MODELS {
            observed.reason = Some("inference model catalog exceeds the observation limit".into());
            return observed;
        }
        for item in data {
            let Some(id) = item["id"].as_str().filter(|id| {
                !id.is_empty()
                    && id.len() <= 1024
                    && !id.chars().any(char::is_control)
                    && secret.as_ref().is_none_or(|secret| !id.contains(secret))
            }) else {
                observed.reason =
                    Some("inference model catalog contains an invalid identifier".into());
                return observed;
            };
            models.insert(id.to_owned());
            if models.len() > MAX_MODELS {
                observed.reason =
                    Some("inference model catalog exceeds the observation limit".into());
                return observed;
            }
        }
        match value.get("has_more") {
            None | Some(serde_json::Value::Bool(false)) => {
                observed.status = ObservationStatus::Available;
                observed.reason = None;
                observed.authentication = if secret.is_some() {
                    AuthenticationStatus::Accepted
                } else {
                    AuthenticationStatus::NotRequired
                };
                observed.models = models.into_iter().collect();
                return observed;
            }
            Some(serde_json::Value::Bool(true))
                if request.api == InferenceApi::AnthropicMessages =>
            {
                let Some(cursor) = value["last_id"].as_str().filter(|id| {
                    !id.is_empty() && id.len() <= 1024 && !id.chars().any(char::is_control)
                }) else {
                    observed.reason =
                        Some("inference model catalog pagination is incomplete".into());
                    return observed;
                };
                if !cursors.insert(cursor.to_owned()) {
                    observed.reason =
                        Some("inference model catalog pagination did not advance".into());
                    return observed;
                }
                url.query_pairs_mut()
                    .clear()
                    .append_pair("limit", "1000")
                    .append_pair("after_id", cursor);
            }
            _ => {
                observed.reason = Some("inference model catalog pagination is unsupported".into());
                return observed;
            }
        }
    }
    observed.reason = Some("inference model catalog exceeds the pagination limit".into());
    observed
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn authentication_uses_protocol_headers_without_query_credentials() {
        let client = reqwest::Client::new();
        let url = url::Url::parse("https://example.com/v1/models").unwrap();
        let request = model_request(
            &client,
            url.clone(),
            InferenceApi::AnthropicMessages,
            Some("SECRET_VALUE"),
        )
        .build()
        .unwrap();
        assert_eq!(request.headers()["x-api-key"], "SECRET_VALUE");
        assert_eq!(request.headers()["anthropic-version"], "2023-06-01");
        assert!(request.url().query().is_none());
        let request = model_request(
            &client,
            url,
            InferenceApi::OpenaiResponses,
            Some("SECRET_VALUE"),
        )
        .build()
        .unwrap();
        assert_eq!(
            request.headers()[reqwest::header::AUTHORIZATION],
            "Bearer SECRET_VALUE"
        );
        assert!(!request.headers().contains_key("x-api-key"));
    }
}
