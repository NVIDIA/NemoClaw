// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::*;
use crate::http_fixture::Fixture;
use std::sync::{Arc, Mutex};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};
fn model() -> Model {
    Model {
        name: "fixture:latest".into(),
        digest: "a".repeat(64),
        size: 42,
    }
}
/// Answers requests with `responses` in order and records each method and path.
async fn server(responses: Vec<(u16, String)>) -> (Models, Arc<Mutex<Vec<String>>>, Fixture) {
    let requests = Arc::new(Mutex::new(Vec::new()));
    let seen = requests.clone();
    let mut responses = responses.into_iter();
    let fixture = Fixture::start_tcp(move |request| {
        seen.lock()
            .unwrap()
            .push(format!("{} {}", request.method, request.path));
        responses
            .next()
            .map(|(status, body)| (status, body.into_bytes()))
    })
    .await;
    let client = Models::new(&format!("{}/v1", fixture.endpoint)).unwrap();
    (client, requests, fixture)
}
#[tokio::test]
async fn only_complete_inventory_can_confirm_model_absence() {
    for body in [
        "{}",
        "{\"models\":null}",
        "{\"models\":[{}]}",
        "{\"models\":[]",
        "{\"models\":[{\"name\":\"other\",\"digest\":\"bad\",\"size\":1}]}",
    ] {
        let (client, requests, _server) = server(vec![(200, body.into())]).await;
        assert!(client.read("fixture:latest").await.is_err());
        assert_eq!(requests.lock().unwrap().len(), 1);
    }
    let (client, _, _server) = server(vec![(200, "{\"models\":[]}".into())]).await;
    assert_eq!(client.read("fixture:latest").await.unwrap(), None);
}
#[tokio::test]
async fn rejected_inventory_is_failure_even_for_http_not_found() {
    for status in [401, 403, 404, 500] {
        let (client, requests, _server) = server(vec![(status, "secret-sentinel".into())]).await;
        let error = client.read("fixture:latest").await.unwrap_err();
        assert!(!error.to_string().contains("secret-sentinel"));
        assert_eq!(requests.lock().unwrap().len(), 1);
    }
}

#[tokio::test]
async fn external_model_observation_only_reads_inventory() {
    let (client, requests, _server) = server(vec![(
        200,
        serde_json::json!({"models":[model()]}).to_string(),
    )])
    .await;
    assert_eq!(client.read("fixture:latest").await.unwrap(), Some(model()));
    let requests = requests.lock().unwrap();
    assert_eq!(*requests, ["GET /api/tags"]);
}

#[tokio::test]
async fn readiness_waits_for_connection_refused_startup_but_never_retries_inventory_failures() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    drop(listener);
    let client = Models::new(&format!("http://{address}/v1")).unwrap();
    assert!(matches!(
        client.read("fixture:latest").await,
        Err(Error::ServiceStarting)
    ));
    let task = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(100)).await;
        let listener = TcpListener::bind(address).await.unwrap();
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut request = Vec::new();
        while !request.ends_with(b"\r\n\r\n") {
            request.push(socket.read_u8().await.unwrap());
        }
        assert!(request.starts_with(b"GET /api/tags "));
        let body = r#"{"models":[]}"#;
        socket
            .write_all(
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                )
                .as_bytes(),
            )
            .await
            .unwrap();
    });
    client.ready("fixture:latest").await.unwrap();
    task.await.unwrap();
    for (status, body) in [(401, "{}"), (503, "{}"), (200, "{}")] {
        let (client, requests, _server) = server(vec![(status, body.into())]).await;
        assert!(client.ready("fixture:latest").await.is_err());
        assert_eq!(requests.lock().unwrap().len(), 1);
    }
}
