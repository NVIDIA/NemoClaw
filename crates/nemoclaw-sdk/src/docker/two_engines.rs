// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::{Engine, fixture::Fixture};
use serde_json::json;
use std::sync::{Arc, Mutex};

struct State {
    status: u16,
    present: bool,
    deletes: usize,
}
async fn daemon(id: &'static str) -> (Fixture, Arc<Mutex<State>>) {
    let state = Arc::new(Mutex::new(State {
        status: 200,
        present: true,
        deletes: 0,
    }));
    let shared = state.clone();
    let fixture = Fixture::start(move |request| {
        let mut state = shared.lock().unwrap();
        let path = request.path.split('?').next().unwrap();
        let (status, body) = if state.status != 200 {
            (state.status, json!({"message":"private transport detail"}))
        } else {
            match (request.method.as_str(), path) {
                ("GET", "/info") => (200, json!({"ID":id})),
                ("GET", "/containers/shared/json") if state.present => (
                    200,
                    json!({"Id":format!("{id}-container"),"Name":"/shared"}),
                ),
                ("GET", "/containers/shared/json") => (404, json!({"message":"absent"})),
                ("DELETE", "/containers/shared") => {
                    state.present = false;
                    state.deletes += 1;
                    (204, json!(null))
                }
                _ => panic!("unexpected {} {}", request.method, request.path),
            }
        };
        Some((
            status,
            if status == 204 {
                vec![]
            } else {
                serde_json::to_vec(&body).unwrap()
            },
        ))
    })
    .await;
    (fixture, state)
}

#[tokio::test]
async fn same_named_resources_failures_and_cleanup_stay_with_the_selected_daemon() {
    let (a, state_a) = daemon("daemon-a").await;
    let (b, state_b) = daemon("daemon-b").await;
    let a = Engine::connect(&a.endpoint).unwrap();
    let b = Engine::connect(&b.endpoint).unwrap();
    assert_eq!(a.info().await.unwrap().id.as_deref(), Some("daemon-a"));
    assert_eq!(b.info().await.unwrap().id.as_deref(), Some("daemon-b"));
    assert_eq!(
        a.container("shared").await.unwrap().unwrap().id.as_deref(),
        Some("daemon-a-container")
    );
    assert_eq!(
        b.container("shared").await.unwrap().unwrap().id.as_deref(),
        Some("daemon-b-container")
    );
    for status in [401, 403, 500] {
        state_b.lock().unwrap().status = status;
        let error = b.container("shared").await.unwrap_err();
        assert!(!error.to_string().contains("private transport detail"));
        assert!(a.container("shared").await.unwrap().is_some());
    }
    state_b.lock().unwrap().status = 200;
    a.api.remove_container("shared", None).await.unwrap();
    assert!(a.container("shared").await.unwrap().is_none());
    assert!(b.container("shared").await.unwrap().is_some());
    assert_eq!(state_a.lock().unwrap().deletes, 1);
    assert_eq!(state_b.lock().unwrap().deletes, 0);
}

#[tokio::test]
async fn injected_connections_are_explicit_and_never_fall_back_to_a_local_daemon() {
    use super::Connections;
    let (first, _) = daemon("first").await;
    let (second, _) = daemon("second").await;
    let connections = Connections::fixed([
        Engine::connect(&first.endpoint).unwrap(),
        Engine::connect(&second.endpoint).unwrap(),
    ])
    .unwrap();
    assert_eq!(
        connections
            .resolve(&first.endpoint)
            .unwrap()
            .info()
            .await
            .unwrap()
            .id
            .as_deref(),
        Some("first")
    );
    assert_eq!(
        connections
            .resolve(&second.endpoint)
            .unwrap()
            .info()
            .await
            .unwrap()
            .id
            .as_deref(),
        Some("second")
    );
    assert!(connections.resolve("unix:///var/run/docker.sock").is_err());
    assert!(
        Connections::fixed([
            Engine::connect(&first.endpoint).unwrap(),
            Engine::connect(&first.endpoint).unwrap(),
        ])
        .is_err()
    );
}
