// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::{
    app::JourneyWizard,
    labels::{label, terminal_text},
    logo::BrandImage,
    terminal::{ask_target, credential_probe, local_engine_probe, model_catalog_probe},
};
use crate::{Source, load_journey};
use nemoclaw_authoring::{
    Capabilities, JourneyDefinition, JourneyQuestionKind, PartialDocument, TargetPrerequisite,
    discovery_queries, inference_request_for_document,
};
use nemoclaw_sdk::discovery::DiscoveryObservations;
use nemoclaw_sdk::{
    CancellationToken, Error,
    config::{ComputeDriver, Document},
    discovery::{
        CredentialRequest, DiscoveryObservation, DiscoveryQuery, DiscoveryRequest,
        EngineObservation, ObservationStatus,
    },
    inference_discovery::{CredentialObservation, EndpointObservation},
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
    let mut values: Value = serde_saphyr::from_slice(include_bytes!(
        "../../../../examples/onboarding/openclaw.yaml"
    ))
    .unwrap();
    values["spec"]["sandboxes"]["assistant"]["harness"]["kind"] =
        serde_json::json!("fixture-root-agent");
    values["spec"]["sandboxes"]["assistant"]["harness"]
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
    let mut values: Value = serde_saphyr::from_slice(include_bytes!(
        "../../../../examples/onboarding/openclaw.yaml"
    ))
    .unwrap();
    values["spec"]["sandboxes"]["assistant"]["harness"]["kind"] =
        serde_json::json!("fixture-schema-agent");
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
    let base = PartialDocument::from_yaml(include_bytes!(
        "../../../../examples/onboarding/openclaw.yaml"
    ))
    .unwrap();
    let state = JourneyDefinition::new("target-gated", base)
        .omit([
            "adapter:nvidia.fabric.openclaw:/agent_id",
            "adapter:nvidia.fabric.openclaw:/channel_config",
            "adapter:nvidia.fabric.openclaw:/connect_timeout_seconds",
            "adapter:nvidia.fabric.openclaw:/openclaw_command",
            "adapter:nvidia.fabric.openclaw:/port_range",
            "adapter:nvidia.fabric.openclaw:/read_timeout_seconds",
            "adapter:nvidia.fabric.openclaw:/shutdown_timeout_seconds",
            "adapter:nvidia.fabric.openclaw:/startup_timeout_seconds",
        ])
        .require_target([TargetPrerequisite::EngineAndImageCompatible])
        .start(&capabilities)
        .unwrap();
    let mut wizard = JourneyWizard::new(capabilities, state);
    wizard.started = true;
    assert!(wizard.question().unwrap().is_none());
    wizard.advance();
    assert!(!wizard.accepted);
    assert_eq!(wizard.error, None);
    assert!(
        flat(&screen(&wizard, 100, 30)).contains("Target compatibility"),
        "the review must say what it waits for"
    );
}

#[test]
fn wizard_uses_the_shared_resolver_for_an_sdk_form_choice() {
    let capabilities = Capabilities::available();
    let mut values: serde_json::Value = serde_saphyr::from_slice(include_bytes!(
        "../../../../examples/onboarding/openclaw.yaml"
    ))
    .unwrap();
    values["spec"]["sandboxes"]["assistant"]["agent"]
        .as_object_mut()
        .unwrap()
        .remove("inference");
    let base = PartialDocument::from_yaml(values.to_string().as_bytes()).unwrap();
    let state = JourneyDefinition::new("agent-form", base)
        .start(&capabilities)
        .unwrap();
    let mut wizard = JourneyWizard::new(capabilities, state);
    let question = wizard.question().unwrap().unwrap();
    assert_eq!(question.id(), "form:/spec/sandboxes/assistant/agent");
    assert_eq!(label(&question), "Choose agent form");
    wizard
        .submit(Some(serde_json::json!("inferenceRef")))
        .unwrap();
    assert_eq!(
        wizard.question().unwrap().unwrap().id(),
        "/spec/sandboxes/assistant/agent/inferenceRef"
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
        "/spec/sandboxes/assistant/harness/kind"
    );
    wizard.advance();
    assert_eq!(
        wizard
            .state()
            .values()
            .pointer("/spec/sandboxes/assistant/harness/kind"),
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
        "/spec/sandboxes/assistant/harness/kind"
    );
    wizard.back();
    assert_eq!(wizard.question().unwrap().unwrap().id(), "/metadata/name");
    assert_eq!(
        wizard.state().values().pointer("/metadata/name"),
        original_name.as_ref()
    );
}

/// A template's sandbox keeps its name. The harness question holds that name
/// and keeps its friendly text.
#[test]
fn a_template_sandbox_keeps_its_name_in_questions_and_text() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("template.yaml");
    let mut values: Value = serde_saphyr::from_slice(include_bytes!(
        "../../../../examples/onboarding/openclaw.yaml"
    ))
    .unwrap();
    let sandboxes = values["spec"]["sandboxes"].as_object_mut().unwrap();
    let sandbox = sandboxes.remove("assistant").unwrap();
    sandboxes.insert("reviewer".into(), sandbox);
    std::fs::write(&path, serde_json::to_vec(&values).unwrap()).unwrap();
    let capabilities = Capabilities::available();
    let state = load_journey(Source::Template(&path), &capabilities).unwrap();
    let mut wizard = JourneyWizard::new(capabilities, state);
    wizard
        .submit(Some(serde_json::json!("reviewed-deployment")))
        .unwrap();
    let question = wizard.question().unwrap().unwrap();
    assert_eq!(question.id(), "/spec/sandboxes/reviewer/harness/kind");
    assert_eq!(super::labels::title(&question), "Choose your agent harness");
    wizard
        .submit(Some(serde_json::json!("nvidia.fabric.hermes")))
        .unwrap();
    let sandboxes = wizard.state().values()["spec"]["sandboxes"]
        .as_object()
        .unwrap();
    assert_eq!(sandboxes.keys().collect::<Vec<_>>(), ["reviewer"]);
    assert_eq!(
        sandboxes["reviewer"]["harness"]["kind"],
        "nvidia.fabric.hermes"
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
                    .state()
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

/// Accept every suggestion and return the questions in the order asked.
fn questions_until_review(wizard: &mut JourneyWizard) -> Vec<String> {
    wizard.started = true;
    let mut asked = Vec::new();
    for _ in 0..40 {
        if let Some(question) = wizard.question().unwrap() {
            asked.push(question.id().to_owned());
        }
        wizard.advance();
        assert!(wizard.error.is_none(), "{asked:?}: {:?}", wizard.error);
        if wizard.accepted {
            return asked;
        }
    }
    panic!("the journey did not reach review: {asked:?}");
}

#[test]
fn default_journey_asks_route_choices_and_leaves_tuning_settings_at_their_defaults() {
    let capabilities = Capabilities::available();
    let state = load_journey(Source::Defaults, &capabilities).unwrap();
    let mut wizard = JourneyWizard::new(capabilities, state);
    assert_eq!(
        questions_until_review(&mut wizard),
        [
            "/metadata/name",
            "/spec/sandboxes/assistant/harness/kind",
            "/spec/gateway/runtime/provider",
            "inference:preset",
            "adapter:nvidia.fabric.openclaw:/channel_config",
            "/spec/inferenceProviders/nvidia-prod/api",
            "/spec/sandboxes/assistant/agent/inference/routes/0/overrides/model",
            "/spec/gateway/engine",
            "/spec/sandboxes/assistant/image/ref",
            "/spec/sandboxes/assistant/network/tier",
        ]
    );
}

#[test]
fn default_journey_saves_the_reviewed_deployment_without_unasked_sdk_defaults() {
    let capabilities = Capabilities::available();
    let state = load_journey(Source::Defaults, &capabilities).unwrap();
    let mut wizard = JourneyWizard::new(capabilities, state);
    questions_until_review(&mut wizard);
    let yaml = wizard.saved_yaml().unwrap();
    let saved: Value = serde_saphyr::from_str(&yaml).unwrap();
    let gateway = saved["spec"]["gateway"].as_object().unwrap();
    assert!(!gateway.contains_key("endpoint"), "{yaml}");
    assert!(!gateway.contains_key("networkCIDR"), "{yaml}");
    assert!(
        saved
            .pointer("/spec/sandboxes/assistant/harness/settings")
            .and_then(Value::as_object)
            .is_none_or(serde_json::Map::is_empty),
        "{yaml}"
    );
    assert_eq!(
        Document::parse(yaml.as_bytes()).unwrap(),
        wizard.document().unwrap()
    );
}

#[test]
fn saved_yaml_keeps_the_sdk_field_order_and_values() {
    let capabilities = Capabilities::available();
    let state = load_journey(Source::Defaults, &capabilities).unwrap();
    let mut wizard = JourneyWizard::new(capabilities, state);
    questions_until_review(&mut wizard);
    let saved = wizard.saved_yaml().unwrap();
    let full = wizard.document().unwrap().yaml().unwrap();
    let mut remaining = super::saved::entries(&full).into_iter();
    for entry in super::saved::entries(&saved) {
        assert!(
            remaining.any(|candidate| candidate == entry),
            "{entry:?} is out of the SDK's order or differs:\n{saved}\n---\n{full}"
        );
    }
}

/// Building the saved configuration serializes, reads back, and validates the
/// whole document, so redrawing or scrolling the review reuses it.
#[test]
fn review_builds_the_saved_configuration_once_until_the_journey_changes() {
    let capabilities = Capabilities::available();
    let state = load_journey(Source::Defaults, &capabilities).unwrap();
    let mut wizard = JourneyWizard::new(capabilities, state);
    questions_until_review(&mut wizard);
    wizard.accepted = false;
    screen(&wizard, 100, 24);
    let built = wizard.configurations();
    for _ in 0..3 {
        screen(&wizard, 100, 24);
        wizard.next();
    }
    wizard.saved_yaml().unwrap();
    assert_eq!(wizard.configurations(), built);

    wizard.back();
    questions_until_review(&mut wizard);
    wizard.accepted = false;
    screen(&wizard, 100, 24);
    let rebuilt = wizard.configurations();
    assert!(rebuilt > built);
    screen(&wizard, 100, 24);
    assert_eq!(wizard.configurations(), rebuilt);
}

#[test]
fn a_configuration_that_cannot_be_saved_says_why_and_keeps_the_review_open() {
    let capabilities = Capabilities::available();
    let state = load_journey(Source::Defaults, &capabilities).unwrap();
    let mut wizard = JourneyWizard::new(capabilities, state);
    questions_until_review(&mut wizard);
    wizard.accepted = false;
    wizard.fail_configuration("the saved configuration does not reproduce the reviewed document");
    for (width, height) in [(80, 24), (140, 40)] {
        let screen = screen(&wizard, width, height);
        let text = flat(&screen);
        assert!(
            text.contains("Cannot save: the saved configuration does not reproduce"),
            "{screen}"
        );
        assert!(!text.contains("Enter save"), "{screen}");
    }
    wizard.advance();
    assert!(!wizard.accepted);
    assert!(wizard.saved_yaml().is_err());
}

#[test]
fn a_template_value_is_saved_even_when_it_matches_the_sdk_default() {
    let directory = tempfile::tempdir().unwrap();
    let template = directory.path().join("template.yaml");
    let mut values: Value = serde_saphyr::from_slice(include_bytes!(
        "../../../../examples/onboarding/openclaw.yaml"
    ))
    .unwrap();
    values["spec"]["gateway"]["endpoint"] = "http://127.0.0.1:17681".into();
    std::fs::write(&template, values.to_string()).unwrap();
    let capabilities = Capabilities::available();
    let state = load_journey(Source::Template(&template), &capabilities).unwrap();
    let mut wizard = JourneyWizard::new(capabilities, state);
    questions_until_review(&mut wizard);
    let saved: Value = serde_saphyr::from_str(&wizard.saved_yaml().unwrap()).unwrap();
    assert_eq!(
        saved.pointer("/spec/gateway/endpoint"),
        Some(&Value::from("http://127.0.0.1:17681"))
    );
}

#[test]
fn review_shows_the_configuration_that_will_be_saved() {
    let capabilities = Capabilities::available();
    let state = load_journey(Source::Defaults, &capabilities).unwrap();
    let mut wizard = JourneyWizard::new(capabilities, state);
    questions_until_review(&mut wizard);
    wizard.accepted = false;
    let screen = screen(&wizard, 160, 120);
    for line in wizard.saved_yaml().unwrap().lines() {
        assert!(screen.contains(line), "{line:?} is not on screen: {screen}");
    }
    assert!(!screen.contains("networkCIDR"), "{screen}");
}

#[test]
fn another_harness_omits_its_optional_settings_and_asks_required_ones() {
    let capabilities = Capabilities::available();
    let harness = "/spec/sandboxes/assistant/harness/kind";
    let mut state = load_journey(Source::Defaults, &capabilities).unwrap();
    state
        .answer(
            &capabilities,
            harness,
            Some(serde_json::json!("nvidia.fabric.hermes")),
        )
        .unwrap();
    let resolution = state.resolve(&capabilities).unwrap();
    assert!(
        resolution
            .questions()
            .iter()
            .all(|question| !question.id().starts_with("adapter:")),
        "{:?}",
        resolution.questions()
    );
    state
        .answer(
            &capabilities,
            harness,
            Some(serde_json::json!("nvidia.fabric.remote-agent")),
        )
        .unwrap();
    let adapter_questions = state
        .resolve(&capabilities)
        .unwrap()
        .questions()
        .iter()
        .filter(|question| question.id().starts_with("adapter:"))
        .map(|question| question.id().to_owned())
        .collect::<Vec<_>>();
    assert_eq!(
        adapter_questions,
        ["adapter:nvidia.fabric.remote-agent:/base_url"]
    );
}

/// Lines of the review section listing template values kept by omission.
fn from_template_section(wizard: &JourneyWizard) -> Option<Vec<String>> {
    let lines = wizard
        .review_lines()
        .iter()
        .map(|line| line.to_string())
        .collect::<Vec<_>>();
    let start = lines
        .iter()
        .position(|line| line == "From your template:")?;
    Some(
        lines[start + 1..]
            .iter()
            .take_while(|line| !line.is_empty())
            .cloned()
            .collect(),
    )
}

#[test]
fn default_journey_suggests_its_own_name_and_lists_nothing_from_a_template() {
    let capabilities = Capabilities::available();
    let state = load_journey(Source::Defaults, &capabilities).unwrap();
    let mut wizard = JourneyWizard::new(capabilities, state);
    assert_eq!(
        wizard.question().unwrap().unwrap().suggestion(),
        Some(&serde_json::json!("openclaw"))
    );
    questions_until_review(&mut wizard);
    assert_eq!(from_template_section(&wizard), None);
}

#[test]
fn template_values_kept_by_omission_are_listed_at_review() {
    let mut values: Value = serde_saphyr::from_slice(include_bytes!(
        "../../../../examples/onboarding/openclaw.yaml"
    ))
    .unwrap();
    values["spec"]["sandboxes"]["assistant"]["harness"]["settings"] =
        serde_json::json!({"startup_timeout_seconds": 45});
    values["spec"]["gateway"]["networkCIDR"] = serde_json::json!("172.30.77.0/24");
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("template.yaml");
    std::fs::write(&path, values.to_string()).unwrap();
    let capabilities = Capabilities::available();
    let state = load_journey(Source::Template(&path), &capabilities).unwrap();
    let mut wizard = JourneyWizard::new(capabilities, state);
    let asked = questions_until_review(&mut wizard);
    assert!(
        !asked.iter().any(|id| id.ends_with("/startup_timeout_seconds")
            || id == "/spec/gateway/networkCIDR"),
        "{asked:?}"
    );
    let document = wizard.document().unwrap();
    assert_eq!(
        document.spec.sandboxes["assistant"]
            .harness
            .as_ref()
            .and_then(|harness| harness.settings.as_ref())
            .and_then(|settings| settings.get("startup_timeout_seconds")),
        Some(&serde_json::json!(45))
    );
    // Values set through a question, such as the provider behind the
    // inference preset, were part of the journey and are not repeated.
    let mut section = from_template_section(&wizard).expect("From your template section");
    section.sort();
    assert_eq!(
        section,
        [
            "Gateway: network CIDR: 172.30.77.0/24",
            "Startup timeout seconds: 45",
        ]
    );
}

#[test]
fn mixed_local_and_hosted_template_reaches_review_without_losing_routes() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../examples/spark/local-and-hosted.yaml");
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
        document.spec.sandboxes["assistant"]
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
        .join("../../examples")
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
    let saved = wizard
        .saved_yaml()
        .unwrap_or_else(|error| panic!("{relative}: {error}"));
    assert_eq!(
        Document::parse(saved.as_bytes()).unwrap(),
        wizard.document().unwrap(),
        "{relative}"
    );
}

/// Rendering, the next question, and advancing share one resolution until an
/// answer, undo, or observation changes what the journey resolves to.
#[test]
fn an_unchanged_journey_resolves_once_until_an_answer_or_observation_changes_it() {
    let capabilities = Capabilities::available();
    let state = load_journey(Source::Defaults, &capabilities).unwrap();
    let mut wizard = JourneyWizard::new(capabilities, state);
    wizard.advance();
    let first = wizard.question().unwrap().unwrap();
    for _ in 0..3 {
        assert_eq!(wizard.question().unwrap().unwrap().id(), first.id());
        let _ = wizard.document();
    }
    assert_eq!(wizard.resolutions(), 1);

    wizard.advance();
    let second = wizard.question().unwrap().unwrap();
    assert_ne!(second.id(), first.id());
    // Answering resolves the new state once more, and only once.
    assert_eq!(wizard.resolutions(), 2);

    wizard.back();
    assert_eq!(wizard.question().unwrap().unwrap().id(), first.id());
    assert_eq!(wizard.resolutions(), 3);

    let document =
        Document::parse(include_bytes!("../../../../examples/managed-ollama.yaml").as_slice())
            .unwrap();
    let engine = discovery_queries(&document, None)
        .unwrap()
        .into_iter()
        .find(|query| matches!(query, DiscoveryQuery::Engine(_)))
        .unwrap();
    let mut observed = DiscoveryObservations::new();
    observed.record(
        engine,
        DiscoveryObservation::Engine(nemoclaw_sdk::discovery::EngineObservation {
            status: nemoclaw_sdk::discovery::ObservationStatus::Unavailable,
            reason: Some("fixture".into()),
            source: "fixture".into(),
            server_version: None,
            architecture: None,
            operating_system: None,
            memory_bytes: None,
            cpus: None,
        }),
    );
    wizard.remember(observed);
    wizard.question().unwrap();
    assert_eq!(wizard.resolutions(), 4);
}

// One test per example, generated by build.rs, so examples run in parallel with
// separate time limits and a new example is covered without listing it.
mod example_journeys {
    include!(concat!(env!("OUT_DIR"), "/example_journeys.rs"));
}

#[test]
fn offline_vendor_menu_selects_a_catalog_alternative() {
    let capabilities = Capabilities::available();
    let state = load_journey(Source::Defaults, &capabilities).unwrap();
    let mut wizard = JourneyWizard::new(capabilities, state);
    for _ in 0..12 {
        if wizard
            .question()
            .unwrap()
            .as_ref()
            .is_some_and(|question| question.kind() == JourneyQuestionKind::InferenceModel)
        {
            break;
        }
        wizard.advance();
    }
    let question = wizard.question().unwrap().unwrap();
    let model = serde_json::json!("nvidia/nemotron-3-ultra-550b-a55b");
    wizard.selected = question
        .choices()
        .iter()
        .position(|choice| choice == &model)
        .unwrap();
    wizard.selection_changed = true;
    wizard.started = true;
    let mut terminal = Terminal::new(TestBackend::new(140, 40)).unwrap();
    terminal.draw(|frame| wizard.render(frame)).unwrap();
    let screen = terminal.backend().to_string();
    assert!(
        screen.contains("nvidia/nemotron-3-ultra-550b-a55b"),
        "{screen}"
    );
    assert!(screen.contains("Type another model"), "{screen}");
    wizard.advance();
    assert!(wizard.error.is_none(), "{:?}", wizard.error);
    assert_eq!(wizard.state().values().pointer(question.id()), Some(&model));
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
        .state()
        .resolve(&wizard.capabilities)
        .unwrap()
        .assessment()
        .document()
        .unwrap()
        .clone();
    wizard.record(
        DiscoveryQuery::Inference(
            inference_request_for_document(&document, wizard.state().current_route())
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
        wizard.state().values().pointer(question.id()),
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
            .is_some_and(|question| question.id() == "/spec/gateway/runtime/provider")
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
        wizard.state().values().pointer(question.id()),
        Some(&serde_json::json!("podman"))
    );
}

/// A host as onboarding found it: the engines its environment named, and what
/// each said when asked.
#[derive(serde::Deserialize)]
struct RecordedHost {
    candidates: Vec<DiscoveryRequest>,
    observations: DiscoveryObservations,
}

#[tokio::test]
async fn enter_accepts_the_runtime_this_machine_can_run_and_targets_its_engine() {
    let capabilities = Capabilities::available();
    let state = load_journey(Source::Defaults, &capabilities).unwrap();
    // Only Podman answered when this machine was read, but the template says Docker.
    let host: RecordedHost = serde_json::from_str(include_str!(
        "../../../../crates/nemoclaw-authoring/tests/fixtures/observations/podman-only.json"
    ))
    .unwrap();
    let podman = host
        .candidates
        .iter()
        .find(|candidate| candidate.compute_driver.as_str() == "podman")
        .unwrap()
        .engine
        .clone();
    let mut wizard = JourneyWizard::new(capabilities, state)
        .with_local_engine_candidates(host.candidates.clone());
    let queries = local_engine_probe(&wizard);
    let replay = async |_: Vec<DiscoveryQuery>, _: &CancellationToken| Ok(host.observations);
    assert!(
        ask_target(
            &mut wizard,
            replay,
            queries,
            &CancellationToken::new(),
            &mut std::collections::VecDeque::new(),
            || Ok(None),
        )
        .await
        .unwrap()
    );
    for _ in 0..5 {
        if wizard
            .question()
            .unwrap()
            .is_some_and(|question| question.id() == "/spec/gateway/runtime/provider")
        {
            break;
        }
        wizard.advance();
    }
    wizard.advance();
    assert!(wizard.error.is_none(), "{:?}", wizard.error);
    assert_eq!(
        wizard
            .state()
            .values()
            .pointer("/spec/gateway/runtime/provider"),
        Some(&serde_json::json!("podman"))
    );
    assert_eq!(
        wizard.state().values().pointer("/spec/gateway/engine"),
        Some(&serde_json::json!(podman))
    );
}

#[test]
fn review_uses_authoring_readiness_for_an_observed_target_conflict() {
    let capabilities = Capabilities::available();
    let base = PartialDocument::from_yaml(include_bytes!(
        "../../../../examples/onboarding/openclaw.yaml"
    ))
    .unwrap();
    let state = JourneyDefinition::new("conflicted-target", base)
        .omit([
            "adapter:nvidia.fabric.openclaw:/agent_id",
            "adapter:nvidia.fabric.openclaw:/channel_config",
            "adapter:nvidia.fabric.openclaw:/connect_timeout_seconds",
            "adapter:nvidia.fabric.openclaw:/openclaw_command",
            "adapter:nvidia.fabric.openclaw:/port_range",
            "adapter:nvidia.fabric.openclaw:/read_timeout_seconds",
            "adapter:nvidia.fabric.openclaw:/shutdown_timeout_seconds",
            "adapter:nvidia.fabric.openclaw:/startup_timeout_seconds",
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
    let engine = discovery_queries(&document, None)
        .unwrap()
        .into_iter()
        .find(|query| matches!(query, DiscoveryQuery::Engine(_)))
        .expect("a managed gateway reads its engine");
    wizard.record(engine, DiscoveryObservation::Engine(conflicting_engine()));
    wizard.started = true;
    wizard.advance();

    assert!(!wizard.accepted);
    assert_eq!(wizard.error, None);
    assert!(
        flat(&screen(&wizard, 100, 40)).contains("The selected engine does not meet"),
        "the review must say why saving is blocked"
    );
}

/// A target that cannot be reached: every read is recorded as unknown,
/// deterministically and without any process or network.
async fn unreachable(
    queries: Vec<DiscoveryQuery>,
    _: &CancellationToken,
) -> Result<DiscoveryObservations, Error> {
    let mut observed = DiscoveryObservations::new();
    for query in queries {
        let observation = match &query {
            DiscoveryQuery::Engine(_) => {
                DiscoveryObservation::Engine(EngineObservation::unknown("unreachable"))
            }
            DiscoveryQuery::Inference(_) => {
                DiscoveryObservation::Inference(EndpointObservation::unknown("unreachable"))
            }
            DiscoveryQuery::Credential(request) => {
                DiscoveryObservation::Credential(CredentialObservation {
                    reference: request.reference.clone(),
                    status: ObservationStatus::Unknown,
                    reason: Some("unreachable".into()),
                })
            }
            other => panic!("unexpected read {other:?}"),
        };
        observed.record(query, observation);
    }
    Ok(observed)
}

/// Ask the target without a terminal: nobody types during the read.
async fn ask(wizard: &mut JourneyWizard, queries: Vec<DiscoveryQuery>) -> bool {
    ask_target(
        wizard,
        unreachable,
        queries,
        &CancellationToken::new(),
        &mut std::collections::VecDeque::new(),
        || Ok(None),
    )
    .await
    .unwrap()
}

#[tokio::test]
async fn a_new_questionnaire_asks_which_engines_this_machine_has_exactly_once() {
    let capabilities = Capabilities::available();
    let state = load_journey(Source::Defaults, &capabilities).unwrap();
    let candidates = [
        "unix:///home/me/.colima/docker.sock",
        "unix:///run/user/501/podman/podman.sock",
    ]
    .into_iter()
    .zip([ComputeDriver::Docker, ComputeDriver::Podman])
    .map(|(engine, compute_driver)| DiscoveryRequest {
        engine: engine.into(),
        compute_driver,
    })
    .collect::<Vec<_>>();
    let mut wizard =
        JourneyWizard::new(capabilities, state).with_local_engine_candidates(candidates.clone());
    let asked: Vec<DiscoveryQuery> = candidates.into_iter().map(DiscoveryQuery::Engine).collect();
    assert_eq!(local_engine_probe(&wizard), asked);

    let queries = local_engine_probe(&wizard);
    assert!(ask(&mut wizard, queries).await);

    // Each read is recorded, even though none could be made, so none is repeated.
    assert!(local_engine_probe(&wizard).is_empty());
    for query in &asked {
        assert!(wizard.observations().contains(query));
    }
}

#[tokio::test]
async fn the_model_catalog_is_asked_when_the_model_question_comes_and_only_once() {
    let capabilities = Capabilities::available();
    let state = load_journey(Source::Defaults, &capabilities).unwrap();
    let mut wizard = JourneyWizard::new(capabilities, state);
    assert_eq!(model_catalog_probe(&wizard), None, "no model question yet");

    for _ in 0..12 {
        if wizard
            .question()
            .unwrap()
            .is_some_and(|question| question.kind() == JourneyQuestionKind::InferenceModel)
        {
            break;
        }
        wizard.advance();
    }
    let document = wizard
        .state()
        .resolve(&wizard.capabilities)
        .unwrap()
        .assessment()
        .document()
        .unwrap()
        .clone();
    let request = inference_request_for_document(&document, wizard.state().current_route())
        .unwrap()
        .unwrap();
    let query = model_catalog_probe(&wizard).expect("the model question needs its catalog");
    assert_eq!(query, DiscoveryQuery::Inference(request.clone()));

    assert!(ask(&mut wizard, vec![query]).await);

    assert_eq!(
        model_catalog_probe(&wizard),
        None,
        "the catalog is read once"
    );
    assert!(wizard.observations().get(&request).is_some());
}

#[tokio::test]
async fn credentials_are_checked_when_review_opens_and_only_once() {
    let mut wizard = reviewing_wizard(unverified_engine());
    let asked = vec![DiscoveryQuery::Credential(CredentialRequest {
        reference: "NVIDIA_API_KEY".into(),
    })];
    assert_eq!(credential_probe(&wizard), asked);

    assert!(ask(&mut wizard, asked).await);

    assert!(credential_probe(&wizard).is_empty(), "each is checked once");
    assert!(
        flat(&screen(&wizard, 100, 40))
            .contains("NVIDIA_API_KEY could not be read in this environment.")
    );
}

#[test]
fn questions_do_not_check_credentials() {
    let capabilities = Capabilities::available();
    let state = load_journey(Source::Defaults, &capabilities).unwrap();
    let mut wizard = JourneyWizard::new(capabilities, state);
    wizard.started = true;
    for _ in 0..40 {
        if wizard.question().unwrap().is_none() {
            return;
        }
        assert!(credential_probe(&wizard).is_empty());
        wizard.advance();
    }
    panic!("the journey did not reach review");
}

#[test]
fn credential_availability_appears_on_review_and_not_on_questions() {
    for (status, expected) in [
        (
            ObservationStatus::Available,
            "NVIDIA_API_KEY is set in this environment.",
        ),
        (
            ObservationStatus::Unavailable,
            "NVIDIA_API_KEY is not set in this environment.",
        ),
    ] {
        let capabilities = Capabilities::available();
        let state = load_journey(Source::Defaults, &capabilities).unwrap();
        let mut wizard =
            JourneyWizard::new(capabilities, state).with_local_engine_candidates(vec![]);
        wizard.record(
            DiscoveryQuery::Credential(CredentialRequest {
                reference: "NVIDIA_API_KEY".into(),
            }),
            DiscoveryObservation::Credential(CredentialObservation {
                reference: "NVIDIA_API_KEY".into(),
                status,
                reason: None,
            }),
        );
        wizard.started = true;
        for _ in 0..40 {
            if wizard.question().unwrap().is_none() {
                break;
            }
            for (width, height) in [(160, 35), (72, 24)] {
                let text = flat(&screen(&wizard, width, height));
                assert!(!text.contains("in this environment"), "{text}");
            }
            wizard.advance();
        }
        assert!(wizard.question().unwrap().is_none(), "review");
        for (width, height) in [(160, 35), (72, 24)] {
            let text = flat(&screen(&wizard, width, height));
            assert!(text.contains(expected), "{width}x{height}: {text}");
        }
    }
}

#[test]
fn missing_catalog_key_does_not_occupy_the_error_slot_or_hide_engine_failures() {
    use nemoclaw_sdk::{
        discovery::{FabricObservation, ObservationStatus, plan_queries},
        fabric_capabilities::{CompatibilityReport, ImageMetadata, Support},
        fabric_catalog::FabricCatalog,
        inference_discovery::AuthenticationStatus,
    };
    let capabilities = Capabilities::available();
    let base = PartialDocument::from_yaml(include_bytes!(
        "../../../../examples/onboarding/openclaw.yaml"
    ))
    .unwrap();
    let mut state = JourneyDefinition::new("catalog-note", base)
        .ask(["/spec/sandboxes/assistant/harness/kind", "/metadata/name"])
        .start(&capabilities)
        .unwrap();
    state
        .answer(
            &capabilities,
            "/spec/sandboxes/assistant/harness/kind",
            Some(serde_json::json!("nvidia.fabric.openclaw")),
        )
        .unwrap();
    let document = state
        .resolve(&capabilities)
        .unwrap()
        .assessment()
        .document()
        .unwrap()
        .clone();
    let mut wizard = JourneyWizard::new(capabilities, state);
    wizard.started = true;
    let catalog = FabricCatalog::bundled();
    let engine_query = plan_queries(&document)
        .unwrap()
        .into_iter()
        .find(|q| matches!(q, DiscoveryQuery::Engine(_)))
        .unwrap();
    wizard.record(
        engine_query.clone(),
        DiscoveryObservation::Engine(EngineObservation {
            status: ObservationStatus::Available,
            reason: None,
            source: "fixture".into(),
            server_version: Some("1".into()),
            architecture: Some("aarch64".into()),
            operating_system: Some("linux".into()),
            memory_bytes: None,
            cpus: None,
        }),
    );
    let image_query = plan_queries(&document)
        .unwrap()
        .into_iter()
        .find(|q| matches!(q, DiscoveryQuery::Fabric(_)))
        .unwrap();
    wizard.record(
        image_query,
        DiscoveryObservation::Fabric(FabricObservation {
            status: ObservationStatus::Available,
            reason: None,
            source: "fixture".into(),
            image_id: Some("sha256:observed".into()),
            catalog: Some(catalog),
            image: ImageMetadata {
                architecture: Some("arm64".into()),
                operating_system: Some("linux".into()),
                repo_digests: vec![document.spec.sandboxes["assistant"].image.ref_.clone()],
                ..Default::default()
            },
            compatibility: Some(CompatibilityReport {
                status: Support::Supported,
                adapter_id: None,
                checks: Vec::new(),
            }),
        }),
    );
    let request = inference_request_for_document(&document, wizard.state().current_route())
        .unwrap()
        .unwrap();
    wizard.record(
        DiscoveryQuery::Inference(request),
        DiscoveryObservation::Inference(EndpointObservation {
            status: ObservationStatus::Unavailable,
            reason: None,
            source: "fixture".into(),
            reachable: Some(true),
            authentication: AuthenticationStatus::Required,
            models: Vec::new(),
            api_verified: false,
        }),
    );
    let before = wizard.state().values().clone();
    wizard.delegate();
    assert!(wizard.error.is_none(), "{:?}", wizard.error);
    assert_eq!(wizard.state().values(), &before);
    assert!(wizard.history.is_empty());
    let mut terminal = Terminal::new(TestBackend::new(160, 35)).unwrap();
    terminal.draw(|frame| wizard.render(frame)).unwrap();
    assert!(
        terminal
            .backend()
            .to_string()
            .contains("Model catalog needs credential NVIDIA_API_KEY")
    );
    wizard.record(
        engine_query,
        DiscoveryObservation::Engine(EngineObservation {
            status: ObservationStatus::Unavailable,
            reason: None,
            source: "fixture".into(),
            server_version: None,
            architecture: None,
            operating_system: None,
            memory_bytes: None,
            cpus: None,
        }),
    );
    wizard.delegate();
    assert!(
        wizard
            .error
            .as_deref()
            .unwrap()
            .contains("Target engine and image compatibility")
    );
}

/// Ask this machine about one Docker engine, which answers as `status` says,
/// then accept suggestions up to the engine question.
async fn wizard_at_engine_question(
    status: nemoclaw_sdk::discovery::ObservationStatus,
) -> JourneyWizard {
    let capabilities = Capabilities::available();
    let state = load_journey(Source::Defaults, &capabilities).unwrap();
    let candidate = DiscoveryRequest {
        engine: "unix:///home/me/.colima/docker.sock".into(),
        compute_driver: ComputeDriver::Docker,
    };
    let mut wizard =
        JourneyWizard::new(capabilities, state).with_local_engine_candidates(vec![candidate]);
    let queries = local_engine_probe(&wizard);
    let reply = async move |queries: Vec<DiscoveryQuery>, _: &CancellationToken| {
        let mut observed = DiscoveryObservations::new();
        for query in queries {
            observed.record(
                query,
                DiscoveryObservation::Engine(engine_observation(status)),
            );
        }
        Ok(observed)
    };
    assert!(
        ask_target(
            &mut wizard,
            reply,
            queries,
            &CancellationToken::new(),
            &mut std::collections::VecDeque::new(),
            || Ok(None),
        )
        .await
        .unwrap()
    );
    wizard.started = true;
    for _ in 0..20 {
        if wizard
            .question()
            .unwrap()
            .is_some_and(|question| question.id() == "/spec/gateway/engine")
        {
            return wizard;
        }
        wizard.advance();
        assert!(wizard.error.is_none(), "{:?}", wizard.error);
    }
    panic!("the journey never asked for the engine");
}

fn screen(wizard: &JourneyWizard, width: u16, height: u16) -> String {
    let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
    terminal.draw(|frame| wizard.render(frame)).unwrap();
    terminal.backend().to_string()
}

#[tokio::test]
async fn engine_question_says_why_it_has_no_suggestion_when_no_engine_answered() {
    use nemoclaw_sdk::discovery::ObservationStatus;
    let wizard = wizard_at_engine_question(ObservationStatus::Unavailable).await;
    for (width, height) in [(80, 24), (140, 40)] {
        let screen = screen(&wizard, width, height);
        let flat = flat(&screen);
        assert!(
            flat.contains("No docker engine answered on this machine."),
            "{screen}"
        );
        assert!(flat.contains("to its socket."), "{screen}");
    }
}

#[tokio::test]
async fn engine_question_suggests_the_answering_socket_without_a_reason() {
    use nemoclaw_sdk::discovery::ObservationStatus;
    let wizard = wizard_at_engine_question(ObservationStatus::Available).await;
    let screen = screen(&wizard, 140, 40);
    assert!(
        screen.contains("unix:///home/me/.colima/docker.sock"),
        "{screen}"
    );
    assert!(!screen.contains("engine answered"), "{screen}");
}

/// The default journey at review. This machine answered for no engine, and the
/// engine the document names was read as `engine`.
fn reviewing_wizard(engine: EngineObservation) -> JourneyWizard {
    let capabilities = Capabilities::available();
    let state = load_journey(Source::Defaults, &capabilities).unwrap();
    let document = state
        .resolve(&capabilities)
        .unwrap()
        .assessment()
        .document()
        .unwrap()
        .clone();
    let query = discovery_queries(&document, state.current_route())
        .unwrap()
        .into_iter()
        .find(|query| matches!(query, DiscoveryQuery::Engine(_)))
        .expect("a managed gateway reads its engine");
    let mut observed = DiscoveryObservations::new();
    observed.record(query, DiscoveryObservation::Engine(engine));
    let mut wizard = JourneyWizard::new(capabilities, state).with_local_engine_candidates(vec![]);
    wizard.remember(observed);
    wizard.started = true;
    for _ in 0..40 {
        if wizard.question().unwrap().is_none() {
            return wizard;
        }
        wizard.advance();
        assert!(wizard.error.is_none(), "{:?}", wizard.error);
    }
    panic!("the journey did not reach review");
}

fn unverified_engine() -> EngineObservation {
    EngineObservation::unknown("fixture")
}

fn conflicting_engine() -> EngineObservation {
    EngineObservation {
        reason: Some("target rejected engine".into()),
        ..engine_observation(nemoclaw_sdk::discovery::ObservationStatus::Unavailable)
    }
}

/// An engine the fixture host read as `status`.
fn engine_observation(status: nemoclaw_sdk::discovery::ObservationStatus) -> EngineObservation {
    EngineObservation {
        status,
        reason: None,
        source: "fixture".into(),
        server_version: None,
        architecture: None,
        operating_system: None,
        memory_bytes: None,
        cpus: None,
    }
}

/// Scroll the review as far as it goes; it draws first so the view knows its limit.
fn scroll_to_end(wizard: &mut JourneyWizard, width: u16, height: u16) {
    screen(wizard, width, height);
    for _ in 0..500 {
        wizard.next();
    }
}

/// The last screen of the review.
fn review_end(wizard: &mut JourneyWizard, width: u16, height: u16) -> String {
    scroll_to_end(wizard, width, height);
    screen(wizard, width, height)
}

fn flat(screen: &str) -> String {
    screen.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn drawn(wizard: &JourneyWizard, width: u16, height: u16) -> ratatui::buffer::Buffer {
    let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
    terminal.draw(|frame| wizard.render(frame)).unwrap();
    terminal.backend().buffer().clone()
}

/// The foreground of the first cell of `needle` on the rendered screen.
fn foreground_of(wizard: &JourneyWizard, needle: &str) -> ratatui::style::Color {
    let buffer = drawn(wizard, 100, 40);
    for y in 0..buffer.area.height {
        let row = (0..buffer.area.width)
            .map(|x| buffer[(x, y)].symbol().to_owned())
            .collect::<String>();
        if let Some(column) = row.find(needle) {
            let x = row[..column].chars().count() as u16;
            return buffer[(x, y)].fg;
        }
    }
    panic!("{needle:?} is not on screen");
}

#[test]
fn review_opens_with_the_unverified_target_and_every_reason_above_the_yaml() {
    let wizard = reviewing_wizard(unverified_engine());
    for (width, height) in [(72, 24), (80, 24), (140, 40)] {
        let screen = screen(&wizard, width, height);
        let text = flat(&screen);
        for expected in [
            "Target: Unverified",
            "No docker engine answered on this machine.",
            "The selected engine remains unverified.",
            "The selected image's Fabric capabilities have not been observed.",
        ] {
            assert!(text.contains(expected), "{width}x{height}: {screen}");
        }
        if let Some(yaml) = screen.find("kind:") {
            assert!(screen.find("Target: Unverified") < Some(yaml), "{screen}");
        }
    }
    assert_eq!(
        foreground_of(&wizard, "Target: Unverified"),
        super::view::WARNING
    );
}

#[test]
fn a_target_conflict_blocks_saving_and_says_why_on_the_review() {
    let mut wizard = reviewing_wizard(conflicting_engine());
    for (width, height) in [(80, 24), (140, 40)] {
        wizard.review_scroll = 0;
        let screen = screen(&wizard, width, height);
        let text = flat(&screen);
        assert!(text.contains("Target: Conflict"), "{screen}");
        assert!(
            text.contains("The selected engine does not meet gateway prerequisites."),
            "{screen}"
        );
        assert!(!text.contains("Enter save"), "{screen}");
        let end = flat(&review_end(&mut wizard, width, height));
        assert!(!end.contains("Press Enter to save"), "{end}");
    }
    wizard.advance();
    assert!(!wizard.accepted);
    assert_eq!(wizard.error, None);
}

#[test]
fn a_target_conflict_is_shown_in_the_error_colour() {
    let wizard = reviewing_wizard(conflicting_engine());
    assert_eq!(
        foreground_of(&wizard, "Target: Conflict"),
        super::view::ERROR
    );
}

#[test]
fn an_unverified_target_still_saves() {
    let mut wizard = reviewing_wizard(unverified_engine());
    assert!(flat(&screen(&wizard, 80, 24)).contains("Enter save"));
    assert!(flat(&review_end(&mut wizard, 80, 24)).contains("Press Enter to save."));
    wizard.advance();
    assert!(wizard.accepted);
}

#[test]
fn review_scroll_stops_at_the_last_line_and_shows_a_scrollbar() {
    let mut wizard = reviewing_wizard(unverified_engine());
    let last = wizard.saved_yaml().map_or_else(
        |_| String::new(),
        |yaml| yaml.lines().last().unwrap().trim().to_owned(),
    );
    assert!(!last.is_empty());
    assert!(screen(&wizard, 80, 24).contains('┃'), "no scrollbar");
    scroll_to_end(&mut wizard, 80, 24);
    let bottom = screen(&wizard, 80, 24);
    assert!(flat(&bottom).contains(&last), "{bottom}");
    let capped = wizard.review_scroll;
    wizard.previous();
    assert_eq!(wizard.review_scroll, capped - 1);
    assert!(
        !screen(&wizard, 80, 200).contains('┃'),
        "a short review needs no scrollbar"
    );
}

#[test]
fn an_unverified_target_the_journey_requires_blocks_saving_in_the_error_colour() {
    let capabilities = Capabilities::available();
    let base = PartialDocument::from_yaml(include_bytes!(
        "../../../../examples/onboarding/openclaw.yaml"
    ))
    .unwrap();
    let state = JourneyDefinition::new("target-gated", base)
        .require_target([TargetPrerequisite::EngineAndImageCompatible])
        .omit([
            "adapter:nvidia.fabric.openclaw:/agent_id",
            "adapter:nvidia.fabric.openclaw:/channel_config",
            "adapter:nvidia.fabric.openclaw:/connect_timeout_seconds",
            "adapter:nvidia.fabric.openclaw:/openclaw_command",
            "adapter:nvidia.fabric.openclaw:/port_range",
            "adapter:nvidia.fabric.openclaw:/read_timeout_seconds",
            "adapter:nvidia.fabric.openclaw:/shutdown_timeout_seconds",
            "adapter:nvidia.fabric.openclaw:/startup_timeout_seconds",
        ])
        .start(&capabilities)
        .unwrap();
    let document = state
        .resolve(&capabilities)
        .unwrap()
        .assessment()
        .document()
        .unwrap()
        .clone();
    let engine = discovery_queries(&document, None)
        .unwrap()
        .into_iter()
        .find(|query| matches!(query, DiscoveryQuery::Engine(_)))
        .unwrap();
    let mut wizard = JourneyWizard::new(capabilities, state);
    wizard.record(engine, DiscoveryObservation::Engine(unverified_engine()));
    wizard.started = true;
    assert!(wizard.question().unwrap().is_none());
    let text = flat(&screen(&wizard, 100, 40));
    assert!(text.contains("Target: Unverified"), "{text}");
    assert!(!text.contains("Enter save"), "{text}");
    assert_eq!(
        foreground_of(&wizard, "Target: Unverified"),
        super::view::ERROR
    );
}

/// The scrollbar's symbols down the review's right edge, top to bottom.
fn scrollbar_column(wizard: &JourneyWizard, width: u16, height: u16) -> String {
    let buffer = drawn(wizard, width, height);
    (9..height - 2)
        .map(|y| buffer[(width - 3, y)].symbol().to_owned())
        .collect()
}

#[test]
fn the_scrollbar_thumb_reaches_each_end_with_the_review() {
    let mut wizard = reviewing_wizard(unverified_engine());
    let top = scrollbar_column(&wizard, 80, 24);
    assert!(top.starts_with('┃'), "{top}");
    scroll_to_end(&mut wizard, 80, 24);
    let bottom = scrollbar_column(&wizard, 80, 24);
    assert!(bottom.ends_with('┃'), "{bottom}");
}

#[test]
fn review_opens_at_the_top_after_going_back_and_returning() {
    let mut wizard = reviewing_wizard(unverified_engine());
    screen(&wizard, 80, 24);
    for _ in 0..10 {
        wizard.next();
    }
    assert!(wizard.review_scroll > 0);
    wizard.back();
    wizard.advance();
    assert!(wizard.question().unwrap().is_none());
    assert_eq!(wizard.review_scroll, 0);
}
