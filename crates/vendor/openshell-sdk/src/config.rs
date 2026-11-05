// SPDX-FileCopyrightText: Copyright (c) 2025-2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Public input types for the SDK: how callers describe a gateway and the
//! credentials used to talk to it.
//!
//! Filesystem-aware callers such as the CLI resolve certificate paths before
//! constructing [`ClientConfig`]. The SDK accepts certificate contents so it
//! remains independent of filesystem layout and gateway-name resolution.

use crate::refresh::Refresh;
use std::sync::Arc;

/// Authentication mode for outgoing gRPC requests.
///
/// The two variants are functionally distinct in the transport layer:
/// `EdgeJwt` routes through a local WebSocket tunnel (the only way to get a
/// browser-flow JWT past Cloudflare Access on POST/HTTP2), while `Oidc`
/// connects directly over HTTPS and adds an `authorization: Bearer ...`
/// header.
//
// `#[non_exhaustive]` keeps future additions non-breaking: adding a third
// auth variant won't force downstream `match` arms to break.
#[derive(Clone)]
#[non_exhaustive]
pub enum AuthConfig {
    /// Cloudflare Access JWT — routes through the edge WebSocket tunnel.
    EdgeJwt(String),
    /// OIDC bearer token — direct HTTPS, `authorization` header.
    ///
    /// `expires_at` (Unix seconds, when known) lets the client refresh
    /// proactively before expiry. `refresh`, when supplied, lets the client
    /// rotate the token in place — proactively before expiry and reactively
    /// on an `Unauthenticated` response. `None` keeps the token static for
    /// the connection's lifetime.
    Oidc {
        /// Current OIDC access token.
        token: String,
        /// Advertised expiry (Unix seconds), if known.
        expires_at: Option<u64>,
        /// Optional refresher driving live token rotation.
        refresh: Option<Arc<dyn Refresh>>,
    },
}

impl AuthConfig {
    /// Convenience constructor for a static OIDC bearer token (no refresh).
    pub fn oidc(token: impl Into<String>) -> Self {
        Self::Oidc {
            token: token.into(),
            expires_at: None,
            refresh: None,
        }
    }
}

/// PEM-encoded client identity used for mutual TLS.
///
/// The certificate may contain a chain. The private key must be PKCS#1,
/// PKCS#8, or SEC1 PEM as accepted by tonic/rustls.
#[derive(Clone)]
pub struct ClientIdentity {
    pub certificate: Vec<u8>,
    pub private_key: Vec<u8>,
}

impl ClientIdentity {
    pub fn new(certificate: impl Into<Vec<u8>>, private_key: impl Into<Vec<u8>>) -> Self {
        Self {
            certificate: certificate.into(),
            private_key: private_key.into(),
        }
    }
}

/// Configuration for opening a gRPC channel to an `OpenShell` gateway.
///
/// Consumed by [`crate::OpenShellClient::connect`] and
/// [`crate::transport::build_channel`]. Use one `ClientConfig` per logical
/// connection; callers that want connection pooling cache the resulting client.
//
// NOTE:
// - `gateway` is a full URL (`http://...` or `https://...`) so the scheme
//   tells the transport layer whether to use plaintext or TLS. Matches
//   today's CLI convention; matches the RFC's `pub gateway: String`.
// - `ca_cert` pins a private-CA certificate (PEM-encoded). `None` falls
//   back to the platform's system roots.
// - `client_identity` carries already-resolved PEM bytes. The SDK deliberately
//   does not know where a caller stores certificates.
// - `insecure_skip_verify` is a separate flag rather than a third
//   `AuthConfig` variant because it's a transport concern (cert
//   verification) that's orthogonal to auth.
// - No `timeout` field yet. The RFC mentions one but today's behavior is
//   `connect_timeout(10s)` hard-coded; introducing a configurable timeout
//   here would be a behavior change. Phase 2 territory.
// - No `Debug` derive: `auth` carries secrets; `ca_cert` is fine but we
//   redact the whole struct for safety. If callers want ergonomic printing
//   we can implement `Debug` manually with a redacted token field.
// - `#[non_exhaustive]` + `Default` lets phase 2 add fields (timeout, retry
//   policy, `Refresh` trait) without breaking literal-construct callers.
//   Idiom is `ClientConfig { gateway: g, ..Default::default() }`.
#[derive(Clone, Default)]
#[non_exhaustive]
pub struct ClientConfig {
    /// Gateway URL, e.g. `http://127.0.0.1:8080` or `https://gw.example.com`.
    pub gateway: String,
    /// CA certificate (PEM) for private-CA gateways. `None` uses system
    /// roots. Ignored for plaintext gateways and when
    /// `insecure_skip_verify` is enabled.
    pub ca_cert: Option<Vec<u8>>,
    /// Client certificate and private key for mutual TLS. Ignored for
    /// plaintext gateways, Cloudflare Access tunnels, and insecure TLS.
    pub client_identity: Option<ClientIdentity>,
    /// Bearer-token auth mode. `None` = anonymous TLS over HTTPS, or
    /// plaintext when `gateway` is `http://`.
    pub auth: Option<AuthConfig>,
    /// Disable TLS certificate verification (development/debug only).
    /// Ignored for plaintext gateways. **Do not enable in production.**
    pub insecure_skip_verify: bool,
}

impl ClientConfig {
    pub fn new(gateway: impl Into<String>) -> Self {
        Self {
            gateway: gateway.into(),
            ..Default::default()
        }
    }
}
