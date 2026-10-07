// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
#![cfg(unix)]
use crate::transport;
use nemoclaw_discovery::{Direct, observe};
use nemoclaw_sdk::{
    CancellationToken, EnvironmentSecrets, Error, ObservationError, Secrets,
    config::{ComputeDriver, InferenceApi},
    discovery::{
        CredentialRequest, DiscoveryObservation, DiscoveryQuery, DiscoveryRequest, FabricRequest,
        HardwareRequest, ObservationStatus,
    },
    fabric_capabilities::{FabricRequirements, Support},
    inference_discovery::EndpointRequest,
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
    DiscoveryQuery::Fabric(FabricRequest {
        engine: endpoint.into(),
        image: "runtime:test".into(),
        requirements: FabricRequirements::default(),
        platform,
        metadata_env: None,
    })
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
    let hardware = DiscoveryQuery::Hardware(HardwareRequest {
        engine: "unix:///missing-engine.sock".into(),
    });
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
        &[DiscoveryQuery::Hardware(HardwareRequest {
            engine: fixture.endpoint.clone(),
        })],
        &Direct,
        &EnvironmentSecrets,
        &cancel,
    )
    .await;
    assert!(matches!(result, Err(Error::Cancelled)));
}

/// Resolves only `API_KEY`, so no real environment variable is read.
struct FakeSecrets;
impl Secrets for FakeSecrets {
    fn resolve(&self, reference: &str) -> Result<String, ObservationError> {
        match reference {
            "API_KEY" => Ok("sk-secret-value".into()),
            _ => Err(ObservationError::Authentication),
        }
    }
}

#[tokio::test]
async fn inference_and_credential_queries_are_each_answered_under_their_own_query() {
    let catalog = transport::Fixture::start_tcp(|_| {
        Some((
            200,
            br#"{"data":[{"id":"model-b"},{"id":"model-a"}]}"#.to_vec(),
        ))
    })
    .await;
    let inference = DiscoveryQuery::Inference(EndpointRequest {
        endpoint: format!("{}/v1", catalog.endpoint),
        api: InferenceApi::OpenaiResponses,
        credential_env: Some("API_KEY".into()),
    });
    let resolvable = DiscoveryQuery::Credential(CredentialRequest {
        reference: "API_KEY".into(),
    });
    let unresolvable = DiscoveryQuery::Credential(CredentialRequest {
        reference: "OTHER_KEY".into(),
    });
    let observed = observe(
        &[inference.clone(), resolvable.clone(), unresolvable.clone()],
        &Direct,
        &FakeSecrets,
        &CancellationToken::new(),
    )
    .await
    .unwrap();
    let Some(DiscoveryObservation::Inference(models)) = observed.get(&inference) else {
        panic!("the inference read is recorded under its query");
    };
    assert_eq!(models.status, ObservationStatus::Available);
    assert_eq!(models.models, vec!["model-a", "model-b"]);
    let Some(DiscoveryObservation::Credential(found)) = observed.get(&resolvable) else {
        panic!("the credential read is recorded under its query");
    };
    assert_eq!(found.status, ObservationStatus::Available);
    let Some(DiscoveryObservation::Credential(missing)) = observed.get(&unresolvable) else {
        panic!("each credential reference has its own answer");
    };
    assert_eq!(missing.status, ObservationStatus::Unavailable);
    let recorded = serde_json::to_string(&(found, missing)).unwrap();
    assert!(!recorded.contains("sk-secret-value"));
}
