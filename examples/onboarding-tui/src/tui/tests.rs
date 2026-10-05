// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::{
    app::JourneyWizard,
    labels::{label, terminal_text},
    logo::BrandImage,
    terminal::observe_queries,
};
use crate::{Source, load_journey};
use nemoclaw_authoring::{
    Capabilities, JourneyDefinition, PartialDocument, TargetPrerequisite,
    discovery_key_for_document, inference_request_for_document,
};
use nemoclaw_sdk::{
    CancellationToken,
    config::Document,
    discovery::DiscoveryRequest,
    discovery_session::{DiscoveryObservation, DiscoveryQuery},
};
use ratatui::{Terminal, backend::TestBackend};
use serde_json::Value;

#[test]
fn onboarding_screen_keeps_the_existing_wordmark() {
    let capabilities = Capabilities::available();
    let state = load_journey(Source::Defaults, &capabilities).unwrap();
    let mut wizard = JourneyWizard::new(capabilities, state);
    wizard.started = true;
    let mut terminal = Terminal::new(TestBackend::new(120, 30)).unwrap();
    terminal.draw(|frame| wizard.render(frame)).unwrap();
    let screen = terminal.backend().to_string();
    assert!(screen.contains("███╗"), "missing wordmark: {screen}");
    assert!(
        screen
            .chars()
            .any(|character| ('\u{2800}'..='\u{28ff}').contains(&character)),
        "missing the prior logo texture: {screen}"
    );
}

#[test]
fn compatible_terminal_keeps_the_brand_image_beside_the_wordmark() {
    let capabilities = Capabilities::available();
    let state = load_journey(Source::Defaults, &capabilities).unwrap();
    let wizard = JourneyWizard::new(capabilities, state);
    let mut terminal = Terminal::new(TestBackend::new(120, 30)).unwrap();
    terminal
        .draw(|frame| wizard.render_with_brand(frame, Some(BrandImage::from_id(0x12_34_56))))
        .unwrap();
    let screen = terminal.backend().to_string();
    assert!(
        screen
            .lines()
            .any(|line| line.contains('\u{10eeee}') && line.contains("██╔██╗")),
        "{screen}"
    );
}

#[test]
fn narrow_terminal_asks_for_resize_instead_of_clipping_questions() {
    let capabilities = Capabilities::available();
    let state = load_journey(Source::Defaults, &capabilities).unwrap();
    let mut wizard = JourneyWizard::new(capabilities, state);
    wizard.started = true;
    let mut terminal = Terminal::new(TestBackend::new(70, 20)).unwrap();
    terminal.draw(|frame| wizard.render(frame)).unwrap();
    let screen = terminal.backend().to_string();
    assert!(screen.contains("Resize to continue."), "{screen}");
    assert!(!screen.contains("Deployment name"), "{screen}");
}

#[test]
fn review_scroll_reveals_later_yaml_without_changing_the_document() {
    let capabilities = Capabilities::available();
    let state = load_journey(Source::Defaults, &capabilities).unwrap();
    let mut wizard = JourneyWizard::new(capabilities, state);
    for _ in 0..40 {
        wizard.advance();
        if wizard.accepted {
            break;
        }
    }
    assert!(wizard.accepted);
    let before_document = wizard.document().unwrap().yaml().unwrap();
    let mut terminal = Terminal::new(TestBackend::new(100, 24)).unwrap();
    terminal.draw(|frame| wizard.render(frame)).unwrap();
    let first = terminal.backend().to_string();
    for _ in 0..12 {
        wizard.next();
    }
    terminal.draw(|frame| wizard.render(frame)).unwrap();
    let later = terminal.backend().to_string();
    assert_ne!(first, later, "review did not scroll");
    assert_eq!(wizard.document().unwrap().yaml().unwrap(), before_document);
}

#[test]
fn external_terminal_text_escapes_controls_without_changing_the_value() {
    let value = "fixture\u{1b}[31m\n\u{202e}agent";
    assert_eq!(terminal_text(value), "fixture\\u{1b}[31m\\n\\u{202e}agent");
    assert_eq!(value, "fixture\u{1b}[31m\n\u{202e}agent");
}

#[test]
fn root_adapter_alternatives_accept_json_object_input() {
    use nemoclaw_sdk::fabric_catalog::FabricCatalog;

    let mut catalog = FabricCatalog::bundled();
    let mut adapter = catalog.adapters[0].clone();
    adapter.descriptor["adapter_id"] = serde_json::json!("fixture-root-agent");
    adapter.descriptor["settings_schema"] = serde_json::json!({
        "oneOf": [
            {"type":"object", "properties":{"token":{"type":"string"}}, "required":["token"], "additionalProperties":false},
            {"type":"object", "properties":{"port":{"type":"integer"}}, "required":["port"], "additionalProperties":false}
        ]
    });
    catalog.adapters = vec![adapter];
    let capabilities = Capabilities::from_catalog(&catalog);
    let mut values: Value =
        serde_saphyr::from_slice(include_bytes!("../../../onboarding/openclaw.yaml")).unwrap();
    values["spec"]["sandboxes"][0]["harness"]["kind"] = serde_json::json!("fixture-root-agent");
    values["spec"]["sandboxes"][0]["harness"]
        .as_object_mut()
        .unwrap()
        .remove("settings");
    let base = PartialDocument::from_yaml(values.to_string().as_bytes()).unwrap();
    let state = JourneyDefinition::new("root-alternatives", base)
        .start(&capabilities)
        .unwrap();
    let mut wizard = JourneyWizard::new(capabilities, state);
    let question = wizard.question().unwrap().unwrap();
    assert_eq!(question.id(), "adapter:fixture-root-agent:");
    assert_eq!(label(&question), "Adapter settings");
    wizard.input = r#"{"port":443}"#.into();
    assert_eq!(
        wizard.answer_from_input(&question).unwrap(),
        Some(serde_json::json!({"port":443}))
    );
}

#[test]
fn resolver_failure_is_not_reported_as_a_finished_questionnaire() {
    use nemoclaw_sdk::fabric_catalog::FabricCatalog;

    let mut catalog = FabricCatalog::bundled();
    let mut first = catalog.adapters[0].clone();
    first.descriptor["adapter_id"] = serde_json::json!("fixture-schema-agent");
    first.descriptor["settings_schema"] =
        serde_json::json!({"type":"object","properties":{"a":{"type":"string"}}});
    let mut second = first.clone();
    second.descriptor["settings_schema"] =
        serde_json::json!({"type":"object","properties":{"b":{"type":"boolean"}}});
    catalog.adapters = vec![first, second];
    let capabilities = Capabilities::from_catalog(&catalog);
    let mut values: Value =
        serde_saphyr::from_slice(include_bytes!("../../../onboarding/openclaw.yaml")).unwrap();
    values["spec"]["sandboxes"][0]["harness"]["kind"] = serde_json::json!("fixture-schema-agent");
    let base = PartialDocument::from_yaml(values.to_string().as_bytes()).unwrap();
    let state = JourneyDefinition::new("conflicting-descriptors", base)
        .start(&capabilities)
        .unwrap();
    let mut wizard = JourneyWizard::new(capabilities, state);
    assert!(wizard.question().is_err());
    wizard.started = true;
    wizard.advance();
    assert!(!wizard.accepted);
    assert!(
        wizard
            .error
            .as_deref()
            .unwrap()
            .contains("ambiguous setting schemas")
    );
    wizard.next();
    wizard.previous();
    let mut terminal = Terminal::new(TestBackend::new(160, 30)).unwrap();
    terminal.draw(|frame| wizard.render(frame)).unwrap();
    let screen = terminal.backend().to_string();
    assert!(
        screen.contains("Press ← to go back"),
        "missing recovery hint: {screen}"
    );
}

#[test]
fn configured_target_prerequisite_blocks_save_until_observed() {
    let capabilities = Capabilities::available();
    let base =
        PartialDocument::from_yaml(include_bytes!("../../../onboarding/openclaw.yaml")).unwrap();
    let state = JourneyDefinition::new("target-gated", base)
        .omit([
            "adapter:nvidia.fabric.openclaw:/agent_name",
            "adapter:nvidia.fabric.openclaw:/cli",
            "adapter:nvidia.fabric.openclaw:/home",
            "adapter:nvidia.fabric.openclaw:/native_config",
            "adapter:nvidia.fabric.openclaw:/timeout_seconds",
        ])
        .require_target([TargetPrerequisite::EngineAndImageCompatible])
        .start(&capabilities)
        .unwrap();
    let mut wizard = JourneyWizard::new(capabilities, state);
    wizard.started = true;
    assert!(wizard.question().unwrap().is_none());
    wizard.advance();
    assert!(!wizard.accepted);
    assert!(
        wizard
            .error
            .as_deref()
            .unwrap()
            .contains("Target compatibility")
    );
}

#[test]
fn wizard_uses_the_shared_resolver_for_an_sdk_form_choice() {
    let capabilities = Capabilities::available();
    let mut values: serde_json::Value =
        serde_saphyr::from_slice(include_bytes!("../../../onboarding/openclaw.yaml")).unwrap();
    values["spec"]["sandboxes"][0]["agent"]
        .as_object_mut()
        .unwrap()
        .remove("inference");
    let base = PartialDocument::from_yaml(values.to_string().as_bytes()).unwrap();
    let state = JourneyDefinition::new("agent-form", base)
        .start(&capabilities)
        .unwrap();
    let mut wizard = JourneyWizard::new(capabilities, state);
    let question = wizard.question().unwrap().unwrap();
    assert_eq!(question.id(), "form:/spec/sandboxes/0/agent");
    assert_eq!(label(&question), "Choose agent form");
    wizard
        .submit(Some(serde_json::json!("inferenceRef")))
        .unwrap();
    assert_eq!(
        wizard.question().unwrap().unwrap().id(),
        "/spec/sandboxes/0/agent/inferenceRef"
    );
}

#[test]
fn enter_uses_the_supplied_choice_suggestion() {
    let capabilities = Capabilities::available();
    let state = load_journey(Source::Defaults, &capabilities).unwrap();
    let mut wizard = JourneyWizard::new(capabilities, state);
    wizard.advance();
    wizard.advance();
    assert_eq!(
        wizard.question().unwrap().unwrap().id(),
        "/spec/sandboxes/0/harness/kind"
    );
    wizard.advance();
    assert_eq!(
        wizard
            .state
            .values()
            .pointer("/spec/sandboxes/0/harness/kind"),
        Some(&serde_json::json!("nvidia.fabric.openclaw"))
    );
}

#[test]
fn back_restores_the_previous_answer_without_rewriting_the_template() {
    let capabilities = Capabilities::available();
    let state = load_journey(Source::Defaults, &capabilities).unwrap();
    let original_name = state.values().pointer("/metadata/name").cloned();
    let mut wizard = JourneyWizard::new(capabilities, state);
    wizard
        .submit(Some(serde_json::json!("chosen-name")))
        .unwrap();
    assert_eq!(
        wizard.question().unwrap().unwrap().id(),
        "/spec/sandboxes/0/harness/kind"
    );
    wizard.back();
    assert_eq!(wizard.question().unwrap().unwrap().id(), "/metadata/name");
    assert_eq!(
        wizard.state.values().pointer("/metadata/name"),
        original_name.as_ref()
    );
}

#[test]
fn optional_question_can_be_omitted_through_the_new_wizard() {
    let capabilities = Capabilities::available();
    let state = load_journey(Source::Defaults, &capabilities).unwrap();
    let mut wizard = JourneyWizard::new(capabilities, state);
    for _ in 0..30 {
        if wizard
            .question()
            .unwrap()
            .is_some_and(|question| !question.required())
        {
            let id = wizard.question().unwrap().unwrap().id().to_owned();
            wizard.submit(None).unwrap();
            assert!(
                wizard
                    .state
                    .resolve(&wizard.capabilities)
                    .unwrap()
                    .omitted()
                    .contains(&id)
            );
            return;
        }
        wizard.advance();
        assert!(wizard.error.is_none(), "{:?}", wizard.error);
    }
    panic!("the default journey has no optional question");
}

#[test]
fn default_path_reaches_a_valid_document_through_the_new_wizard() {
    let capabilities = Capabilities::available();
    let state = load_journey(Source::Defaults, &capabilities).unwrap();
    let mut wizard = JourneyWizard::new(capabilities, state);
    for _ in 0..40 {
        wizard.advance();
        if wizard.accepted {
            break;
        }
        assert!(
            wizard.error.is_none(),
            "question={:?} error={:?}",
            wizard
                .question()
                .unwrap()
                .map(|question| question.id().to_owned()),
            wizard.error
        );
    }
    assert!(
        wizard.accepted,
        "remaining={:?}",
        wizard
            .question()
            .unwrap()
            .map(|question| question.id().to_owned())
    );
    assert!(wizard.document().is_ok());
}

#[test]
fn mixed_local_and_hosted_template_reaches_review_without_losing_routes() {
    let path =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../spark/local-and-hosted.yaml");
    let capabilities = Capabilities::available();
    let state = load_journey(Source::Template(&path), &capabilities).unwrap();
    let mut wizard = JourneyWizard::new(capabilities, state);
    for _ in 0..80 {
        wizard.advance();
        if wizard.accepted {
            break;
        }
        assert!(
            wizard.error.is_none(),
            "question={:?} error={:?}",
            wizard
                .question()
                .unwrap()
                .map(|question| question.id().to_owned()),
            wizard.error
        );
    }
    assert!(
        wizard.accepted,
        "remaining={:?}",
        wizard
            .question()
            .unwrap()
            .map(|question| question.id().to_owned())
    );
    let document = wizard.document().unwrap();
    assert_eq!(
        document.spec.sandboxes[0]
            .agent
            .inference
            .as_ref()
            .unwrap()
            .routes
            .len(),
        2
    );
}

/// Walk one example's sparse journey to review, requiring friendly text for every question.
/// Examples with more than one sandbox are outside the single-sandbox journey.
fn example_reaches_review(relative: &str) {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join(relative);
    let document = Document::parse(std::fs::read(&path).unwrap().as_slice())
        .unwrap_or_else(|error| panic!("{relative}: {error}"));
    if document.spec.sandboxes.len() != 1 {
        return;
    }
    let capabilities = Capabilities::available();
    let state = load_journey(Source::Template(&path), &capabilities)
        .unwrap_or_else(|error| panic!("{relative}: {error}"));
    let mut wizard = JourneyWizard::new(capabilities, state);
    let mut missing_text = std::collections::BTreeSet::new();
    for _ in 0..100 {
        if let Ok(Some(question)) = wizard.question()
            && let Some(missing) = super::labels::missing_text(&question)
        {
            missing_text.insert(format!("{} has no {missing}", question.id()));
        }
        wizard.advance();
        if wizard.accepted || wizard.error.is_some() {
            break;
        }
    }
    assert!(
        wizard.accepted,
        "{relative}: question={:?} error={:?}",
        wizard
            .question()
            .unwrap()
            .map(|question| question.id().to_owned()),
        wizard.error
    );
    // Add friendly text in text.json for NemoClaw-owned questions.
    assert!(missing_text.is_empty(), "{relative}: {missing_text:#?}");
}

// One test per example, generated by build.rs, so examples run in parallel with
// separate time limits and a new example is covered without listing it.
mod example_journeys {
    include!(concat!(env!("OUT_DIR"), "/example_journeys.rs"));
}

#[test]
fn existing_model_metadata_is_offered_as_an_editable_suggestion() {
    let capabilities = Capabilities::available();
    let state = load_journey(Source::Defaults, &capabilities).unwrap();
    let mut wizard = JourneyWizard::new(capabilities, state);
    let mut seen = Vec::new();
    for _ in 0..40 {
        if wizard
            .question()
            .unwrap()
            .is_some_and(|question| question.id() == "model:/model_metadata")
        {
            return;
        }
        seen.push(
            wizard
                .question()
                .unwrap()
                .map(|question| question.id().to_owned()),
        );
        wizard.advance();
        assert!(wizard.error.is_none(), "{:?}", wizard.error);
    }
    panic!("The supplied model metadata was skipped; seen={seen:?}");
}

#[test]
fn discovered_model_menu_keeps_a_custom_text_answer() {
    use nemoclaw_sdk::{
        discovery::ObservationStatus,
        inference_discovery::{AuthenticationStatus, EndpointObservation},
    };
    let capabilities = Capabilities::available();
    let state = load_journey(Source::Defaults, &capabilities).unwrap();
    let mut wizard = JourneyWizard::new(capabilities, state);
    for _ in 0..12 {
        if wizard
            .question()
            .unwrap()
            .as_ref()
            .is_some_and(|question| question.allows_custom_answer())
        {
            break;
        }
        wizard.advance();
    }
    let document = wizard
        .state
        .resolve(&wizard.capabilities)
        .unwrap()
        .assessment()
        .document()
        .unwrap()
        .clone();
    wizard.observations.record(
        DiscoveryQuery::Inference(
            inference_request_for_document(&document, wizard.state.current_route())
                .unwrap()
                .unwrap(),
        ),
        DiscoveryObservation::Inference(EndpointObservation {
            status: ObservationStatus::Available,
            reason: None,
            source: "fixture".into(),
            reachable: Some(true),
            authentication: AuthenticationStatus::Accepted,
            models: vec!["vendor/discovered".into()],
            api_verified: false,
        }),
    );
    let question = wizard.question().unwrap().unwrap();
    assert!(
        question
            .choices()
            .contains(&serde_json::json!("vendor/discovered"))
    );
    wizard.selected = question.choices().len();
    wizard.selection_changed = true;
    wizard.advance();
    assert!(wizard.custom_answer);
    wizard.input = "private/custom".into();
    wizard.advance();
    assert_eq!(
        wizard.state.values().pointer(question.id()),
        Some(&serde_json::json!("private/custom"))
    );
}

#[test]
fn tui_preserves_podman_as_an_authored_target_choice() {
    let capabilities = Capabilities::available();
    let state = load_journey(Source::Defaults, &capabilities).unwrap();
    let mut wizard = JourneyWizard::new(capabilities, state);
    for _ in 0..5 {
        if wizard
            .question()
            .unwrap()
            .is_some_and(|question| question.id() == "/spec/sandboxes/0/runtime/provider")
        {
            break;
        }
        wizard.advance();
    }
    let question = wizard.question().unwrap().unwrap();
    wizard.selected = question
        .choices()
        .iter()
        .position(|choice| choice == "podman")
        .unwrap();
    wizard.selection_changed = true;
    wizard.advance();
    assert!(wizard.error.is_none());
    assert_eq!(
        wizard.state.values().pointer(question.id()),
        Some(&serde_json::json!("podman"))
    );
}

#[test]
fn enter_accepts_the_runtime_this_machine_can_run() {
    let capabilities = Capabilities::available();
    let state = load_journey(Source::Defaults, &capabilities).unwrap();
    let mut wizard = JourneyWizard::new(capabilities, state);
    // Only Podman answered when this machine was read, but the template says Docker.
    wizard.observations = serde_json::from_str(include_str!(
        "../../../../crates/nemoclaw-authoring/tests/fixtures/observations/podman-only.json"
    ))
    .unwrap();
    for _ in 0..5 {
        if wizard
            .question()
            .unwrap()
            .is_some_and(|question| question.id() == "/spec/sandboxes/0/runtime/provider")
        {
            break;
        }
        wizard.advance();
    }
    wizard.advance();
    assert!(wizard.error.is_none(), "{:?}", wizard.error);
    assert_eq!(
        wizard
            .state
            .values()
            .pointer("/spec/sandboxes/0/runtime/provider"),
        Some(&serde_json::json!("podman"))
    );
}

#[test]
fn review_uses_authoring_readiness_for_an_observed_target_conflict() {
    let capabilities = Capabilities::available();
    let base =
        PartialDocument::from_yaml(include_bytes!("../../../onboarding/openclaw.yaml")).unwrap();
    let state = JourneyDefinition::new("conflicted-target", base)
        .omit([
            "adapter:nvidia.fabric.openclaw:/agent_name",
            "adapter:nvidia.fabric.openclaw:/cli",
            "adapter:nvidia.fabric.openclaw:/home",
            "adapter:nvidia.fabric.openclaw:/native_config",
            "adapter:nvidia.fabric.openclaw:/timeout_seconds",
        ])
        .start(&capabilities)
        .unwrap();
    let document = state
        .resolve(&capabilities)
        .unwrap()
        .materialized_document()
        .unwrap()
        .clone();
    let mut wizard = JourneyWizard::new(capabilities, state);
    let key = discovery_key_for_document(&document).unwrap();
    wizard.observations.record(
        DiscoveryQuery::Engine(DiscoveryRequest {
            engine: key.engine,
            compute_driver: key.compute_driver,
        }),
        DiscoveryObservation::Engine(nemoclaw_sdk::discovery::EngineObservation {
            status: nemoclaw_sdk::discovery::ObservationStatus::Unavailable,
            reason: Some("target rejected engine".into()),
            source: "fixture".into(),
            server_version: None,
            architecture: None,
            operating_system: None,
            memory_bytes: None,
            cpus: None,
        }),
    );
    wizard.started = true;
    wizard.advance();

    assert!(!wizard.accepted);
    assert!(
        wizard
            .error
            .as_deref()
            .is_some_and(|error| error.contains("selected engine"))
    );
}

#[tokio::test]
async fn unavailable_optional_bundle_keeps_model_discovery_unverified() {
    let capabilities = Capabilities::available();
    let state = load_journey(Source::Defaults, &capabilities).unwrap();
    let document = state
        .resolve(&capabilities)
        .unwrap()
        .assessment()
        .document()
        .unwrap()
        .clone();
    let request = inference_request_for_document(&document, state.current_route())
        .unwrap()
        .unwrap();
    let missing = std::path::Path::new("/definitely/missing/nemoclaw-bundle");
    let observed = observe_queries(
        missing,
        vec![DiscoveryQuery::Inference(request.clone())],
        &CancellationToken::new(),
    )
    .await
    .unwrap();
    // With no provider session the model catalog is unknown, never absent.
    let catalog = observed
        .inference(&request)
        .expect("the attempt is recorded");
    assert_eq!(
        catalog.status,
        nemoclaw_sdk::discovery::ObservationStatus::Unknown
    );
}
