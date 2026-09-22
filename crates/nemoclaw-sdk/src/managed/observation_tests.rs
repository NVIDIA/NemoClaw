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
async fn service_readiness_observes_only_the_provider_container_identity() {
    let (spec, _, _, _) = reference();
    let state = Arc::new(Mutex::new((
        200,
        json!({"Id":"current-container","Name":format!("/{}",spec.name),
            "State":{"Running":true,"StartedAt":"2026-09-14T00:00:00Z"}}),
    )));
    let shared = state.clone();
    let fixture = Fixture::start(move |request| {
        assert_eq!(request.method, "GET", "readiness must never mutate Docker");
        assert!(
            matches!(
                request.path.as_str(),
                "/containers/current-container/json" | "/containers/replacement-container/json"
            ),
            "readiness must not collect unrelated host, image, network, or storage state: {}",
            request.path
        );
        let (status, response) = &*shared.lock().unwrap();
        Some((*status, serde_json::to_vec(response).unwrap()))
    })
    .await;
    let engine = fixture.engine_for(spec.engine());
    let observed = engine
        .observe_service(&spec, "current-container")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(observed.id, "current-container");
    assert_eq!(observed.container_id, "current-container");
    assert_eq!(observed.data_path, "/data");
    assert!(observed.running);
    assert_eq!(observed.started_at, "2026-09-14T00:00:00Z");

    *state.lock().unwrap() = (404, json!({"message":"absent"}));
    assert!(
        engine
            .observe_service(&spec, "current-container")
            .await
            .unwrap()
            .is_none()
    );
    // A later explicit provider apply may replace disposable compute. Readiness
    // accepts the newly recorded ID without requiring an earlier physical ID.
    *state.lock().unwrap() = (
        200,
        json!({"Id":"replacement-container","Name":format!("/{}",spec.name),
        "State":{"Running":false,"StartedAt":"2026-09-15T00:00:00Z"}}),
    );
    let replacement = engine
        .observe_service(&spec, "replacement-container")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(replacement.id, "replacement-container");
    assert!(!replacement.running);
    assert!(
        engine
            .observe_service(&spec, "current-container")
            .await
            .is_err(),
        "an inspect response must match the requested provider ID"
    );
    state.lock().unwrap().1["Name"] = json!("/other-service");
    assert!(
        engine
            .observe_service(&spec, "replacement-container")
            .await
            .is_err()
    );
    state.lock().unwrap().1["Name"] = json!(format!("/{}", spec.name));
    for incomplete in [
        json!({"Running":true}),
        json!({"StartedAt":"2026-09-15T00:00:00Z"}),
    ] {
        state.lock().unwrap().1["State"] = incomplete;
        assert!(
            engine
                .observe_service(&spec, "replacement-container")
                .await
                .is_err()
        );
    }
    *state.lock().unwrap() = (503, json!({"message":"unavailable"}));
    assert!(
        engine
            .observe_service(&spec, "replacement-container")
            .await
            .is_err()
    );
    assert!(engine.observe_service(&spec, "").await.is_err());
}

#[tokio::test]
async fn managed_installers_accept_current_runtime_readiness_without_collecting_model_files() {
    for source in [
        include_str!("../../tests/fixtures/config/spark.yaml"),
        include_str!("../../tests/fixtures/config/managed-ollama.yaml"),
    ] {
        let document = crate::config::Document::parse(source.as_bytes()).unwrap();
        let generations: crate::compile::Generations = ["inference_service", "ollama_service"]
            .map(|kind| (kind.into(), "a".repeat(32)))
            .into();
        let plans = crate::services::install_plans(
            &document,
            &generations,
            crate::services::InstallStage::Runtime,
        )
        .unwrap();
        let target = plans
            .targets()
            .find(|target| matches!(target.kind.as_str(), "inference_service" | "ollama_service"))
            .unwrap();
        let spec: Spec = serde_json::from_str(&target.values["spec"]).unwrap();
        let name = spec.name.clone();
        let status = Arc::new(Mutex::new(
            json!({"phase":"ready","updated":"2026-09-15T00:00:01Z","detail":"","pid":42}),
        ));
        let shared = status.clone();
        let fixture = Fixture::start(move |request| {
            assert_eq!(request.method, "GET");
            if request.path == "/containers/provider-container/json" {
                return Some((
                    200,
                    serde_json::to_vec(
                        &json!({"Id":"provider-container","Name":format!("/{name}"),
                    "State":{"Running":true,"StartedAt":"2026-09-15T00:00:00Z"}}),
                    )
                    .unwrap(),
                ));
            }
            assert!(
                request
                    .path
                    .starts_with("/containers/provider-container/archive?")
                    && request.path.contains("status.json"),
                "runtime owns model startup and artifact readiness, unexpected collector: {}",
                request.path
            );
            Some((
                200,
                crate::docker::archive(&[(
                    "status.json",
                    &serde_json::to_vec(&*shared.lock().unwrap()).unwrap(),
                    0o600,
                )])
                .unwrap(),
            ))
        })
        .await;
        let connections =
            crate::docker::Connections::fixed([fixture.engine_for(spec.engine())]).unwrap();
        let bindings = BTreeMap::from([(
            crate::docker_compute::address(&target.address),
            crate::state::StateBinding {
                id: "provider-container".into(),
                spec: String::new(),
            },
        )]);
        assert!(
            crate::services::required_storage_address(
                &document,
                &generations,
                &crate::docker_compute::address(&target.address),
            )
            .unwrap()
            .is_none(),
            "unauthenticated compute must not require immutable cache identity"
        );
        let cancel = crate::CancellationToken::new();
        crate::services::check_running(
            &document,
            &generations,
            crate::services::InstallStage::Runtime,
            &connections,
            &bindings,
            &cancel,
        )
        .await
        .unwrap();
        status.lock().unwrap()["phase"] = json!("stopped");
        assert!(
            crate::services::check_running(
                &document,
                &generations,
                crate::services::InstallStage::Runtime,
                &connections,
                &bindings,
                &cancel
            )
            .await
            .is_err()
        );
    }
}
#[tokio::test]
async fn gateway_observation_preserves_identity_and_fails_closed_on_drift_or_partial_results() {
    let fixtures: Vec<Value> = serde_json::from_str(include_str!("reference.json")).unwrap();
    let data = &fixtures[0];
    let spec: Spec = serde_json::from_str(data["spec"].as_str().unwrap()).unwrap();
    let launch = serde_json::to_value(
        spec.container("/var/lib/docker/volumes/fixture/_data")
            .unwrap(),
    )
    .unwrap();
    let mut config = launch.clone();
    config.as_object_mut().unwrap().remove("HostConfig");
    config.as_object_mut().unwrap().remove("NetworkingConfig");
    let mut host = launch["HostConfig"].clone();
    host["Privileged"] = json!(false);
    let container = json!({"Id":"container","Name":format!("/{}",spec.name),"Image":"sha256:runtime","Config":config,"HostConfig":host,"NetworkSettings":{"Networks":{spec.network():{"IPAddress":spec.gateway_address().unwrap()}}},"State":{"Running":true},"Mounts":[{"Type":"volume","Name":spec.volume(),"Destination":"/var/lib/docker/volumes/fixture/_data","RW":true},{"Type":"bind","Source":"/var/run/docker.sock","Destination":"/var/run/docker.sock","RW":true}]});
    let volume = json!({"Name":spec.volume(),"Driver":"local","Scope":"local","Mountpoint":"/var/lib/docker/volumes/fixture/_data","CreatedAt":"2026-09-14T00:00:00Z","Labels":spec.labels().unwrap(),"Options":{}});
    let network = json!({"Id":"network","Name":spec.network(),"Driver":"bridge","Internal":false,"EnableIPv6":false,"Labels":spec.labels().unwrap(),"IPAM":{"Driver":"default","Config":[{"Subnet":spec.network_cidr(),"Gateway":spec.bridge().unwrap()}]}});
    let gateway_config = spec.gateway_config("/var/lib/docker/volumes/fixture/_data");
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
        if request.path.contains("/archive?") {
            let url = url::Url::parse(&format!("http://fixture{}", request.path)).unwrap();
            let path = url
                .query_pairs()
                .find(|(key, _)| key == "path")
                .unwrap()
                .1
                .into_owned();
            let bytes = if path.ends_with("gateway.toml") {
                gateway_config.as_bytes().to_vec()
            } else if path.ends_with("public.pem") {
                b"public".to_vec()
            } else if path.ends_with("key-encryption-key.bin") {
                vec![7; 32]
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
        }
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
            (
                200,
                json!({
                    "Id":"sha256:runtime",
                    "Architecture":"arm64",
                    "Os":"linux",
                    "Config":{"Env":[],"Labels":{}}
                }),
            )
        } else {
            panic!("unexpected path {}", request.path)
        };
        Some((code, serde_json::to_vec(&value).unwrap()))
    })
    .await;
    let engine = fixture.engine_for(&spec.gateway.engine);
    let observed = engine.observe_gateway(&spec, "").await.unwrap().unwrap();
    assert!(
        observed
            .id
            .starts_with("engine/container/2026-09-14T00:00:00Z/network/")
    );
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
            engine.observe_gateway(&spec, &observed.id).await.is_err(),
            "{pointer}"
        );
    }
    let mut changed = original.clone();
    changed["NetworkSettings"]["Networks"][spec.network()]["IPAddress"] =
        json!(spec.bridge().unwrap());
    state.lock().unwrap().0 = Some(changed);
    assert!(engine.observe_gateway(&spec, &observed.id).await.is_err());
    state.lock().unwrap().0 = Some(original);
    state.lock().unwrap().3 = true;
    assert!(engine.observe_gateway(&spec, &observed.id).await.is_err());
    state.lock().unwrap().0 = None;
    assert!(
        engine
            .observe_gateway_removal(&spec, &observed.id)
            .await
            .is_err()
    );
    state.lock().unwrap().3 = false;
    assert!(engine.observe_gateway(&spec, &observed.id).await.is_err());
    assert!(matches!(
        engine.observe_gateway(&spec, "").await,
        Err(Error::PartialRuntime)
    ));
    assert!(
        engine
            .observe_gateway_removal(&spec, &observed.id)
            .await
            .unwrap()
            .is_none()
    );
    state.lock().unwrap().1 = None;
    state.lock().unwrap().2 = None;
    assert!(engine.observe_gateway(&spec, "").await.unwrap().is_none());
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
        assert!(engine.observe_gateway(&spec, "engine/bound").await.is_err());
        assert!(engine.ensure_gateway(&spec, "engine/bound").await.is_err());
        assert!(engine.replace_gateway(&spec, "engine/bound").await.is_err());
        assert!(engine.remove_gateway(&spec, "engine/bound").await.is_err());
        assert_eq!(requests.load(std::sync::atomic::Ordering::SeqCst), 0);
    }
}

#[tokio::test]
async fn authenticated_vllm_readiness_rechecks_key_permissions() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    for valid in [false, true] {
        let directory = tempfile::tempdir().unwrap();
        let socket = directory.path().join("docker.sock");
        let listener = tokio::net::UnixListener::bind(&socket).unwrap();
        let source = include_str!("../../tests/fixtures/config/spark.yaml")
            .replace(
                "unix:///var/run/docker.sock",
                &format!("unix://{}", socket.display()),
            )
            .replace("kind: vllm", "kind: vllm\n      authentication: bearer");
        let document = crate::config::Document::parse(source.as_bytes()).unwrap();
        let generations = [("inference_service".into(), "a".repeat(32))].into();
        let plans = crate::services::install_plans(
            &document,
            &generations,
            crate::services::InstallStage::Runtime,
        )
        .unwrap();
        let target = plans
            .targets()
            .find(|t| t.kind == "inference_service")
            .unwrap();
        let spec: Spec = serde_json::from_str(&target.values["spec"]).unwrap();
        let container = serde_json::to_vec(&json!({"Id":"provider-container","Name":format!("/{}", spec.name),"State":{"Running":true,"StartedAt":"2026-09-15T00:00:00Z"}})).unwrap();
        let status = crate::docker::archive(&[(
            "status.json",
            br#"{"phase":"ready","updated":"2026-09-15T00:00:01Z","detail":"","pid":42}"#,
            0o600,
        )])
        .unwrap();
        let metadata = if valid {
            "eyJuYW1lIjogImluZmVyZW5jZS1rZXkiLCAic2l6ZSI6IDY0LCAibW9kZSI6IDM4NCwgIm10aW1lIjogIjIwMjYtMDktMTlUMDA6MDA6MDBaIiwgImxpbmtUYXJnZXQiOiAiIn0="
        } else {
            "eyJuYW1lIjogImluZmVyZW5jZS1rZXkiLCAic2l6ZSI6IDY0LCAibW9kZSI6IDQyMCwgIm10aW1lIjogIjIwMjYtMDktMTlUMDA6MDA6MDBaIiwgImxpbmtUYXJnZXQiOiAiIn0="
        };
        let server = tokio::spawn(async move {
            loop {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                while !request.ends_with(b"\r\n\r\n") {
                    request.push(stream.read_u8().await.unwrap());
                }
                let request = String::from_utf8(request).unwrap();
                let (body, header) = if request
                    .starts_with("GET /containers/provider-container/json")
                {
                    (container.clone(), String::new())
                } else if request.contains("status.json") {
                    (status.clone(), String::new())
                } else if request.starts_with("HEAD ") && request.contains("inference-key") {
                    (
                        vec![],
                        format!("X-Docker-Container-Path-Stat: {metadata}\r\n"),
                    )
                } else {
                    assert!(
                        request.starts_with("GET ") && request.contains("inference-key"),
                        "{request}"
                    );
                    (
                        crate::docker::archive(&[("inference-key", &[b'a'; 64], 0o600)]).unwrap(),
                        String::new(),
                    )
                };
                stream.write_all(format!("HTTP/1.1 200 OK\r\n{header}Content-Length: {}\r\nConnection: close\r\n\r\n",body.len()).as_bytes()).await.unwrap();
                stream.write_all(&body).await.unwrap();
            }
        });
        let engine = Engine::connect(spec.engine()).unwrap();
        let connections = crate::docker::Connections::fixed([engine]).unwrap();
        let bindings = [(
            crate::docker_compute::address(&target.address),
            crate::state::StateBinding {
                id: "provider-container".into(),
                spec: String::new(),
            },
        )]
        .into();
        let result = crate::services::check_running(
            &document,
            &generations,
            crate::services::InstallStage::Runtime,
            &connections,
            &bindings,
            &crate::CancellationToken::new(),
        )
        .await;
        server.abort();
        assert_eq!(
            result.is_ok(),
            valid,
            "credential mode must be checked even when runtime is ready: {result:?}"
        );
    }
}
