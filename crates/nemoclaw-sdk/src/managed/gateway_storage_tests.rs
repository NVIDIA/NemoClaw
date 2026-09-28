// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::*;
use crate::docker::fixture::Fixture;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
#[tokio::test]
async fn retained_gateway_storage_requires_complete_owned_credentials_without_mutations() {
    let fixtures: Vec<Value> = serde_json::from_str(include_str!("reference.json")).unwrap();
    let mut spec: Spec = serde_json::from_str(fixtures[0]["spec"].as_str().unwrap()).unwrap();
    spec.layout = 1;
    let data_path = "/var/lib/docker/volumes/fixture/_data";
    let create = serde_json::to_value(initializer(&spec, data_path).unwrap()).unwrap();
    let helper = json!({"Id":"helper","Config":create,"HostConfig":create["HostConfig"],"State":{"Status":"exited","Running":false,"ExitCode":0},"Mounts":[{"Type":"volume","Name":spec.volume(),"Destination":data_path,"RW":true}]});
    let volume = json!({"Name":spec.volume(),"Driver":"local","Scope":"local","Mountpoint":data_path,"CreatedAt":"2026-09-14T00:00:00Z","Labels":spec.labels().unwrap(),"Options":{}});
    let network = json!({"Id":"network","Name":spec.network(),"Driver":"bridge","Internal":false,"EnableIPv6":false,"Labels":spec.labels().unwrap(),"IPAM":{"Driver":"default","Config":[{"Subnet":spec.gateway.network_cidr,"Gateway":spec.gateway.bridge().unwrap()}]}});
    let state = Arc::new(Mutex::new((
        Some(helper),
        Some(volume),
        Some(network),
        false,
        false,
        false,
    )));
    let shared = state.clone();
    let toml = spec.gateway_config(data_path);
    let fixture = Fixture::start(move |request| {
        assert_eq!(
            request.method, "GET",
            "gateway storage observation mutated Docker"
        );
        let state = shared.lock().unwrap();
        let (code, value) = if request.path == "/info" {
            (
                200,
                json!({"ID":"engine","DockerRootDir":"/var/lib/docker"}),
            )
        } else if request.path.contains("/archive?") {
            if state.3 {
                return Some((403, br#"{"message":"denied"}"#.to_vec()));
            }
            let url = url::Url::parse(&format!("http://fixture{}", request.path)).unwrap();
            let path = url
                .query_pairs()
                .find(|(key, _)| key == "path")
                .unwrap()
                .1
                .into_owned();
            let bytes = if path.ends_with("gateway.toml") {
                toml.as_bytes().to_vec()
            } else if path.ends_with("public.pem") {
                b"public".to_vec()
            } else if path.ends_with("key-encryption-key.bin") {
                if state.4 {
                    b"short".to_vec()
                } else {
                    vec![if state.5 { 8 } else { 7 }; 32]
                }
            } else {
                panic!("unexpected archive {path}")
            };
            let mut archive = tar::Builder::new(Vec::new());
            let mut header = tar::Header::new_gnu();
            header.set_size(bytes.len() as u64);
            header.set_mode(0o600);
            header.set_cksum();
            archive
                .append_data(&mut header, "file", bytes.as_slice())
                .unwrap();
            return Some((200, archive.into_inner().unwrap()));
        } else if request.path.starts_with("/containers/") {
            state
                .0
                .clone()
                .map(|v| (200, v))
                .unwrap_or((404, json!({"message":"missing"})))
        } else if request.path.starts_with("/volumes/") {
            state
                .1
                .clone()
                .map(|v| (200, v))
                .unwrap_or((404, json!({"message":"missing"})))
        } else if request.path.starts_with("/networks/") {
            state
                .2
                .clone()
                .map(|v| (200, v))
                .unwrap_or((404, json!({"message":"missing"})))
        } else {
            panic!("unexpected request {}", request.path)
        };
        Some((code, serde_json::to_vec(&value).unwrap()))
    })
    .await;
    let engine = fixture.engine_for(&spec.gateway.engine);
    let id = engine
        .gateway_storage(&spec, "", false)
        .await
        .unwrap()
        .unwrap();
    assert!(
        id.starts_with("engine/nc-68d203b0c7e6083f-gateway-data/2026-09-14T00:00:00Z/network/")
    );
    assert_eq!(
        engine
            .gateway_storage(&spec, &id, false)
            .await
            .unwrap()
            .as_deref(),
        Some(id.as_str())
    );
    state.lock().unwrap().5 = true;
    assert!(engine.gateway_storage(&spec, &id, false).await.is_err());
    assert!(engine.gateway_storage(&spec, &id, true).await.is_err());
    state.lock().unwrap().5 = false;
    state.lock().unwrap().0.as_mut().unwrap()["State"]["Status"] = json!("created");
    assert!(engine.gateway_storage(&spec, &id, false).await.is_err());
    assert!(engine.gateway_storage(&spec, &id, true).await.is_err());
    state.lock().unwrap().0.as_mut().unwrap()["State"]["Status"] = json!("exited");
    let original_command = state.lock().unwrap().0.as_ref().unwrap()["Config"]["Cmd"].clone();
    state.lock().unwrap().0.as_mut().unwrap()["Config"]["Cmd"] = json!(["unexpected"]);
    assert!(engine.gateway_storage(&spec, &id, true).await.is_err());
    state.lock().unwrap().0.as_mut().unwrap()["Config"]["Cmd"] = original_command;
    state.lock().unwrap().3 = true;
    assert!(engine.gateway_storage(&spec, &id, false).await.is_err());
    state.lock().unwrap().3 = false;
    state.lock().unwrap().4 = true;
    assert!(engine.gateway_storage(&spec, &id, false).await.is_err());
    state.lock().unwrap().4 = false;
    state.lock().unwrap().0.as_mut().unwrap()["Mounts"][0]["Name"] = json!("foreign");
    assert!(engine.gateway_storage(&spec, &id, false).await.is_err());
    state.lock().unwrap().0 = None;
    assert!(engine.gateway_storage(&spec, &id, true).await.is_err());
    assert!(matches!(
        engine.gateway_storage(&spec, "", false).await,
        Err(Error::PartialRuntime)
    ));
    state.lock().unwrap().1 = None;
    state.lock().unwrap().2 = None;
    assert!(
        engine
            .gateway_storage(&spec, "", false)
            .await
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn missing_persistent_key_never_imports_or_generates_for_an_existing_gateway() {
    let fixtures: Vec<Value> = serde_json::from_str(include_str!("reference.json")).unwrap();
    let mut spec: Spec = serde_json::from_str(fixtures[0]["spec"].as_str().unwrap()).unwrap();
    spec.layout = 0;
    let requests = Arc::new(Mutex::new(Vec::new()));
    let seen = requests.clone();
    let fixture = Fixture::start(move |request| {
        assert_eq!(request.method, "GET", "missing key must not cause a write");
        seen.lock().unwrap().push(request.path.clone());
        if request.path.contains("/archive?") {
            Some((404, br#"{"message":"missing"}"#.to_vec()))
        } else {
            Some((200, br#"{"Id":"existing-gateway"}"#.to_vec()))
        }
    })
    .await;
    let engine = fixture.engine_for(&spec.gateway.engine);
    for bound in [true, false] {
        requests.lock().unwrap().clear();
        assert!(
            engine
                .credential_key(&spec, "helper", "/owned-data", bound, true)
                .await
                .is_err()
        );
        let observed = requests.lock().unwrap();
        assert_eq!(observed.len(), if bound { 1 } else { 2 });
        let path = url::Url::parse(&format!("http://fixture{}", observed[0])).unwrap();
        assert!(
            path.query_pairs()
                .any(|(k, v)| k == "path" && v == format!("/owned-data{CREDENTIAL_KEY_PATH}"))
        );
        if !bound {
            assert!(observed[1].contains(&spec.name));
        }
    }
}

#[tokio::test]
async fn gateway_prerequisites_can_be_checked_without_storage_or_resource_reads() {
    let fixture = Fixture::start(|request| {
        assert_eq!(request.method, "GET");
        assert_eq!(request.path, "/info");
        Some((200, br#"{"ID":"engine"}"#.to_vec()))
    })
    .await;
    let engine = fixture.engine_for("unix:///var/run/docker.sock");
    assert_eq!(
        engine
            .gateway_engine_info(ComputeDriver::Docker)
            .await
            .unwrap()
            .id
            .as_deref(),
        Some("engine")
    );
}
