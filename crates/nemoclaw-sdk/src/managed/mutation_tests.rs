// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::*;
use crate::docker::fixture::Fixture;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
struct CapacityResult(bool);
#[async_trait::async_trait]
impl CapacityCheck for CapacityResult {
    async fn check(
        &self,
        _: &Engine,
        _: &Spec,
        _: Option<&RuntimeObservation>,
    ) -> Result<(), Error> {
        if self.0 {
            Ok(())
        } else {
            Err(Error::Conflict("fixture capacity rejection"))
        }
    }
}
#[derive(Default)]
struct State {
    container: Option<Value>,
    volume: Option<Value>,
    network: Value,
    starts: usize,
    creates: usize,
    removes: usize,
    exit_on_start: bool,
    lose_create: bool,
}

#[tokio::test]
async fn image_pull_policy_controls_registry_requests_and_requires_a_local_image() {
    for service in [false, true] {
        for policy in ["default", "Always", "IfNotPresent", "Never"] {
            for present in [false, true] {
                for pull_fails in [false, true] {
                    let fixtures: Vec<Value> =
                        serde_json::from_str(include_str!("reference.json")).unwrap();
                    let mut value: Value = serde_json::from_str(
                        fixtures[usize::from(service)]["spec"].as_str().unwrap(),
                    )
                    .unwrap();
                    if policy != "default" {
                        value[if service { "service" } else { "gateway" }]["imagePullPolicy"] =
                            json!(policy);
                    }
                    let policy = if policy == "default" {
                        if service { "Never" } else { "IfNotPresent" }
                    } else {
                        policy
                    };
                    let spec: Spec = serde_json::from_value(value).unwrap();
                    let state = Arc::new(Mutex::new((present, 0)));
                    let shared = state.clone();
                    let fixture = Fixture::start(move |request| {
                        let mut state = shared.lock().unwrap();
                        let path = request.path.split('?').next().unwrap();
                        let (code, body) = match (request.method.as_str(), path) {
                            ("POST", "/images/create") => {
                                state.1 += 1;
                                if pull_fails {
                                    (200, json!({"errorDetail": {"message": "registry unavailable"}}))
                                } else {
                                    state.0 = true;
                                    (200, json!({"status": "complete"}))
                                }
                            }
                            ("GET", "/info") => (200, json!({"ID": "engine", "Architecture": "aarch64"})),
                            ("GET", path) if path.starts_with("/images/") => {
                                if state.0 {
                                    (200, json!({
                                        "Id": "sha256:runtime", "Architecture": "arm64", "Os": "linux",
                                        "Config": {"Labels": {
                                            "org.nemoclaw.recipe.protocol": "v1",
                                            "org.nemoclaw.backend": "vllm"
                                        }}
                                    }))
                                } else {
                                    (404, json!({"message": "missing"}))
                                }
                            }
                            _ => panic!("unexpected request {} {}", request.method, request.path),
                        };
                        Some((code, serde_json::to_vec(&body).unwrap()))
                    }).await;
                    let result = fixture.engine_for(spec.engine()).ensure_image(&spec).await;
                    let pulls = policy == "Always" || (policy == "IfNotPresent" && !present);
                    assert_eq!(
                        state.lock().unwrap().1,
                        usize::from(pulls),
                        "{policy}, present={present}"
                    );
                    assert_eq!(
                        result.is_ok(),
                        (present || pulls) && !(pulls && pull_fails),
                        "{policy}, present={present}, pull_fails={pull_fails}: {result:?}"
                    );
                }
            }
        }
    }
}

#[tokio::test]
async fn network_creation_rechecks_conflicts_that_appear_after_planning() {
    let fixtures: Vec<Value> = serde_json::from_str(include_str!("reference.json")).unwrap();
    let spec: Spec = serde_json::from_str(fixtures[0]["spec"].as_str().unwrap()).unwrap();
    let networks = Arc::new(Mutex::new(json!([])));
    let shared = networks.clone();
    let fixture = Fixture::start(move |request| {
        assert_eq!(
            request.method, "GET",
            "conflict must prevent network creation"
        );
        let (status, body) = if request.path.split('?').next() == Some("/networks") {
            (200, shared.lock().unwrap().clone())
        } else {
            (404, json!({"message":"missing"}))
        };
        Some((status, serde_json::to_vec(&body).unwrap()))
    })
    .await;
    let engine = fixture.engine_for(spec.engine());
    assert!(engine.checked_network(&spec).await.unwrap().is_none());
    *networks.lock().unwrap() = json!([{"IPAM":{"Config":[{"Subnet":spec.network_cidr()}]}}]);
    assert!(matches!(
        engine.ensure_network(&spec).await,
        Err(Error::Conflict(
            "managed gateway subnet overlaps an existing Docker network"
        ))
    ));
}

#[tokio::test]
async fn existing_network_is_reused_only_with_matching_ownership_and_configuration() {
    let fixtures: Vec<Value> = serde_json::from_str(include_str!("reference.json")).unwrap();
    let spec: Spec = serde_json::from_str(fixtures[0]["spec"].as_str().unwrap()).unwrap();
    let network = json!({"Id":"network","Name":spec.network(),"Driver":"bridge","Internal":false,"EnableIPv6":false,"Labels":spec.labels().unwrap(),"IPAM":{"Driver":"default","Config":[{"Subnet":spec.network_cidr(),"Gateway":spec.bridge().unwrap()}]}});
    let shared = Arc::new(Mutex::new(network.clone()));
    let state = shared.clone();
    let fixture = Fixture::start(move |request| {
        assert_eq!(request.method, "GET");
        assert!(
            request.path.starts_with("/networks/"),
            "owned network needs no inventory or mutation"
        );
        Some((200, serde_json::to_vec(&*state.lock().unwrap()).unwrap()))
    })
    .await;
    let engine = fixture.engine_for(spec.engine());
    assert!(engine.checked_network(&spec).await.unwrap().is_some());
    engine.ensure_network(&spec).await.unwrap();
    for drift in [
        json!({"Labels":{super::super::OWNER_LABEL:"foreign"}}),
        json!({"IPAM":{"Driver":"default","Config":[{"Subnet":"10.99.0.0/24","Gateway":"10.99.0.1"}]}}),
    ] {
        let mut changed = network.clone();
        for (key, value) in drift.as_object().unwrap() {
            changed[key] = value.clone();
        }
        *shared.lock().unwrap() = changed;
        assert!(engine.checked_network(&spec).await.is_err());
        assert!(engine.ensure_network(&spec).await.is_err());
    }
}

#[tokio::test]
async fn managed_gateway_accepts_a_native_linux_amd64_image() {
    let fixtures: Vec<Value> = serde_json::from_str(include_str!("reference.json")).unwrap();
    let spec: Spec = serde_json::from_str(fixtures[0]["spec"].as_str().unwrap()).unwrap();
    let fixture = Fixture::start(|request| match request.path.as_str() {
        "/info" => Some((
            200,
            serde_json::to_vec(&json!({
                "ID": "engine",
                "Architecture": "x86_64"
            }))
            .unwrap(),
        )),
        path if path.starts_with("/images/") => Some((
            200,
            serde_json::to_vec(&json!({
                "Id": "sha256:gateway",
                "Architecture": "amd64",
                "Os": "linux",
                "Config": {"Env": []}
            }))
            .unwrap(),
        )),
        _ => panic!("unexpected runtime observation {}", request.path),
    })
    .await;

    fixture
        .engine_for(&spec.gateway.engine)
        .ensure_image(&spec)
        .await
        .unwrap();
}

#[tokio::test]
async fn managed_gateway_rejects_an_image_for_a_different_engine_architecture() {
    let fixtures: Vec<Value> = serde_json::from_str(include_str!("reference.json")).unwrap();
    let spec: Spec = serde_json::from_str(fixtures[0]["spec"].as_str().unwrap()).unwrap();
    let fixture = Fixture::start(|request| match request.path.as_str() {
        "/info" => Some((
            200,
            serde_json::to_vec(&json!({
                "ID": "engine",
                "Architecture": "x86_64"
            }))
            .unwrap(),
        )),
        path if path.starts_with("/images/") => Some((
            200,
            serde_json::to_vec(&json!({
                "Id": "sha256:gateway",
                "Architecture": "arm64",
                "Os": "linux",
                "Config": {"Env": []}
            }))
            .unwrap(),
        )),
        _ => panic!("unexpected runtime observation {}", request.path),
    })
    .await;

    assert!(matches!(
        fixture
            .engine_for(&spec.gateway.engine)
            .ensure_image(&spec)
            .await,
        Err(Error::Conflict(
            "runtime image is unavailable or incompatible with the execution target"
        ))
    ));
}

#[tokio::test]
async fn failed_startup_and_explicit_recovery_keep_container_and_storage_identity() {
    let fixtures: Vec<Value> = serde_json::from_str(include_str!("reference.json")).unwrap();
    let data = &fixtures[1];
    let spec: Spec = serde_json::from_str(data["spec"].as_str().unwrap()).unwrap();
    let container = json!({"Id":"container","Name":format!("/{}",spec.name),"Image":"sha256:runtime","Config":data["config"],"HostConfig":data["hostConfig"],"State":{"Running":false,"StartedAt":"2026-09-14T00:00:00Z"},"Mounts":[{"Type":"volume","Name":spec.volume(),"Destination":"/data","RW":true}]});
    let volume = json!({"Name":spec.volume(),"Driver":"local","Scope":"local","Mountpoint":"/var/lib/docker/volumes/fixture/_data","CreatedAt":"2026-09-14T00:00:00Z","Labels":spec.labels().unwrap(),"Options":{}});
    let network = json!({"Id":"network","Name":spec.network(),"Driver":"bridge","Internal":false,"EnableIPv6":false,"Labels":{super::super::OWNER_LABEL:spec.owner},"IPAM":{"Driver":"default","Config":[{"Subnet":spec.gateway.network_cidr,"Gateway":spec.gateway.bridge().unwrap()}]}});
    let state = Arc::new(Mutex::new(State {
        container: Some(container.clone()),
        volume: Some(volume),
        network,
        exit_on_start: true,
        ..Default::default()
    }));
    let shared = state.clone();
    let service = spec.service.clone().unwrap();
    let template = container.clone();
    let fixture=Fixture::start(move |request|{
        let mut state=shared.lock().unwrap();
        let (status,value)=match (request.method.as_str(),request.path.split('?').next().unwrap()) {
            ("GET","/info")=>(200,json!({"ID":"engine","DockerRootDir":"/var/lib/docker"})),
            ("GET",path) if path.starts_with("/images/")=>(200,json!({"Id":"sha256:runtime","Architecture":"arm64","Os":"linux","Config":{"Env":[],"Labels":{"org.nemoclaw.recipe.protocol":"v1","org.nemoclaw.backend":service.backend,"org.nemoclaw.model":service.model.revision}}})),
            ("GET",path) if path.starts_with("/networks/")=>(200,state.network.clone()),
            ("GET",path) if path.starts_with("/volumes/")=>state.volume.clone().map(|v|(200,v)).unwrap_or((404,json!({"message":"missing"}))),
            ("GET",path) if path.starts_with("/containers/")=>state.container.clone().map(|v|(200,v)).unwrap_or((404,json!({"message":"missing"}))),
            ("POST","/containers/create")=>{
                state.creates+=1;let request:Value=serde_json::from_slice(&request.body).unwrap();let mut created=template.clone();
                created["Id"]=json!("replacement");created["Config"]=request.clone();created["HostConfig"]=request["HostConfig"].clone();
                state.container=Some(created);if std::mem::take(&mut state.lose_create){return None;}(201,json!({"Id":"replacement","Warnings":[]}))
            }
            ("POST",path) if path.ends_with("/start")=>{state.starts+=1;let running=!state.exit_on_start;state.container.as_mut().unwrap()["State"]["Running"]=json!(running);(204,Value::Null)},
            ("POST",path) if path.ends_with("/stop")=>{state.container.as_mut().unwrap()["State"]["Running"]=json!(false);(204,Value::Null)},
            ("DELETE",path) if path.starts_with("/containers/")=>{state.removes+=1;state.container=None;(204,Value::Null)},
            _=>panic!("unexpected runtime mutation {} {}",request.method,request.path),
        };Some((status,if status==204 {Vec::new()} else {serde_json::to_vec(&value).unwrap()}))
    }).await;
    let engine = fixture.engine_for(&spec.gateway.engine);
    assert!(
        engine
            .ensure_runtime_checked(&spec, "", &CapacityResult(false))
            .await
            .is_err()
    );
    assert_eq!(state.lock().unwrap().starts, 0);
    let first = engine
        .ensure_runtime_checked(&spec, "", &CapacityResult(true))
        .await
        .unwrap();
    assert!(!first.running);
    assert_eq!(state.lock().unwrap().starts, 1);
    engine.observe_runtime(&spec, &first.id).await.unwrap();
    assert_eq!(state.lock().unwrap().starts, 1);
    state.lock().unwrap().exit_on_start = false;
    let recovered = engine
        .ensure_runtime_checked(&spec, &first.id, &CapacityResult(true))
        .await
        .unwrap();
    assert!(recovered.running);
    assert_eq!(recovered.id, first.id);
    engine
        .ensure_runtime_checked(&spec, &first.id, &CapacityResult(false))
        .await
        .unwrap();
    assert_eq!(state.lock().unwrap().starts, 2);
    engine.remove_runtime(&spec, &first.id).await.unwrap();
    engine.remove_runtime(&spec, &first.id).await.unwrap();
    assert_eq!(state.lock().unwrap().removes, 1);
    assert!(state.lock().unwrap().volume.is_some());
    assert!(
        engine
            .ensure_runtime_checked(&spec, &first.id, &CapacityResult(true))
            .await
            .is_err()
    );
    state.lock().unwrap().lose_create = true;
    assert!(
        engine
            .ensure_runtime_checked(&spec, "", &CapacityResult(true))
            .await
            .is_err()
    );
    let recreated = engine
        .ensure_runtime_checked(&spec, "", &CapacityResult(true))
        .await
        .unwrap();
    assert!(recreated.running);
    assert!(recreated.id.contains("/replacement/"));
    assert_eq!(state.lock().unwrap().creates, 1);
}

#[tokio::test]
async fn image_pull_reports_layer_bytes_without_claiming_whole_image_percentage() {
    use crate::{ByteProgress, DownloadPhase, Progress, with_download_progress};
    let fixture = Fixture::start(|request| {
        if request.method == "POST" && request.path.starts_with("/images/create") {
            Some((200, b"{\"status\":\"Downloading\",\"id\":\"abcdef\",\"progressDetail\":{\"current\":50,\"total\":100}}\n{\"status\":\"Extracting\",\"id\":\"abcdef\",\"progressDetail\":{\"current\":80,\"total\":100}}\n".to_vec()))
        } else if request.method == "GET" && request.path.starts_with("/images/") {
            Some((200, serde_json::to_vec(&json!({"Id":"sha256:image"})).unwrap()))
        } else { panic!("unexpected request {} {}", request.method, request.path); }
    }).await;
    let events = Arc::new(Mutex::new(Vec::new()));
    let seen = events.clone();
    let engine = fixture.engine_for("unix:///fixture");
    with_download_progress(
        "managed_gateway.gateway".into(),
        Arc::new(move |event| {
            if let Progress::Download(event) = event {
                seen.lock().unwrap().push(event);
            }
        }),
        engine.pull_image("image:tag"),
    )
    .await
    .unwrap();
    let events = events.lock().unwrap();
    assert!(
        events
            .iter()
            .any(|event| event.layer.as_deref() == Some("abcdef")
                && event.phase == DownloadPhase::Downloading
                && event.bytes
                    == Some(ByteProgress {
                        completed: 50,
                        total: Some(100)
                    }))
    );
    assert!(
        events
            .iter()
            .any(|event| event.phase == DownloadPhase::Extracting)
    );
    assert!(
        events
            .iter()
            .filter(|event| event.layer.is_none())
            .all(|event| event.bytes.is_none())
    );
    assert_eq!(events.last().unwrap().phase, DownloadPhase::Complete);
}
