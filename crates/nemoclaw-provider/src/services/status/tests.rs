// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::*;
use crate::{ObservationError, docker::fixture::Fixture, managed::RuntimeObservation};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

fn observed(kind: &str) -> RuntimeObservation {
    let fixtures: Vec<Value> =
        serde_json::from_str(include_str!("../../managed/reference.json")).unwrap();
    let mut spec: crate::managed::Spec =
        serde_json::from_str(fixtures[1]["spec"].as_str().unwrap()).unwrap();
    spec.kind = kind.into();
    RuntimeObservation {
        spec,
        id: "binding".into(),
        container_id: "container".into(),
        data_path: "/data".into(),
        running: true,
        started_at: "2026-09-14T00:00:00Z".into(),
    }
}
fn status(phase: &str) -> Value {
    json!({"phase":phase,"detail":"","updated":"2026-09-14T00:01:00Z","pid":123})
}
async fn fixture(response: Arc<Mutex<(u16, Vec<u8>)>>) -> Fixture {
    Fixture::engine(move |request| {
        assert_eq!(request.method, "GET", "status reads must never mutate");
        assert!(request.path.starts_with("/containers/container/archive?"));
        assert!(request.path.ends_with("path=%2Fdata%2Fstatus.json"));
        let (code, bytes) = &*response.lock().unwrap();
        let body = if *code == 200 {
            crate::docker::archive(&[("status.json", bytes, 0o600)]).unwrap()
        } else {
            b"{}".to_vec()
        };
        Some((*code, body))
    })
    .await
}

#[tokio::test]
async fn runtime_status_preserves_each_runtimes_schema_phases_and_safe_errors() {
    let response = Arc::new(Mutex::new((200, Vec::new())));
    let fixture = fixture(response.clone()).await;
    let engine = Engine::connect(&fixture.endpoint).unwrap();
    for (kind, incomplete, unknown) in [
        (
            "inference_service",
            "inference runtime status is incomplete",
            "unknown inference runtime status",
        ),
        (
            "ollama_service",
            "Ollama runtime status is incomplete",
            "unknown Ollama runtime status",
        ),
    ] {
        let observed = observed(kind);
        for phase in ["initializing", "downloading", "loading", "ready", "stopped"] {
            response.lock().unwrap().1 = status(phase).to_string().into_bytes();
            assert_eq!(runtime_phase(&engine, &observed).await.unwrap(), phase);
        }
        response.lock().unwrap().1 = status("preparing").to_string().into_bytes();
        let preparing = runtime_phase(&engine, &observed).await;
        if kind == "inference_service" {
            assert_eq!(preparing.unwrap(), "preparing");
        } else {
            assert!(matches!(preparing, Err(Error::State(message)) if message == unknown));
        }
        for mut value in [
            json!({"phase":"ready","updated":"2026-09-14T00:01:00Z"}),
            json!({"phase":"ready","updated":"2026-09-14T00:01:00Z","detail":false,"pid":-1}),
            json!({"phase":"ready","updated":"2026-09-14T00:01:00Z","detail":"","pid":4294967296u64}),
        ] {
            value["extra"] = json!("ignored");
            response.lock().unwrap().1 = value.to_string().into_bytes();
            let result = runtime_phase(&engine, &observed).await;
            if kind == "inference_service" {
                assert!(matches!(result, Err(Error::State(message)) if message == incomplete));
            } else {
                assert_eq!(result.unwrap(), "ready");
            }
        }
        for bytes in [b"not JSON: private-value".to_vec(), b"{}".to_vec(),
            br#"{"phase":"ready","phase":"stopped","updated":"2026-09-14T00:01:00Z","detail":"","pid":123}"#.to_vec(),
        ] {
            response.lock().unwrap().1 = bytes;
            assert!(matches!(runtime_phase(&engine, &observed).await,
                Err(Error::State(message)) if message == incomplete));
        }
        response.lock().unwrap().1 = status("private-value").to_string().into_bytes();
        assert!(matches!(runtime_phase(&engine, &observed).await,
            Err(Error::State(message)) if message == unknown));
    }
}

#[tokio::test]
async fn runtime_status_requires_fresh_timestamps_and_bounds_missing_file_grace() {
    let response = Arc::new(Mutex::new((200, Vec::new())));
    let fixture = fixture(response.clone()).await;
    let engine = Engine::connect(&fixture.endpoint).unwrap();
    for (kind, missing) in [
        (
            "inference_service",
            "inference runtime status is unobservable",
        ),
        ("ollama_service", "Ollama runtime status is unobservable"),
    ] {
        let mut observed = observed(kind);
        for (updated, expected) in [
            ("2026-09-13T00:00:00Z", "initializing"),
            ("2026-09-14T00:00:00Z", "ready"),
            ("2099-01-01T00:00:00Z", "ready"),
        ] {
            let mut value = status(if expected == "initializing" {
                "old-unknown-phase"
            } else {
                "ready"
            });
            value["updated"] = json!(updated);
            *response.lock().unwrap() = (200, value.to_string().into_bytes());
            assert_eq!(runtime_phase(&engine, &observed).await.unwrap(), expected);
        }
        let mut value = status("ready");
        value["updated"] = json!("private-invalid-timestamp");
        response.lock().unwrap().1 = value.to_string().into_bytes();
        assert!(matches!(
            runtime_phase(&engine, &observed).await,
            Err(Error::State("runtime observation timestamp is incomplete"))
        ));
        response.lock().unwrap().0 = 404;
        for seconds in [-60, -31, -1, 60] {
            observed.started_at = (OffsetDateTime::now_utc() + time::Duration::seconds(seconds))
                .format(&Rfc3339)
                .unwrap();
            let result = runtime_phase(&engine, &observed).await;
            if seconds == -1 {
                assert_eq!(result.unwrap(), "initializing");
            } else {
                assert!(matches!(result, Err(Error::State(message)) if message == missing));
            }
        }
    }
}

#[tokio::test]
async fn runtime_status_preserves_size_and_transport_failures_during_startup() {
    let response = Arc::new(Mutex::new((200, Vec::new())));
    let fixture = fixture(response.clone()).await;
    let engine = Engine::connect(&fixture.endpoint).unwrap();
    for kind in ["inference_service", "ollama_service"] {
        let mut observed = observed(kind);
        observed.started_at = OffsetDateTime::now_utc().format(&Rfc3339).unwrap();
        let mut bytes = status("ready").to_string().into_bytes();
        bytes.resize(128 << 10, b' ');
        *response.lock().unwrap() = (200, bytes);
        assert_eq!(
            runtime_phase(&engine, &observed).await.unwrap(),
            "initializing"
        );
        response.lock().unwrap().1.push(b' ');
        assert!(matches!(
            runtime_phase(&engine, &observed).await,
            Err(Error::Observation(ObservationError::Incomplete))
        ));
        for (code, expected) in [
            (401, ObservationError::Authentication),
            (403, ObservationError::Permission),
            (500, ObservationError::Transport),
        ] {
            response.lock().unwrap().0 = code;
            assert!(matches!(runtime_phase(&engine, &observed).await,
                Err(Error::Observation(error)) if error == expected));
        }
    }
}

#[tokio::test]
async fn runtime_status_rejects_invalid_start_time_before_contacting_engine() {
    let fixture = Fixture::engine(|_| panic!("invalid start time must fail before I/O")).await;
    let engine = Engine::connect(&fixture.endpoint).unwrap();
    for kind in ["inference_service", "ollama_service"] {
        let mut observed = observed(kind);
        observed.started_at = "private-invalid-timestamp".into();
        assert!(matches!(
            runtime_phase(&engine, &observed).await,
            Err(Error::State("runtime observation timestamp is incomplete"))
        ));
    }
}
