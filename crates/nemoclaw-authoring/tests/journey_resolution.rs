// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_authoring::{Capabilities, JourneyDefinition, JourneyQuestionReason, PartialDocument};
use serde_json::json;

fn minimum() -> PartialDocument {
    PartialDocument::from_yaml(
        b"apiVersion: nemoclaw.nvidia.com/v1alpha1\nkind: NemoClawConfig\nspec:\n  sandboxes:\n    - {}\n",
    )
    .unwrap()
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
