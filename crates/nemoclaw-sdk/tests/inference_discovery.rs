// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use nemoclaw_sdk::{
    ObservationError, Secrets, config::InferenceApi, discovery::ObservationStatus,
    inference_discovery::observe_credential,
};
struct Missing;
impl Secrets for Missing {
    fn resolve(&self, _: &str) -> Result<String, ObservationError> {
        Err(ObservationError::Authentication)
    }
}
#[test]
fn credential_availability_never_contains_the_value() {
    struct Present;
    impl Secrets for Present {
        fn resolve(&self, _: &str) -> Result<String, ObservationError> {
            Ok("PRIVATE_SENTINEL".into())
        }
    }
    let present = observe_credential(&Present, "API_KEY");
    assert_eq!(present.status, ObservationStatus::Available);
    assert!(
        !serde_json::to_string(&present)
            .unwrap()
            .contains("PRIVATE_SENTINEL")
    );
    assert_eq!(
        observe_credential(&Missing, "API_KEY").status,
        ObservationStatus::Unavailable
    );
}

#[test]
fn endpoint_requests_deduplicate_shared_routes_and_preserve_harness_api_defaults() {
    use nemoclaw_sdk::{config::Document, inference_discovery::endpoint_requests};
    let document =
        Document::parse(include_bytes!("../../../examples/onboarding/openclaw.yaml").as_slice())
            .unwrap();
    let mut value = serde_json::to_value(document).unwrap();
    value["spec"]["inferenceProviders"][0]
        .as_object_mut()
        .unwrap()
        .remove("api");
    let mut second = value["spec"]["sandboxes"][0].clone();
    second["name"] = serde_json::json!("second");
    value["spec"]["sandboxes"]
        .as_array_mut()
        .unwrap()
        .push(second.clone());
    let document = Document::parse(value.to_string().as_bytes()).unwrap();
    assert_eq!(endpoint_requests(&document).unwrap().len(), 1);
    second["harness"]["kind"] = serde_json::json!("codex");
    value["spec"]["sandboxes"][1] = second;
    let document = Document::parse(value.to_string().as_bytes()).unwrap();
    let requests = endpoint_requests(&document).unwrap();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].api, InferenceApi::OpenaiCompletions);
}

#[test]
fn managed_services_keep_their_owner_readiness_queries_instead_of_anonymous_catalog_reads() {
    let document = nemoclaw_sdk::config::Document::parse(
        include_bytes!("fixtures/config/spark.yaml").as_slice(),
    )
    .unwrap();
    assert!(
        nemoclaw_sdk::inference_discovery::endpoint_requests(&document)
            .unwrap()
            .is_empty()
    );
}
