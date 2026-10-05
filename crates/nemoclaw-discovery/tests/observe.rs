// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
#![cfg(unix)]
use crate::transport;
use nemoclaw_discovery::{Direct, observe};
use nemoclaw_sdk::{
    CancellationToken, EnvironmentSecrets, Error,
    config::ComputeDriver,
    discovery::{DiscoveryObservation, DiscoveryQuery, DiscoveryRequest, ObservationStatus},
    fabric_capabilities::{FabricRequirements, Support},
};
use serde_json::json;

/// An arm64 engine holding an amd64 image.
async fn arm64_engine_with_an_amd64_image() -> transport::Fixture {
    transport::Fixture::start(|request| {
        let body = if request.path == "/info" {
            json!({"ID":"engine", "Architecture":"aarch64", "OSType":"linux"})
        } else {
            json!({"Id":"sha256:image", "Architecture":"amd64", "Os":"linux"})
        };
        Some((200, serde_json::to_vec(&body).unwrap()))
    })
    .await
}

fn image(endpoint: &str, platform: Option<DiscoveryRequest>) -> DiscoveryQuery {
    DiscoveryQuery::Fabric {
        engine: endpoint.into(),
        image: "runtime:test".into(),
        requirements: FabricRequirements::default(),
        platform,
    }
}

fn platform_check(observation: Option<&DiscoveryObservation>) -> Option<Support> {
    let Some(DiscoveryObservation::Fabric(fabric)) = observation else {
        panic!("the image read is recorded");
    };
    fabric
        .compatibility
        .as_ref()
        .expect("an image is judged against its requirements")
        .checks
        .iter()
        .find(|check| check.requirement == "image_architecture")
        .map(|check| check.status)
}

#[tokio::test]
async fn an_image_is_judged_on_its_platform_engine_and_only_when_it_names_one() {
    let fixture = arm64_engine_with_an_amd64_image().await;
    let platform = DiscoveryRequest {
        engine: fixture.endpoint.clone(),
        compute_driver: ComputeDriver::Docker,
    };
    let on_platform = image(&fixture.endpoint, Some(platform.clone()));
    let without = image(&fixture.endpoint, None);
    let observed = observe(
        &[on_platform.clone(), without.clone()],
        &Direct,
        &EnvironmentSecrets,
        &CancellationToken::new(),
    )
    .await
    .unwrap();
    assert_eq!(
        platform_check(observed.get(&on_platform)),
        Some(Support::Unsupported)
    );
    // An external gateway's image store does not establish its platform.
    assert_eq!(platform_check(observed.get(&without)), None);
    // The platform's engine read serves the image; it is recorded only when asked.
    assert!(!observed.contains(&DiscoveryQuery::Engine(platform)));
}

#[tokio::test]
async fn a_read_that_fails_is_unknown_and_every_distinct_query_is_answered() {
    let engine = DiscoveryQuery::Engine(DiscoveryRequest {
        engine: "unix:///missing-engine.sock".into(),
        compute_driver: ComputeDriver::Docker,
    });
    let hardware = DiscoveryQuery::Hardware {
        engine: "unix:///missing-engine.sock".into(),
    };
    let observed = observe(
        &[engine.clone(), hardware.clone(), engine.clone()],
        &Direct,
        &EnvironmentSecrets,
        &CancellationToken::new(),
    )
    .await
    .unwrap();
    assert!(matches!(
        observed.get(&engine),
        Some(DiscoveryObservation::Engine(observed)) if observed.status == ObservationStatus::Unknown
    ));
    assert!(matches!(
        observed.get(&hardware),
        Some(DiscoveryObservation::Hardware(observed)) if observed.status == ObservationStatus::Unknown
    ));
    assert!(observed.missing(&[engine, hardware]).is_empty());
}

#[tokio::test]
async fn cancellation_abandons_the_reads() {
    // The engine never answers, so only cancellation can end the read early.
    let fixture = transport::Fixture::start(|_| None).await;
    let cancel = CancellationToken::new();
    cancel.cancel();
    let result = observe(
        &[DiscoveryQuery::Hardware {
            engine: fixture.endpoint.clone(),
        }],
        &Direct,
        &EnvironmentSecrets,
        &cancel,
    )
    .await;
    assert!(matches!(result, Err(Error::Cancelled)));
}
