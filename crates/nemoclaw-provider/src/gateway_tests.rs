// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::*;
use crate::{docker::fixture::Fixture, gateway::GatewayReadinessDataSource};
use serde_json::json;
use std::{sync::atomic::AtomicUsize, time::Duration};
use tf_provider::DataSource;

#[tokio::test]
async fn exited_gateway_stops_readiness_without_waiting_for_a_stalled_api() {
    let references: Vec<serde_json::Value> =
        serde_json::from_str(include_str!("managed/reference.json")).unwrap();
    let mut spec: crate::managed::Spec =
        serde_json::from_str(references[0]["spec"].as_str().unwrap()).unwrap();
    let gateway = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    spec.gateway.endpoint = format!("http://{}", gateway.local_addr().unwrap());
    let name = spec.name.clone();
    let owner = spec.owner.clone();
    let reads = Arc::new(AtomicUsize::new(0));
    let count = reads.clone();
    let fixture = Fixture::engine(move |request| {
        assert_eq!(request.method, "GET");
        assert_eq!(request.path, "/containers/provider-gateway-id/json");
        count.fetch_add(1, Ordering::SeqCst);
        Some((
            200,
            serde_json::to_vec(&json!({
                "Id":"provider-gateway-id", "Name":format!("/{name}"),
                "Config":{"Labels":{"nemoclaw.nvidia.com/uid":owner}},
                "State":{"Running":false,"Status":"exited","ExitCode":42,
                    "Error":"PRIVATE_SENTINEL", "FinishedAt":"2026-09-29T00:00:00Z"}
            }))
            .unwrap(),
        ))
    })
    .await;
    let provider = NemoClawProvider::default();
    let mut diags = Diagnostics::default();
    // Readiness takes its gateway endpoint as an input, not from the provider.
    provider
        .configure(&mut diags, String::new(), ProviderConfig::default())
        .await
        .unwrap();
    let config = serde_json::from_value(json!({
        "engine":fixture.endpoint, "container_id":"provider-gateway-id",
        "name":spec.name, "owner":spec.owner, "endpoint":spec.gateway.endpoint,
        "wait_timeout_seconds":90, "read_trigger":true, "ready":null
    }))
    .unwrap();
    let source = GatewayReadinessDataSource(provider.backend.clone());
    let result = tokio::time::timeout(
        Duration::from_secs(2),
        DataSource::read(&source, &mut diags, config, ValueEmpty::default()),
    )
    .await
    .expect("an exited gateway must not wait for its API timeout");
    assert!(result.is_none());
    let message = format!("{diags:?}");
    assert!(message.contains(&spec.name), "{message}");
    assert!(message.contains("exit code 42"), "{message}");
    assert!(message.contains("docker logs"), "{message}");
    assert!(message.contains("resources retained"), "{message}");
    assert!(!message.contains("PRIVATE_SENTINEL"), "{message}");
    assert!(
        reads.load(Ordering::SeqCst) >= 2,
        "confirm stopped state across a restart race"
    );
}
