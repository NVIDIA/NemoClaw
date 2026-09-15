// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
#![cfg(unix)]
use nemoclaw_e2e::{docker, openshell};
use nemoclaw_sdk::{CancellationToken, Deployment, config::Document};
use serde_json::{Value, json};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
#[derive(Default)]
struct State {
    volume: Option<Value>,
    container: Option<Value>,
    installed: bool,
    fail_inventory: bool,
    creates: usize,
    starts: usize,
    fail_start: bool,
    deletes: usize,
    lose_delete: bool,
    fail_engine: bool,
    pulls: usize,
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires explicit verified NEMOCLAW_TEST_BUNDLE"]
async fn managed_ollama_bundle_preserves_models_across_noop_export_and_failed_observation() {
    let bundle = PathBuf::from(std::env::var_os("NEMOCLAW_TEST_BUNDLE").unwrap());
    let shared = Arc::new(Mutex::new(State::default()));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/v1", listener.local_addr().unwrap());
    let state = shared.clone();
    let server = tokio::spawn(async move {
        loop {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut bytes = Vec::new();
            while !bytes.ends_with(b"\r\n\r\n") {
                bytes.push(socket.read_u8().await.unwrap());
            }
            let header = String::from_utf8(bytes).unwrap();
            let len = header
                .lines()
                .find_map(|l| l.strip_prefix("content-length: "))
                .map(|n| n.parse().unwrap())
                .unwrap_or(0);
            socket.read_exact(&mut vec![0; len]).await.unwrap();
            let (status, body) = {
                let mut state = state.lock().unwrap();
                if header.starts_with("GET /api/tags ") {
                    if state.fail_inventory {
                        (503, "{}".into())
                    } else {
                        (200, json!({"models": if state.installed { vec![json!({"name":"qwen3:0.6b","digest":"a".repeat(64),"size":42})] } else {vec![]} }).to_string())
                    }
                } else if header.starts_with("POST /api/pull ") {
                    state.pulls += 1;
                    state.installed = true;
                    (200, "{\"status\":\"success\"}\n".into())
                } else {
                    panic!("unexpected model request");
                }
            };
            socket.write_all(format!("HTTP/1.1 {status} Fixture\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
        }
    });
    let state = shared.clone();
    let engine=docker::Fixture::start(move |request| {
        let mut state=state.lock().unwrap();
        let (status,value)=match (request.method.as_str(),request.path.as_str()) {
            ("GET","/info")=>if state.fail_engine {(503,json!({}))} else {(200,json!({"ID":"fixture-engine"}))},
            ("GET",p) if p.starts_with("/images/")=>(200,json!({"Id":"image"})),
            ("GET",p) if p.starts_with("/containers/")=>state.container.clone().map(|v|(200,v)).unwrap_or((404,json!({}))),
            ("GET",p) if p.starts_with("/volumes/")=>state.volume.clone().map(|v|(200,v)).unwrap_or((404,json!({}))),
            ("POST","/volumes/create")=>{let r:Value=serde_json::from_slice(&request.body).unwrap();let v=json!({"Name":r["Name"],"Labels":r["Labels"],"Driver":"local","Scope":"local","Options":{},"CreatedAt":"created","Mountpoint":"/fixture"});state.volume=Some(v.clone());(201,v)},
            ("POST",p) if p.starts_with("/containers/create")=>{state.creates+=1;let r:Value=serde_json::from_slice(&request.body).unwrap();let name=r["HostConfig"]["Mounts"][0]["Source"].as_str().unwrap().trim_end_matches("-models");state.container=Some(json!({"Id":format!("container-{}",state.creates),"Name":format!("/{name}"),"Config":r,"HostConfig":r["HostConfig"],"State":{"Running":false},"Mounts":[{"Type":"volume","Name":format!("{name}-models"),"Destination":"/root/.ollama","RW":true}]}));(201,json!({"Id":"container","Warnings":[]}))},
            ("POST",p) if p.ends_with("/start")=>{if state.fail_start { return Some((503,b"{}".to_vec())); } state.starts+=1;state.container.as_mut().unwrap()["State"]["Running"]=json!(true);(204,json!({}))},
            ("DELETE",p) if p.starts_with("/containers/")=>{state.deletes+=1;state.container=None;if std::mem::take(&mut state.lose_delete) {return None;} (204,json!({}))},
            _=>panic!("unexpected Docker effect {} {}",request.method,request.path),
        };Some((status,serde_json::to_vec(&value).unwrap()))
    }).await;
    let gateway = openshell::Fixture::start().await;
    let mut document = Document::parse(
        include_str!("../../nemoclaw-sdk/tests/fixtures/config/managed-ollama.yaml").as_bytes(),
    )
    .unwrap();
    document.spec.gateway.endpoint = gateway.endpoint.clone();
    document.spec.inference_providers[0].endpoint = endpoint;
    document.spec.inference_providers[0]
        .ollama
        .as_mut()
        .unwrap()
        .engine = engine.endpoint.clone();
    let directory = tempfile::tempdir().unwrap();
    let deployment = Deployment::new(directory.path(), &bundle).with_engines(
        nemoclaw_sdk::docker::Connections::fixed([nemoclaw_sdk::docker::Engine::connect(
            &engine.endpoint,
        )
        .unwrap()])
        .unwrap(),
    );
    let cancel = CancellationToken::new();
    assert_eq!(
        deployment
            .plan(&document, &cancel)
            .await
            .unwrap()
            .changes
            .len(),
        7
    );
    assert_eq!(shared.lock().unwrap().creates, 0);
    assert_eq!(shared.lock().unwrap().pulls, 0);
    deployment.apply(&document, &cancel).await.unwrap();
    let export = deployment.export(&cancel).await.unwrap();
    assert_eq!(export, document);
    assert!(
        deployment
            .apply(&export, &cancel)
            .await
            .unwrap()
            .changes
            .is_empty()
    );
    // Existing deployments have service/model bindings but no independent storage.
    let state_path = directory.path().join("terraform.tfstate");
    let mut legacy: Value = serde_json::from_slice(&std::fs::read(&state_path).unwrap()).unwrap();
    legacy["resources"]
        .as_array_mut()
        .unwrap()
        .retain(|r| r["type"] != "nemoclaw_ollama_storage");
    std::fs::write(&state_path, serde_json::to_vec(&legacy).unwrap()).unwrap();
    assert!(deployment.plan_destroy(&cancel).await.is_err());
    deployment.apply(&document, &cancel).await.unwrap();
    assert_eq!(shared.lock().unwrap().creates, 1);
    assert_eq!(shared.lock().unwrap().pulls, 1);
    let established = shared.lock().unwrap().container.clone().unwrap()["Id"].clone();
    let retained_volume = shared.lock().unwrap().volume.clone();
    shared.lock().unwrap().container.as_mut().unwrap()["State"]["Running"] = json!(false);
    let recovery = deployment.plan(&document, &cancel).await.unwrap();
    assert!(!recovery.deferred.is_empty());
    assert_eq!(recovery.changes.len(), 1);
    assert_eq!(recovery.changes[0].resource, "nemoclaw_ollama.service");
    assert_eq!(shared.lock().unwrap().starts, 1);
    shared.lock().unwrap().fail_start = true;
    assert!(deployment.apply(&document, &cancel).await.is_err());
    assert_eq!(
        shared.lock().unwrap().container.as_ref().unwrap()["Id"],
        established
    );
    assert_eq!(shared.lock().unwrap().volume, retained_volume);
    shared.lock().unwrap().fail_start = false;
    deployment.apply(&document, &cancel).await.unwrap();
    assert_eq!(
        shared.lock().unwrap().container.as_ref().unwrap()["Id"],
        established
    );
    assert_eq!(shared.lock().unwrap().pulls, 1);
    let original = std::fs::read(directory.path().join("terraform.tfstate")).unwrap();
    shared.lock().unwrap().fail_inventory = true;
    assert!(deployment.plan(&document, &cancel).await.is_err());
    assert!(deployment.apply(&document, &cancel).await.is_err());
    assert!(deployment.export(&cancel).await.is_err());
    assert_eq!(
        original,
        std::fs::read(directory.path().join("terraform.tfstate")).unwrap()
    );
    // Teardown verifies Docker identities/storage, but never needs model inventory:
    // model bytes are retained, including when their API is unavailable.
    shared.lock().unwrap().container.as_mut().unwrap()["State"]["Running"] = json!(false);
    let before = std::fs::read(&state_path).unwrap();
    shared.lock().unwrap().fail_engine = true;
    assert!(deployment.plan_destroy(&cancel).await.is_err());
    assert!(deployment.destroy(&cancel).await.is_err());
    assert_eq!(std::fs::read(&state_path).unwrap(), before);
    assert_eq!(shared.lock().unwrap().deletes, 0);
    shared.lock().unwrap().fail_engine = false;
    shared.lock().unwrap().volume.as_mut().unwrap()["CreatedAt"] = json!("replacement");
    assert!(deployment.destroy(&cancel).await.is_err());
    assert_eq!(shared.lock().unwrap().deletes, 0);
    shared.lock().unwrap().volume = retained_volume.clone();
    let preview = deployment.plan_destroy(&cancel).await.unwrap();
    assert!(
        preview
            .retained
            .contains(&"nemoclaw_ollama_storage.models".into())
    );
    assert_eq!(shared.lock().unwrap().deletes, 0);
    shared.lock().unwrap().lose_delete = true;
    assert!(deployment.destroy(&cancel).await.is_err());
    assert!(shared.lock().unwrap().container.is_none());
    deployment.destroy(&cancel).await.unwrap();
    assert_eq!(shared.lock().unwrap().deletes, 1);
    assert!(shared.lock().unwrap().container.is_none());
    assert_eq!(shared.lock().unwrap().volume, retained_volume);
    shared.lock().unwrap().fail_inventory = false;
    deployment.apply(&document, &cancel).await.unwrap();
    assert_ne!(
        shared.lock().unwrap().container.as_ref().unwrap()["Id"],
        established
    );
    assert_eq!(shared.lock().unwrap().volume, retained_volume);
    assert_eq!(deployment.export(&cancel).await.unwrap(), document);
    let state = shared.lock().unwrap();
    assert_eq!(state.creates, 2);
    assert_eq!(state.pulls, 1);
    server.abort();
}
