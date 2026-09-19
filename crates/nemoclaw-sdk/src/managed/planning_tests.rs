// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::Spec;
use crate::{
    Error, ObservationError,
    backend::{Backend, Row},
    compile,
    config::Document,
    docker::{Connections, Engine, fixture::Fixture},
    hardware::{Capacity, GIB, HostObservation, HostObserver},
    services::BackendRegistry,
};
use serde_json::{Value, json};
use std::sync::Arc;

struct Host(bool);
#[async_trait::async_trait]
impl HostObserver for Host {
    async fn observe(&self, _: &Engine) -> Result<HostObservation, Error> {
        if self.0 {
            return Err(ObservationError::Transport.into());
        }
        Ok(HostObservation {
            engine_id: "selected-engine".into(),
            capacity: Capacity {
                architecture: "arm64".into(),
                gpu: "NVIDIA GB10".into(),
                compute_capability: 121,
                driver_major: 570,
                total: 128 * GIB,
                available: 120 * GIB,
                disk_free: 500 * GIB,
                ..Default::default()
            },
        })
    }
}

struct OccupiedHost;
#[async_trait::async_trait]
impl HostObserver for OccupiedHost {
    async fn observe(&self, _: &Engine) -> Result<HostObservation, Error> {
        Ok(HostObservation {
            engine_id: "selected-engine".into(),
            capacity: Capacity {
                architecture: "arm64".into(),
                gpu: "NVIDIA GB10".into(),
                compute_capability: 121,
                driver_major: 610,
                total: 128 * GIB,
                available: 0,
                disk_free: 0,
                ..Default::default()
            },
        })
    }
}

#[tokio::test]
async fn replacement_creation_plan_checks_hardware_without_requiring_resources_to_be_released() {
    // OpenTofu plans a replacement again with null prior state while the old
    // process still owns its memory. Startup headroom must be checked later.
    let document =
        Document::parse(include_bytes!("../../../../examples/spark/vllm.yaml").as_slice()).unwrap();
    let generations = [
        ("managed_gateway".into(), "a".repeat(32)),
        ("inference_service".into(), "b".repeat(32)),
    ]
    .into();
    let target = compile::runtime_targets(&document, &generations)
        .unwrap()
        .into_iter()
        .find(|target| target.kind == "inference_service")
        .unwrap();
    let spec: Spec = serde_json::from_str(&target.values["spec"]).unwrap();
    let fixture = planning_fixture((200, network(&spec)), json!([]), (200, image(&spec))).await;
    let connections = Connections::fixed([fixture
        .engine_for(spec.engine())
        .with_host_observer(Arc::new(OccupiedHost))])
    .unwrap();
    let backend = BackendRegistry::new(&connections)
        .resolve(&target.kind, &target.values)
        .unwrap()
        .unwrap();
    backend
        .plan(&target.kind, &target.values, None)
        .await
        .unwrap();
}

#[tokio::test]
async fn planning_observes_the_selected_engine_and_rejects_hardware_without_mutations() {
    let fixture = Fixture::start(|request| {
        assert_eq!(request.method, "GET", "planning mutated Docker");
        let (status, body) = if request.path == "/info" {
            (
                200,
                json!({"ID":"selected-engine", "DockerRootDir":"/var/lib/docker"}),
            )
        } else {
            (404, json!({"message":"absent"}))
        };
        Some((status, serde_json::to_vec(&body).unwrap()))
    })
    .await;
    for source in [
        include_bytes!("../../../../examples/spark/vllm.yaml").as_slice(),
        include_bytes!("../../../../examples/managed-ollama-gpu.yaml").as_slice(),
    ] {
        let document = Document::parse(source).unwrap();
        let generations = [
            ("managed_gateway".into(), "a".repeat(32)),
            ("inference_service".into(), "b".repeat(32)),
            ("ollama_service".into(), "c".repeat(32)),
        ]
        .into();
        let target = compile::runtime_targets(&document, &generations)
            .unwrap()
            .into_iter()
            .find(|target| matches!(target.kind.as_str(), "inference_service" | "ollama_service"))
            .unwrap();
        let spec: Spec = serde_json::from_str(&target.values["spec"]).unwrap();
        for unavailable in [false, true] {
            let connections = Connections::fixed([fixture
                .engine_for(spec.engine())
                .with_host_observer(Arc::new(Host(unavailable)))])
            .unwrap();
            let backend = BackendRegistry::new(&connections)
                .resolve(&target.kind, &target.values)
                .unwrap()
                .unwrap();
            let error = backend
                .plan(&target.kind, &target.values, None)
                .await
                .unwrap_err();
            assert_eq!(
                error.to_string(),
                if unavailable {
                    "observation transport failed"
                } else {
                    "hardware.minDriverMajor requires at least 580; observed 570"
                }
            );
        }
    }
}

fn runtime_specs() -> Vec<Spec> {
    let mut specs = Vec::new();
    for (source, port) in [
        (include_str!("../../../../examples/spark/vllm.yaml"), 18898),
        (
            include_str!("../../../../examples/managed-ollama-gpu.yaml"),
            18888,
        ),
    ] {
        for independent in [false, true] {
            let source = if independent {
                source.replace(
                    "        engine: unix:///var/run/docker.sock",
                    "        engine: ssh://worker@inference.example",
                ).replace(
                    "      model:\n",
                    &format!("      placement:\n        networkCidr: 172.30.119.0/24\n      publication:\n        endpoint: http://10.0.0.8:{port}/v1\n        bindAddress: 10.0.0.8\n      model:\n"),
                )
            } else {
                source.to_owned()
            };
            let document = Document::parse(source.as_bytes()).unwrap();
            let generations = [
                ("managed_gateway".into(), "a".repeat(32)),
                ("inference_service".into(), "b".repeat(32)),
                ("ollama_service".into(), "c".repeat(32)),
            ]
            .into();
            for target in compile::runtime_targets(&document, &generations).unwrap() {
                if matches!(target.kind.as_str(), "inference_service" | "ollama_service")
                    || (target.kind == super::GATEWAY_KIND && specs.is_empty())
                {
                    specs.push(serde_json::from_str(&target.values["spec"]).unwrap());
                }
            }
        }
    }
    assert_eq!(specs.len(), 5);
    specs
}

fn network(spec: &Spec) -> Value {
    json!({
        "Id":"network", "Name":spec.network(), "Driver":"bridge",
        "Internal":false, "EnableIPv6":false, "Labels":spec.labels().unwrap(),
        "IPAM":{"Driver":"default", "Config":[{
            "Subnet":spec.network_cidr(), "Gateway":spec.bridge().unwrap()
        }]}
    })
}

fn image(spec: &Spec) -> Value {
    json!({
        "Id":"sha256:runtime", "Os":"linux", "Architecture":"arm64",
        "Config":{"Labels":spec.process.as_ref().map(|process| &process.image_labels)}
    })
}

async fn planning_fixture(network: (u16, Value), inventory: Value, image: (u16, Value)) -> Fixture {
    Fixture::start(move |request| {
        assert_eq!(request.method, "GET", "planning mutated the engine");
        let response = match request.path.split('?').next().unwrap() {
            "/info" => (
                200,
                json!({"ID":"selected-engine", "Architecture":"aarch64"}),
            ),
            "/networks" => (200, inventory.clone()),
            path if path.starts_with("/networks/") => network.clone(),
            path if path.starts_with("/images/") => image.clone(),
            _ => panic!("unexpected planning observation {}", request.path),
        };
        Some((response.0, serde_json::to_vec(&response.1).unwrap()))
    })
    .await
}

async fn plan_runtime(
    fixture: &Fixture,
    spec: &Spec,
    policy: &str,
    update: bool,
) -> Result<(), Error> {
    let connections = Connections::fixed([fixture
        .engine_for(spec.engine())
        .with_host_observer(Arc::new(OccupiedHost))])
    .unwrap();
    let desired = Row::from([
        ("spec".into(), serde_json::to_string(spec).unwrap()),
        ("image_pull_policy".into(), policy.into()),
    ]);
    let mut prior = desired.clone();
    prior.insert("id".into(), "retained-runtime".into());
    BackendRegistry::new(&connections)
        .resolve(&spec.kind, &desired)
        .unwrap()
        .unwrap()
        .plan(&spec.kind, &desired, update.then_some(&prior))
        .await
}

#[tokio::test]
async fn planning_checks_network_ownership_configuration_and_observation_failures() {
    for spec in runtime_specs() {
        let owned = network(&spec);
        let mut foreign = owned.clone();
        foreign["Labels"][super::OWNER_LABEL] = json!("another-deployment");
        let mut drifted = owned.clone();
        drifted["IPAM"]["Config"][0]["Subnet"] = json!("10.99.0.0/24");
        for (response, expected) in [
            ((200, owned), None),
            (
                (200, foreign),
                Some("managed bridge identity, ownership or configuration drifted"),
            ),
            (
                (200, drifted),
                Some("managed bridge identity, ownership or configuration drifted"),
            ),
            ((200, json!({})), Some("observation is incomplete")),
            (
                (401, json!({"message":"PRIVATE_SENTINEL"})),
                Some("observation authentication failed"),
            ),
            (
                (500, json!({"message":"PRIVATE_SENTINEL"})),
                Some("observation transport failed"),
            ),
        ] {
            let fixture = planning_fixture(response, json!([]), (200, image(&spec))).await;
            for update in [false, true] {
                let result = plan_runtime(&fixture, &spec, "Never", update).await;
                assert_eq!(
                    result.err().map(|error| error.to_string()).as_deref(),
                    expected,
                    "{}, update={update}",
                    spec.kind
                );
            }
        }
    }
}

#[tokio::test]
async fn planning_checks_subnet_conflicts_and_defers_absent_shared_networks() {
    for spec in runtime_specs() {
        let creates_network =
            spec.kind == super::GATEWAY_KIND || spec.process.as_ref().unwrap().create_network;
        for conflict in [false, true] {
            let inventory = if conflict {
                json!([{"IPAM":{"Config":[{"Subnet":spec.network_cidr()}]}}])
            } else {
                json!([])
            };
            let fixture = planning_fixture((404, json!({})), inventory, (200, image(&spec))).await;
            let result = plan_runtime(&fixture, &spec, "Never", false).await;
            if creates_network && conflict {
                assert!(
                    matches!(
                        result,
                        Err(Error::Conflict(
                            "managed gateway subnet overlaps an existing Docker network"
                        ))
                    ),
                    "{result:?}"
                );
            } else {
                result.unwrap();
            }
            if !creates_network {
                assert!(matches!(
                    fixture
                        .engine_for(spec.engine())
                        .ensure_network(&spec)
                        .await,
                    Err(Error::Conflict("managed gateway network is absent"))
                ));
            }
        }
    }
}

#[tokio::test]
async fn planning_inspects_images_without_pulling_and_honors_the_resource_pull_policy() {
    for spec in runtime_specs() {
        for policy in ["", "Always", "IfNotPresent", "Never"] {
            for present in [false, true] {
                let response = if present {
                    (200, image(&spec))
                } else {
                    (404, json!({}))
                };
                let fixture = planning_fixture((200, network(&spec)), json!([]), response).await;
                for update in [false, true] {
                    let result = plan_runtime(&fixture, &spec, policy, update).await;
                    let may_pull = matches!(policy, "Always" | "IfNotPresent")
                        || (policy.is_empty()
                            && spec
                                .process
                                .as_ref()
                                .is_none_or(|process| process.pull_image));
                    if present || may_pull {
                        result.unwrap();
                    } else {
                        assert!(
                            matches!(
                                result,
                                Err(Error::Conflict(
                                    "image is absent from the selected engine and imagePullPolicy is Never; load the pinned image there or allow pulling"
                                ))
                            ),
                            "{}, policy={policy}: {result:?}",
                            spec.kind
                        );
                    }
                }
            }
        }
    }
}

#[tokio::test]
async fn planning_rejects_incompatible_and_unreadable_images_even_when_pulling_is_allowed() {
    for spec in runtime_specs() {
        for change in [
            json!({"Architecture":"amd64"}),
            json!({"Os":"windows"}),
            json!({"Id":""}),
            json!({"Config":{"Labels":{}}}),
        ] {
            if spec.process.is_none() && change.get("Config").is_some() {
                continue;
            }
            let mut incompatible = image(&spec);
            for (key, value) in change.as_object().unwrap() {
                incompatible[key] = value.clone();
            }
            let fixture =
                planning_fixture((200, network(&spec)), json!([]), (200, incompatible)).await;
            for policy in ["Always", "IfNotPresent", "Never"] {
                let result = plan_runtime(&fixture, &spec, policy, false).await;
                assert!(
                    matches!(result, Err(Error::Conflict(_))),
                    "{}, {policy}: {result:?}",
                    spec.kind
                );
            }
        }
        for (code, expected) in [
            (401, "observation authentication failed"),
            (500, "observation transport failed"),
        ] {
            let fixture = planning_fixture(
                (200, network(&spec)),
                json!([]),
                (code, json!({"message":"PRIVATE_SENTINEL"})),
            )
            .await;
            let error = plan_runtime(&fixture, &spec, "IfNotPresent", false)
                .await
                .unwrap_err();
            assert_eq!(error.to_string(), expected);
        }
    }
}
