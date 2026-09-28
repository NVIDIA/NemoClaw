// SPDX-FileCopyrightText: Copyright (c) 2025-2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! OIDC discovery and refresh-token flow (non-interactive).
//!
//! Browser-based authorization flows live in `openshell-cli` since they
//! require a local callback HTTP server and an OS browser launcher.

use crate::error::{Result, SdkError};
use oauth2::basic::BasicClient;
use oauth2::{ClientId, RefreshToken, Scope, TokenResponse, TokenUrl};
use serde::Deserialize;

/// OIDC discovery document (subset of fields callers consume).
#[derive(Debug, Deserialize)]
#[non_exhaustive]
pub struct OidcDiscovery {
    pub issuer: String,
    pub authorization_endpoint: String,
    pub token_endpoint: String,
}

/// Input to [`refresh_token`].
///
/// Constructed by the caller from whatever bundle / storage shape they
/// use — the SDK does not assume any particular persistence model.
#[derive(Clone)]
#[non_exhaustive]
pub struct RefreshTokenInput {
    pub refresh_token: String,
    pub issuer: String,
    pub client_id: String,
    /// Scopes to resend with the refresh request. Some identity providers use
    /// these to select the API resource for the refreshed access token.
    pub scopes: Vec<String>,
    pub insecure: bool,
}

impl std::fmt::Debug for RefreshTokenInput {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Omit `refresh_token` (a long-lived secret).
        f.debug_struct("RefreshTokenInput")
            .field("issuer", &self.issuer)
            .field("client_id", &self.client_id)
            .field("scopes", &self.scopes)
            .field("insecure", &self.insecure)
            .finish_non_exhaustive()
    }
}

impl RefreshTokenInput {
    pub fn new(
        refresh_token: impl Into<String>,
        issuer: impl Into<String>,
        client_id: impl Into<String>,
    ) -> Self {
        Self {
            refresh_token: refresh_token.into(),
            issuer: issuer.into(),
            client_id: client_id.into(),
            scopes: Vec::new(),
            insecure: false,
        }
    }

    /// Set the scopes to resend with the refresh-token grant.
    #[must_use]
    pub fn with_scopes<I, S>(mut self, scopes: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        self.scopes = scopes.into_iter().map(Into::into).collect();
        self
    }

    #[must_use]
    pub fn with_insecure(mut self, insecure: bool) -> Self {
        self.insecure = insecure;
        self
    }
}

/// Output from [`refresh_token`].
///
/// `refresh_token` is `None` when the OIDC server did not return a new
/// refresh token; per OAuth 2.0, callers should preserve the previous
/// refresh token in that case. `expires_at` is a Unix timestamp (seconds
/// since epoch); `None` when the server omits `expires_in`.
#[derive(Clone)]
#[non_exhaustive]
pub struct RefreshTokenOutput {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_at: Option<u64>,
}

impl std::fmt::Debug for RefreshTokenOutput {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Omit `access_token`; never print the refresh-token value.
        f.debug_struct("RefreshTokenOutput")
            .field("has_refresh_token", &self.refresh_token.is_some())
            .field("expires_at", &self.expires_at)
            .finish_non_exhaustive()
    }
}

/// Discover OIDC endpoints from the issuer's well-known configuration.
///
/// Validates that the discovery document's `issuer` field matches the
/// configured issuer URL to prevent SSRF or misdirection. When `insecure`
/// is true, TLS certificate verification is disabled (intended for
/// development against self-signed gateways).
pub async fn discover(issuer: &str, insecure: bool) -> Result<OidcDiscovery> {
    let normalized_issuer = issuer.trim_end_matches('/');
    let url = format!("{normalized_issuer}/.well-known/openid-configuration");
    let client = http_client(insecure);
    let resp: OidcDiscovery = client
        .get(&url)
        .send()
        .await
        .map_err(|e| SdkError::auth(format!("OIDC discovery request failed: {e}")))?
        .json()
        .await
        .map_err(|e| SdkError::auth(format!("OIDC discovery JSON parse failed: {e}")))?;

    let discovered_issuer = resp.issuer.trim_end_matches('/');
    if discovered_issuer != normalized_issuer {
        return Err(SdkError::auth(format!(
            "OIDC discovery issuer mismatch: expected '{normalized_issuer}', got '{discovered_issuer}'"
        )));
    }
    Ok(resp)
}

/// Build an HTTP client suitable for OIDC token-endpoint requests.
///
/// Disables redirects so token-endpoint responses aren't accidentally
/// followed; OIDC providers should not redirect on the token endpoint.
/// When `insecure` is true, TLS certificate verification is disabled.
pub fn http_client(insecure: bool) -> reqwest::Client {
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
    let mut builder = reqwest::ClientBuilder::new().redirect(reqwest::redirect::Policy::none());
    if insecure {
        builder = builder.danger_accept_invalid_certs(true);
    }
    builder.build().expect("failed to build HTTP client")
}

/// Refresh an OIDC access token using the `refresh_token` grant.
///
/// The request resends any configured scopes so providers that use scopes to
/// select an API resource mint the correct access token. The caller is
/// responsible for preserving the prior refresh token when the output's
/// `refresh_token` is `None` — per OAuth 2.0 the server may omit it from the
/// refresh response.
pub async fn refresh_token(input: &RefreshTokenInput) -> Result<RefreshTokenOutput> {
    let discovery = discover(&input.issuer, input.insecure).await?;

    let client = BasicClient::new(ClientId::new(input.client_id.clone())).set_token_uri(
        TokenUrl::new(discovery.token_endpoint)
            .map_err(|e| SdkError::auth(format!("invalid token endpoint URL: {e}")))?,
    );

    let refresh_token = RefreshToken::new(input.refresh_token.clone());
    let mut request = client.exchange_refresh_token(&refresh_token);
    for scope in &input.scopes {
        request = request.add_scope(Scope::new(scope.clone()));
    }

    let http = http_client(input.insecure);
    let token_response = request
        .request_async(&http)
        .await
        .map_err(|e| SdkError::auth(format!("token refresh failed: {e}")))?;

    Ok(output_from_oauth2_response(&token_response))
}

fn output_from_oauth2_response(resp: &oauth2::basic::BasicTokenResponse) -> RefreshTokenOutput {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    RefreshTokenOutput {
        access_token: resp.access_token().secret().clone(),
        refresh_token: resp.refresh_token().map(|rt| rt.secret().clone()),
        expires_at: resp.expires_in().map(|ei| now.saturating_add(ei.as_secs())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{body_string_contains, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[test]
    fn debug_redacts_tokens() {
        let input = RefreshTokenInput::new("refresh-secret", "https://idp", "cli")
            .with_scopes(["openid", "api://cli/access_as_user"]);
        let rendered = format!("{input:?}");
        assert!(!rendered.contains("refresh-secret"));
        assert!(rendered.contains("cli"));

        let output = RefreshTokenOutput {
            access_token: "access-secret".to_string(),
            refresh_token: Some("refresh-secret".to_string()),
            expires_at: Some(123),
        };
        let rendered = format!("{output:?}");
        assert!(!rendered.contains("access-secret"));
        assert!(!rendered.contains("refresh-secret"));
        assert!(rendered.contains("has_refresh_token"));
    }

    #[tokio::test]
    async fn refresh_sends_configured_scopes() {
        let server = MockServer::start().await;
        let issuer = server.uri();

        Mock::given(method("GET"))
            .and(path("/.well-known/openid-configuration"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "issuer": issuer,
                "authorization_endpoint": format!("{}/authorize", server.uri()),
                "token_endpoint": format!("{}/token", server.uri()),
            })))
            .expect(1)
            .mount(&server)
            .await;

        Mock::given(method("POST"))
            .and(path("/token"))
            .and(body_string_contains("scope="))
            .and(body_string_contains("access_as_user"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "access_token": "refreshed-access",
                "token_type": "bearer",
                "expires_in": 300,
            })))
            .expect(1)
            .mount(&server)
            .await;

        let input = RefreshTokenInput::new("refresh-secret", &issuer, "client-id")
            .with_scopes(["openid", "api://client-id/access_as_user"]);
        let refreshed = refresh_token(&input)
            .await
            .expect("configured scopes should be sent on refresh");

        assert_eq!(refreshed.access_token, "refreshed-access");
        assert!(refreshed.refresh_token.is_none());
        assert!(refreshed.expires_at.is_some());
    }
}
