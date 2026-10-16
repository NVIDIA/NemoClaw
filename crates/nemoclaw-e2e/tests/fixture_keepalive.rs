// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Connection handling of the shared HTTP fixture over TCP, which every
//! platform serves.

use nemoclaw_e2e::http_fixture::Fixture;
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
};

/// Read one response framed by its `Content-Length`, leaving the connection open.
async fn response(stream: &mut TcpStream) -> (String, String) {
    let mut head = Vec::new();
    while !head.ends_with(b"\r\n\r\n") {
        head.push(stream.read_u8().await.unwrap());
    }
    let head = String::from_utf8(head).unwrap().to_ascii_lowercase();
    let size = head
        .lines()
        .find_map(|line| line.strip_prefix("content-length:"))
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    let mut body = vec![0; size];
    stream.read_exact(&mut body).await.unwrap();
    (head, String::from_utf8(body).unwrap())
}

#[tokio::test]
async fn fixture_keeps_a_connection_open_between_requests_until_it_is_dropped() {
    let fixture = Fixture::start_tcp(|request| Some((200, request.path.into_bytes()))).await;
    let address = fixture.endpoint.strip_prefix("http://").unwrap().to_owned();
    tokio::time::timeout(Duration::from_secs(5), async {
        let mut kept = TcpStream::connect(&address).await.unwrap();
        for path in ["/first", "/second"] {
            let request = format!("GET {path} HTTP/1.1\r\nHost: fixture\r\n\r\n");
            kept.write_all(request.as_bytes()).await.unwrap();
            let (head, body) = response(&mut kept).await;
            assert!(!head.contains("connection: close"), "{head}");
            assert_eq!(body, path);
        }
        // Another client is served while the first holds its connection open,
        // and its `Connection: close` request is answered, then closed.
        let mut other = TcpStream::connect(&address).await.unwrap();
        other
            .write_all(b"GET /other HTTP/1.1\r\nConnection: close\r\n\r\n")
            .await
            .unwrap();
        let mut answer = String::new();
        other.read_to_string(&mut answer).await.unwrap();
        assert!(answer.ends_with("\r\n\r\n/other"), "{answer:?}");
        kept.write_all(b"GET /third HTTP/1.1\r\n\r\n")
            .await
            .unwrap();
        assert_eq!(response(&mut kept).await.1, "/third");
        // A dropped fixture answers nothing more, even on a kept connection.
        drop(fixture);
        assert!(matches!(kept.read(&mut [0]).await, Ok(0) | Err(_)));
    })
    .await
    .expect("the fixture answered every request and closed when dropped");
}

#[tokio::test]
async fn fixture_answers_requests_sent_together_in_one_write_in_order() {
    let fixture = Fixture::start_tcp(|request| {
        let mut answer = format!("{} ", request.path).into_bytes();
        answer.extend_from_slice(&request.body);
        Some((200, answer))
    })
    .await;
    let address = fixture.endpoint.strip_prefix("http://").unwrap().to_owned();
    tokio::time::timeout(Duration::from_secs(5), async {
        let mut stream = TcpStream::connect(&address).await.unwrap();
        // One write, so the fixture's first read can return both requests;
        // the second must not be lost with the first one's read buffer.
        stream
            .write_all(
                b"POST /first HTTP/1.1\r\nContent-Length: 3\r\n\r\none\
                  POST /second HTTP/1.1\r\nContent-Length: 3\r\n\r\ntwo",
            )
            .await
            .unwrap();
        assert_eq!(response(&mut stream).await.1, "/first one");
        assert_eq!(response(&mut stream).await.1, "/second two");
    })
    .await
    .expect("the fixture answered both requests");
}

#[tokio::test]
async fn dropped_fixture_does_not_answer_a_request_waiting_on_a_kept_connection() {
    let served = Arc::new(Mutex::new(Vec::new()));
    let recorded = served.clone();
    let fixture = Fixture::start_tcp(move |request| {
        recorded.lock().unwrap().push(request.path.clone());
        Some((200, request.path.into_bytes()))
    })
    .await;
    let address = fixture.endpoint.strip_prefix("http://").unwrap().to_owned();
    tokio::time::timeout(Duration::from_secs(5), async {
        let mut kept = TcpStream::connect(&address).await.unwrap();
        kept.write_all(b"GET /before HTTP/1.1\r\n\r\n")
            .await
            .unwrap();
        assert_eq!(response(&mut kept).await.1, "/before");
        // On this single-threaded runtime, the yield lets the runtime see the
        // next request arrive and queue the connection's task, then resumes
        // this test first. The drop therefore lands while that task waits
        // to be polled, as on a busy multi-threaded runtime.
        kept.write_all(b"GET /after HTTP/1.1\r\n\r\n")
            .await
            .unwrap();
        tokio::task::yield_now().await;
        drop(fixture);
        let mut answer = Vec::new();
        let _ = kept.read_to_end(&mut answer).await;
        assert!(answer.is_empty(), "{:?}", String::from_utf8_lossy(&answer));
    })
    .await
    .expect("the dropped fixture closed the kept connection");
    assert_eq!(*served.lock().unwrap(), ["/before"]);
}

#[tokio::test]
async fn fixture_closes_the_connection_after_a_1xx_204_304_or_head_response() {
    let fixture = Fixture::start_tcp(|request| {
        let status = request.path[1..].parse().unwrap();
        Some((status, b"body".to_vec()))
    })
    .await;
    let address = fixture.endpoint.strip_prefix("http://").unwrap().to_owned();
    for request in ["GET /102", "GET /204", "GET /304", "HEAD /200"] {
        let mut stream = TcpStream::connect(&address).await.unwrap();
        stream
            .write_all(format!("{request} HTTP/1.1\r\n\r\n").as_bytes())
            .await
            .unwrap();
        let mut answer = Vec::new();
        let read = tokio::time::timeout(Duration::from_secs(5), stream.read_to_end(&mut answer));
        let closed = read.await.is_ok();
        let answer = String::from_utf8_lossy(&answer).to_ascii_lowercase();
        assert!(closed, "{request} left the connection open: {answer:?}");
        assert!(
            answer.contains("\r\nconnection: close\r\n"),
            "{request}: {answer:?}"
        );
    }
}
