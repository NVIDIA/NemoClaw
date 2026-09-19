// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::*;
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
async fn server(
    responses: Vec<(u16, String)>,
) -> (Models, Arc<Mutex<Vec<String>>>, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let client = Models::new(&format!("http://{}/v1", listener.local_addr().unwrap())).unwrap();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let seen = requests.clone();
    let task = tokio::spawn(async move {
        for (status, body) in responses {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            while !request.ends_with(b"\r\n\r\n") {
                request.push(socket.read_u8().await.unwrap());
            }
            let header = String::from_utf8(request).unwrap();
            let length = header
                .lines()
                .find_map(|line| line.strip_prefix("content-length: "))
                .map(|n| n.parse::<usize>().unwrap())
                .unwrap_or(0);
            let mut content = vec![0; length];
            socket.read_exact(&mut content).await.unwrap();
            seen.lock()
                .unwrap()
                .push(format!("{header}{}", String::from_utf8(content).unwrap()));
            socket.write_all(format!("HTTP/1.1 {status} Fixture\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
        }
    });
    (client, requests, task)
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
        let (client, requests, task) = server(vec![(200, body.into())]).await;
        assert!(client.ensure("fixture:latest").await.is_err());
        task.await.unwrap();
        assert_eq!(requests.lock().unwrap().len(), 1);
    }
    let (client, _, task) = server(vec![(200, "{\"models\":[]}".into())]).await;
    assert_eq!(client.read("fixture:latest").await.unwrap(), None);
    task.await.unwrap();
}
#[tokio::test]
async fn pull_requires_success_and_reconciliation_before_returning_model_identity() {
    let inventory = serde_json::json!({"models":[model()]}).to_string();
    let (client, requests, task) = server(vec![
        (200, "{\"models\":[]}".into()),
        (
            200,
            "{\"status\":\"downloading\"}\n{\"status\":\"success\"}\n".into(),
        ),
        (200, inventory.clone()),
        (200, inventory),
    ])
    .await;
    assert_eq!(client.ensure("fixture:latest").await.unwrap(), model());
    assert_eq!(client.ensure("fixture:latest").await.unwrap(), model());
    task.await.unwrap();
    let requests = requests.lock().unwrap();
    assert_eq!(
        requests.iter().filter(|r| r.starts_with("POST ")).count(),
        1
    );
    assert!(requests[1].ends_with("{\"model\":\"fixture:latest\",\"stream\":true}"));
}
#[tokio::test]
async fn partial_or_ambiguous_pull_is_not_retried_or_claimed_successful() {
    for events in [
        "{\"status\":\"downloading\"}\n",
        "{\"status\":\"success\"}\n{\"status\":\"downloading\"}\n",
        "{\"error\":\"secret-sentinel\"}\n",
    ] {
        let (client, requests, task) =
            server(vec![(200, "{\"models\":[]}".into()), (200, events.into())]).await;
        let error = client.ensure("fixture:latest").await.unwrap_err();
        assert!(!error.to_string().contains("secret-sentinel"));
        task.await.unwrap();
        assert_eq!(requests.lock().unwrap().len(), 2);
    }
}
#[tokio::test]
async fn rejected_inventory_is_failure_even_for_http_not_found() {
    for status in [401, 403, 404, 500] {
        let (client, _, task) = server(vec![(status, "secret-sentinel".into())]).await;
        let error = client.read("fixture:latest").await.unwrap_err();
        assert!(!error.to_string().contains("secret-sentinel"));
        task.await.unwrap();
    }
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
        let (client, requests, task) = server(vec![(status, body.into())]).await;
        assert!(client.ready("fixture:latest").await.is_err());
        task.await.unwrap();
        assert_eq!(requests.lock().unwrap().len(), 1);
    }
}

#[tokio::test]
async fn model_download_reports_bytes_and_only_completes_after_inventory_verification() {
    use crate::{ByteProgress, DownloadPhase, Progress, with_download_progress};
    for verified in [false, true] {
        let (client, _, task) = server(vec![
            (200, "{\"models\":[]}".into()),
            (200, "{\"status\":\"pulling abcdef\",\"digest\":\"sha256:abcdef\",\"completed\":50,\"total\":100}\n{\"status\":\"success\"}\n".into()),
            (200, if verified { serde_json::json!({"models":[model()]}).to_string() } else { "{\"models\":[]}".into() }),
        ]).await;
        let events = Arc::new(Mutex::new(Vec::new()));
        let seen = events.clone();
        let result = with_download_progress(
            "ollama_model.chat".into(),
            Arc::new(move |event| {
                if let Progress::Download(event) = event {
                    seen.lock().unwrap().push(event);
                }
            }),
            client.ensure("fixture:latest"),
        )
        .await;
        task.await.unwrap();
        assert_eq!(result.is_ok(), verified);
        let events = events.lock().unwrap();
        assert!(
            events
                .iter()
                .any(|event| event.phase == DownloadPhase::Downloading
                    && event.bytes
                        == Some(ByteProgress {
                            completed: 50,
                            total: Some(100)
                        })
                    && event.layer.as_deref() == Some("sha256:abcdef"))
        );
        assert_eq!(
            events
                .iter()
                .any(|event| event.phase == DownloadPhase::Complete && event.layer.is_none()),
            verified
        );
    }
}
