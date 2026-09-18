// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::*;
use crate::docker::{Connections, fixture::Fixture};

fn gateway_targets() -> (Spec, Vec<Target>) {
    let fixtures: Vec<Value> =
        serde_json::from_str(include_str!("../../managed/reference.json")).unwrap();
    let mut spec: Spec = serde_json::from_str(fixtures[0]["spec"].as_str().unwrap()).unwrap();
    spec.gateway.network_cidr = "172.30.161.0/24".into();
    let mut targets = Vec::new();
    for (kind, address, layout) in [
        (GATEWAY_STORAGE_KIND, GATEWAY_STORAGE, 0),
        (GATEWAY_KIND, GATEWAY, 2),
    ] {
        spec.layout = layout;
        targets.push(Target {
            kind: kind.into(),
            address: address.into(),
            values: [("spec".into(), spec.json().unwrap())].into(),
        });
    }
    (spec, targets)
}

#[tokio::test]
async fn runtime_validation_rejects_overlapping_subnets_without_mutating_engine() {
    for subnet in ["172.30.161.0/24", "172.30.0.0/16", "172.30.161.128/25"] {
        let (spec, targets) = gateway_targets();
        let fixture = absent_runtime(
            200,
            json!([{"Name":"foreign","IPAM":{"Config":[{"Subnet":subnet}]}}]),
        )
        .await;
        let engines = Connections::fixed([fixture.engine_for(spec.engine())]).unwrap();
        let result = validate_runtime_environment(&engines, &targets, &BTreeMap::new()).await;
        assert!(
            matches!(
                result,
                Err(Error::Conflict(
                    "managed gateway subnet overlaps an existing Docker network"
                ))
            ),
            "overlap with {subnet} was not rejected"
        );
    }
}

async fn absent_runtime(status: u16, networks: Value) -> Fixture {
    Fixture::start(move |request| {
        assert_eq!(
            request.method, "GET",
            "runtime validation mutated the engine"
        );
        let (status, body) = match request.path.split('?').next().unwrap() {
            "/info" => (
                200,
                json!({"ID":"engine","DockerRootDir":"/var/lib/docker"}),
            ),
            "/networks" => (status, networks.clone()),
            _ => (404, json!({"message":"missing"})),
        };
        Some((status, serde_json::to_vec(&body).unwrap()))
    })
    .await
}

#[tokio::test]
async fn runtime_validation_allows_disjoint_networks_and_propagates_inventory_failure() {
    let (spec, targets) = gateway_targets();
    for networks in [
        json!([]),
        json!([
            {"IPAM":{"Config":[{"Subnet":"172.30.160.0/24"},{"Subnet":"172.30.162.0/24"}]}},
            {"IPAM":{"Config":[{"Subnet":"fd00::/64"}]}},
            {"Name":"host","IPAM":{"Config":[]}}
        ]),
    ] {
        let fixture = absent_runtime(200, networks).await;
        let engines = Connections::fixed([fixture.engine_for(spec.engine())]).unwrap();
        assert!(
            validate_runtime_environment(&engines, &targets, &BTreeMap::new())
                .await
                .is_ok()
        );
    }
    let fixture = absent_runtime(403, json!({"message":"denied"})).await;
    let engines = Connections::fixed([fixture.engine_for(spec.engine())]).unwrap();
    assert!(matches!(
        validate_runtime_environment(&engines, &targets, &BTreeMap::new()).await,
        Err(Error::Observation(ObservationError::Permission))
    ));
}

#[tokio::test]
async fn runtime_validation_checks_the_remote_service_network_on_its_selected_engine() {
    let document = Document::parse(
        include_bytes!("../../../../../examples/spark/remote-vllm.yaml").as_slice(),
    )
    .unwrap();
    let record = Record::new(document.clone()).unwrap();
    let targets = compile::runtime_targets(&document, &record.generations).unwrap();
    let fixture = absent_runtime(
        200,
        json!([{"IPAM":{"Config":[{"Subnet":"172.30.119.0/24"}]}}]),
    )
    .await;
    // No local engine is supplied: this must observe the SSH-selected engine.
    let engines = Connections::fixed([fixture.engine_for("ssh://gpu-box")]).unwrap();
    assert!(matches!(
        validate_runtime_environment(&engines, &targets, &BTreeMap::new()).await,
        Err(Error::Conflict(
            "managed gateway subnet overlaps an existing Docker network"
        ))
    ));
}
