// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::Spec;
use crate::{
    Error,
    backend::{Backend, Row},
    compile,
    config::Document,
    docker::{Connections, fixture::Fixture},
    services::BackendRegistry,
};
use serde_json::{Value, json};

fn runtime_specs() -> Vec<Spec> {
    let document =
        Document::parse(include_bytes!("../../../../examples/spark/vllm.yaml").as_slice()).unwrap();
    let generations = [
        ("managed_gateway".into(), "a".repeat(32)),
        ("inference_service".into(), "b".repeat(32)),
    ]
    .into();
    compile::runtime_targets(&document, &generations)
        .unwrap()
        .into_iter()
        .filter(|target| target.kind == super::GATEWAY_KIND)
        .map(|target| serde_json::from_str(&target.values["spec"]).unwrap())
        .collect()
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
            path if path.starts_with("/containers/") => (404, json!({"message":"absent"})),
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
    let connections = Connections::fixed([fixture.engine_for(spec.engine())]).unwrap();
    let desired = Row::from([
        ("spec".into(), serde_json::to_string(spec).unwrap()),
        ("image_pull_policy".into(), policy.into()),
    ]);
    let mut prior = desired.clone();
    prior.insert(
        "id".into(),
        "selected-engine/container/created/network".into(),
    );
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
