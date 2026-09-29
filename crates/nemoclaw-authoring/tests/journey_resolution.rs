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
