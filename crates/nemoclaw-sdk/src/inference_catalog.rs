// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Advertised model catalogs, not inference probes or sandbox reachability.
//! Protocols: https://platform.openai.com/docs/api-reference/models/list and
//! https://platform.claude.com/docs/en/api/models/list.
use crate::{
    Secrets,
    config::InferenceApi,
    discovery::ObservationStatus,
    inference_discovery::{AuthenticationStatus, EndpointObservation, EndpointRequest},
};
use futures_util::StreamExt;
use std::{collections::BTreeSet, time::Duration};

const MAX_BYTES: usize = 2 * 1024 * 1024;
const MAX_MODELS: usize = 10_000;
const MAX_PAGES: usize = 10;

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
/// Whether a request failed because the server presented a certificate the
/// system trust store does not accept. TLS errors arrive inside nested I/O
/// errors, whose `source` skips the error each one wraps.
fn untrusted_certificate(error: &reqwest::Error) -> bool {
    let mut current: Option<&(dyn std::error::Error + 'static)> = Some(error);
    while let Some(error) = current {
        if matches!(
            error.downcast_ref::<rustls::Error>(),
            Some(rustls::Error::InvalidCertificate(_))
        ) {
            return true;
        }
        current = match error
            .downcast_ref::<std::io::Error>()
            .and_then(std::io::Error::get_ref)
        {
            Some(inner) => Some(inner as &(dyn std::error::Error + 'static)),
            None => error.source(),
        };
    }
    false
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
            Err(error) if untrusted_certificate(&error) => {
                observed.reason = Some(
                    "the inference server's certificate is not trusted by the control host; add its CA to the system trust store or set SSL_CERT_FILE to a bundle that includes it"
                        .into(),
                );
                return observed;
            }
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

    /// A server whose certificate no system trust store holds. It only needs
    /// to present the certificate; the client rejects it during the handshake.
    fn untrusted_server() -> u16 {
        let key = rcgen::KeyPair::generate().unwrap();
        let certificate = rcgen::CertificateParams::new(vec!["localhost".into()])
            .unwrap()
            .self_signed(&key)
            .unwrap();
        let config = std::sync::Arc::new(
            rustls::ServerConfig::builder_with_provider(std::sync::Arc::new(
                rustls::crypto::ring::default_provider(),
            ))
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_no_client_auth()
            .with_single_cert(
                vec![certificate.der().clone()],
                rustls::pki_types::PrivateKeyDer::Pkcs8(key.serialize_der().into()),
            )
            .unwrap(),
        );
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for mut stream in listener.incoming().flatten() {
                let mut connection = rustls::ServerConnection::new(config.clone()).unwrap();
                let _ = connection.complete_io(&mut stream);
            }
        });
        port
    }

    #[tokio::test]
    async fn an_untrusted_certificate_names_how_to_trust_it() {
        let request = EndpointRequest {
            endpoint: format!("https://localhost:{}/v1", untrusted_server()),
            api: InferenceApi::OpenaiCompletions,
            credential_env: None,
        };
        let observed = observe_endpoint(&request, &crate::EnvironmentSecrets).await;
        assert_eq!(observed.status, ObservationStatus::Unknown);
        let reason = observed.reason.unwrap();
        assert!(reason.contains("certificate is not trusted"), "{reason}");
        assert!(reason.contains("SSL_CERT_FILE"), "{reason}");
    }

    #[tokio::test]
    async fn invalid_requests_are_unknown_without_contacting_the_endpoint() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let request = EndpointRequest {
            endpoint: format!("http://{}/v1", listener.local_addr().unwrap()),
            api: InferenceApi::OpenaiCompletions,
            credential_env: Some("not a credential name".into()),
        };
        let observed = observe_endpoint(&request, &crate::EnvironmentSecrets).await;
        assert_eq!(observed.status, ObservationStatus::Unknown);
        assert!(
            tokio::time::timeout(Duration::from_millis(200), listener.accept())
                .await
                .is_err()
        );
    }
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
