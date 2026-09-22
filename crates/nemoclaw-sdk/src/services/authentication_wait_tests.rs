// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::*;
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
const VALID: &str = "eyJuYW1lIjogImluZmVyZW5jZS1rZXkiLCAic2l6ZSI6IDY0LCAibW9kZSI6IDM4NCwgIm10aW1lIjogIjIwMjYtMDktMTlUMDA6MDA6MDBaIiwgImxpbmtUYXJnZXQiOiAiIn0=";
const INVALID: &str = "eyJuYW1lIjogImluZmVyZW5jZS1rZXkiLCAic2l6ZSI6IDY0LCAibW9kZSI6IDQyMCwgIm10aW1lIjogIjIwMjYtMDktMTlUMDA6MDA6MDBaIiwgImxpbmtUYXJnZXQiOiAiIn0=";
#[tokio::test]
async fn proxy_key_waits_only_for_a_running_uninitialized_volume() {
    for case in ["delayed", "invalid", "transport", "initialized", "stopped"] {
        let mut responses: Vec<(&str, u16, &str, Vec<u8>)> = match case {
            "invalid" => vec![("HEAD", 200, INVALID, vec![])],
            "transport" => vec![("HEAD", 403, "", vec![])],
            _ => vec![("HEAD", 404, "", vec![])],
        };
        if case == "initialized" {
            responses.push(("HEAD", 200, VALID, vec![]));
        }
        if case == "delayed" || case == "stopped" {
            responses.push(("HEAD", 404, "", vec![]));
            responses.push((
                "GET",
                200,
                "",
                serde_json::to_vec(&serde_json::json!({"State":{"Running":case=="delayed"}}))
                    .unwrap(),
            ));
        }
        if case == "delayed" {
            responses.push(("HEAD", 200, VALID, vec![]));
            responses.push((
                "GET",
                200,
                "",
                crate::docker::archive(&[(
                    "inference-key",
                    b"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    0o600,
                )])
                .unwrap(),
            ));
        }
        let expected = responses.len();
        let directory = tempfile::tempdir().unwrap();
        let socket = directory.path().join("engine.sock");
        let listener = tokio::net::UnixListener::bind(&socket).unwrap();
        let count = Arc::new(AtomicUsize::new(0));
        let observed = count.clone();
        let server = tokio::spawn(async move {
            for (method, status, stat, body) in responses {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                while !request.ends_with(b"\r\n\r\n") {
                    request.push(stream.read_u8().await.unwrap());
                }
                assert!(String::from_utf8(request).unwrap().starts_with(method));
                observed.fetch_add(1, Ordering::SeqCst);
                let stat = if stat.is_empty() {
                    String::new()
                } else {
                    format!("X-Docker-Container-Path-Stat: {stat}\r\n")
                };
                let header = format!(
                    "HTTP/1.1 {status} Fixture\r\n{stat}Content-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                stream.write_all(header.as_bytes()).await.unwrap();
                stream.write_all(&body).await.unwrap();
            }
        });
        let engine = Engine::connect(&format!("unix://{}", socket.display())).unwrap();
        let result = read_proxy_key(&engine, "provider-id").await;
        server.abort();
        assert_eq!(result.is_ok(), case == "delayed", "{case}: {result:?}");
        assert_eq!(count.load(Ordering::SeqCst), expected, "{case}");
    }
}
