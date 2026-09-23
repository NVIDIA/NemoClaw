// SPDX-FileCopyrightText: Copyright (c) 2025-2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! SDK error type. Surfaces a discriminable variant set so consumers (CLI,
//! TUI, language bindings) can decide how to render or remap each kind.

use miette::Diagnostic;
pub use openshell_core::rpc_error::ErrorDetails;
use thiserror::Error;

/// SDK result type alias.
pub type Result<T> = std::result::Result<T, SdkError>;

/// Errors produced by `openshell-sdk`.
///
/// CLI consumers convert these to `miette::Report` at the call boundary;
/// future TS/Python bindings will map them to language-native exceptions
/// via the [`SdkError::code`] accessor.
#[derive(Debug, Error, Diagnostic)]
pub enum SdkError {
    /// Caller-supplied configuration is invalid (URL parse, missing field,
    /// illegal token characters).
    #[error("invalid configuration: {message}")]
    #[diagnostic(code(openshell::sdk::invalid_config))]
    InvalidConfig {
        /// Error message.
        message: String,
        /// Original gateway status, when validation happened remotely.
        status: Option<Box<tonic::Status>>,
    },

    /// TLS material parse or rustls config build failure.
    #[error("TLS error: {message}")]
    #[diagnostic(code(openshell::sdk::tls))]
    Tls {
        /// Error message.
        message: String,
    },

    /// Failed to establish a connection to the gateway (TCP, TLS handshake,
    /// HTTP/2, WebSocket upgrade).
    #[error("connect error: {message}")]
    #[diagnostic(code(openshell::sdk::connect))]
    Connect {
        /// Error message.
        message: String,
    },

    /// Auth-related failure: OIDC discovery / refresh, token format invalid
    /// for header injection.
    ///
    /// `retryable` mirrors the refresh contract's transient/terminal split: a
    /// transient failure (network or `IdP` blip) may succeed on retry, while a
    /// terminal one (session revoked, refresh token expired) requires
    /// re-authentication. All non-refresh auth failures are non-retryable.
    #[error("auth error: {message}")]
    #[diagnostic(code(openshell::sdk::auth))]
    Auth {
        /// Error message.
        message: String,
        /// Whether retrying the same operation may succeed.
        retryable: bool,
        /// Original gateway status, when authentication happened remotely.
        status: Option<Box<tonic::Status>>,
    },

    /// Local IO failure (file read, listener bind, socket).
    #[error("I/O error: {source}")]
    #[diagnostic(code(openshell::sdk::io))]
    Io {
        /// Underlying I/O error.
        #[from]
        source: std::io::Error,
    },

    /// Gateway reported the requested object does not exist (gRPC `NotFound`).
    #[error("not found: {message}")]
    #[diagnostic(code(openshell::sdk::not_found))]
    NotFound {
        /// Error message.
        message: String,
        /// Original gateway status, including details and metadata.
        status: Box<tonic::Status>,
    },

    /// Gateway reported the requested object already exists (gRPC `AlreadyExists`).
    #[error("already exists: {message}")]
    #[diagnostic(code(openshell::sdk::already_exists))]
    AlreadyExists {
        /// Error message.
        message: String,
        /// Original gateway status, including details and metadata.
        status: Box<tonic::Status>,
    },

    /// Catch-all for gRPC errors not mapped to a more specific variant.
    #[error("gateway error ({code}): {message}")]
    #[diagnostic(code(openshell::sdk::rpc))]
    Rpc {
        /// Numeric gRPC status code (see [`tonic::Code`]).
        code: i32,
        /// Error message.
        message: String,
        /// Original gateway status, including unknown details and metadata.
        status: Box<tonic::Status>,
    },
}

impl SdkError {
    /// Create an `InvalidConfig` error.
    pub fn invalid_config(message: impl Into<String>) -> Self {
        Self::InvalidConfig {
            message: message.into(),
            status: None,
        }
    }

    /// Create a `Tls` error.
    pub fn tls(message: impl Into<String>) -> Self {
        Self::Tls {
            message: message.into(),
        }
    }

    /// Create a `Connect` error.
    pub fn connect(message: impl Into<String>) -> Self {
        Self::Connect {
            message: message.into(),
        }
    }

    /// Create a non-retryable `Auth` error.
    pub fn auth(message: impl Into<String>) -> Self {
        Self::Auth {
            message: message.into(),
            retryable: false,
            status: None,
        }
    }

    /// Create an `Auth` error, tagging whether retrying may succeed.
    pub fn auth_retryable(message: impl Into<String>, retryable: bool) -> Self {
        Self::Auth {
            message: message.into(),
            retryable,
            status: None,
        }
    }

    /// Map a gateway failure while retaining its complete transport status.
    pub fn from_status(status: tonic::Status) -> Self {
        let message = status.message().to_owned();
        let code = status.code();
        let status = Box::new(status);
        match code {
            tonic::Code::NotFound => Self::NotFound { message, status },
            tonic::Code::AlreadyExists => Self::AlreadyExists { message, status },
            tonic::Code::InvalidArgument => Self::InvalidConfig {
                message,
                status: Some(status),
            },
            tonic::Code::Unauthenticated | tonic::Code::PermissionDenied => Self::Auth {
                message,
                retryable: false,
                status: Some(status),
            },
            _ => Self::Rpc {
                code: code as i32,
                message,
                status,
            },
        }
    }

    /// Complete original status, including unrecognized details and metadata.
    pub fn grpc_status(&self) -> Option<&tonic::Status> {
        match self {
            Self::InvalidConfig { status, .. } | Self::Auth { status, .. } => status.as_deref(),
            Self::NotFound { status, .. }
            | Self::AlreadyExists { status, .. }
            | Self::Rpc { status, .. } => Some(status),
            _ => None,
        }
    }

    /// Decode standard rich details. Malformed details never replace the failure.
    /// The original bytes remain accessible through [`Self::grpc_status`].
    pub fn error_details(&self) -> Option<ErrorDetails> {
        self.grpc_status()
            .and_then(openshell_core::rpc_error::decode_details)
    }

    /// Server-suggested minimum retry delay, if supplied.
    /// This does not establish that repeating a mutation is safe.
    pub fn retry_delay(&self) -> Option<std::time::Duration> {
        self.error_details()?.retry_info()?.retry_delay
    }

    /// Stable string code for cross-language binding consumers.
    ///
    /// Returns one of: `invalid_config`, `tls`, `connect`, `auth`, `io`,
    /// `not_found`, `already_exists`, `rpc`. Phase 3 (napi binding) will
    /// surface this as the JS error's `code` field for discriminated-union
    /// ergonomics.
    /// Whether retrying the same operation may succeed.
    ///
    /// Only a transient [`SdkError::Auth`] failure reports `true`; every other
    /// error is non-retryable and the caller should surface it rather than
    /// loop. Consumers use this to distinguish a retryable refresh blip from a
    /// dead session that needs re-authentication.
    pub const fn retryable(&self) -> bool {
        matches!(
            self,
            Self::Auth {
                retryable: true,
                ..
            }
        )
    }

    pub const fn code(&self) -> &'static str {
        match self {
            Self::InvalidConfig { .. } => "invalid_config",
            Self::Tls { .. } => "tls",
            Self::Connect { .. } => "connect",
            Self::Auth { .. } => "auth",
            Self::Io { .. } => "io",
            Self::NotFound { .. } => "not_found",
            Self::AlreadyExists { .. } => "already_exists",
            Self::Rpc { .. } => "rpc",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use openshell_core::rpc_error;
    use openshell_core::rpc_error::StatusExt;

    #[test]
    fn preserves_details_and_metadata_for_every_status_class() {
        for code in [
            tonic::Code::InvalidArgument,
            tonic::Code::NotFound,
            tonic::Code::AlreadyExists,
            tonic::Code::Unauthenticated,
            tonic::Code::PermissionDenied,
            tonic::Code::Aborted,
            tonic::Code::Unavailable,
        ] {
            let mut status = tonic::Status::with_error_details(
                code,
                "invalid name",
                rpc_error::invalid_argument("name", "invalid name").get_error_details(),
            );
            status
                .metadata_mut()
                .insert("request-id", "test-correlation".parse().unwrap());
            let original = status.details().to_vec();
            let error = SdkError::from_status(status);
            let raw = error.grpc_status().unwrap();
            assert_eq!(raw.code(), code);
            assert_eq!(raw.details(), original);
            assert_eq!(
                raw.metadata().get("request-id").unwrap(),
                "test-correlation"
            );
            assert_eq!(
                error
                    .error_details()
                    .unwrap()
                    .bad_request()
                    .unwrap()
                    .field_violations[0]
                    .field,
                "name"
            );
        }
    }

    #[test]
    fn malformed_details_do_not_replace_the_original_error() {
        let status =
            tonic::Status::with_details(tonic::Code::Unavailable, "offline", vec![255].into());
        let error = SdkError::from_status(status);
        assert_eq!(error.grpc_status().unwrap().details(), &[255]);
        assert!(error.error_details().is_none());
        assert!(error.retry_delay().is_none());
    }

    #[test]
    fn local_errors_have_no_transport_status() {
        assert!(SdkError::invalid_config("local").grpc_status().is_none());
        assert!(SdkError::auth("local").error_details().is_none());
    }
}
