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
