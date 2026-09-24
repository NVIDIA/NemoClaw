// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use nemoclaw_sdk::{
    ObservationError,
    config::InferenceApi,
    discovery::ObservationStatus,
    inference_discovery::{
        AuthenticationStatus, EndpointRequest, observe_credential, observe_endpoint,
    },
    openshell::Secrets,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
struct Missing;
impl Secrets for Missing {
    fn resolve(&self, _: &str) -> Result<String, ObservationError> {
        Err(ObservationError::Authentication)
    }
}
async fn fixture(status: &str, body: &str) -> (String, tokio::task::JoinHandle<String>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/v1", listener.local_addr().unwrap());
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let task = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut data = Vec::new();
        while !data.ends_with(b"\r\n\r\n") {
            data.push(stream.read_u8().await.unwrap());
        }
        stream.write_all(response.as_bytes()).await.unwrap();
        String::from_utf8(data).unwrap()
    });
    (endpoint, task)
}
#[tokio::test]
async fn model_catalog_is_read_only_deduplicated_and_does_not_claim_generation_api() {
    let (endpoint, request) = fixture(
        "200 OK",
        r#"{"data":[{"id":"model-b"},{"id":"model-a"},{"id":"model-b"}]}"#,
    )
    .await;
    let observed = observe_endpoint(
        &EndpointRequest {
            endpoint,
            api: InferenceApi::OpenaiResponses,
            credential_env: None,
        },
        &Missing,
    )
    .await;
    assert_eq!(observed.status, ObservationStatus::Available);
    assert_eq!(observed.models, vec!["model-a", "model-b"]);
    assert_eq!(observed.reachable, Some(true));
    assert_eq!(observed.authentication, AuthenticationStatus::NotRequired);
    assert!(!observed.api_verified);
    assert!(
        request
            .await
            .unwrap()
            .starts_with("GET /v1/models HTTP/1.1\r\n")
    );
}
#[tokio::test]
async fn authentication_and_incomplete_catalog_are_distinct_from_unreachable() {
    for (status, body, expected, auth) in [
        (
            "401 Unauthorized",
            r#"{"error":"PRIVATE_SENTINEL"}"#,
            ObservationStatus::Unavailable,
            AuthenticationStatus::Required,
        ),
        (
            "200 OK",
            r#"{"different":[]}"#,
            ObservationStatus::Unknown,
            AuthenticationStatus::Unknown,
        ),
        (
            "404 Not Found",
            r#"{"error":"PRIVATE_SENTINEL"}"#,
            ObservationStatus::Unknown,
            AuthenticationStatus::Unknown,
        ),
    ] {
        let (endpoint, task) = fixture(status, body).await;
        let observed = observe_endpoint(
            &EndpointRequest {
                endpoint,
                api: InferenceApi::OpenaiCompletions,
                credential_env: None,
            },
            &Missing,
        )
        .await;
        assert_eq!(observed.status, expected);
        assert_eq!(observed.authentication, auth);
        assert_eq!(observed.reachable, Some(true));
        assert!(
            !serde_json::to_string(&observed)
                .unwrap()
                .contains("PRIVATE_SENTINEL")
        );
        task.await.unwrap();
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

#[tokio::test]
async fn redirects_are_not_followed_and_catalog_bounds_are_enforced() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let task = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut bytes = Vec::new();
        while !bytes.ends_with(b"\r\n\r\n") {
            bytes.push(stream.read_u8().await.unwrap());
        }
        stream.write_all(format!("HTTP/1.1 302 Found\r\nLocation: http://{address}/forbidden\r\nContent-Length: 0\r\n\r\n").as_bytes()).await.unwrap();
    });
    let observed = observe_endpoint(
        &EndpointRequest {
            endpoint: format!("http://{address}/v1"),
            api: InferenceApi::OpenaiCompletions,
            credential_env: None,
        },
        &Missing,
    )
    .await;
    assert_eq!(observed.status, ObservationStatus::Unknown);
    assert_eq!(observed.reachable, Some(true));
    task.await.unwrap();
    let body = serde_json::json!({"data":[{"id":"x".repeat(1025)}]}).to_string();
    let (endpoint, task) = fixture("200 OK", &body).await;
    let observed = observe_endpoint(
        &EndpointRequest {
            endpoint,
            api: InferenceApi::OpenaiCompletions,
            credential_env: None,
        },
        &Missing,
    )
    .await;
    assert_eq!(observed.status, ObservationStatus::Unknown);
    assert!(observed.models.is_empty());
    task.await.unwrap();
}

#[tokio::test]
async fn anthropic_pagination_is_complete_before_publishing_model_choices() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let task = tokio::spawn(async move {
        let mut paths = Vec::new();
        for body in [
            r#"{"data":[{"id":"model-a"}],"has_more":true,"last_id":"model-a"}"#,
            r#"{"data":[{"id":"model-b"}],"has_more":false}"#,
        ] {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut bytes = Vec::new();
            while !bytes.ends_with(b"\r\n\r\n") {
                bytes.push(stream.read_u8().await.unwrap());
            }
            let request = String::from_utf8(bytes).unwrap();
            assert!(request.contains("anthropic-version: 2023-06-01"));
            paths.push(request.lines().next().unwrap().to_owned());
            stream
                .write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
        }
        paths
    });
    let observed = observe_endpoint(
        &EndpointRequest {
            endpoint: format!("http://{address}"),
            api: InferenceApi::AnthropicMessages,
            credential_env: None,
        },
        &Missing,
    )
    .await;
    assert_eq!(observed.status, ObservationStatus::Available);
    assert_eq!(observed.models, vec!["model-a", "model-b"]);
    let paths = task.await.unwrap();
    assert_eq!(paths[0], "GET /v1/models?limit=1000 HTTP/1.1");
    assert!(paths[1].contains("after_id=model-a"));
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
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[0].api, InferenceApi::OpenaiCompletions);
    assert_eq!(requests[1].api, InferenceApi::OpenaiResponses);
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
#[tokio::test]
async fn credential_headers_follow_the_owning_local_http_endpoint_policy() {
    struct Present;
    impl Secrets for Present {
        fn resolve(&self, _: &str) -> Result<String, ObservationError> {
            Ok("SECRET_HEADER_VALUE".into())
        }
    }
    let (endpoint, task) = fixture("200 OK", r#"{"data":[{"id":"known-model"}]}"#).await;
    let observed = observe_endpoint(
        &EndpointRequest {
            endpoint,
            api: InferenceApi::OpenaiCompletions,
            credential_env: Some("API_KEY".into()),
        },
        &Present,
    )
    .await;
    assert_eq!(observed.status, ObservationStatus::Available);
    assert_eq!(observed.authentication, AuthenticationStatus::Accepted);
    assert!(
        task.await
            .unwrap()
            .contains("authorization: Bearer SECRET_HEADER_VALUE")
    );
    assert!(
        !serde_json::to_string(&observed)
            .unwrap()
            .contains("SECRET_HEADER_VALUE")
    );
    assert!(
        EndpointRequest {
            endpoint: "http://public.example/v1".into(),
            api: InferenceApi::OpenaiCompletions,
            credential_env: None
        }
        .validate()
        .is_err()
    );
}

#[tokio::test]
async fn an_endpoint_cannot_echo_the_credential_into_model_suggestions_or_state() {
    struct Present;
    impl Secrets for Present {
        fn resolve(&self, _: &str) -> Result<String, ObservationError> {
            Ok("SECRET_HEADER_VALUE".into())
        }
    }
    let (endpoint, task) =
        fixture("200 OK", r#"{"data":[{"id":"model-SECRET_HEADER_VALUE"}]}"#).await;
    let observed = observe_endpoint(
        &EndpointRequest {
            endpoint,
            api: InferenceApi::OpenaiCompletions,
            credential_env: Some("API_KEY".into()),
        },
        &Present,
    )
    .await;
    assert_eq!(observed.status, ObservationStatus::Unknown);
    assert!(observed.models.is_empty());
    assert!(
        !serde_json::to_string(&observed)
            .unwrap()
            .contains("SECRET_HEADER_VALUE")
    );
    task.await.unwrap();
}
