// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::*;
use crate::docker::fixture::Fixture;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
#[test]
fn environment_accepts_slices_and_preserves_last_assignment_and_equals() {
    let values = ["A=first".into(), "EMPTY".into(), "A=last=value".into()];
    assert_eq!(
        environment(Some(&values[..])),
        BTreeMap::from([("A", "last=value"), ("EMPTY", "")])
    );
    assert!(environment(None).is_empty());
    assert!(environment(Some(&values[..0])).is_empty());
}

fn reference() -> (Spec, Value, Value, Value) {
    let fixtures: Vec<Value> = serde_json::from_str(include_str!("reference.json")).unwrap();
    let fixture = &fixtures[1];
    let spec: Spec = serde_json::from_str(fixture["spec"].as_str().unwrap()).unwrap();
    let container = json!({"Id":"container","Name":format!("/{}",spec.name),"Image":"sha256:runtime","Config":fixture["config"],"HostConfig":fixture["hostConfig"],"State":{"Running":true,"StartedAt":"2026-09-14T00:00:00Z"},"Mounts":[{"Type":"volume","Name":spec.volume(),"Source":"/var/lib/docker/volumes/fixture/_data","Destination":"/data","RW":true}]});
    let volume = json!({"Name":spec.volume(),"Driver":"local","Scope":"local","Mountpoint":"/var/lib/docker/volumes/fixture/_data","CreatedAt":"2026-09-14T00:00:00Z","Labels":spec.labels().unwrap(),"Options":{}});
    let network = json!({"Id":"network","Name":spec.network(),"Driver":"bridge","Internal":false,"EnableIPv6":false,"Labels":{OWNER_LABEL:spec.owner},"IPAM":{"Driver":"default","Config":[{"Subnet":spec.gateway.network_cidr,"Gateway":spec.gateway.bridge().unwrap()}]}});
    (spec, container, volume, network)
}
#[tokio::test]
async fn runtime_observation_preserves_identity_and_fails_closed_on_drift_or_partial_results() {
    let (spec, container, volume, network) = reference();
    let state = Arc::new(Mutex::new((
        Some(container),
        Some(volume),
        Some(network),
        false,
    )));
    let shared = state.clone();
    let fixture = Fixture::start(move |request| {
        assert_eq!(request.method, "GET", "observation mutated Docker");
        let state = shared.lock().unwrap();
        let (code, value) = if request.path == "/info" {
            (
                200,
                json!({"ID":"engine","DockerRootDir":"/var/lib/docker"}),
            )
        } else if request.path.starts_with("/containers/") {
            state
                .0
                .clone()
                .map(|v| (200, v))
                .unwrap_or((404, json!({"message":"missing"})))
        } else if request.path.starts_with("/volumes/") {
            if state.3 {
                (503, json!({"message":"failed"}))
            } else {
                state
                    .1
                    .clone()
                    .map(|v| (200, v))
                    .unwrap_or((404, json!({"message":"missing"})))
            }
        } else if request.path.starts_with("/networks/") {
            state
                .2
                .clone()
                .map(|v| (200, v))
                .unwrap_or((404, json!({"message":"missing"})))
        } else if request.path.starts_with("/images/") {
            (200, json!({"Id":"sha256:runtime","Config":{"Env":[]}}))
        } else {
            panic!("unexpected path {}", request.path)
        };
        Some((code, serde_json::to_vec(&value).unwrap()))
    })
    .await;
    let engine = fixture.engine_for(&spec.gateway.engine);
    let observed = engine.observe_runtime(&spec, "").await.unwrap().unwrap();
    assert_eq!(observed.id, "engine/container/2026-09-14T00:00:00Z/network");
    assert!(observed.running);
    let original = state.lock().unwrap().0.clone().unwrap();
    for pointer in [
        "/Config/Image",
        "/Config/Env",
        "/HostConfig/Privileged",
        "/HostConfig/Memory",
        "/HostConfig/RestartPolicy/Name",
        "/HostConfig/CapDrop",
        "/Mounts/0/Name",
        "/Config/Labels/nemoclaw.nvidia.com~1generation",
    ] {
        let mut changed = original.clone();
        *changed.pointer_mut(pointer).unwrap() = match pointer {
            "/HostConfig/Privileged" => json!(true),
            "/HostConfig/Memory" => json!(1),
            "/Config/Env" => json!(["UNDECLARED=1"]),
            "/HostConfig/CapDrop" => json!([]),
            _ => json!("drift"),
        };
        state.lock().unwrap().0 = Some(changed);
        assert!(
            engine.observe_runtime(&spec, &observed.id).await.is_err(),
            "{pointer}"
        );
    }
    state.lock().unwrap().0 = Some(original);
    state.lock().unwrap().3 = true;
    assert!(engine.observe_runtime(&spec, &observed.id).await.is_err());
    state.lock().unwrap().0 = None;
    assert!(engine.observe_removal(&spec, &observed.id).await.is_err());
    state.lock().unwrap().3 = false;
    assert!(engine.observe_runtime(&spec, &observed.id).await.is_err());
    assert!(matches!(
        engine.observe_runtime(&spec, "").await,
        Err(Error::PartialRuntime)
    ));
    assert!(
        engine
            .observe_removal(&spec, &observed.id)
            .await
            .unwrap()
            .is_none()
    );
    state.lock().unwrap().1 = None;
    assert!(engine.observe_runtime(&spec, "").await.unwrap().is_none());
}

#[test]
fn gateway_identity_includes_signing_key_and_persisted_encryption_key() {
    let base = "engine/container/created/network";
    let signing = b"public signing key";
    let key = [7_u8; 32];
    let signing_hash: String = Sha256::digest(signing)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    let key_hash: String = Sha256::digest(key)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    assert_eq!(
        gateway_identity(base, signing, &key).unwrap(),
        format!("{base}/{signing_hash}/{key_hash}")
    );
    assert!(gateway_identity(base, signing, &[]).is_err());
    assert!(gateway_identity(base, signing, b"short").is_err());
    assert!(gateway_identity(base, b"", &key).is_err());
    assert_ne!(
        gateway_identity(base, signing, &key).unwrap(),
        gateway_identity(base, signing, &[8; 32]).unwrap()
    );
}

#[tokio::test]
async fn invalid_managed_capacity_requests_fail_before_host_observation() {
    let (mut spec, _, _, _) = reference();
    spec.owner.clear();
    let fixture = Fixture::start(|_| panic!("invalid spec reached engine")).await;
    let engine = fixture.engine_for(&spec.gateway.engine);
    let error = engine.check_capacity(&spec, None).await.unwrap_err();
    assert!(matches!(error, Error::Conflict(_)));
}

#[tokio::test]
async fn capacity_requires_measurements_from_the_selected_execution_target() {
    use crate::hardware::{Capacity, GIB, HostObservation, HostObserver};
    struct Source(&'static str);
    #[async_trait::async_trait]
    impl HostObserver for Source {
        async fn observe(&self, _: &Engine) -> Result<HostObservation, Error> {
            if self.0 == "missing" {
                return Err(Error::State("remote host measurements unavailable"));
            }
            Ok(HostObservation {
                engine_id: if self.0 == "wrong" {
                    "wrong-daemon"
                } else {
                    "selected-daemon"
                }
                .into(),
                capacity: if self.0 == "incomplete" {
                    Capacity::default()
                } else {
                    Capacity {
                        architecture: "arm64".into(),
                        gpu: "NVIDIA GB10".into(),
                        driver_major: 580,
                        compute_capability: 121,
                        gpu_memory: None,
                        total: 128 * GIB,
                        available: 120 * GIB,
                        free: 110 * GIB,
                        disk_free: 1000 * GIB,
                        foreign_gpu_processes: 0,
                    }
                },
            })
        }
    }
    let (spec, _, _, _) = reference();
    let fixture = Fixture::start(|request| {
        assert_eq!(
            request.path, "/info",
            "invalid host observation reached artifact or resource operations"
        );
        Some((200, br#"{"ID":"selected-daemon"}"#.to_vec()))
    })
    .await;
    for available in ["missing", "wrong", "selected", "incomplete"] {
        let engine = fixture
            .engine_for(&spec.gateway.engine)
            .with_host_observer(std::sync::Arc::new(Source(available)));
        let result = engine.check_capacity(&spec, None).await;
        if available == "selected" {
            result.unwrap();
            continue;
        }
        let error = result.unwrap_err();
        if available == "wrong" {
            assert!(matches!(
                error,
                Error::Observation(ObservationError::BindingMismatch)
            ));
        } else if available == "missing" {
            assert_eq!(error.to_string(), "remote host measurements unavailable");
        } else {
            assert!(matches!(
                error,
                Error::State("GPU compute capability is unobservable")
            ));
        }
    }
}

#[test]
fn owned_volume_accepts_an_isolated_daemon_data_root() {
    let (spec, _, mut volume, _) = reference();
    volume["Mountpoint"] = json!("/srv/nemoclaw-fixture/docker/volumes/fixture/_data");
    let volume = serde_json::from_value(volume).unwrap();
    verify_volume(&spec, &volume, Some("/srv/nemoclaw-fixture/docker")).unwrap();
    for root in [
        None,
        Some("/var/lib/docker"),
        Some("relative"),
        Some("/srv/../docker"),
    ] {
        assert!(verify_volume(&spec, &volume, root).is_err());
    }
    let mut drifted: Volume = volume;
    drifted.mountpoint = "/srv/nemoclaw-fixture/docker/volumes/../foreign/_data".into();
    assert!(verify_volume(&spec, &drifted, Some("/srv/nemoclaw-fixture/docker")).is_err());
}

#[tokio::test]
async fn retired_gateway_process_layouts_fail_before_engine_access() {
    let fixtures: Vec<Value> = serde_json::from_str(include_str!("reference.json")).unwrap();
    let mut spec: Spec = serde_json::from_str(
        fixtures
            .iter()
            .find(|f| {
                serde_json::from_str::<Spec>(f["spec"].as_str().unwrap())
                    .unwrap()
                    .layout
                    == 2
            })
            .unwrap()["spec"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    let requests = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let count = requests.clone();
    let fixture = Fixture::start(move |_| {
        count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Some((503, br#"{"message":"unavailable"}"#.to_vec()))
    })
    .await;
    let engine = fixture.engine_for(&spec.gateway.engine);
    for layout in [0, 1] {
        spec.layout = layout;
        assert!(spec.container("/owned-data").is_err());
        assert!(engine.observe_runtime(&spec, "engine/bound").await.is_err());
        assert!(engine.ensure_runtime(&spec, "engine/bound").await.is_err());
        assert!(engine.replace_runtime(&spec, "engine/bound").await.is_err());
        assert!(engine.remove_runtime(&spec, "engine/bound").await.is_err());
        assert_eq!(requests.load(std::sync::atomic::Ordering::SeqCst), 0);
    }
}
