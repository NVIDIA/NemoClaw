// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Owned deterministic Ollama inventory and OpenAI inference endpoint.
use serde_json::{Value, json};
use std::{
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

pub async fn serve(
    listener: tokio::net::TcpListener,
    requests: Arc<Mutex<Vec<String>>>,
    allow_inference: Arc<AtomicBool>,
    engine: Option<PathBuf>,
    reply: String,
) {
    loop {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut header = vec![];
        while !header.ends_with(b"\r\n\r\n") {
            assert!(header.len() < 65536, "fixture request header too large");
            header.push(socket.read_u8().await.unwrap());
        }
        let header = String::from_utf8(header).unwrap();
        let line = header.lines().next().unwrap().to_owned();
        requests.lock().unwrap().push(line.clone());
        let running = engine.as_ref().is_none_or(|path| {
            let state: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
            state["container"]["State"]["Running"] == true
        });
        if engine.is_none() {
            assert!(
                !header.to_ascii_lowercase().contains("authorization:"),
                "proxy forwarded credentials to external Ollama"
            );
        }
        let mut content_type = "application/json";
        let body = if line.starts_with("GET /api/tags ") {
            json!({"models":[{"name":"llama3:fixture","digest":"a".repeat(64),"size":42}]})
                .to_string()
        } else if line.starts_with("GET /v1/models ") {
            json!({"object":"list","data":[{"id":"llama3:fixture","object":"model"}]}).to_string()
        } else {
            assert!(
                line.starts_with("POST /v1/chat/completions "),
                "unexpected model operation: {line}"
            );
            assert!(
                allow_inference.load(Ordering::SeqCst),
                "orchestration attempted model generation without an explicit invocation"
            );
            let length: usize = header
                .lines()
                .find_map(|line| {
                    let (key, value) = line.split_once(':')?;
                    key.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse().unwrap())
                })
                .expect("bounded JSON content length");
            assert!(length <= 1024 * 1024);
            let mut bytes = vec![0; length];
            socket.read_exact(&mut bytes).await.unwrap();
            let request: Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(request["model"], "llama3:fixture");
            let mut response = json!({"id":"fixture-response","object":"chat.completion","created":1,"model":"llama3:fixture",
                "choices":[{"index":0,"message":{"role":"assistant","content":reply},"finish_reason":"stop"}],
                "usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}});
            if request["stream"] == true {
                content_type = "text/event-stream";
                response["object"] = json!("chat.completion.chunk");
                response["choices"] = json!([{"index":0,"delta":{"role":"assistant","content":reply},"finish_reason":null}]);
                let first = format!("data: {response}\n\n");
                response["choices"] = json!([{"index":0,"delta":{},"finish_reason":"stop"}]);
                format!("{first}data: {response}\n\ndata: [DONE]\n\n")
            } else {
                response.to_string()
            }
        };
        let code = if running {
            "200 OK"
        } else {
            "503 Service Unavailable"
        };
        socket.write_all(format!("HTTP/1.1 {code}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
    }
}
