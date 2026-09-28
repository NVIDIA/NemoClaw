// SPDX-FileCopyrightText: Copyright (c) 2025-2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Edge-authenticated WebSocket tunnel proxy.
//!
//! When the gateway sits behind a reverse proxy with edge authentication
//! (e.g., Cloudflare Access), gRPC (HTTP/2 POST) requests are rejected at the
//! edge because browser-flow JWTs only authenticate GET requests.
//!
//! The workaround is to open a **WebSocket** to the edge (WebSocket upgrades
//! are GET requests, which the edge authenticates normally) and then pipe raw
//! TCP bytes through WebSocket binary frames.
//!
//! This module implements the pattern:
//!
//! 1. Bind a local TCP listener on an ephemeral port.
//! 2. For each accepted connection, open a WebSocket (`wss://`) to the
//!    gateway's tunnel endpoint with the bearer token in upgrade headers.
//! 3. Bidirectionally pipe bytes between the local TCP stream and the
//!    WebSocket.
//!
//! The gRPC `Channel` then connects to `http://127.0.0.1:<local_port>`
//! (plaintext) — the edge handles TLS, and the WebSocket carries the raw
//! bytes to the origin.

use crate::error::{Result, SdkError};
use futures::stream::{SplitSink, SplitStream};
use futures::{SinkExt, StreamExt};
use openshell_core::net::set_tcp_nodelay_best_effort;
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};
use tracing::{debug, error, warn};

/// A running edge-authenticated tunnel proxy.
///
/// The proxy listens on a local TCP port and tunnels each connection over a
/// WebSocket to the edge. The listener runs in a detached task for the
/// lifetime of the current process.
pub struct EdgeTunnelProxy {
    /// Local address the proxy is listening on (e.g. `127.0.0.1:54321`).
    pub local_addr: SocketAddr,
}

/// Configuration for establishing the WebSocket tunnel.
#[derive(Clone)]
struct TunnelConfig {
    /// The `wss://` URL to connect to (derived from the gateway endpoint).
    ws_url: String,
    /// The bearer token for edge authentication.
    edge_token: String,
}

/// Start the local tunnel proxy.
///
/// Returns an [`EdgeTunnelProxy`] with the local address to connect to.
/// The proxy runs as a background tokio task.
pub async fn start_tunnel_proxy(
    gateway_endpoint: &str,
    edge_token: &str,
) -> Result<EdgeTunnelProxy> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let local_addr = listener.local_addr()?;

    // Convert the gateway endpoint to a WebSocket URL.
    // https://foo.com -> wss://foo.com
    // http://foo.com  -> ws://foo.com  (edge proxy over plain HTTP, uncommon but handled)
    let ws_url = format!(
        "{}/_ws_tunnel",
        gateway_endpoint
            .replacen("https://", "wss://", 1)
            .replacen("http://", "ws://", 1)
            .trim_end_matches('/')
    );

    let config = Arc::new(TunnelConfig {
        ws_url,
        edge_token: edge_token.to_string(),
    });

    debug!(
        local_addr = %local_addr,
        gateway = %gateway_endpoint,
        "starting edge tunnel proxy"
    );

    tokio::spawn(accept_loop(listener, config));

    Ok(EdgeTunnelProxy { local_addr })
}

/// Accept loop: for each incoming TCP connection, spawn a handler that
/// opens a WebSocket to the edge and pipes bytes bidirectionally.
async fn accept_loop(listener: TcpListener, config: Arc<TunnelConfig>) {
    loop {
        match listener.accept().await {
            Ok((stream, peer)) => {
                debug!(peer = %peer, "accepted local tunnel connection");
                set_tcp_nodelay_best_effort(&stream);
                let config = Arc::clone(&config);
                tokio::spawn(async move {
                    if let Err(e) = handle_connection(stream, &config).await {
                        warn!(peer = %peer, error = %e, "tunnel connection failed");
                    }
                });
            }
            Err(e) => {
                error!(error = %e, "failed to accept tunnel connection");
                // Brief backoff to avoid tight error loops.
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            }
        }
    }
}

/// Handle a single tunneled connection: open a WebSocket to the edge and
/// bidirectionally copy bytes.
async fn handle_connection(tcp_stream: TcpStream, config: &TunnelConfig) -> Result<()> {
    let ws_stream = open_ws(config).await?;
    let (ws_sink, ws_source) = ws_stream.split();
    let (tcp_read, tcp_write) = tokio::io::split(tcp_stream);

    // Two tasks: TCP->WS and WS->TCP. Abort the peer task once either
    // direction finishes so the connection tears down promptly.
    let mut tcp_to_ws = tokio::spawn(copy_tcp_to_ws(tcp_read, ws_sink));
    let mut ws_to_tcp = tokio::spawn(copy_ws_to_tcp(ws_source, tcp_write));

    tokio::select! {
        res = &mut tcp_to_ws => {
            if let Err(e) = res {
                debug!(error = %e, "tcp->ws task panicked");
            }
            ws_to_tcp.abort();
        }
        res = &mut ws_to_tcp => {
            if let Err(e) = res {
                debug!(error = %e, "ws->tcp task panicked");
            }
            tcp_to_ws.abort();
        }
    }

    Ok(())
}

/// Open a WebSocket connection to the edge proxy.
async fn open_ws(config: &TunnelConfig) -> Result<WebSocketStream<MaybeTlsStream<TcpStream>>> {
    let mut request = (&config.ws_url)
        .into_client_request()
        .map_err(|e| SdkError::invalid_config(format!("invalid tunnel URL: {e}")))?;

    // Inject the bearer token via multiple headers for compatibility with
    // Cloudflare Access (which checks `Cf-Access-Token`, the
    // `CF_Authorization` cookie, and the `Cf-Access-Jwt-Assertion` header).
    let token_val = HeaderValue::from_str(&config.edge_token)
        .map_err(|e| SdkError::auth(format!("invalid edge token header value: {e}")))?;
    request
        .headers_mut()
        .insert("Cf-Access-Token", token_val.clone());
    request
        .headers_mut()
        .insert("Cf-Access-Jwt-Assertion", token_val);
    request.headers_mut().insert(
        "Cookie",
        HeaderValue::from_str(&format!("CF_Authorization={}", config.edge_token))
            .map_err(|e| SdkError::auth(format!("invalid edge token cookie value: {e}")))?,
    );

    debug!(url = %config.ws_url, "opening WebSocket to edge");

    let (ws_stream, response) = tokio_tungstenite::connect_async(request)
        .await
        .map_err(|e| SdkError::connect(format!("WebSocket connect failed: {e}")))?;

    let tcp = match ws_stream.get_ref() {
        MaybeTlsStream::Plain(tcp) => Some(tcp),
        MaybeTlsStream::Rustls(tls) => Some(tls.get_ref().0),
        // `MaybeTlsStream` is #[non_exhaustive]; surface any future/unknown
        // variant so a silent TCP_NODELAY miss doesn't go unnoticed.
        _ => {
            debug!("edge tunnel: unrecognized MaybeTlsStream variant; skipping TCP_NODELAY");
            None
        }
    };
    if let Some(tcp) = tcp {
        set_tcp_nodelay_best_effort(tcp);
    }

    debug!(
        status = %response.status(),
        "WebSocket connected to edge"
    );

    Ok(ws_stream)
}

/// Copy bytes from a local TCP reader into WebSocket binary frames.
async fn copy_tcp_to_ws(
    mut tcp_read: tokio::io::ReadHalf<TcpStream>,
    mut ws_sink: SplitSink<WebSocketStream<MaybeTlsStream<TcpStream>>, Message>,
) {
    let mut buf = vec![0u8; 32 * 1024];
    loop {
        match tcp_read.read(&mut buf).await {
            Ok(0) => {
                // EOF — send a close frame.
                let _ = ws_sink.close().await;
                break;
            }
            Ok(n) => {
                if ws_sink
                    .send(Message::Binary(buf[..n].to_vec().into()))
                    .await
                    .is_err()
                {
                    break;
                }
            }
            Err(e) => {
                debug!(error = %e, "tcp read error");
                let _ = ws_sink.close().await;
                break;
            }
        }
    }
}

/// Copy bytes from WebSocket binary frames into a local TCP writer.
async fn copy_ws_to_tcp(
    mut ws_source: SplitStream<WebSocketStream<MaybeTlsStream<TcpStream>>>,
    mut tcp_write: tokio::io::WriteHalf<TcpStream>,
) {
    while let Some(msg) = ws_source.next().await {
        match msg {
            Ok(Message::Binary(data)) => {
                if tcp_write.write_all(&data).await.is_err() {
                    break;
                }
            }
            Ok(Message::Close(_)) => break,
            Ok(Message::Ping(_) | Message::Pong(_) | Message::Frame(_)) => {
                // Handled automatically by tungstenite.
            }
            Ok(Message::Text(text)) => {
                // Some proxies send text frames — treat as binary.
                if tcp_write.write_all(text.as_bytes()).await.is_err() {
                    break;
                }
            }
            Err(e) => {
                debug!(error = %e, "ws read error");
                break;
            }
        }
    }
    let _ = tcp_write.shutdown().await;
}
