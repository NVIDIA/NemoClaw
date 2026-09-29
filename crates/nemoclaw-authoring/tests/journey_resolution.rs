// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_authoring::{
    Capabilities, JourneyDefinition, JourneyQuestionReason, JourneyScope, PartialDocument,
};
use nemoclaw_sdk::fabric_catalog::FabricCatalog;
use serde_json::json;

fn minimum() -> PartialDocument {
    PartialDocument::from_yaml(
        b"apiVersion: nemoclaw.nvidia.com/v1alpha1\nkind: NemoClawConfig\nspec:\n  sandboxes:\n    - {}\n",
    )
    .unwrap()
}

#[test]
fn sparse_journey_follows_nested_fabric_conditionals() {
    let mut catalog = FabricCatalog::bundled();
    let mut adapter = catalog.adapters[0].clone();
    adapter.descriptor["adapter_id"] = json!("fixture-schema-agent");
    adapter.descriptor["settings_schema"] = json!({
        "type":"object", "properties":{"mode":{"type":"string","enum":["basic","remote"],"default":"basic"}}, "required":["mode"],
        "if":{"properties":{"mode":{"const":"remote"}},"required":["mode"]},
        "then":{"properties":{"region":{"type":"string","enum":["west","east"]}},"required":["region"]}
    });
    catalog.adapters = vec![adapter];
    let capabilities = Capabilities::from_catalog(&catalog);
    let mut base: serde_json::Value =
        serde_saphyr::from_slice(include_bytes!("../../../examples/onboarding/openclaw.yaml"))
            .unwrap();
    base["spec"]["sandboxes"][0]["harness"]["kind"] = json!("fixture-schema-agent");
    let mut state = JourneyDefinition::new(
        "conditional",
        PartialDocument::from_yaml(base.to_string().as_bytes()).unwrap(),
    )
    .start(&capabilities)
    .unwrap();
    let mode = "adapter:fixture-schema-agent:/mode";
    let region = "adapter:fixture-schema-agent:/region";
    assert!(
        state
            .resolve(&capabilities)
            .unwrap()
            .question(mode)
            .is_some()
    );
    assert!(
        state
            .resolve(&capabilities)
            .unwrap()
            .question(region)
            .is_none()
    );
    state
        .answer(&capabilities, mode, Some(json!("remote")))
        .unwrap();
    assert!(
        state
            .resolve(&capabilities)
            .unwrap()
            .question(region)
            .is_some()
    );
    state
        .answer(&capabilities, region, Some(json!("west")))
        .unwrap();
    assert!(
        state
            .resolve(&capabilities)
            .unwrap()
            .materialized_document()
            .is_some()
    );
}

#[test]
fn sparse_journey_asks_existing_deployment_fields_and_checks_complete_sdk_edits() {
    let capabilities = Capabilities::available();
    let base =
        PartialDocument::from_yaml(include_bytes!("../../../examples/spark/remote-vllm.yaml"))
            .unwrap();
    let mut state = JourneyDefinition::new("deployment", base)
        .ask([JourneyScope::DeploymentFields])
        .start(&capabilities)
        .unwrap();
    let path = "/spec/services/qwen/serving/contextTokens";
    let resolution = state.resolve(&capabilities).unwrap();
    assert!(resolution.question(path).is_some());
    let before = state.values().clone();
    assert!(state.answer(&capabilities, path, Some(json!(-1))).is_err());
    assert_eq!(state.values(), &before);
    state
        .answer(&capabilities, path, Some(json!(16384)))
        .unwrap();
    assert_eq!(state.values().pointer(path), Some(&json!(16384)));
    assert!(
        state
            .resolve(&capabilities)
            .unwrap()
            .question(path)
            .is_none()
    );
}

#[test]
fn sparse_journey_uses_workflow_and_model_owner_schemas() {
    let mut catalog = FabricCatalog::bundled();
    let mut adapter = catalog.adapters[0].clone();
    adapter.descriptor["adapter_id"] = json!("fixture.native-owner");
    adapter.descriptor["settings_schema"] = json!({"type":"object","properties":{}});
    adapter.descriptor["config"]["schema"] = json!({"type":"object","required":["workflow"]});
    adapter.descriptor["model_schema"] = json!({"type":"object","properties":{"settings":{"type":"object","properties":{"variant":{"type":"string","enum":["quick","thorough"]}},"required":["variant"]}}});
    catalog.adapters = vec![adapter];
    catalog.targets = vec![json!({"descriptor":{
        "type":"workflow","id":"fixture.target","adapter_id":"fixture.native-owner",
        "spec":{"settings_schema":{"type":"object","properties":{"region":{"type":"string","enum":["west","east"]}},"required":["region"]}}
    },"provenance":[]})];
    let capabilities = Capabilities::from_catalog(&catalog);
    let mut base: serde_json::Value =
        serde_saphyr::from_slice(include_bytes!("../../../examples/onboarding/openclaw.yaml"))
            .unwrap();
    base["spec"]["sandboxes"][0]["harness"]["kind"] = json!("fixture.native-owner");
    let mut state = JourneyDefinition::new(
        "native",
        PartialDocument::from_yaml(base.to_string().as_bytes()).unwrap(),
    )
    .ask([JourneyScope::NativeSettings])
    .start(&capabilities)
    .unwrap();
    assert!(
        state
            .resolve(&capabilities)
            .unwrap()
            .question("workflow:/target_id")
            .is_some()
    );
    assert!(
        state
            .resolve(&capabilities)
            .unwrap()
            .question("model:/variant")
            .is_some()
    );
    state
        .answer(
            &capabilities,
            "workflow:/target_id",
            Some(json!("fixture.target")),
        )
        .unwrap();
    assert!(
        state
            .resolve(&capabilities)
            .unwrap()
            .question("workflow:/settings/region")
            .is_some()
    );
    state
        .answer(
            &capabilities,
            "workflow:/settings/region",
            Some(json!("west")),
        )
        .unwrap();
    state
        .answer(&capabilities, "model:/variant", Some(json!("quick")))
        .unwrap();
    assert!(
        state
            .resolve(&capabilities)
            .unwrap()
            .materialized_document()
            .is_some()
    );
}

#[test]
fn invalid_complete_native_model_settings_cannot_reach_review() {
    let capabilities = Capabilities::available();
    let base =
        PartialDocument::from_yaml(include_bytes!("../../../examples/onboarding/openclaw.yaml"))
            .unwrap();
    let mut state = JourneyDefinition::new("native-validation", base)
        .ask([JourneyScope::NativeSettings])
        .omit([
            "adapter:nvidia.fabric.openclaw:/agent_name",
            "adapter:nvidia.fabric.openclaw:/cli",
            "adapter:nvidia.fabric.openclaw:/home",
            "adapter:nvidia.fabric.openclaw:/native_config",
            "adapter:nvidia.fabric.openclaw:/timeout_seconds",
        ])
        .start(&capabilities)
        .unwrap();
    state
        .answer(
            &capabilities,
            "model:/api",
            Some(json!("openai-completions")),
        )
        .unwrap();
    let result = state.resolve(&capabilities).unwrap();
    assert!(
        !result.unverified().is_empty(),
        "invalid native model config must be reported"
    );
    assert!(result.materialized_document().is_none());
}

#[test]
fn discovered_models_extend_the_current_route_question_without_restricting_custom_answers() {
    use nemoclaw_authoring::{AuthoringFacts, EndpointEvidence, inference_request_for_document};
    use nemoclaw_sdk::{
        discovery::ObservationStatus,
        inference_discovery::{AuthenticationStatus, EndpointObservation},
    };
    let capabilities = Capabilities::available();
    let base =
        PartialDocument::from_yaml(include_bytes!("../../../examples/onboarding/openclaw.yaml"))
            .unwrap();
    let mut state = JourneyDefinition::new("discovered", base)
        .ask([JourneyScope::RouteModels])
        .start(&capabilities)
        .unwrap();
    let document = state
        .resolve(&capabilities)
        .unwrap()
        .assessment()
        .document()
        .unwrap()
        .clone();
    let facts = AuthoringFacts {
        endpoint: Some(EndpointEvidence {
            request: inference_request_for_document(&document, state.current_route()).unwrap(),
            observation: EndpointObservation {
                status: ObservationStatus::Available,
                reason: None,
                source: "fixture".into(),
                reachable: Some(true),
                authentication: AuthenticationStatus::Accepted,
                models: vec!["vendor/discovered-model".into()],
                api_verified: false,
            },
        }),
        ..Default::default()
    };
    let model = "/spec/sandboxes/0/agent/inference/routes/0/overrides/model";
    assert!(
        state
            .resolve_with_facts(&capabilities, &facts)
            .unwrap()
            .question(model)
            .unwrap()
            .choices()
            .contains(&json!("vendor/discovered-model"))
    );
    let mut stale = facts.clone();
    stale.endpoint.as_mut().unwrap().request.endpoint = "https://other.example/v1".into();
    assert!(
        !state
            .resolve_with_facts(&capabilities, &stale)
            .unwrap()
            .question(model)
            .unwrap()
            .choices()
            .contains(&json!("vendor/discovered-model"))
    );
    stale.endpoint.as_mut().unwrap().request = facts.endpoint.as_ref().unwrap().request.clone();
    stale.endpoint.as_mut().unwrap().observation.status = ObservationStatus::Unknown;
    assert!(
        !state
            .resolve_with_facts(&capabilities, &stale)
            .unwrap()
            .question(model)
            .unwrap()
            .choices()
            .contains(&json!("vendor/discovered-model"))
    );
    state
        .answer(&capabilities, model, Some(json!("private/custom")))
        .unwrap();
    assert_eq!(
        state.values().pointer(model),
        Some(&json!("private/custom"))
    );
}

#[test]
fn runtime_question_uses_finite_sdk_schema_choices() {
    let capabilities = Capabilities::available();
    let base =
        PartialDocument::from_yaml(include_bytes!("../../../examples/onboarding/openclaw.yaml"))
            .unwrap();
    let state = JourneyDefinition::new("runtime", base)
        .ask(["/spec/sandboxes/0/runtime/provider"])
        .start(&capabilities)
        .unwrap();
    let question = state
        .resolve(&capabilities)
        .unwrap()
        .question("/spec/sandboxes/0/runtime/provider")
        .unwrap()
        .clone();
    assert!(question.choices().contains(&json!("docker")));
    assert!(question.choices().contains(&json!("podman")));
}

#[test]
fn choosing_podman_updates_the_matching_managed_gateway_default() {
    let capabilities = Capabilities::available();
    let base =
        PartialDocument::from_yaml(include_bytes!("../../../examples/onboarding/openclaw.yaml"))
            .unwrap();
    let mut state = JourneyDefinition::new("runtime", base)
        .ask(["/spec/sandboxes/0/runtime/provider"])
        .start(&capabilities)
        .unwrap();
    state
        .answer(
            &capabilities,
            "/spec/sandboxes/0/runtime/provider",
            Some(json!("podman")),
        )
        .unwrap();
    assert_eq!(
        state.values().pointer("/spec/gateway/engine"),
        Some(&json!("unix:///run/user/1000/podman/podman.sock"))
    );
    assert!(
        state
            .resolve(&capabilities)
            .unwrap()
            .assessment()
            .document()
            .is_some()
    );
}

#[test]
fn sparse_journey_delegation_requires_current_target_evidence() {
    let capabilities = Capabilities::available();
    let base =
        PartialDocument::from_yaml(include_bytes!("../../../examples/onboarding/openclaw.yaml"))
            .unwrap();
    let mut state = JourneyDefinition::new("delegate", base)
        .ask(["/spec/sandboxes/0/harness/kind", "/metadata/name"])
        .start(&capabilities)
        .unwrap();
    state
        .answer(
            &capabilities,
            "/spec/sandboxes/0/harness/kind",
            Some(json!("nvidia.fabric.openclaw")),
        )
        .unwrap();
    assert!(
        state
            .delegate_remaining(&capabilities, None, &Default::default())
            .is_err()
    );
    assert!(
        state
            .resolve(&capabilities)
            .unwrap()
            .question("/metadata/name")
            .is_some()
    );
}

#[test]
fn sparse_journey_delegates_suggestions_with_compatible_current_evidence() {
    use nemoclaw_authoring::{
        AuthoringFacts, DiscoveryEvidence, EndpointEvidence, discovery_key_for_document,
        inference_request_for_document,
    };
    use nemoclaw_sdk::{
        discovery::{EngineObservation, FabricObservation, ObservationStatus},
        fabric_capabilities::ImageMetadata,
        fabric_catalog::FabricCatalog,
        inference_discovery::{AuthenticationStatus, CredentialObservation, EndpointObservation},
    };
    let capabilities = Capabilities::available();
    let base =
        PartialDocument::from_yaml(include_bytes!("../../../examples/onboarding/openclaw.yaml"))
            .unwrap();
    let mut state = JourneyDefinition::new("delegate", base)
        .ask([
            "/spec/sandboxes/0/harness/kind",
            "/metadata/name",
            "inference:preset",
        ])
        .ask([JourneyScope::RouteModels])
        .ask([JourneyScope::InferenceApi])
        .ask([JourneyScope::ActiveAdapterSettings])
        .ask([JourneyScope::NativeSettings])
        .ask([JourneyScope::DeploymentFields])
        .start(&capabilities)
        .unwrap();
    state
        .answer(
            &capabilities,
            "/spec/sandboxes/0/harness/kind",
            Some(json!("nvidia.fabric.openclaw")),
        )
        .unwrap();
    let document = state
        .resolve(&capabilities)
        .unwrap()
        .assessment()
        .document()
        .unwrap()
        .clone();
    let key = discovery_key_for_document(&document).unwrap();
    let evidence = DiscoveryEvidence {
        key: key.clone(),
        engine: Some(EngineObservation {
            status: ObservationStatus::Available,
            reason: None,
            source: "fixture".into(),
            server_version: Some("1".into()),
            architecture: Some("aarch64".into()),
            operating_system: Some("linux".into()),
            memory_bytes: None,
            cpus: None,
        }),
        fabric: Some(FabricObservation {
            status: ObservationStatus::Available,
            reason: None,
            source: "fixture".into(),
            image_id: Some("sha256:observed".into()),
            catalog: Some(FabricCatalog::bundled()),
            image: ImageMetadata {
                architecture: Some("arm64".into()),
                operating_system: Some("linux".into()),
                repo_digests: vec![key.image],
                ..Default::default()
            },
            compatibility: None,
        }),
    };
    let facts = AuthoringFacts {
        endpoint: Some(EndpointEvidence {
            request: inference_request_for_document(&document, state.current_route()).unwrap(),
            observation: EndpointObservation {
                status: ObservationStatus::Available,
                reason: None,
                source: "fixture".into(),
                reachable: Some(true),
                authentication: AuthenticationStatus::Accepted,
                models: vec![
                    document.spec.sandboxes[0]
                        .agent
                        .inference
                        .as_ref()
                        .unwrap()
                        .routes[0]
                        .overrides
                        .model
                        .clone(),
                ],
                api_verified: false,
            },
        }),
        credentials: document
            .credential_names()
            .into_iter()
            .map(|reference| CredentialObservation {
                reference: reference.into(),
                status: ObservationStatus::Available,
                reason: None,
            })
            .collect(),
        ..Default::default()
    };
    let delegated = state
        .delegate_remaining(&capabilities, Some(&evidence), &facts)
        .unwrap();
    assert!(
        delegated
            .resolve(&capabilities)
            .unwrap()
            .materialized_document()
            .is_some()
    );
    assert_eq!(
        delegated.values().pointer("/metadata/name"),
        state.values().pointer("/metadata/name")
    );
}

#[test]
fn sparse_journey_visits_each_route_and_keeps_its_model_answers_separate() {
    let capabilities = Capabilities::available();
    let base = PartialDocument::from_yaml(include_bytes!(
        "../../../examples/spark/local-and-hosted.yaml"
    ))
    .unwrap();
    let mut state = JourneyDefinition::new("routes", base)
        .ask([JourneyScope::RouteModels])
        .omit([
            "adapter:nvidia.fabric.openclaw:/agent_name",
            "adapter:nvidia.fabric.openclaw:/cli",
            "adapter:nvidia.fabric.openclaw:/home",
            "adapter:nvidia.fabric.openclaw:/native_config",
            "adapter:nvidia.fabric.openclaw:/timeout_seconds",
        ])
        .start(&capabilities)
        .unwrap();
    let route = "route:selection";
    let hosted_model = "/spec/sandboxes/0/agent/inference/routes/1/overrides/model";
    let local_model = "/spec/sandboxes/0/agent/inference/routes/0/overrides/model";
    let first = state.resolve(&capabilities).unwrap();
    assert_eq!(
        first.question(route).unwrap().choices(),
        &[json!("local"), json!("hosted")]
    );
    assert!(first.question(hosted_model).is_none());
    state
        .answer(&capabilities, route, Some(json!("hosted")))
        .unwrap();
    assert!(
        state
            .resolve(&capabilities)
            .unwrap()
            .question(hosted_model)
            .is_some()
    );
    state
        .answer(
            &capabilities,
            hosted_model,
            Some(json!("replacement-model")),
        )
        .unwrap();
    assert!(
        state
            .resolve(&capabilities)
            .unwrap()
            .question(route)
            .is_some()
    );
    state
        .answer(&capabilities, route, Some(json!("local")))
        .unwrap();
    assert!(
        state
            .resolve(&capabilities)
            .unwrap()
            .question(local_model)
            .is_some()
    );
    state
        .answer(
            &capabilities,
            local_model,
            Some(json!("nvidia/Qwen3.8-27B-NVFP4")),
        )
        .unwrap();
    let resolved = state.resolve(&capabilities).unwrap();
    assert!(resolved.question(route).is_none());
    assert_eq!(
        state.values().pointer(hosted_model),
        Some(&json!("replacement-model"))
    );
    assert!(
        resolved.materialized_document().is_some(),
        "questions={:?} unverified={:?} issues={:?}",
        resolved.questions(),
        resolved.unverified(),
        resolved.assessment().issues()
    );
}

#[test]
fn referenced_inference_routes_are_selected_and_edited_through_the_same_journey() {
    let capabilities = Capabilities::available();
    let mut document = nemoclaw_sdk::config::Document::parse(
        &include_bytes!("../../../examples/multiple-providers.yaml")[..],
    )
    .unwrap();
    document.spec.sandboxes.truncate(1);
    let base =
        PartialDocument::from_yaml(serde_json::to_vec(&document).unwrap().as_slice()).unwrap();
    let mut state = JourneyDefinition::new("referenced-routes", base)
        .ask([JourneyScope::RouteModels])
        .start(&capabilities)
        .unwrap();
    let path = "/spec/inferences/smart-and-fast/routes/1/overrides/model";
    let original = state.values().clone();
    assert_eq!(
        state
            .resolve(&capabilities)
            .unwrap()
            .question("route:selection")
            .unwrap()
            .choices(),
        &[json!("smart"), json!("fast")]
    );
    state
        .answer(&capabilities, "route:selection", Some(json!("fast")))
        .unwrap();
    assert_eq!(state.current_route(), Some("fast"));
    assert!(
        state
            .resolve(&capabilities)
            .unwrap()
            .question(path)
            .is_some()
    );
    state
        .answer(&capabilities, path, Some(json!("new-local-model")))
        .unwrap();
    assert_eq!(
        state.values().pointer(path),
        Some(&json!("new-local-model"))
    );
    assert_eq!(
        state
            .values()
            .pointer("/spec/inferences/smart-and-fast/routes/0"),
        original.pointer("/spec/inferences/smart-and-fast/routes/0")
    );
    let before_invalid = state.values().clone();
    assert!(
        state
            .answer(&capabilities, "route:selection", Some(json!("absent")))
            .is_err()
    );
    assert_eq!(state.values(), &before_invalid);
    document
        .spec
        .inferences
        .get_mut("smart-and-fast")
        .unwrap()
        .routes[1]
        .overrides
        .model = "new-local-model".into();
    assert_eq!(
        state
            .resolve(&capabilities)
            .unwrap()
            .assessment()
            .document()
            .unwrap(),
        &document
    );
}

#[test]
fn referenced_harness_settings_are_owned_by_the_referenced_definition() {
    let capabilities = Capabilities::available();
    let mut document = nemoclaw_sdk::config::Document::parse(
        &include_bytes!("../../../examples/multiple-models.yaml")[..],
    )
    .unwrap();
    document.spec.sandboxes.truncate(1);
    let base =
        PartialDocument::from_yaml(serde_json::to_vec(&document).unwrap().as_slice()).unwrap();
    let mut state = JourneyDefinition::new("referenced-harness", base)
        .ask([JourneyScope::ActiveAdapterSettings])
        .start(&capabilities)
        .unwrap();
    let field = "adapter:nvidia.fabric.openclaw:/timeout_seconds";
    assert!(
        state
            .resolve(&capabilities)
            .unwrap()
            .question(field)
            .is_some()
    );
    state
        .answer(&capabilities, field, Some(json!(301)))
        .unwrap();
    assert_eq!(
        state
            .values()
            .pointer("/spec/harnesses/assistant/settings/timeout_seconds"),
        Some(&json!(301))
    );
    assert!(
        state
            .values()
            .pointer("/spec/sandboxes/0/harness")
            .is_none()
    );
}

#[test]
fn revisiting_a_referenced_harness_choice_does_not_create_an_inline_harness() {
    let capabilities = Capabilities::available();
    let mut document = nemoclaw_sdk::config::Document::parse(
        &include_bytes!("../../../examples/multiple-models.yaml")[..],
    )
    .unwrap();
    document.spec.sandboxes.truncate(1);
    let base =
        PartialDocument::from_yaml(serde_json::to_vec(&document).unwrap().as_slice()).unwrap();
    let mut state = JourneyDefinition::new("referenced-harness-choice", base)
        .ask(["/spec/sandboxes/0/harness/kind"])
        .start(&capabilities)
        .unwrap();
    let field = "/spec/sandboxes/0/harness/kind";
    state
        .answer(&capabilities, field, Some(json!("nvidia.fabric.openclaw")))
        .unwrap();
    state
        .answer(&capabilities, field, Some(json!("nvidia.fabric.hermes")))
        .unwrap();
    assert_eq!(
        state.values().pointer("/spec/harnesses/assistant/kind"),
        Some(&json!("nvidia.fabric.hermes"))
    );
    assert!(
        state
            .values()
            .pointer("/spec/sandboxes/0/harness")
            .is_none()
    );
}

#[test]
fn referenced_model_settings_are_written_to_the_selected_route() {
    let capabilities = Capabilities::available();
    let mut document = nemoclaw_sdk::config::Document::parse(
        &include_bytes!("../../../examples/multiple-models.yaml")[..],
    )
    .unwrap();
    document.spec.sandboxes.truncate(1);
    let base =
        PartialDocument::from_yaml(serde_json::to_vec(&document).unwrap().as_slice()).unwrap();
    let mut state = JourneyDefinition::new("referenced-model", base)
        .ask([JourneyScope::RouteModels])
        .ask([JourneyScope::NativeSettings])
        .start(&capabilities)
        .unwrap();
    state
        .answer(&capabilities, "route:selection", Some(json!("fast")))
        .unwrap();
    let field = "model:/reasoning_effort";
    assert!(
        state
            .resolve(&capabilities)
            .unwrap()
            .question(field)
            .is_some()
    );
    state
        .answer(&capabilities, field, Some(json!("low")))
        .unwrap();
    assert_eq!(
        state.values().pointer(
            "/spec/inferences/smart-and-fast/routes/1/overrides/settings/reasoning_effort"
        ),
        Some(&json!("low"))
    );
    assert!(
        state
            .values()
            .pointer("/spec/sandboxes/0/agent/inference")
            .is_none()
    );
}

#[test]
fn referenced_workflow_answers_keep_the_named_harness_as_the_owner() {
    let mut catalog = FabricCatalog::bundled();
    let mut adapter = catalog.adapters[0].clone();
    adapter.descriptor["adapter_id"] = json!("fixture.workflow-owner");
    adapter.descriptor["settings_schema"] = json!({"type":"object","properties":{}});
    adapter.descriptor["config"]["schema"] = json!({"type":"object","required":["workflow"]});
    catalog.adapters = vec![adapter];
    catalog.targets = vec![json!({"descriptor":{
        "type":"workflow","id":"fixture.target","adapter_id":"fixture.workflow-owner",
        "spec":{"settings_schema":{"type":"object","properties":{}}}
    },"provenance":[]})];
    let capabilities = Capabilities::from_catalog(&catalog);
    let mut document = nemoclaw_sdk::config::Document::parse(
        &include_bytes!("../../../examples/multiple-models.yaml")[..],
    )
    .unwrap();
    document.spec.sandboxes.truncate(1);
    let mut value = serde_json::to_value(&document).unwrap();
    value["spec"]["harnesses"]["assistant"]["kind"] = json!("fixture.workflow-owner");
    let base = PartialDocument::from_yaml(value.to_string().as_bytes()).unwrap();
    let mut state = JourneyDefinition::new("referenced-workflow", base)
        .ask([JourneyScope::NativeSettings])
        .start(&capabilities)
        .unwrap();
    let field = "workflow:/target_id";
    assert!(
        state
            .resolve(&capabilities)
            .unwrap()
            .question(field)
            .is_some()
    );
    state
        .answer(&capabilities, field, Some(json!("fixture.target")))
        .unwrap();
    assert_eq!(
        state
            .values()
            .pointer("/spec/harnesses/assistant/config/workflow/target_id"),
        Some(&json!("fixture.target"))
    );
    assert!(
        state
            .values()
            .pointer("/spec/sandboxes/0/harness")
            .is_none()
    );
}

#[test]
fn omitting_an_implicit_api_keeps_the_sdk_default_without_writing_an_override() {
    let capabilities = Capabilities::available();
    let bytes = include_bytes!("../../../examples/explicit-policy.yaml");
    let original = nemoclaw_sdk::config::Document::parse(&bytes[..]).unwrap();
    let base = PartialDocument::from_yaml(bytes).unwrap();
    let mut state = JourneyDefinition::new("implicit-api", base)
        .ask([JourneyScope::InferenceApi])
        .start(&capabilities)
        .unwrap();
    let path = "/spec/inferenceProviders/0/api";
    let question = state
        .resolve(&capabilities)
        .unwrap()
        .question(path)
        .cloned()
        .unwrap();
    assert!(!question.required());
    assert!(question.suggestion().is_none());
    state.answer(&capabilities, path, None).unwrap();
    assert!(state.values().pointer(path).is_none());
    assert_eq!(
        state
            .resolve(&capabilities)
            .unwrap()
            .assessment()
            .document()
            .unwrap(),
        &original
    );
}

#[test]
fn absent_optional_adapter_settings_remain_unsupplied_until_answered() {
    let capabilities = Capabilities::available();
    let base = PartialDocument::from_yaml(include_bytes!("../../../examples/explicit-policy.yaml"))
        .unwrap();
    let mut state = JourneyDefinition::new("optional-adapter", base)
        .ask([JourneyScope::ActiveAdapterSettings])
        .start(&capabilities)
        .unwrap();
    let field = "adapter:nvidia.fabric.openclaw:/cli";
    let question = state
        .resolve(&capabilities)
        .unwrap()
        .question(field)
        .cloned()
        .unwrap();
    assert!(!question.required());
    assert!(question.suggestion().is_none());
    state.answer(&capabilities, field, None).unwrap();
    assert!(
        state
            .values()
            .pointer("/spec/sandboxes/0/harness/settings/cli")
            .is_none()
    );
}

#[test]
fn editing_a_route_model_preserves_explicit_credential_references() {
    let capabilities = Capabilities::available();
    let yaml = include_str!("../../../examples/onboarding/openclaw.yaml")
        .replace("NVIDIA_API_KEY", "NVIDIA_INFERENCE_API_KEY");
    let base = PartialDocument::from_yaml(yaml.as_bytes()).unwrap();
    let mut state = JourneyDefinition::new("credential-reference", base)
        .ask([JourneyScope::RouteModels])
        .start(&capabilities)
        .unwrap();
    let model = "/spec/sandboxes/0/agent/inference/routes/0/overrides/model";
    state
        .answer(
            &capabilities,
            model,
            Some(json!("organization/selected-model")),
        )
        .unwrap();
    let resolution = state.resolve(&capabilities).unwrap();
    let document = resolution.assessment().document().unwrap();
    assert_eq!(document.credential_names(), ["NVIDIA_INFERENCE_API_KEY"]);
    assert_eq!(
        document.inference_provider().unwrap().endpoint,
        "https://integrate.api.nvidia.com/v1"
    );
}

#[test]
fn route_preset_changes_only_the_selected_external_provider() {
    let capabilities = Capabilities::available();
    let base = PartialDocument::from_yaml(include_bytes!(
        "../../../examples/spark/local-and-hosted.yaml"
    ))
    .unwrap();
    let mut state = JourneyDefinition::new("route-presets", base)
        .ask([JourneyScope::RouteModels])
        .ask(["inference:preset"])
        .start(&capabilities)
        .unwrap();
    let before = state.values().clone();
    assert!(
        state
            .resolve(&capabilities)
            .unwrap()
            .question("inference:preset")
            .is_none()
    );
    state
        .answer(&capabilities, "route:selection", Some(json!("local")))
        .unwrap();
    assert!(
        state
            .resolve(&capabilities)
            .unwrap()
            .question("inference:preset")
            .is_none()
    );
    state
        .answer(
            &capabilities,
            "/spec/sandboxes/0/agent/inference/routes/0/overrides/model",
            Some(json!("nvidia/Qwen3.8-27B-NVFP4")),
        )
        .unwrap();
    state
        .answer(&capabilities, "route:selection", Some(json!("hosted")))
        .unwrap();
    assert!(
        state
            .resolve(&capabilities)
            .unwrap()
            .question("inference:preset")
            .is_some()
    );
    state
        .answer(&capabilities, "inference:preset", Some(json!("openai")))
        .unwrap();
    assert_eq!(
        state.values().pointer("/spec/inferenceProviders/0"),
        before.pointer("/spec/inferenceProviders/0")
    );
    assert_eq!(
        state.values().pointer("/spec/inferenceProviders/1/name"),
        Some(&json!("openai-api"))
    );
    assert_eq!(
        state
            .values()
            .pointer("/spec/sandboxes/0/agent/inference/routes/1/providerRef"),
        Some(&json!("openai-api"))
    );
    assert_eq!(
        state
            .values()
            .pointer("/spec/sandboxes/0/agent/inference/routes/0/overrides/model"),
        before.pointer("/spec/sandboxes/0/agent/inference/routes/0/overrides/model")
    );
}

#[test]
fn partial_journey_recomputes_questions_after_answers_and_omissions() {
    let capabilities = Capabilities::available();
    let definition = JourneyDefinition::new("minimum", minimum());
    let mut state = definition.start(&capabilities).unwrap();
    let questions = state.resolve(&capabilities).unwrap();
    assert!(questions.question("/metadata/name").is_some());
    assert!(
        questions
            .question("/spec/sandboxes/0/harness/kind")
            .is_some()
    );
    assert!(
        questions
            .question("adapter:nvidia.fabric.openclaw:/cli")
            .is_none()
    );

    state
        .answer(
            &capabilities,
            "/metadata/name",
            Some(json!("my-deployment")),
        )
        .unwrap();
    state
        .answer(
            &capabilities,
            "/spec/sandboxes/0/harness/kind",
            Some(json!("nvidia.fabric.openclaw")),
        )
        .unwrap();
    let questions = state.resolve(&capabilities).unwrap();
    assert!(questions.question("/metadata/name").is_none());
    assert!(
        questions
            .question("adapter:nvidia.fabric.openclaw:/cli")
            .is_some()
    );

    state
        .answer(&capabilities, "adapter:nvidia.fabric.openclaw:/cli", None)
        .unwrap();
    let questions = state.resolve(&capabilities).unwrap();
    assert!(
        questions
            .question("adapter:nvidia.fabric.openclaw:/cli")
            .is_none()
    );
    assert!(
        questions
            .omitted()
            .contains(&"adapter:nvidia.fabric.openclaw:/cli".to_owned())
    );
    assert!(questions.assessment().document().is_none());
}

#[test]
fn accepting_a_supplied_suggestion_resolves_an_explicit_ask() {
    let capabilities = Capabilities::available();
    let base =
        PartialDocument::from_yaml(include_bytes!("../../../examples/onboarding/openclaw.yaml"))
            .unwrap();
    let definition = JourneyDefinition::new("guided", base).ask(["/metadata/name"]);
    let mut state = definition.start(&capabilities).unwrap();
    let suggested = state
        .resolve(&capabilities)
        .unwrap()
        .question("/metadata/name")
        .unwrap()
        .suggestion()
        .cloned()
        .unwrap();

    state
        .answer(&capabilities, "/metadata/name", Some(suggested))
        .unwrap();
    assert!(
        state
            .resolve(&capabilities)
            .unwrap()
            .question("/metadata/name")
            .is_none()
    );
}

#[test]
fn existing_onboarding_fields_resolve_and_materialize_without_a_draft() {
    let capabilities = Capabilities::available();
    let mut sparse: serde_json::Value =
        serde_saphyr::from_slice(include_bytes!("../../../examples/onboarding/openclaw.yaml"))
            .unwrap();
    sparse
        .pointer_mut("/spec/sandboxes/0/agent/inference/routes/0/overrides")
        .unwrap()
        .as_object_mut()
        .unwrap()
        .remove("model");
    let base = PartialDocument::from_yaml(sparse.to_string().as_bytes()).unwrap();
    let fields = [
        "/metadata/name",
        "/spec/sandboxes/0/harness/kind",
        "/spec/sandboxes/0/runtime/provider",
        "/spec/inferenceProviders/0/provider",
        "/spec/inferenceProviders/0/api",
        "/spec/sandboxes/0/agent/inference/routes/0/overrides/model",
    ];
    let definition = JourneyDefinition::new("guided", base).ask(fields).omit([
        "adapter:nvidia.fabric.openclaw:/agent_name",
        "adapter:nvidia.fabric.openclaw:/cli",
        "adapter:nvidia.fabric.openclaw:/home",
        "adapter:nvidia.fabric.openclaw:/native_config",
        "adapter:nvidia.fabric.openclaw:/timeout_seconds",
    ]);
    let mut state = definition.start(&capabilities).unwrap();
    assert!(
        state
            .resolve(&capabilities)
            .unwrap()
            .assessment()
            .document()
            .is_none()
    );
    assert!(
        state
            .resolve(&capabilities)
            .unwrap()
            .materialized_document()
            .is_none()
    );
    for field in fields {
        assert!(
            state
                .resolve(&capabilities)
                .unwrap()
                .question(field)
                .is_some(),
            "{field}"
        );
    }
    let mut seen = Vec::new();
    for _ in fields {
        let question = state
            .resolve(&capabilities)
            .unwrap()
            .next_question()
            .cloned()
            .unwrap();
        let field = question.id();
        seen.push(field.to_owned());
        let value = match field {
            "/metadata/name" => json!("new-deployment"),
            "/spec/sandboxes/0/agent/inference/routes/0/overrides/model" => {
                let before = state.values().clone();
                assert!(
                    state
                        .answer(&capabilities, field, Some(json!("bad model")))
                        .is_err()
                );
                assert_eq!(state.values(), &before);
                json!("nvidia/another-model")
            }
            _ => question.suggestion().cloned().unwrap(),
        };
        state.answer(&capabilities, field, Some(value)).unwrap();
    }
    assert_eq!(seen, fields);
    let resolved = state.resolve(&capabilities).unwrap();
    assert!(
        resolved.questions().is_empty(),
        "{:?}",
        resolved.questions()
    );
    assert!(
        resolved.unverified().is_empty(),
        "{:?}",
        resolved.unverified()
    );
    let document = resolved.materialized_document().unwrap();
    assert_eq!(document.metadata.name, "new-deployment");
    assert_eq!(
        state
            .values()
            .pointer("/spec/sandboxes/0/agent/inference/routes/0/overrides/model"),
        Some(&json!("nvidia/another-model"))
    );
}

#[test]
fn inference_preset_updates_sparse_values_and_reopens_dependent_answers() {
    let capabilities = Capabilities::available();
    let base =
        PartialDocument::from_yaml(include_bytes!("../../../examples/onboarding/openclaw.yaml"))
            .unwrap();
    let preset = "inference:preset";
    let api = "/spec/inferenceProviders/0/api";
    let provider_name = "/spec/inferenceProviders/0/name";
    let model = "/spec/sandboxes/0/agent/inference/routes/0/overrides/model";
    let name = "/metadata/name";
    let mut state = JourneyDefinition::new("preset", base)
        .ask([name, preset, api, model, provider_name])
        .omit([
            "adapter:nvidia.fabric.openclaw:/agent_name",
            "adapter:nvidia.fabric.openclaw:/cli",
            "adapter:nvidia.fabric.openclaw:/home",
            "adapter:nvidia.fabric.openclaw:/native_config",
            "adapter:nvidia.fabric.openclaw:/timeout_seconds",
        ])
        .start(&capabilities)
        .unwrap();

    assert_eq!(
        state
            .resolve(&capabilities)
            .unwrap()
            .question(preset)
            .unwrap()
            .suggestion(),
        Some(&json!("nvidia-endpoints"))
    );
    state
        .answer(&capabilities, name, Some(json!("my-deployment")))
        .unwrap();
    state
        .answer(&capabilities, preset, Some(json!("nvidia-endpoints")))
        .unwrap();
    state
        .answer(&capabilities, api, Some(json!("openai-completions")))
        .unwrap();
    state
        .answer(&capabilities, model, Some(json!("nvidia/my-model")))
        .unwrap();
    state
        .answer(&capabilities, provider_name, Some(json!("nvidia-prod")))
        .unwrap();
    assert!(
        state
            .resolve(&capabilities)
            .unwrap()
            .materialized_document()
            .is_some()
    );

    let before = state.values().clone();
    assert!(
        state
            .answer(&capabilities, preset, Some(json!("unknown")))
            .is_err()
    );
    assert_eq!(state.values(), &before);
    state
        .answer(&capabilities, preset, Some(json!("anthropic")))
        .unwrap();
    assert_eq!(
        state
            .values()
            .pointer("/spec/inferenceProviders/0/provider"),
        Some(&json!("anthropic"))
    );
    assert_eq!(
        state.values().pointer("/spec/inferenceProviders/0/name"),
        Some(&json!("anthropic-prod"))
    );
    assert_eq!(
        state.values().pointer("/spec/inferenceProviders/0/api"),
        Some(&json!("anthropic-messages"))
    );
    assert_eq!(
        state
            .values()
            .pointer("/spec/inferenceProviders/0/endpoint"),
        Some(&json!("https://api.anthropic.com"))
    );
    assert_eq!(
        state
            .values()
            .pointer("/spec/inferenceProviders/0/credential/env"),
        Some(&json!("ANTHROPIC_API_KEY"))
    );
    assert_eq!(
        state
            .values()
            .pointer("/spec/sandboxes/0/agent/inference/routes/0/providerRef"),
        Some(&json!("anthropic-prod"))
    );
    assert_eq!(
        state.values().pointer(model),
        Some(&json!("claude-sonnet-4-6"))
    );
    let resolved = state.resolve(&capabilities).unwrap();
    assert!(resolved.question(name).is_none());
    assert!(resolved.question(api).is_some());
    assert!(resolved.question(provider_name).is_some());
    assert!(resolved.question(model).is_some());
    assert!(resolved.materialized_document().is_none());
    assert!(
        state
            .answer(&capabilities, api, Some(json!("openai-completions")))
            .is_err()
    );
    state
        .answer(&capabilities, api, Some(json!("anthropic-messages")))
        .unwrap();
    state
        .answer(&capabilities, model, Some(json!("claude-sonnet-4-6")))
        .unwrap();
    state
        .answer(&capabilities, provider_name, Some(json!("anthropic-prod")))
        .unwrap();
    assert!(
        state
            .resolve(&capabilities)
            .unwrap()
            .materialized_document()
            .is_some()
    );
}

#[test]
fn compatible_inference_preset_requires_an_endpoint_answer() {
    let capabilities = Capabilities::available();
    let base =
        PartialDocument::from_yaml(include_bytes!("../../../examples/onboarding/openclaw.yaml"))
            .unwrap();
    let mut state = JourneyDefinition::new("custom", base)
        .ask([
            "inference:preset",
            "/spec/sandboxes/0/agent/inference/routes/0/overrides/model",
        ])
        .start(&capabilities)
        .unwrap();
    state
        .answer(
            &capabilities,
            "inference:preset",
            Some(json!("openai-compatible")),
        )
        .unwrap();
    let resolved = state.resolve(&capabilities).unwrap();
    assert!(
        resolved
            .question("/spec/inferenceProviders/0/endpoint")
            .is_some()
    );
    assert!(
        resolved
            .question("/spec/sandboxes/0/agent/inference/routes/0/overrides/model")
            .is_none()
    );
    assert!(
        state
            .values()
            .pointer("/spec/sandboxes/0/agent/inference/routes/0/overrides/model")
            .is_none()
    );
    assert!(resolved.materialized_document().is_none());
    let endpoint = "/spec/inferenceProviders/0/endpoint";
    let before = state.values().clone();
    assert!(
        state
            .answer(&capabilities, endpoint, Some(json!("file:///tmp/model")))
            .is_err()
    );
    assert_eq!(state.values(), &before);
    state
        .answer(
            &capabilities,
            endpoint,
            Some(json!("https://inference.internal.example/v1")),
        )
        .unwrap();
    assert!(
        state
            .resolve(&capabilities)
            .unwrap()
            .question("/spec/sandboxes/0/agent/inference/routes/0/overrides/model")
            .is_some()
    );
    state
        .answer(
            &capabilities,
            "/spec/sandboxes/0/agent/inference/routes/0/overrides/model",
            Some(json!("org/model")),
        )
        .unwrap();
    assert!(
        state
            .resolve(&capabilities)
            .unwrap()
            .question(endpoint)
            .is_none()
    );
}

#[test]
fn inference_dependencies_wait_for_preset_and_custom_endpoint() {
    let capabilities = Capabilities::available();
    let base =
        PartialDocument::from_yaml(include_bytes!("../../../examples/onboarding/openclaw.yaml"))
            .unwrap();
    let api = "/spec/inferenceProviders/0/api";
    let model = "/spec/sandboxes/0/agent/inference/routes/0/overrides/model";
    let endpoint = "/spec/inferenceProviders/0/endpoint";
    let preset = "inference:preset";
    let mut state = JourneyDefinition::new("order", base)
        .ask([api, model, preset])
        .start(&capabilities)
        .unwrap();
    let before = state.resolve(&capabilities).unwrap();
    assert_eq!(before.next_question().unwrap().id(), preset);
    assert!(before.question(api).is_none());
    assert!(before.question(model).is_none());

    state
        .answer(&capabilities, preset, Some(json!("openai-compatible")))
        .unwrap();
    let after = state.resolve(&capabilities).unwrap();
    assert!(after.question(api).is_some());
    assert!(after.question(endpoint).is_some());
    assert!(after.question(model).is_none());
    state
        .answer(
            &capabilities,
            endpoint,
            Some(json!("https://inference.internal.example/v1")),
        )
        .unwrap();
    assert!(
        state
            .resolve(&capabilities)
            .unwrap()
            .question(model)
            .is_some()
    );
}

#[test]
fn optional_sdk_question_can_be_deliberately_omitted() {
    let capabilities = Capabilities::available();
    let base =
        PartialDocument::from_yaml(include_bytes!("../../../examples/onboarding/openclaw.yaml"))
            .unwrap();
    let mut state = JourneyDefinition::new("optional-api", base)
        .ask(["/spec/inferenceProviders/0/api"])
        .omit([
            "adapter:nvidia.fabric.openclaw:/agent_name",
            "adapter:nvidia.fabric.openclaw:/cli",
            "adapter:nvidia.fabric.openclaw:/home",
            "adapter:nvidia.fabric.openclaw:/native_config",
            "adapter:nvidia.fabric.openclaw:/timeout_seconds",
        ])
        .start(&capabilities)
        .unwrap();
    let question = state
        .resolve(&capabilities)
        .unwrap()
        .next_question()
        .cloned()
        .unwrap();
    assert!(!question.required());
    state.answer(&capabilities, question.id(), None).unwrap();
    let resolved = state.resolve(&capabilities).unwrap();
    assert!(resolved.omitted().contains(&question.id().to_owned()));
    assert!(resolved.materialized_document().is_some());
}

#[test]
fn invalid_answer_does_not_mutate_a_sparse_journey() {
    let capabilities = Capabilities::available();
    let mut state = JourneyDefinition::new("minimum", minimum())
        .start(&capabilities)
        .unwrap();
    assert!(
        state
            .answer(&capabilities, "/metadata/name", Some(json!("Bad Name")))
            .is_err()
    );
    assert!(
        state
            .resolve(&capabilities)
            .unwrap()
            .question("/metadata/name")
            .is_some()
    );
}

#[test]
fn switching_harness_reopens_the_active_adapter_without_losing_its_values() {
    let capabilities = Capabilities::available();
    let base =
        PartialDocument::from_yaml(include_bytes!("../../../examples/onboarding/openclaw.yaml"))
            .unwrap();
    let definition = JourneyDefinition::new("switch", base).ask(["/spec/sandboxes/0/harness/kind"]);
    let mut state = definition.start(&capabilities).unwrap();
    state
        .answer(
            &capabilities,
            "/spec/sandboxes/0/harness/kind",
            Some(json!("nvidia.fabric.openclaw")),
        )
        .unwrap();
    state
        .answer(
            &capabilities,
            "adapter:nvidia.fabric.openclaw:/agent_name",
            Some(json!("kept-agent")),
        )
        .unwrap();
    state
        .answer(
            &capabilities,
            "/spec/sandboxes/0/harness/kind",
            Some(json!("nvidia.fabric.hermes")),
        )
        .unwrap();
    assert!(
        state
            .resolve(&capabilities)
            .unwrap()
            .question("adapter:nvidia.fabric.hermes:/mode")
            .is_some()
    );
    state
        .answer(
            &capabilities,
            "/spec/sandboxes/0/harness/kind",
            Some(json!("nvidia.fabric.openclaw")),
        )
        .unwrap();
    assert_eq!(
        state
            .values()
            .pointer("/spec/sandboxes/0/harness/settings/agent_name"),
        Some(&json!("kept-agent"))
    );
}

#[test]
fn accepted_answers_can_be_revisited_without_losing_other_values() {
    let capabilities = Capabilities::available();
    let mut state = JourneyDefinition::new("minimum", minimum())
        .start(&capabilities)
        .unwrap();
    state
        .answer(&capabilities, "/metadata/name", Some(json!("first")))
        .unwrap();
    state
        .answer(&capabilities, "/metadata/name", Some(json!("second")))
        .unwrap();
    state
        .answer(
            &capabilities,
            "/spec/sandboxes/0/harness/kind",
            Some(json!("nvidia.fabric.openclaw")),
        )
        .unwrap();
    state
        .answer(
            &capabilities,
            "adapter:nvidia.fabric.openclaw:/agent_name",
            Some(json!("alpha")),
        )
        .unwrap();
    state
        .answer(
            &capabilities,
            "adapter:nvidia.fabric.openclaw:/agent_name",
            Some(json!("beta")),
        )
        .unwrap();

    assert_eq!(
        state.values().pointer("/metadata/name"),
        Some(&json!("second"))
    );
    assert_eq!(
        state
            .values()
            .pointer("/spec/sandboxes/0/harness/settings/agent_name"),
        Some(&json!("beta"))
    );
}

#[test]
fn fabric_invalid_value_reopens_a_question_even_when_sdk_document_is_valid() {
    let capabilities = Capabilities::available();
    let mut base: serde_json::Value =
        serde_saphyr::from_slice(include_bytes!("../../../examples/onboarding/openclaw.yaml"))
            .unwrap();
    base["spec"]["sandboxes"][0]["harness"]["settings"] = json!({"cli": 42});
    let base = PartialDocument::from_yaml(base.to_string().as_bytes()).unwrap();
    let mut state = JourneyDefinition::new("fabric-invalid", base)
        .start(&capabilities)
        .unwrap();
    let resolved = state.resolve(&capabilities).unwrap();
    assert!(resolved.assessment().document().is_some());
    assert_eq!(
        resolved
            .question("adapter:nvidia.fabric.openclaw:/cli")
            .unwrap()
            .reason(),
        JourneyQuestionReason::InvalidSupplied
    );

    state
        .answer(
            &capabilities,
            "adapter:nvidia.fabric.openclaw:/cli",
            Some(json!("openclaw")),
        )
        .unwrap();
    assert!(
        state
            .resolve(&capabilities)
            .unwrap()
            .question("adapter:nvidia.fabric.openclaw:/cli")
            .is_none()
    );
}

#[test]
fn fully_supplied_express_definition_has_no_current_questions() {
    let capabilities = Capabilities::available();
    let base =
        PartialDocument::from_yaml(include_bytes!("../../../examples/onboarding/openclaw.yaml"))
            .unwrap();
    let definition = JourneyDefinition::new("express", base).omit([
        "adapter:nvidia.fabric.openclaw:/agent_name",
        "adapter:nvidia.fabric.openclaw:/cli",
        "adapter:nvidia.fabric.openclaw:/home",
        "adapter:nvidia.fabric.openclaw:/native_config",
        "adapter:nvidia.fabric.openclaw:/timeout_seconds",
    ]);

    let resolved = definition
        .start(&capabilities)
        .unwrap()
        .resolve(&capabilities)
        .unwrap();
    assert!(resolved.questions().is_empty());
    assert!(resolved.assessment().document().is_some());
    assert!(resolved.unverified().is_empty());
}

#[test]
fn missing_catalog_schema_keeps_unreachable_guidance_as_a_warning() {
    let capabilities = Capabilities::from_harnesses(["nvidia.fabric.openclaw".parse().unwrap()]);
    let base =
        PartialDocument::from_yaml(include_bytes!("../../../examples/onboarding/openclaw.yaml"))
            .unwrap();
    let definition =
        JourneyDefinition::new("catalog-gap", base).ask(["adapter:nvidia.fabric.hermes:/mode"]);

    let resolved = definition
        .start(&capabilities)
        .unwrap()
        .resolve(&capabilities)
        .unwrap();
    assert!(
        resolved
            .warnings()
            .iter()
            .any(|warning| warning.contains("adapter:nvidia.fabric.hermes:/mode"))
    );
    assert!(!resolved.unverified().is_empty());
}

#[test]
fn supplied_template_can_finish_a_guided_journey_through_one_resolver() {
    let capabilities = Capabilities::available();
    let base =
        PartialDocument::from_yaml(include_bytes!("../../../examples/onboarding/openclaw.yaml"))
            .unwrap();
    let definition = JourneyDefinition::new("guided-complete", base)
        .ask(["/metadata/name", "/spec/sandboxes/0/harness/kind"])
        .omit([
            "adapter:nvidia.fabric.openclaw:/agent_name",
            "adapter:nvidia.fabric.openclaw:/cli",
            "adapter:nvidia.fabric.openclaw:/home",
            "adapter:nvidia.fabric.openclaw:/native_config",
            "adapter:nvidia.fabric.openclaw:/timeout_seconds",
        ]);
    let mut state = definition.start(&capabilities).unwrap();
    assert_eq!(state.resolve(&capabilities).unwrap().questions().len(), 2);
    assert!(
        state
            .resolve(&capabilities)
            .unwrap()
            .assessment()
            .document()
            .is_some()
    );
    assert!(
        state
            .resolve(&capabilities)
            .unwrap()
            .materialized_document()
            .is_none()
    );

    state
        .answer(
            &capabilities,
            "/metadata/name",
            Some(json!("guided-complete")),
        )
        .unwrap();
    state
        .answer(
            &capabilities,
            "/spec/sandboxes/0/harness/kind",
            Some(json!("nvidia.fabric.openclaw")),
        )
        .unwrap();
    let resolved = state.resolve(&capabilities).unwrap();

    assert!(resolved.questions().is_empty());
    assert!(resolved.unverified().is_empty());
    assert!(resolved.materialized_document().is_some());
    assert_eq!(
        resolved.assessment().document().unwrap().metadata.name,
        "guided-complete"
    );
}

#[test]
fn absent_harness_catalog_cannot_silently_accept_an_unadvertised_choice() {
    let capabilities = Capabilities::from_harnesses([]);
    let mut state = JourneyDefinition::new("empty-catalog", minimum())
        .start(&capabilities)
        .unwrap();
    let resolved = state.resolve(&capabilities).unwrap();
    assert!(
        resolved
            .question("/spec/sandboxes/0/harness/kind")
            .is_some()
    );
    assert!(!resolved.unverified().is_empty());
    assert!(
        state
            .answer(
                &capabilities,
                "/spec/sandboxes/0/harness/kind",
                Some(json!("nvidia.fabric.openclaw"))
            )
            .is_err()
    );
}
