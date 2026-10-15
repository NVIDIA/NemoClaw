// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Kubernetes object API and Pod exec for the model resource contracts.
//! Readiness is fixture evidence, not a running model or GPU qualification.

use crate::kube_api::Objects;
use futures_util::SinkExt;
use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_tungstenite::{WebSocketStream, tungstenite};

pub const STARTED: &str = "2099-01-01T00:00:00Z";

pub struct Api {
    pub endpoint: String,
    task: tokio::task::JoinHandle<()>,
}

impl Api {
    pub async fn start(objects: Objects) -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            loop {
                let (stream, _) = listener.accept().await.unwrap();
                let objects = objects.clone();
                tokio::spawn(async move { serve(stream, objects).await });
            }
        });
        Self { endpoint, task }
    }
}

impl Drop for Api {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn serve(mut stream: tokio::net::TcpStream, objects: Objects) {
    let mut header = Vec::new();
    while !header.ends_with(b"\r\n\r\n") {
        let Ok(byte) = stream.read_u8().await else {
            return;
        };
        header.push(byte);
        assert!(header.len() <= 64 * 1024, "oversized fixture request");
    }
    let header = String::from_utf8(header).unwrap();
    let mut lines = header.lines();
    let first: Vec<_> = lines.next().unwrap().split_whitespace().collect();
    let (method, path) = (first[0], first[1]);
    let mut request = tungstenite::http::Request::builder()
        .method(method)
        .uri(path);
    let mut length = 0;
    for (name, value) in lines.filter_map(|line| line.split_once(':')) {
        if name.eq_ignore_ascii_case("content-length") {
            length = value.trim().parse::<usize>().unwrap();
        }
        request = request.header(name, value.trim());
    }
    if path.split('?').next().unwrap().ends_with("/exec") {
        assert_eq!(method, "GET");
        let (pod_path, query) = path.split_once('?').unwrap();
        let segments: Vec<_> = pod_path.trim_start_matches('/').split('/').collect();
        let ["api", "v1", "namespaces", namespace, "pods", name, "exec"] = segments.as_slice()
        else {
            panic!("unexpected Pod exec path: {pod_path}");
        };
        let pod = objects
            .get("v1", "Pod", namespace, name)
            .expect("exec must target an existing Pod in its namespace");
        assert_eq!(pod["status"]["phase"], "Running");
        let containers: Vec<_> = url::form_urlencoded::parse(query.as_bytes())
            .filter(|(key, _)| key == "container")
            .map(|(_, value)| value.into_owned())
            .collect();
        assert_eq!(containers, ["runtime"]);
        assert!(
            pod["spec"]["containers"]
                .as_array()
                .unwrap()
                .iter()
                .any(|container| container["name"] == "runtime")
        );
        let arguments: Vec<_> = url::form_urlencoded::parse(query.as_bytes())
            .filter(|(key, _)| key == "command")
            .map(|(_, value)| value.into_owned())
            .collect();
        assert_eq!(arguments, ["/bin/cat", "/data/status.json"]);
        let mut response =
            tungstenite::handshake::server::create_response(&request.body(()).unwrap()).unwrap();
        response.headers_mut().insert(
            "sec-websocket-protocol",
            "v4.channel.k8s.io".parse().unwrap(),
        );
        let mut header = b"HTTP/1.1 101 Switching Protocols\r\n".to_vec();
        for (name, value) in response.headers() {
            header.extend_from_slice(format!("{name}: {}\r\n", value.to_str().unwrap()).as_bytes());
        }
        header.extend_from_slice(b"\r\n");
        stream.write_all(&header).await.unwrap();
        let mut socket =
            WebSocketStream::from_raw_socket(stream, tungstenite::protocol::Role::Server, None)
                .await;
        let status =
            json!({"phase":"ready", "updated":STARTED, "pid":42, "detail":"fixture readiness"})
                .to_string();
        for (channel, payload) in [(1, status), (3, json!({"status":"Success"}).to_string())] {
            let mut message = vec![channel];
            message.extend_from_slice(payload.as_bytes());
            socket
                .send(tungstenite::Message::Binary(message.into()))
                .await
                .unwrap();
        }
        let _ = socket.close(None).await;
        return;
    }
    let mut body = vec![0; length];
    stream.read_exact(&mut body).await.unwrap();
    let Some((code, mut body)) = objects.answer(method, path, &body) else {
        return;
    };
    // The fixture scheduler and kubelet place and start each admitted Pod. A
    // dry-run must neither start nor retain an object.
    if method == "POST" && code == 201 && !path.contains("dryRun=") {
        let object: serde_json::Value = serde_json::from_slice(&body).unwrap();
        if object["kind"] == "Pod" {
            let object = schedule(&objects, object);
            objects.insert(object.clone());
            body = object.to_string().into_bytes();
        }
    }
    let response = format!(
        "HTTP/1.1 {code} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(response.as_bytes()).await.unwrap();
    stream.write_all(&body).await.unwrap();
}

/// Bind a Pod to the first Node whose labels match its nodeSelector and start
/// its runtime. A Node annotated `fixture.example/image: absent` lacks the
/// runtime image, which the Pod's `imagePullPolicy: Never` cannot pull; with
/// no matching Node, the Pod stays pending as the scheduler reports it.
pub fn schedule(objects: &Objects, mut pod: serde_json::Value) -> serde_json::Value {
    let selector = pod["spec"]["nodeSelector"].clone();
    let node = objects
        .0
        .lock()
        .unwrap()
        .values()
        .filter(|object| object["kind"] == "Node")
        .find(|node| {
            selector
                .as_object()
                .into_iter()
                .flatten()
                .all(|(key, value)| node["metadata"]["labels"][key] == *value)
        })
        .cloned();
    let Some(node) = node else {
        pod["status"] = json!({"phase":"Pending", "conditions":[{"type":"PodScheduled", "status":"False",
            "reason":"Unschedulable", "message":"0/1 nodes are available: 1 node(s) didn't match Pod's node affinity/selector."}]});
        return pod;
    };
    pod["spec"]["nodeName"] = node["metadata"]["name"].clone();
    pod["status"] = if node["metadata"]["annotations"]["fixture.example/image"] == "absent" {
        json!({"phase":"Pending", "conditions":[{"type":"PodScheduled", "status":"True"}], "containerStatuses":[{
            "name":"runtime", "state":{"waiting":{"reason":"ErrImageNeverPull"}}
        }]})
    } else {
        running()
    };
    pod
}

/// The status the fixture kubelet reports for a started runtime.
pub fn running() -> serde_json::Value {
    json!({"phase":"Running", "containerStatuses":[{
        "name":"runtime", "state":{"running":{"startedAt":STARTED}}
    }]})
}
