// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Private loopback semantic connection for the experimental VoiceClaw R0 profile.

use std::{
    convert::Infallible,
    fmt,
    net::SocketAddr,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use async_trait::async_trait;
use axum::{
    Router,
    body::{Body, to_bytes},
    extract::{Request, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::Response,
    routing::post,
};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use tokio::{
    net::TcpListener,
    sync::{mpsc, watch},
    task::JoinHandle,
};
use tokio_stream::wrappers::ReceiverStream;
use tokio_util::sync::CancellationToken;
use zeroize::Zeroize;

use crate::Binding;

mod onboarding;
pub use onboarding::{Bootstrap, Prepared, Ready};

pub const PROFILE: &str = "nemoclaw-voice-r0/1";
const MAX_MESSAGE: usize = 4096;

/// An issued authority. Debug output deliberately excludes the bearer value.
pub struct AccessGrant {
    credential: String,
    digest: [u8; 32],
    target_ref: String,
    binding: Binding,
    expires_at: OffsetDateTime,
}

impl fmt::Debug for AccessGrant {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("AccessGrant")
            .field("credential", &"[REDACTED]")
            .field("target_ref", &self.target_ref)
            .field("binding", &self.binding)
            .field("expires_at", &self.expires_at)
            .finish()
    }
}

impl AccessGrant {
    /// Issue a random 256-bit credential for the fixed fifteen-minute R0 lifetime.
    pub fn issue(
        target_ref: &str,
        binding: Binding,
        issued_at: OffsetDateTime,
    ) -> Result<Self, getrandom::Error> {
        let mut random = [0_u8; 32];
        getrandom::fill(&mut random)?;
        let mut credential = String::with_capacity(64);
        for byte in random {
            use fmt::Write;
            write!(credential, "{byte:02x}").expect("writing to a string cannot fail");
        }
        Ok(Self::new(
            &credential,
            target_ref,
            binding,
            issued_at,
            Duration::from_secs(15 * 60),
        )
        .expect("generated credentials and fixed lifetime are valid"))
    }

    pub fn new(
        credential: &str,
        target_ref: &str,
        binding: Binding,
        issued_at: OffsetDateTime,
        lifetime: Duration,
    ) -> Result<Self, &'static str> {
        if credential.len() < 64 || !credential.is_ascii() {
            return Err("voice credential must contain at least 256 bits encoded as ASCII");
        }
        if target_ref.is_empty() || target_ref.len() > 512 || !target_ref.is_ascii() {
            return Err("voice target reference is invalid");
        }
        let lifetime = time::Duration::try_from(lifetime)
            .map_err(|_| "voice credential lifetime is invalid")?;
        let expires_at = issued_at
            .checked_add(lifetime)
            .ok_or("voice credential expiry is invalid")?;
        Ok(Self {
            credential: credential.into(),
            digest: Sha256::digest(credential.as_bytes()).into(),
            target_ref: target_ref.into(),
            binding,
            expires_at,
        })
    }

    /// Expose the credential only to its protected handoff owner.
    pub fn credential(&self) -> &str {
        &self.credential
    }

    pub fn target_ref(&self) -> &str {
        &self.target_ref
    }

    pub fn expires_at(&self) -> OffsetDateTime {
        self.expires_at
    }
}

impl Drop for AccessGrant {
    fn drop(&mut self) {
        self.credential.zeroize();
    }
}

pub trait Clock: Send + Sync + 'static {
    fn now(&self) -> OffsetDateTime;
}

#[derive(Debug)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> OffsetDateTime {
        OffsetDateTime::now_utc()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProbeResult {
    Ready,
    Replaced,
    Unavailable,
}

#[async_trait]
pub trait TargetProbe: Send + Sync + 'static {
    async fn probe(&self, binding: &Binding) -> ProbeResult;
}

#[derive(Clone, Copy, Debug)]
pub struct ServerConfig {
    pub heartbeat_interval: Duration,
    pub probe_interval: Duration,
    pub probe_timeout: Duration,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CloseReason {
    ClientDisconnected,
    CredentialExpired,
    AgentUnavailable,
    TargetReplaced,
    ServerStopping,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConnectionState {
    Waiting,
    Connected,
    Closed(CloseReason),
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            heartbeat_interval: Duration::from_secs(5),
            probe_interval: Duration::from_secs(5),
            probe_timeout: Duration::from_secs(5),
        }
    }
}

struct ServerState {
    digest: [u8; 32],
    target_ref: String,
    binding: Binding,
    expires_at: OffsetDateTime,
    probe: Arc<dyn TargetProbe>,
    clock: Arc<dyn Clock>,
    config: ServerConfig,
    active: Arc<AtomicBool>,
    connection: watch::Sender<ConnectionState>,
    stop: CancellationToken,
}

pub struct VoiceServer {
    endpoint: String,
    stop: CancellationToken,
    connection: watch::Receiver<ConnectionState>,
    task: JoinHandle<()>,
}

impl VoiceServer {
    pub async fn bind(
        address: SocketAddr,
        grant: &AccessGrant,
        probe: Arc<dyn TargetProbe>,
        clock: Arc<dyn Clock>,
        config: ServerConfig,
    ) -> Result<Self, std::io::Error> {
        if !address.ip().is_loopback() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "voice server must bind to loopback",
            ));
        }
        let listener = TcpListener::bind(address).await?;
        let address = listener.local_addr()?;
        let stop = CancellationToken::new();
        let (connection, observed_connection) = watch::channel(ConnectionState::Waiting);
        let state = Arc::new(ServerState {
            digest: grant.digest,
            target_ref: grant.target_ref.clone(),
            binding: grant.binding.clone(),
            expires_at: grant.expires_at,
            probe,
            clock,
            config,
            active: Arc::new(AtomicBool::new(false)),
            connection,
            stop: stop.clone(),
        });
        let app = Router::new()
            .route("/r0/connect", post(connect))
            .with_state(state);
        let shutdown = stop.clone();
        let task = tokio::spawn(async move {
            let _ = axum::serve(listener, app)
                .with_graceful_shutdown(shutdown.cancelled_owned())
                .await;
        });
        let host = if address.is_ipv6() {
            format!("[{}]", address.ip())
        } else {
            address.ip().to_string()
        };
        Ok(Self {
            endpoint: format!("http://{host}:{}/r0/connect", address.port()),
            stop,
            connection: observed_connection,
            task,
        })
    }

    pub fn endpoint(&self) -> &str {
        &self.endpoint
    }

    pub fn stop(&self) {
        self.stop.cancel();
    }

    pub fn connection_state(&self) -> ConnectionState {
        *self.connection.borrow()
    }

    pub async fn wait_for_run(
        &self,
        cancel: &CancellationToken,
    ) -> Result<CloseReason, crate::Error> {
        let mut connection = self.connection.clone();
        loop {
            match *connection.borrow_and_update() {
                ConnectionState::Closed(reason) => return Ok(reason),
                ConnectionState::Waiting | ConnectionState::Connected => {}
            }
            tokio::select! {
                () = cancel.cancelled() => return Err(crate::Error::Cancelled),
                changed = connection.changed() => changed.map_err(|_| crate::Error::State("voice connection state ended unexpectedly"))?,
            }
        }
    }
}

impl Drop for VoiceServer {
    fn drop(&mut self) {
        self.stop.cancel();
        self.task.abort();
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ConnectRequest {
    profile: String,
    target_ref: String,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Record<'a> {
    Ready {
        profile: &'a str,
        #[serde(rename = "targetRef")]
        target_ref: &'a str,
        #[serde(rename = "expiresAt")]
        expires_at: String,
    },
    Heartbeat,
    Closed {
        reason: &'a str,
    },
}

struct ActiveGuard {
    active: Arc<AtomicBool>,
    connection: watch::Sender<ConnectionState>,
    reason: CloseReason,
    connected: bool,
}

impl ActiveGuard {
    fn close(&mut self, reason: CloseReason) {
        self.reason = reason;
    }
}

impl Drop for ActiveGuard {
    fn drop(&mut self) {
        self.active.store(false, Ordering::Release);
        if self.connected {
            self.connection
                .send_replace(ConnectionState::Closed(self.reason));
        }
    }
}

async fn connect(State(state): State<Arc<ServerState>>, request: Request) -> Response {
    if !authenticated(request.headers(), &state.digest) {
        return error(StatusCode::UNAUTHORIZED, "authentication_failed");
    }
    if state.clock.now() >= state.expires_at {
        return error(StatusCode::UNAUTHORIZED, "credential_expired");
    }
    if request.uri().query().is_some() {
        return error(StatusCode::BAD_REQUEST, "invalid_request");
    }
    if !json_content_type(request.headers()) {
        return error(StatusCode::UNSUPPORTED_MEDIA_TYPE, "unsupported_media_type");
    }
    if request
        .headers()
        .get(header::ACCEPT)
        .and_then(|v| v.to_str().ok())
        != Some("application/x-ndjson")
    {
        return error(StatusCode::BAD_REQUEST, "invalid_request");
    }
    if request
        .headers()
        .get(header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<usize>().ok())
        .is_some_and(|length| length > MAX_MESSAGE)
    {
        return error(StatusCode::PAYLOAD_TOO_LARGE, "request_too_large");
    }
    let body = match to_bytes(request.into_body(), MAX_MESSAGE).await {
        Ok(body) => body,
        Err(_) => return error(StatusCode::PAYLOAD_TOO_LARGE, "request_too_large"),
    };
    let request: ConnectRequest = match serde_json::from_slice(&body) {
        Ok(request) => request,
        Err(_) => return error(StatusCode::BAD_REQUEST, "invalid_request"),
    };
    if request.profile != PROFILE {
        return error(StatusCode::CONFLICT, "unsupported_profile");
    }
    if request.target_ref != state.target_ref {
        return error(StatusCode::FORBIDDEN, "target_not_authorized");
    }
    if state
        .active
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return error(StatusCode::CONFLICT, "connection_active");
    }
    let guard = ActiveGuard {
        active: state.active.clone(),
        connection: state.connection.clone(),
        reason: CloseReason::ClientDisconnected,
        connected: false,
    };
    match tokio::time::timeout(
        state.config.probe_timeout,
        state.probe.probe(&state.binding),
    )
    .await
    {
        Ok(ProbeResult::Ready) => {}
        Ok(ProbeResult::Replaced) => {
            return pre_stream_failure(guard, StatusCode::CONFLICT, "target_replaced");
        }
        Ok(ProbeResult::Unavailable) | Err(_) => {
            return pre_stream_failure(guard, StatusCode::SERVICE_UNAVAILABLE, "agent_unavailable");
        }
    }

    let expires_at = state.expires_at.format(&Rfc3339).unwrap_or_default();
    let (tx, rx) = mpsc::channel::<Vec<u8>>(2);
    let stream_state = state.clone();
    tokio::spawn(async move {
        let mut guard = guard;
        if tx
            .send(line(&Record::Ready {
                profile: PROFILE,
                target_ref: &stream_state.target_ref,
                expires_at,
            }))
            .await
            .is_err()
        {
            return;
        }
        stream_state
            .connection
            .send_replace(ConnectionState::Connected);
        guard.connected = true;
        run_stream(stream_state, tx, guard).await;
    });

    let body = Body::from_stream(ReceiverStream::new(rx).map(Ok::<_, Infallible>));
    response(StatusCode::OK, "application/x-ndjson", body)
}

fn pre_stream_failure(guard: ActiveGuard, status: StatusCode, code: &'static str) -> Response {
    drop(guard);
    error(status, code)
}

async fn run_stream(state: Arc<ServerState>, tx: mpsc::Sender<Vec<u8>>, mut guard: ActiveGuard) {
    let until_expiry = (state.expires_at - state.clock.now())
        .try_into()
        .unwrap_or(Duration::ZERO);
    let expiry = tokio::time::sleep(until_expiry);
    tokio::pin!(expiry);
    let mut heartbeat = tokio::time::interval(state.config.heartbeat_interval);
    let mut probe = tokio::time::interval(state.config.probe_interval);
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    probe.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    heartbeat.tick().await;
    probe.tick().await;
    loop {
        let reason = tokio::select! {
            biased;
            () = state.stop.cancelled() => Some("server_stopping"),
            () = &mut expiry => Some("credential_expired"),
            _ = heartbeat.tick() => {
                if tx.send(line(&Record::Heartbeat)).await.is_err() { return; }
                None
            }
            _ = probe.tick() => {
                match tokio::time::timeout(state.config.probe_timeout, state.probe.probe(&state.binding)).await {
                    Ok(ProbeResult::Ready) => None,
                    Ok(ProbeResult::Replaced) => Some("target_replaced"),
                    Ok(ProbeResult::Unavailable) | Err(_) => Some("agent_unavailable"),
                }
            }
        };
        if let Some(reason) = reason {
            let _ = tx.send(line(&Record::Closed { reason })).await;
            guard.close(match reason {
                "credential_expired" => CloseReason::CredentialExpired,
                "agent_unavailable" => CloseReason::AgentUnavailable,
                "target_replaced" => CloseReason::TargetReplaced,
                "server_stopping" => CloseReason::ServerStopping,
                _ => unreachable!("fixed close reason"),
            });
            return;
        }
    }
}

fn authenticated(headers: &HeaderMap, expected: &[u8; 32]) -> bool {
    if headers.get_all(header::AUTHORIZATION).iter().count() != 1 {
        return false;
    }
    let Some(value) = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
    else {
        return false;
    };
    let Some(value) = value.strip_prefix("Bearer ") else {
        return false;
    };
    let actual: [u8; 32] = Sha256::digest(value.as_bytes()).into();
    actual
        .iter()
        .zip(expected)
        .fold(0_u8, |difference, (left, right)| {
            difference | (left ^ right)
        })
        == 0
}

fn json_content_type(headers: &HeaderMap) -> bool {
    let Some(value) = headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
    else {
        return false;
    };
    let mut parts = value.split(';').map(str::trim);
    if !parts
        .next()
        .is_some_and(|value| value.eq_ignore_ascii_case("application/json"))
    {
        return false;
    }
    parts.all(|parameter| parameter.eq_ignore_ascii_case("charset=utf-8"))
}

fn line(record: &Record<'_>) -> Vec<u8> {
    let mut line = serde_json::to_vec(record).expect("fixed voice records serialize");
    line.push(b'\n');
    debug_assert!(line.len() <= MAX_MESSAGE);
    line
}

fn error(status: StatusCode, code: &'static str) -> Response {
    let body = serde_json::to_vec(&serde_json::json!({"error":{"code":code}}))
        .expect("fixed voice errors serialize");
    response(status, "application/json", Body::from(body))
}

fn response(status: StatusCode, content_type: &'static str, body: Body) -> Response {
    let mut response = Response::new(body);
    *response.status_mut() = status;
    response
        .headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}
