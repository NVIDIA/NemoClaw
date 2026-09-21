// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use crate::{
    ObservationError,
    backend::{Backend, Row},
    docker::{Engine, fixture::Fixture},
    managed::Storage,
};
use serde_json::json;

#[tokio::test]
async fn proxy_compute_changes_preserve_bound_credential_storage() {
    let storage = Storage {
        name: "nc-0123456789abcdef-ollama-proxy-fixture-auth".into(),
        owner: "302ff5e1-088d-42ce-959f-4ff4c3570c13".into(),
        generation: "b".repeat(32),
        engine: String::new(),
    };
    let volume = json!({"Name":storage.name,"Labels":{crate::managed::OWNER_LABEL:storage.owner,crate::managed::GENERATION_LABEL:storage.generation},"Driver":"local","Scope":"local","Options":{},"CreatedAt":"created","Mountpoint":"/var/lib/docker/volumes/auth/_data"});
    let fixture = Fixture::start(move |request| {
        assert_eq!(
            request.method, "GET",
            "credential storage must not be recreated"
        );
        let response = if request.path == "/info" {
            json!({"ID":"engine"})
        } else {
            volume.clone()
        };
        Some((200, serde_json::to_vec(&response).unwrap()))
    })
    .await;
    let backend = super::super::ProxyBackend::new(Engine::connect(&fixture.endpoint).unwrap());
    // Durable auxiliary rows no longer depend on image, model, or port settings.
    let mut row: Row = [
        (
            "name".into(),
            "nc-0123456789abcdef-ollama-proxy-fixture".into(),
        ),
        ("owner".into(), storage.owner),
        ("generation".into(), storage.generation),
        ("engine".into(), fixture.endpoint.clone()),
    ]
    .into();
    let observed = backend
        .read("ollama_proxy_storage", &row, false)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        observed["id"],
        "engine/nc-0123456789abcdef-ollama-proxy-fixture-auth/created"
    );
    let mutation = backend.ensure("ollama_proxy_storage", &observed).await;
    assert_eq!(mutation.error(), None);
    assert_eq!(mutation.state(), Some(&observed));
    row = observed;
    row.insert("generation".into(), "d".repeat(32));
    assert!(
        backend
            .ensure("ollama_proxy_storage", &row)
            .await
            .error()
            .is_some()
    );
}

#[tokio::test]
async fn obsolete_proxy_backend_rejects_compute_without_engine_effects() {
    let fixture = Fixture::start(|request| {
        panic!(
            "unexpected engine effect {} {}",
            request.method, request.path
        )
    })
    .await;
    let backend = super::super::ProxyBackend::new(Engine::connect(&fixture.endpoint).unwrap());
    let expected = ObservationError::Backend("proxy lifecycle belongs to the Docker provider");
    assert_eq!(
        backend.ensure("ollama_proxy", &Row::new()).await.error(),
        Some(expected)
    );
    assert_eq!(
        backend.read("ollama_proxy", &Row::new(), false).await,
        Err(expected)
    );
    assert_eq!(
        backend.remove("ollama_proxy", &Row::new(), true).await,
        Err(expected)
    );
}
