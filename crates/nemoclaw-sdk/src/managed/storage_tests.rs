// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::*;
use crate::docker::fixture::Fixture;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
#[derive(Default)]
struct State {
    volume: Option<Value>,
    lose_create: bool,
    fail_read: bool,
    creates: usize,
}
#[tokio::test]
async fn model_storage_recovers_lost_creation_and_never_recreates_bound_data() {
    let state = Arc::new(Mutex::new(State {
        lose_create: true,
        ..Default::default()
    }));
    let shared = state.clone();
    let fixture=Fixture::start(move |request|{
        let mut state=shared.lock().unwrap();
        let (code,value)=match (request.method.as_str(),request.path.as_str()) {
            ("GET","/info")=>(200,json!({"ID":"engine"})),
            ("POST","/volumes/create")=>{
                state.creates+=1;let request:Value=serde_json::from_slice(&request.body).unwrap();
                let volume=json!({"Name":request["Name"],"Driver":"local","Mountpoint":"/var/lib/docker/volumes/fixture/_data","CreatedAt":"2026-09-14T00:00:00Z","Labels":request["Labels"],"Options":{},"Scope":"local"});
                state.volume=Some(volume.clone());
                if std::mem::take(&mut state.lose_create) {return None;}(201,volume)
            }
            ("GET",path) if path.starts_with("/volumes/")=>{
                if state.fail_read {(503,json!({"message":"failed"}))} else {state.volume.clone().map(|volume|(200,volume)).unwrap_or((404,json!({"message":"missing"})))}
            }
            _=>panic!("unexpected Docker operation {} {}",request.method,request.path),
        };Some((code,serde_json::to_vec(&value).unwrap()))
    }).await;
    let engine = Engine::connect(&fixture.endpoint).unwrap();
    let storage = Storage {
        name: "nc-0123456789abcdef-inference-data".into(),
        owner: "302ff5e1-088d-42ce-959f-4ff4c3570c13".into(),
        generation: "b".repeat(32),
        engine: fixture.endpoint.clone(),
    };
    assert_eq!(storage.observe(&engine, "").await.unwrap(), None);
    assert!(storage.ensure(&engine, "").await.is_err());
    let id = storage.ensure(&engine, "").await.unwrap();
    assert_eq!(
        id,
        "engine/nc-0123456789abcdef-inference-data/2026-09-14T00:00:00Z"
    );
    assert_eq!(storage.ensure(&engine, &id).await.unwrap(), id);
    state.lock().unwrap().fail_read = true;
    assert!(storage.observe(&engine, &id).await.is_err());
    assert!(storage.ensure(&engine, &id).await.is_err());
    state.lock().unwrap().fail_read = false;
    state.lock().unwrap().volume.as_mut().unwrap()["Labels"][OWNER_LABEL] = json!("foreign");
    assert!(storage.ensure(&engine, &id).await.is_err());
    state.lock().unwrap().volume = None;
    assert!(storage.observe(&engine, &id).await.is_err());
    assert!(storage.ensure(&engine, &id).await.is_err());
    assert_eq!(state.lock().unwrap().creates, 1);
}

#[tokio::test]
async fn changed_connection_cannot_adopt_an_identical_volume_on_a_different_daemon() {
    let mut storage = Storage {
        name: "nc-0123456789abcdef-inference-data".into(),
        owner: "302ff5e1-088d-42ce-959f-4ff4c3570c13".into(),
        generation: "b".repeat(32),
        engine: "unix:///unused".into(),
    };
    let volume = json!({"Name":storage.name,"Driver":"local","Scope":"local","Mountpoint":"/var/lib/docker/volumes/shared/_data","CreatedAt":"same-time","Labels":storage.labels(),"Options":{}});
    let start = |id: &'static str, volume: Value| async move {
        let identity = Arc::new(Mutex::new((id, 200)));
        let current = identity.clone();
        let fixture = Fixture::start(move |request| {
            assert_eq!(
                request.method, "GET",
                "identity mismatch reached a mutation"
            );
            let (id, status) = *current.lock().unwrap();
            let value = if request.path == "/info" {
                json!({"ID":id})
            } else {
                volume.clone()
            };
            Some((status, serde_json::to_vec(&value).unwrap()))
        })
        .await;
        (fixture, identity)
    };
    let (a, access) = start("daemon-a", volume.clone()).await;
    let (alias_a, _) = start("daemon-a", volume.clone()).await;
    let (b, _) = start("daemon-b", volume).await;
    storage.engine = a.endpoint.clone();
    let id = storage
        .observe(&Engine::connect(&a.endpoint).unwrap(), "")
        .await
        .unwrap()
        .unwrap();
    // Credential rejection changes connection availability, not the binding.
    *access.lock().unwrap() = ("daemon-a", 401);
    assert!(matches!(
        storage
            .ensure(&Engine::connect(&a.endpoint).unwrap(), &id)
            .await,
        Err(Error::Observation(ObservationError::Authentication))
    ));
    *access.lock().unwrap() = ("daemon-a", 200);
    assert_eq!(
        storage
            .ensure(&Engine::connect(&a.endpoint).unwrap(), &id)
            .await
            .unwrap(),
        id
    );
    // Retargeting the same alias/socket also cannot adopt matching names.
    *access.lock().unwrap() = ("different-daemon", 200);
    assert!(matches!(
        storage
            .ensure(&Engine::connect(&a.endpoint).unwrap(), &id)
            .await,
        Err(Error::Observation(ObservationError::BindingMismatch))
    ));
    *access.lock().unwrap() = ("daemon-a", 200);
    // A different socket reaching the same daemon retains resource identity.
    storage.engine = alias_a.endpoint.clone();
    assert_eq!(
        storage
            .observe(&Engine::connect(&alias_a.endpoint).unwrap(), &id)
            .await
            .unwrap(),
        Some(id.clone())
    );
    // Even identical names, labels and timestamps do not permit a target change.
    storage.engine = b.endpoint.clone();
    let error = storage
        .ensure(&Engine::connect(&b.endpoint).unwrap(), &id)
        .await
        .unwrap_err();
    assert!(matches!(
        error,
        Error::Observation(ObservationError::BindingMismatch)
    ));
    let encoded = storage.json().unwrap();
    let backend = crate::managed::ManagedBackend::new(Engine::connect(&a.endpoint).unwrap());
    use crate::backend::{Backend, Row};
    let row = Row::from([("spec".into(), encoded), ("id".into(), id)]);
    assert!(backend.ensure("test_storage", &row).await.error().is_some());
}
