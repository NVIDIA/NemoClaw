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
        AccessGrant, Clock, CloseReason, PROFILE, ProbeResult, ServerConfig, TargetProbe,
        VoiceServer,
    },
};
use reqwest::{Client, StatusCode, header};
use serde_json::{Value, json};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

const SECRET: &str = "test-only-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const TARGET: &str = "target-r0-fixture";

#[derive(Clone)]
struct FixedClock(OffsetDateTime);

impl Clock for FixedClock {
    fn now(&self) -> OffsetDateTime {
        self.0
    }
}

#[derive(Clone)]
struct Probe {
    results: Arc<Mutex<Vec<ProbeResult>>>,
    calls: Arc<Mutex<usize>>,
}

impl Probe {
    fn always(result: ProbeResult) -> Self {
        Self {
            results: Arc::new(Mutex::new(vec![result])),
            calls: Arc::new(Mutex::new(0)),
        }
    }

    fn sequence(results: Vec<ProbeResult>) -> Self {
        Self {
            results: Arc::new(Mutex::new(results)),
            calls: Arc::new(Mutex::new(0)),
        }
    }

    fn calls(&self) -> usize {
        *self.calls.lock().unwrap()
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

async fn server(probe: Probe, expires_in: Duration) -> VoiceServer {
    let grant = grant(expires_in);
    VoiceServer::bind(
        "127.0.0.1:0".parse().unwrap(),
        &grant,
        Arc::new(probe),
        Arc::new(clock()),
        ServerConfig {
            heartbeat_interval: Duration::from_millis(25),
            probe_interval: Duration::from_millis(20),
            probe_timeout: Duration::from_millis(10),
        },
    )
    .await
    .unwrap()
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
