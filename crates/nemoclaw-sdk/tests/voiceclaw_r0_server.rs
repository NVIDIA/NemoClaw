// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

use async_trait::async_trait;
use futures_util::StreamExt;
use nemoclaw_sdk::{
    Binding,
    voice::{
        AccessGrant, Clock, CloseReason, DispatchResult, PROFILE, ProbeResult, ServerConfig,
        TargetProbe, VoiceServer,
    },
};
use reqwest::{Client, StatusCode, header};
use serde_json::{Value, json};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

const SECRET: &str = "test-only-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const TARGET: &str = "target-r0-fixture";
const QUESTION: &str = "What is two plus two? Reply with only 4.";

#[derive(Clone)]
struct FixedClock(OffsetDateTime);

impl Clock for FixedClock {
    fn now(&self) -> OffsetDateTime {
        self.0
    }
}

#[derive(Clone)]
struct AdjustableClock(Arc<Mutex<OffsetDateTime>>);

impl AdjustableClock {
    fn new(now: OffsetDateTime) -> Self {
        Self(Arc::new(Mutex::new(now)))
    }

    fn set(&self, now: OffsetDateTime) {
        *self.0.lock().unwrap() = now;
    }
}

impl Clock for AdjustableClock {
    fn now(&self) -> OffsetDateTime {
        *self.0.lock().unwrap()
    }
}

#[derive(Clone)]
struct Probe {
    results: Arc<Mutex<Vec<ProbeResult>>>,
    calls: Arc<Mutex<usize>>,
    dispatch_result: Arc<Mutex<DispatchResult>>,
    dispatches: Arc<Mutex<usize>>,
    dispatch_delay: Duration,
}

impl Probe {
    fn always(result: ProbeResult) -> Self {
        Self {
            results: Arc::new(Mutex::new(vec![result])),
            calls: Arc::new(Mutex::new(0)),
            dispatch_result: Arc::new(Mutex::new(DispatchResult::Answer("4".into()))),
            dispatches: Arc::new(Mutex::new(0)),
            dispatch_delay: Duration::ZERO,
        }
    }

    fn sequence(results: Vec<ProbeResult>) -> Self {
        Self {
            results: Arc::new(Mutex::new(results)),
            calls: Arc::new(Mutex::new(0)),
            dispatch_result: Arc::new(Mutex::new(DispatchResult::Answer("4".into()))),
            dispatches: Arc::new(Mutex::new(0)),
            dispatch_delay: Duration::ZERO,
        }
    }

    fn with_dispatch(mut self, result: DispatchResult) -> Self {
        self.dispatch_result = Arc::new(Mutex::new(result));
        self
    }

    fn with_dispatch_delay(mut self, delay: Duration) -> Self {
        self.dispatch_delay = delay;
        self
    }

    fn calls(&self) -> usize {
        *self.calls.lock().unwrap()
    }

    fn dispatches(&self) -> usize {
        *self.dispatches.lock().unwrap()
    }

    fn set_probe_result(&self, result: ProbeResult) {
        *self.results.lock().unwrap() = vec![result];
    }
}

#[async_trait]
impl TargetProbe for Probe {
    async fn probe(&self, _binding: &Binding) -> ProbeResult {
        *self.calls.lock().unwrap() += 1;
        let mut results = self.results.lock().unwrap();
        if results.len() > 1 {
            results.remove(0)
        } else {
            results[0]
        }
    }

    async fn dispatch(&self, _binding: &Binding) -> DispatchResult {
        *self.dispatches.lock().unwrap() += 1;
        tokio::time::sleep(self.dispatch_delay).await;
        self.dispatch_result.lock().unwrap().clone()
    }
}

fn clock() -> FixedClock {
    FixedClock(OffsetDateTime::parse("2030-01-01T00:00:00Z", &Rfc3339).unwrap())
}

fn grant(expires_in: Duration) -> AccessGrant {
    AccessGrant::new(
        SECRET,
        TARGET,
        Binding::new("deployment/integration", "agent-generation", "native-id").unwrap(),
        clock().now(),
        expires_in,
    )
    .unwrap()
}

#[test]
fn issued_access_is_random_fifteen_minute_and_redacted() {
    let binding =
        || Binding::new("deployment/integration", "agent-generation", "native-id").unwrap();
    let first = AccessGrant::issue(TARGET, binding(), clock().now()).unwrap();
    let second = AccessGrant::issue(TARGET, binding(), clock().now()).unwrap();

    assert_eq!(first.credential().len(), 64);
    assert!(
        first
            .credential()
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    );
    assert_ne!(first.credential(), second.credential());
    assert_eq!(
        first.expires_at() - clock().now(),
        time::Duration::minutes(15)
    );
    assert!(!format!("{first:?}").contains(first.credential()));
}

#[test]
fn server_selects_revision_two() {
    assert_eq!(PROFILE, "nemoclaw-voice-r0/2");
}

async fn server(probe: Probe, expires_in: Duration) -> VoiceServer {
    server_with(probe, expires_in, Duration::from_millis(20)).await
}

async fn server_with(probe: Probe, expires_in: Duration, probe_interval: Duration) -> VoiceServer {
    let grant = grant(expires_in);
    VoiceServer::bind(
        "127.0.0.1:0".parse().unwrap(),
        &grant,
        Arc::new(probe),
        Arc::new(clock()),
        ServerConfig {
            heartbeat_interval: Duration::from_millis(25),
            probe_interval,
            probe_timeout: Duration::from_millis(10),
            dispatch_timeout: Duration::from_millis(200),
        },
    )
    .await
    .unwrap()
}

fn probe_endpoint(server: &VoiceServer) -> String {
    format!(
        "{}/probe",
        server.endpoint().strip_suffix("/connect").unwrap()
    )
}

fn probe_request(
    client: &Client,
    server: &VoiceServer,
    secret: Option<&str>,
    body: impl Into<reqwest::Body>,
) -> reqwest::RequestBuilder {
    let mut request = client
        .post(probe_endpoint(server))
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::ACCEPT, "application/json")
        .body(body);
    if let Some(secret) = secret {
        request = request.bearer_auth(secret);
    }
    request
}

fn request(
    client: &Client,
    server: &VoiceServer,
    secret: Option<&str>,
    body: Value,
) -> reqwest::RequestBuilder {
    let mut request = client
        .post(server.endpoint())
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::ACCEPT, "application/x-ndjson")
        .body(body.to_string());
    if let Some(secret) = secret {
        request = request.bearer_auth(secret);
    }
    request
}

async fn error(response: reqwest::Response, status: StatusCode, code: &str) {
    assert_eq!(response.status(), status);
    assert_eq!(response.headers()[header::CONTENT_TYPE], "application/json");
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    assert_eq!(
        serde_json::from_slice::<Value>(&response.bytes().await.unwrap()).unwrap(),
        json!({"error":{"code":code}})
    );
}

#[tokio::test]
async fn authenticates_before_parsing_or_probing() {
    let probe = Probe::always(ProbeResult::Ready);
    let server = server(probe.clone(), Duration::from_secs(900)).await;
    let client = Client::new();

    error(
        request(&client, &server, None, json!({"extra": true}))
            .send()
            .await
            .unwrap(),
        StatusCode::UNAUTHORIZED,
        "authentication_failed",
    )
    .await;
    error(
        request(&client, &server, Some("unknown"), json!({"extra": true}))
            .send()
            .await
            .unwrap(),
        StatusCode::UNAUTHORIZED,
        "authentication_failed",
    )
    .await;
    assert_eq!(probe.calls(), 0);
}

#[tokio::test]
async fn matches_pre_stream_contract_failures() {
    let client = Client::new();
    let body = || json!({"profile":PROFILE,"targetRef":TARGET});

    let expired = server(Probe::always(ProbeResult::Ready), Duration::ZERO).await;
    error(
        request(&client, &expired, Some(SECRET), body())
            .send()
            .await
            .unwrap(),
        StatusCode::UNAUTHORIZED,
        "credential_expired",
    )
    .await;

    let cases = [
        (
            json!({"profile":PROFILE,"targetRef":"wrong"}),
            ProbeResult::Ready,
            StatusCode::FORBIDDEN,
            "target_not_authorized",
        ),
        (
            json!({"profile":"unsupported/0","targetRef":TARGET}),
            ProbeResult::Ready,
            StatusCode::CONFLICT,
            "unsupported_profile",
        ),
        (
            json!({"profile":PROFILE,"targetRef":TARGET,"extra":true}),
            ProbeResult::Ready,
            StatusCode::BAD_REQUEST,
            "invalid_request",
        ),
        (
            body(),
            ProbeResult::Replaced,
            StatusCode::CONFLICT,
            "target_replaced",
        ),
        (
            body(),
            ProbeResult::Unavailable,
            StatusCode::SERVICE_UNAVAILABLE,
            "agent_unavailable",
        ),
    ];
    for (body, probe, status, code) in cases {
        let server = server(Probe::always(probe), Duration::from_secs(900)).await;
        error(
            request(&client, &server, Some(SECRET), body)
                .send()
                .await
                .unwrap(),
            status,
            code,
        )
        .await;
    }
}

#[tokio::test]
async fn dispatches_the_fixed_probe_once_after_connection() {
    let probe = Probe::always(ProbeResult::Ready)
        .with_dispatch(DispatchResult::Answer("\u{2003}4。".into()));
    let server = server_with(
        probe.clone(),
        Duration::from_secs(900),
        Duration::from_secs(5),
    )
    .await;
    let client = Client::new();
    let response = request(
        &client,
        &server,
        Some(SECRET),
        json!({"profile":PROFILE,"targetRef":TARGET}),
    )
    .send()
    .await
    .unwrap();
    let mut stream = response.bytes_stream();
    assert_eq!(
        serde_json::from_slice::<Value>(&stream.next().await.unwrap().unwrap()).unwrap()["type"],
        "ready"
    );

    let response = probe_request(
        &client,
        &server,
        Some(SECRET),
        json!({"profile":PROFILE,"targetRef":TARGET,"question":QUESTION}).to_string(),
    )
    .send()
    .await
    .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()[header::CONTENT_TYPE], "application/json");
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    assert_eq!(
        serde_json::from_slice::<Value>(&response.bytes().await.unwrap()).unwrap(),
        json!({"profile":PROFILE,"answer":"\u{2003}4。"})
    );
    assert_eq!(probe.dispatches(), 1);

    error(
        probe_request(
            &client,
            &server,
            Some(SECRET),
            json!({"profile":PROFILE,"targetRef":TARGET,"question":QUESTION}).to_string(),
        )
        .send()
        .await
        .unwrap(),
        StatusCode::CONFLICT,
        "probe_already_used",
    )
    .await;
    assert_eq!(probe.dispatches(), 1);
    drop(stream);
}

#[tokio::test]
async fn rejects_probe_inputs_before_native_dispatch() {
    let probe = Probe::always(ProbeResult::Ready);
    let server = server_with(
        probe.clone(),
        Duration::from_secs(900),
        Duration::from_secs(5),
    )
    .await;
    let client = Client::new();
    error(
        probe_request(
            &client,
            &server,
            Some(SECRET),
            json!({"profile":PROFILE,"targetRef":TARGET,"question":QUESTION}).to_string(),
        )
        .send()
        .await
        .unwrap(),
        StatusCode::CONFLICT,
        "connection_required",
    )
    .await;

    let response = request(
        &client,
        &server,
        Some(SECRET),
        json!({"profile":PROFILE,"targetRef":TARGET}),
    )
    .send()
    .await
    .unwrap();
    let mut stream = response.bytes_stream();
    let _ = stream.next().await.unwrap().unwrap();
    for (secret, body, status, code) in [
        (
            None,
            "{".into(),
            StatusCode::UNAUTHORIZED,
            "authentication_failed",
        ),
        (
            Some(SECRET),
            json!({"profile":PROFILE,"targetRef":TARGET,"question":"another"}).to_string(),
            StatusCode::BAD_REQUEST,
            "invalid_request",
        ),
        (
            Some(SECRET),
            json!({"profile":"unsupported/0","targetRef":TARGET,"question":QUESTION}).to_string(),
            StatusCode::CONFLICT,
            "unsupported_profile",
        ),
        (
            Some(SECRET),
            json!({"profile":PROFILE,"targetRef":TARGET,"question":QUESTION,"extra":true})
                .to_string(),
            StatusCode::BAD_REQUEST,
            "invalid_request",
        ),
        (
            Some(SECRET),
            format!(
                r#"{{"profile":"{PROFILE}","profile":"{PROFILE}","targetRef":"{TARGET}","question":"{QUESTION}"}}"#
            ),
            StatusCode::BAD_REQUEST,
            "invalid_request",
        ),
        (
            Some(SECRET),
            json!({"profile":PROFILE,"targetRef":"wrong","question":QUESTION}).to_string(),
            StatusCode::FORBIDDEN,
            "target_not_authorized",
        ),
    ] {
        error(
            probe_request(&client, &server, secret, body)
                .send()
                .await
                .unwrap(),
            status,
            code,
        )
        .await;
    }
    error(
        client
            .post(probe_endpoint(&server))
            .bearer_auth(SECRET)
            .header(header::CONTENT_TYPE, "text/plain")
            .header(header::ACCEPT, "application/json")
            .body("{}")
            .send()
            .await
            .unwrap(),
        StatusCode::UNSUPPORTED_MEDIA_TYPE,
        "unsupported_media_type",
    )
    .await;
    error(
        probe_request(&client, &server, Some(SECRET), vec![b'x'; 4097])
            .send()
            .await
            .unwrap(),
        StatusCode::PAYLOAD_TOO_LARGE,
        "request_too_large",
    )
    .await;
    assert_eq!(probe.dispatches(), 0);
    let response = probe_request(
        &client,
        &server,
        Some(SECRET),
        json!({"profile":PROFILE,"targetRef":TARGET,"question":QUESTION}).to_string(),
    )
    .send()
    .await
    .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(probe.dispatches(), 1);
    drop(stream);
}

#[tokio::test]
async fn rejects_an_expired_probe_before_native_dispatch() {
    let probe = Probe::always(ProbeResult::Ready);
    let now = clock().now();
    let adjustable = AdjustableClock::new(now);
    let grant = AccessGrant::new(
        SECRET,
        TARGET,
        Binding::new("deployment/integration", "agent-generation", "native-id").unwrap(),
        now,
        Duration::from_secs(900),
    )
    .unwrap();
    let server = VoiceServer::bind(
        "127.0.0.1:0".parse().unwrap(),
        &grant,
        Arc::new(probe.clone()),
        Arc::new(adjustable.clone()),
        ServerConfig {
            heartbeat_interval: Duration::from_secs(5),
            probe_interval: Duration::from_secs(5),
            probe_timeout: Duration::from_millis(10),
            dispatch_timeout: Duration::from_millis(200),
        },
    )
    .await
    .unwrap();
    let client = Client::new();
    let response = request(
        &client,
        &server,
        Some(SECRET),
        json!({"profile":PROFILE,"targetRef":TARGET}),
    )
    .send()
    .await
    .unwrap();
    let mut stream = response.bytes_stream();
    let _ = stream.next().await.unwrap().unwrap();
    adjustable.set(now + time::Duration::minutes(15));
    error(
        probe_request(
            &client,
            &server,
            Some(SECRET),
            json!({"profile":PROFILE,"targetRef":TARGET,"question":QUESTION}).to_string(),
        )
        .send()
        .await
        .unwrap(),
        StatusCode::UNAUTHORIZED,
        "credential_expired",
    )
    .await;
    assert_eq!(probe.dispatches(), 0);
    drop(stream);
}

#[tokio::test]
async fn revalidates_the_target_and_normalizes_native_failures() {
    for (readiness, dispatch, status, code, dispatches) in [
        (
            ProbeResult::Replaced,
            DispatchResult::Answer("4".into()),
            StatusCode::CONFLICT,
            "target_replaced",
            0,
        ),
        (
            ProbeResult::Unavailable,
            DispatchResult::Answer("4".into()),
            StatusCode::SERVICE_UNAVAILABLE,
            "agent_unavailable",
            0,
        ),
        (
            ProbeResult::Ready,
            DispatchResult::TargetReplaced,
            StatusCode::CONFLICT,
            "target_replaced",
            1,
        ),
        (
            ProbeResult::Ready,
            DispatchResult::AgentUnavailable,
            StatusCode::SERVICE_UNAVAILABLE,
            "agent_unavailable",
            1,
        ),
        (
            ProbeResult::Ready,
            DispatchResult::InvalidResponse,
            StatusCode::BAD_GATEWAY,
            "invalid_response",
            1,
        ),
        (
            ProbeResult::Ready,
            DispatchResult::Answer("The answer is 4".into()),
            StatusCode::BAD_GATEWAY,
            "invalid_response",
            1,
        ),
    ] {
        let probe = Probe::always(ProbeResult::Ready).with_dispatch(dispatch);
        let server = server_with(
            probe.clone(),
            Duration::from_secs(900),
            Duration::from_secs(5),
        )
        .await;
        let client = Client::new();
        let response = request(
            &client,
            &server,
            Some(SECRET),
            json!({"profile":PROFILE,"targetRef":TARGET}),
        )
        .send()
        .await
        .unwrap();
        let mut stream = response.bytes_stream();
        let _ = stream.next().await.unwrap().unwrap();
        probe.set_probe_result(readiness);
        error(
            probe_request(
                &client,
                &server,
                Some(SECRET),
                json!({"profile":PROFILE,"targetRef":TARGET,"question":QUESTION}).to_string(),
            )
            .send()
            .await
            .unwrap(),
            status,
            code,
        )
        .await;
        assert_eq!(probe.dispatches(), dispatches);
        drop(stream);
    }
}

#[tokio::test]
async fn stream_loss_prevents_a_late_probe_success() {
    let probe = Probe::always(ProbeResult::Ready).with_dispatch_delay(Duration::from_millis(100));
    let server = server_with(
        probe.clone(),
        Duration::from_secs(900),
        Duration::from_secs(5),
    )
    .await;
    let client = Client::new();
    let response = request(
        &client,
        &server,
        Some(SECRET),
        json!({"profile":PROFILE,"targetRef":TARGET}),
    )
    .send()
    .await
    .unwrap();
    let mut stream = response.bytes_stream();
    let _ = stream.next().await.unwrap().unwrap();
    let pending = tokio::spawn(
        probe_request(
            &client,
            &server,
            Some(SECRET),
            json!({"profile":PROFILE,"targetRef":TARGET,"question":QUESTION}).to_string(),
        )
        .send(),
    );
    tokio::time::sleep(Duration::from_millis(10)).await;
    drop(stream);
    error(
        pending.await.unwrap().unwrap(),
        StatusCode::SERVICE_UNAVAILABLE,
        "connection_lost",
    )
    .await;
    assert_eq!(probe.dispatches(), 1);
}

#[tokio::test]
async fn dispatch_timeout_consumes_the_one_shot_probe() {
    let probe = Probe::always(ProbeResult::Ready).with_dispatch_delay(Duration::from_millis(300));
    let server = server_with(
        probe.clone(),
        Duration::from_secs(900),
        Duration::from_secs(5),
    )
    .await;
    let client = Client::new();
    let response = request(
        &client,
        &server,
        Some(SECRET),
        json!({"profile":PROFILE,"targetRef":TARGET}),
    )
    .send()
    .await
    .unwrap();
    let mut stream = response.bytes_stream();
    let _ = stream.next().await.unwrap().unwrap();
    let body = json!({"profile":PROFILE,"targetRef":TARGET,"question":QUESTION}).to_string();
    error(
        probe_request(&client, &server, Some(SECRET), body.clone())
            .send()
            .await
            .unwrap(),
        StatusCode::SERVICE_UNAVAILABLE,
        "agent_unavailable",
    )
    .await;
    error(
        probe_request(&client, &server, Some(SECRET), body)
            .send()
            .await
            .unwrap(),
        StatusCode::CONFLICT,
        "probe_already_used",
    )
    .await;
    assert_eq!(probe.dispatches(), 1);
    drop(stream);
}

#[tokio::test]
async fn streams_ready_heartbeats_and_rejects_a_concurrent_connection() {
    let server = server(Probe::always(ProbeResult::Ready), Duration::from_secs(900)).await;
    let client = Client::new();
    let response = request(
        &client,
        &server,
        Some(SECRET),
        json!({"profile":PROFILE,"targetRef":TARGET}),
    )
    .send()
    .await
    .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.headers()[header::CONTENT_TYPE],
        "application/x-ndjson"
    );
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    let mut stream = response.bytes_stream();
    let first = stream.next().await.unwrap().unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&first).unwrap(),
        json!({
            "type":"ready", "profile":PROFILE, "targetRef":TARGET,
            "expiresAt":"2030-01-01T00:15:00Z"
        })
    );

    error(
        request(
            &client,
            &server,
            Some(SECRET),
            json!({"profile":PROFILE,"targetRef":TARGET}),
        )
        .send()
        .await
        .unwrap(),
        StatusCode::CONFLICT,
        "connection_active",
    )
    .await;
    let heartbeat = stream.next().await.unwrap().unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&heartbeat).unwrap(),
        json!({"type":"heartbeat"})
    );

    drop(stream);
    tokio::time::sleep(Duration::from_millis(30)).await;
    assert_eq!(
        server
            .wait_for_run(&nemoclaw_sdk::CancellationToken::new())
            .await
            .unwrap(),
        CloseReason::ClientDisconnected
    );
    let replacement = request(
        &client,
        &server,
        Some(SECRET),
        json!({"profile":PROFILE,"targetRef":TARGET}),
    )
    .send()
    .await
    .unwrap();
    assert_eq!(replacement.status(), StatusCode::OK);
}

#[tokio::test]
async fn closes_when_the_bound_agent_is_replaced() {
    let probe = Probe::sequence(vec![ProbeResult::Ready, ProbeResult::Replaced]);
    let server = server(probe, Duration::from_secs(900)).await;
    let response = request(
        &Client::new(),
        &server,
        Some(SECRET),
        json!({"profile":PROFILE,"targetRef":TARGET}),
    )
    .send()
    .await
    .unwrap();
    let mut stream = response.bytes_stream();
    assert_eq!(
        serde_json::from_slice::<Value>(&stream.next().await.unwrap().unwrap()).unwrap()["type"],
        "ready"
    );

    loop {
        let record =
            serde_json::from_slice::<Value>(&stream.next().await.unwrap().unwrap()).unwrap();
        if record["type"] == "closed" {
            assert_eq!(record, json!({"type":"closed","reason":"target_replaced"}));
            break;
        }
    }
    assert!(stream.next().await.is_none());
}

#[tokio::test]
async fn server_shutdown_closes_the_stream_without_destroying_target_state() {
    let probe = Probe::always(ProbeResult::Ready);
    let server = server(probe, Duration::from_secs(900)).await;
    let response = request(
        &Client::new(),
        &server,
        Some(SECRET),
        json!({"profile":PROFILE,"targetRef":TARGET}),
    )
    .send()
    .await
    .unwrap();
    let mut stream = response.bytes_stream();
    assert_eq!(
        serde_json::from_slice::<Value>(&stream.next().await.unwrap().unwrap()).unwrap()["type"],
        "ready"
    );
    server.stop();

    let mut closed = None;
    while let Some(record) = stream.next().await {
        let record = serde_json::from_slice::<Value>(&record.unwrap()).unwrap();
        if record["type"] == "closed" {
            closed = Some(record);
        }
    }
    assert_eq!(
        closed.unwrap(),
        json!({"type":"closed","reason":"server_stopping"})
    );
    assert_eq!(
        server
            .wait_for_run(&nemoclaw_sdk::CancellationToken::new())
            .await
            .unwrap(),
        CloseReason::ServerStopping
    );
}

#[tokio::test]
async fn enforces_request_media_size_and_schema_boundaries() {
    let server = server(Probe::always(ProbeResult::Ready), Duration::from_secs(900)).await;
    let client = Client::new();

    error(
        client
            .post(server.endpoint())
            .bearer_auth(SECRET)
            .header(header::CONTENT_TYPE, "text/plain")
            .header(header::ACCEPT, "application/x-ndjson")
            .body("{}")
            .send()
            .await
            .unwrap(),
        StatusCode::UNSUPPORTED_MEDIA_TYPE,
        "unsupported_media_type",
    )
    .await;
    error(
        client
            .post(server.endpoint())
            .bearer_auth(SECRET)
            .header(header::CONTENT_TYPE, "application/json")
            .header(header::ACCEPT, "application/x-ndjson")
            .body(vec![b'x'; 4097])
            .send()
            .await
            .unwrap(),
        StatusCode::PAYLOAD_TOO_LARGE,
        "request_too_large",
    )
    .await;
    error(
        client
            .post(server.endpoint())
            .bearer_auth(SECRET)
            .header(header::CONTENT_TYPE, "application/json; charset=utf-8")
            .header(header::ACCEPT, "application/x-ndjson")
            .body(format!(
                r#"{{"profile":"{PROFILE}","profile":"{PROFILE}","targetRef":"{TARGET}"}}"#
            ))
            .send()
            .await
            .unwrap(),
        StatusCode::BAD_REQUEST,
        "invalid_request",
    )
    .await;
    error(
        client
            .post(format!("{}?unexpected=true", server.endpoint()))
            .bearer_auth(SECRET)
            .header(header::CONTENT_TYPE, "application/json")
            .header(header::ACCEPT, "application/x-ndjson")
            .body(json!({"profile":PROFILE,"targetRef":TARGET}).to_string())
            .send()
            .await
            .unwrap(),
        StatusCode::BAD_REQUEST,
        "invalid_request",
    )
    .await;
}

#[tokio::test]
async fn refuses_non_loopback_listeners() {
    let grant = grant(Duration::from_secs(900));
    let result = VoiceServer::bind(
        "0.0.0.0:0".parse().unwrap(),
        &grant,
        Arc::new(Probe::always(ProbeResult::Ready)),
        Arc::new(clock()),
        ServerConfig::default(),
    )
    .await;
    assert!(matches!(result, Err(error) if error.kind() == std::io::ErrorKind::InvalidInput));
}
