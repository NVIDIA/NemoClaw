// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Fakes the `hcl/host` and `hcl/storage` scenarios and their failure tests
//! share: a Docker engine, health and model server, and a volume store.

use crate::http_fixture::Fixture;
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};

/// The fixtures, which pass every check while `healthy` holds, and the
/// variables that name them.
pub(crate) struct Host {
    pub(crate) healthy: Arc<AtomicBool>,
    _fixtures: [Fixture; 2],
    pub(crate) variables: Vec<(&'static str, String)>,
}

impl Host {
    pub(crate) async fn start() -> Self {
        let healthy = Arc::new(AtomicBool::new(true));
        let state = healthy.clone();
        let engine = Fixture::engine(move |request| {
            assert_eq!(request.method, "GET", "a host check must not mutate");
            let healthy = state.load(Ordering::SeqCst);
            let body = if request.path.starts_with("/images/") {
                let backend = if healthy { "vllm" } else { "ollama" };
                json!({"Id": "sha256:runtime", "Os": "linux", "Architecture": "arm64",
                    "Config": {"Labels": {"org.nemoclaw.backend": backend}}})
            } else if request.path == "/containers/application-id/json" {
                let health = if healthy { "healthy" } else { "unhealthy" };
                json!({"Id": "application-id", "Name": "/application",
                    "Config": {"Labels": {"nemoclaw.nvidia.com/owner": "deployment"}},
                    "State": {"Running": true, "StartedAt": "2026-01-02T00:00:00Z", "Health": {"Status": health}}})
            } else if request.path.contains("/archive?") {
                let phase = if healthy { "ready" } else { "stopped" };
                let status = json!({"phase": phase, "updated": "2026-01-02T00:00:01Z", "detail": "", "pid": 42})
                    .to_string();
                let archive = nemoclaw_docker::archive(&[("status.json", status.as_bytes(), 0o600)]);
                return Some((200, archive.unwrap()));
            } else {
                json!({"ID": "engine", "Architecture": "arm64", "ServerVersion": "28.0", "OSType": "linux"})
            };
            Some((200, serde_json::to_vec(&body).unwrap()))
        })
        .await;
        let state = healthy.clone();
        let server = Fixture::start_tcp(move |request| {
            assert_eq!(request.method, "GET");
            let healthy = state.load(Ordering::SeqCst);
            match request.path.as_str() {
                "/health" => Some((if healthy { 200 } else { 503 }, Vec::new())),
                "/v1/models" => {
                    let models = if healthy {
                        json!([{"id": "qwen"}])
                    } else {
                        json!([])
                    };
                    Some((
                        200,
                        json!({"object": "list", "data": models})
                            .to_string()
                            .into_bytes(),
                    ))
                }
                other => panic!("unexpected request {other}"),
            }
        })
        .await;
        // An engine nothing serves: a missing socket, or a closed loopback
        // port where the relay reaches engines.
        let unreachable = if cfg!(unix) {
            "unix:///nonexistent/engine.sock"
        } else {
            "ssh://127.0.0.1:1"
        };
        let variables = vec![
            ("TF_VAR_engine", engine.endpoint.clone()),
            ("TF_VAR_unreachable_engine", unreachable.to_owned()),
            ("TF_VAR_health_url", format!("{}/health", server.endpoint)),
            ("TF_VAR_model_server", server.endpoint.clone()),
        ];
        Self {
            healthy,
            _fixtures: [engine, server],
            variables,
        }
    }
}

#[derive(Default)]
pub(crate) struct Volumes {
    pub(crate) volumes: BTreeMap<String, Value>,
    pub(crate) creates: usize,
    /// Create the next volume but close the connection before replying.
    pub(crate) lose_create: bool,
}

/// A Docker engine that stores named volumes and counts creations.
pub(crate) async fn volume_engine() -> (Fixture, Arc<Mutex<Volumes>>) {
    let volumes = Arc::new(Mutex::new(Volumes::default()));
    let shared = volumes.clone();
    let fixture = Fixture::engine(move |request| {
        let mut volumes = shared.lock().unwrap();
        let path = request.path.split('?').next().unwrap();
        let (status, value) = match (request.method.as_str(), path) {
            ("GET", "/info") => (200, json!({"ID":"engine"})),
            ("POST", "/volumes/create") => {
                let request: Value = serde_json::from_slice(&request.body).unwrap();
                let name = request["Name"].as_str().unwrap().to_owned();
                let volume = json!({"Name":name, "Driver":"local", "Mountpoint":"/fixture", "CreatedAt":"2026-10-08T00:00:00Z", "Labels":request["Labels"], "Options":{}, "Scope":"local"});
                volumes.volumes.insert(name, volume.clone());
                volumes.creates += 1;
                if std::mem::take(&mut volumes.lose_create) {
                    return None;
                }
                (201, volume)
            }
            ("GET", path) if path.starts_with("/volumes/") => {
                match volumes.volumes.get(path.trim_start_matches("/volumes/")) {
                    Some(volume) => (200, volume.clone()),
                    None => (404, json!({"message":"missing"})),
                }
            }
            _ => panic!("unexpected Docker operation {} {path}", request.method),
        };
        Some((status, serde_json::to_vec(&value).unwrap()))
    })
    .await;
    (fixture, volumes)
}
