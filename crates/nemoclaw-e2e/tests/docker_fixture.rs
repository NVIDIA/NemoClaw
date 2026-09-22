// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
#![cfg(unix)]

use nemoclaw_e2e::docker::Fixture;
use std::{
    io::Write,
    sync::{Arc, Mutex},
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[tokio::test]
async fn fixture_preserves_request_bytes_and_recovers_after_a_lost_reply() {
    let requests = Arc::new(Mutex::new(Vec::new()));
    let recorded = requests.clone();
    let fixture = Fixture::start(move |request| {
        let mut requests = recorded.lock().unwrap();
        requests.push((request.method, request.path, request.body));
        (requests.len() > 1).then(|| (409, b"conflict".to_vec()))
    })
    .await;
    let path = fixture.endpoint.strip_prefix("unix://").unwrap();
    for attempt in 0..2 {
        let mut socket = tokio::net::UnixStream::connect(path).await.unwrap();
        socket
            .write_all(
                b"POST /v1.53/containers/create?name=owned HTTP/1.1\r\nContent-Length: 4\r\n\r\n",
            )
            .await
            .unwrap();
        socket.write_all(&[0, 1]).await.unwrap();
        socket.write_all(&[2, 255]).await.unwrap();
        let mut response = Vec::new();
        socket.read_to_end(&mut response).await.unwrap();
        if attempt == 0 {
            assert!(response.is_empty());
        } else {
            assert!(response.starts_with(b"HTTP/1.1 409 "));
            assert!(response.ends_with(b"\r\n\r\nconflict"));
        }
    }
    let requests = requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    for (method, path, body) in requests.iter() {
        assert_eq!(method, "POST");
        assert_eq!(path, "/containers/create?name=owned");
        assert_eq!(body, &[0, 1, 2, 255]);
    }
    let socket_path = std::path::PathBuf::from(path);
    drop(fixture);
    assert!(!socket_path.exists());
}

#[tokio::test]
async fn disconnected_clients_do_not_stop_the_engine_fixture() {
    let fixture = Fixture::start(|_| Some((200, b"healthy".to_vec()))).await;
    let path = fixture.endpoint.strip_prefix("unix://").unwrap();
    // Synchronous writes ensure the client closes before the server can respond.
    for request in [
        &b"GET /containers/json HTTP/1.1\r\n\r\n"[..],
        &b"GET /containers"[..],
        &b"POST /containers/create HTTP/1.1\r\nContent-Length: 8\r\n\r\nx"[..],
    ] {
        let mut client = std::os::unix::net::UnixStream::connect(path).unwrap();
        client.write_all(request).unwrap();
        drop(client);
        let response = tokio::time::timeout(std::time::Duration::from_secs(2), async {
            let mut client = tokio::net::UnixStream::connect(path).await.unwrap();
            client
                .write_all(b"GET /version HTTP/1.1\r\n\r\n")
                .await
                .unwrap();
            let mut response = String::new();
            client.read_to_string(&mut response).await.unwrap();
            response
        })
        .await
        .unwrap();
        assert!(response.ends_with("healthy"), "{response:?}");
    }
}
