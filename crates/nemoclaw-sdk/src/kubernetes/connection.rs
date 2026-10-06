// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! A command-scoped connection to a managed Kubernetes gateway.
//!
//! The gateway is not exposed outside the cluster. For each command the SDK
//! listens on the authored loopback port and forwards every connection to
//! the gateway pod through the Kubernetes API, so no `kubectl` process is
//! involved. Dropping the connection stops the forward.

use super::{CA_ENV, CERT_ENV, KEY_ENV, TOKEN_ENV};
use std::{collections::BTreeMap, future::Future, io};
use tokio::{
    io::{AsyncRead, AsyncWrite},
    net::TcpListener,
};
use tokio_util::task::AbortOnDropHandle;

/// The gateway's endpoint and credentials, valid while this value lives.
pub struct Connection {
    endpoint: String,
    environment: BTreeMap<String, String>,
    _forward: AbortOnDropHandle<()>,
}

impl Connection {
    pub(super) fn new(
        endpoint: String,
        environment: BTreeMap<String, String>,
        forward: AbortOnDropHandle<()>,
    ) -> Self {
        Self {
            endpoint,
            environment,
            _forward: forward,
        }
    }
    /// The loopback HTTPS endpoint the gateway answers on.
    pub fn endpoint(&self) -> &str {
        &self.endpoint
    }
    /// Values for the credential references the provider uses: the
    /// development token and paths to the client CA, certificate and key.
    pub fn environment(&self) -> BTreeMap<String, String> {
        self.environment.clone()
    }
}

/// The environment names this connection supplies.
pub const NAMES: [&str; 4] = [TOKEN_ENV, CA_ENV, CERT_ENV, KEY_ENV];

/// Accept connections on `listener` and copy each one, in both directions,
/// to a stream from `dial`. Runs until the returned handle is dropped.
pub fn forward<D, F, S>(listener: TcpListener, dial: D) -> AbortOnDropHandle<()>
where
    D: Fn() -> F + Send + Sync + 'static,
    F: Future<Output = io::Result<S>> + Send + 'static,
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let dial = std::sync::Arc::new(dial);
    AbortOnDropHandle::new(tokio::spawn(async move {
        // Aborting the listener also drops this set, closing accepted streams
        // and cancelling dials that have not opened their remote stream yet.
        let mut streams = tokio::task::JoinSet::new();
        loop {
            tokio::select! {
                accepted = listener.accept() => {
                    let Ok((mut local, _)) = accepted else {
                        continue;
                    };
                    let dial = dial.clone();
                    streams.spawn(async move {
                        if let Ok(mut remote) = dial().await {
                            let _ = tokio::io::copy_bidirectional(&mut local, &mut remote).await;
                        }
                    });
                }
                _ = streams.join_next(), if !streams.is_empty() => {}
            }
        }
    }))
}
