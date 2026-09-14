// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::*;
use crate::docker::fixture::Fixture;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
#[derive(Default)]
struct State {
    volume: Option<Value>,
    container: Option<Value>,
    lost_create: bool,
    fail_read: bool,
    creates: usize,
    starts: usize,
}
#[tokio::test]
async fn ollama_reconciles_lost_create_and_refuses_recreation_after_observation_failure() {
    let spec = ServiceSpec {
        name: "nc-0123456789abcdef-ollama".into(),
        owner: "302ff5e1-088d-42ce-959f-4ff4c3570c13".into(),
        generation: "b".repeat(32),
        image: format!("ollama/ollama@sha256:{}", "a".repeat(64)),
        network: "openshell-docker".into(),
        bind_address: "127.0.0.1:11434".into(),
    };
    let state = Arc::new(Mutex::new(State {
        lost_create: true,
        ..Default::default()
    }));
    let shared = state.clone();
    let want = spec.clone();
    let fixture=Fixture::start(move |request| {
        let mut state=shared.lock().unwrap();
        let (code,value)=match (request.method.as_str(),request.path.as_str()) {
            ("GET","/info")=>(200,json!({"ID":"engine"})),
            ("GET",path) if path.starts_with("/images/")=>(200,json!({"Id":"image"})),
            ("GET",path) if path.starts_with("/containers/")=>if state.fail_read {(503,json!({}))} else {state.container.clone().map(|v|(200,v)).unwrap_or((404,json!({})))},
            ("GET",path) if path.starts_with("/volumes/")=>state.volume.clone().map(|v|(200,v)).unwrap_or((404,json!({}))),
            ("POST","/volumes/create")=>{let r:Value=serde_json::from_slice(&request.body).unwrap();let v=json!({"Name":r["Name"],"Labels":r["Labels"],"Driver":"local","Scope":"local","Options":{},"CreatedAt":"created","Mountpoint":"/var/lib/docker/volumes/models/_data"});state.volume=Some(v.clone());(201,v)},
            ("POST",path) if path.starts_with("/containers/create")=>{
                state.creates+=1;let r:Value=serde_json::from_slice(&request.body).unwrap();
                state.container=Some(json!({"Id":"container","Name":format!("/{}",want.name),"Config":r,"HostConfig":r["HostConfig"],"State":{"Running":false},"Mounts":[{"Type":"volume","Name":want.volume(),"Destination":"/root/.ollama","RW":true}]}));
                if std::mem::take(&mut state.lost_create) {return None;} (201,json!({"Id":"container","Warnings":[]}))
            },
            ("POST","/containers/container/start")=>{state.starts+=1;state.container.as_mut().unwrap()["State"]["Running"]=json!(true);(204,json!({}))},
            _=>panic!("unexpected engine effect {} {}",request.method,request.path),
        };Some((code,serde_json::to_vec(&value).unwrap()))
    }).await;
    let engine = Engine::connect(&fixture.endpoint).unwrap();
    assert!(engine.ensure_ollama(&spec, "").await.is_err());
    let established = engine.ensure_ollama(&spec, "").await.unwrap();
    assert_eq!(established.id, "engine/container/created");
    assert!(established.running);
    assert_eq!(
        engine
            .ensure_ollama(&spec, &established.id)
            .await
            .unwrap()
            .id,
        established.id
    );
    state.lock().unwrap().fail_read = true;
    assert!(engine.ensure_ollama(&spec, &established.id).await.is_err());
    state.lock().unwrap().fail_read = false;
    state.lock().unwrap().volume.as_mut().unwrap()["CreatedAt"] = json!("replaced");
    assert!(engine.ensure_ollama(&spec, &established.id).await.is_err());
    state.lock().unwrap().container = None;
    assert!(engine.ensure_ollama(&spec, &established.id).await.is_err());
    let state = state.lock().unwrap();
    assert_eq!(state.creates, 1);
    assert_eq!(state.starts, 1);
}
