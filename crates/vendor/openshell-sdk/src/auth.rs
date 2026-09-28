// SPDX-FileCopyrightText: Copyright (c) 2025-2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Bearer-token authentication interceptor for outgoing gRPC requests.

use crate::error::{Result, SdkError};
use std::sync::{Arc, RwLock};
use tonic::metadata::{Ascii, MetadataValue};

/// Shared, mutable OIDC bearer header.
///
/// The interceptor reads it on every request and a [`crate::TokenSource`]
/// overwrites it in place on refresh, so rotation propagates to an
/// already-connected client without rebuilding the channel. Mirrors the slot
/// pattern in `openshell-core`'s gRPC client.
pub type BearerSlot = Arc<RwLock<Option<MetadataValue<Ascii>>>>;

/// Build the `authorization` header value for an OIDC bearer token.
pub fn bearer_metadata(token: &str) -> Result<MetadataValue<Ascii>> {
    format!("Bearer {token}")
        .parse()
        .map_err(|_| SdkError::auth("invalid OIDC token value"))
}

/// Interceptor that injects authentication headers into every outgoing gRPC request.
///
/// Supports OIDC Bearer tokens (standard `authorization` header) and
/// Cloudflare Access tokens (custom headers). When no token is set, acts
/// as a no-op. OIDC takes precedence over edge tokens.
///
/// The OIDC bearer is held in a shared [`BearerSlot`] so token refresh can
/// update it live; edge tokens are captured once at construction (the edge
/// tunnel binds the credential at handshake time).
#[derive(Clone)]
pub struct EdgeAuthInterceptor {
    bearer: Option<BearerSlot>,
    header_value: Option<MetadataValue<Ascii>>,
    cookie_value: Option<MetadataValue<Ascii>>,
}

impl EdgeAuthInterceptor {
    /// Create an interceptor from optional token strings.
    ///
    /// OIDC bearer token takes precedence over edge token. Returns a no-op
    /// interceptor when neither token is provided.
    pub fn new(oidc_token: Option<&str>, edge_token: Option<&str>) -> Result<Self> {
        if let Some(token) = oidc_token {
            let bearer = bearer_metadata(token)?;
            return Ok(Self {
                bearer: Some(Arc::new(RwLock::new(Some(bearer)))),
                header_value: None,
                cookie_value: None,
            });
        }

        let (header_value, cookie_value) = match edge_token {
            Some(t) => {
                let hv: MetadataValue<Ascii> = t
                    .parse()
                    .map_err(|_| SdkError::auth("invalid edge token value"))?;
                let cv: MetadataValue<Ascii> = format!("CF_Authorization={t}")
                    .parse()
                    .map_err(|_| SdkError::auth("invalid edge token value for cookie"))?;
                (Some(hv), Some(cv))
            }
            None => (None, None),
        };
        Ok(Self {
            bearer: None,
            header_value,
            cookie_value,
        })
    }

    /// No-op interceptor that passes requests through without modification.
    pub fn noop() -> Self {
        Self {
            bearer: None,
            header_value: None,
            cookie_value: None,
        }
    }

    /// Handle to the live OIDC bearer slot, if this interceptor carries one.
    ///
    /// The high-level client uses this to overwrite the token in place after
    /// a refresh. `None` for edge-token and no-op interceptors.
    pub fn bearer_slot(&self) -> Option<BearerSlot> {
        self.bearer.clone()
    }
}

impl tonic::service::Interceptor for EdgeAuthInterceptor {
    fn call(
        &mut self,
        mut req: tonic::Request<()>,
    ) -> std::result::Result<tonic::Request<()>, tonic::Status> {
        if let Some(slot) = &self.bearer
            && let Some(val) = slot.read().ok().and_then(|g| g.clone())
        {
            req.metadata_mut().insert("authorization", val);
        }
        if let Some(ref val) = self.header_value {
            req.metadata_mut()
                .insert("cf-access-jwt-assertion", val.clone());
        }
        if let Some(ref val) = self.cookie_value {
            req.metadata_mut().insert("cookie", val.clone());
        }
        Ok(req)
    }
}
