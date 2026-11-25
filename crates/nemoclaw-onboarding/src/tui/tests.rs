// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::{
    app::JourneyWizard,
    labels::{label, terminal_text},
    logo::BrandImage,
    terminal::{
        accept_review, agent_images_probe, ask_target, credential_probe, discover_before_input,
        image_probe, local_engine_probe, model_catalog_probe,
    },
};
use crate::{Source, load_journey};
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use nemoclaw_authoring::{
    Capabilities, JourneyDefinition, JourneyQuestionKind, PartialDocument, TargetPrerequisite,
    discovery_queries, inference_request_for_document,
};
use nemoclaw_sdk::discovery::DiscoveryObservations;
use nemoclaw_sdk::{
    CancellationToken, Error,
    config::{ComputeDriver, Document},
    discovery::{
        AgentImagesObservation, AgentImagesRequest, CredentialRequest, DiscoveryObservation,
        DiscoveryQuery, DiscoveryRequest, EngineObservation, FabricObservation, GatewayObservation,
        ObservationStatus,
    },
    hardware_discovery::HardwareObservation,
    inference_discovery::{CredentialObservation, EndpointObservation},
};
use ratatui::{Terminal, backend::TestBackend};
use serde_json::Value;

#[test]
fn a_tall_terminal_keeps_the_full_wordmark_on_questions() {
    let capabilities = Capabilities::available();
    let state = load_defaults(&capabilities);
    let mut wizard = JourneyWizard::new(capabilities, state);
    wizard.started = true;
    let mut terminal = Terminal::new(TestBackend::new(120, 50)).unwrap();
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
fn a_short_terminal_and_the_review_show_a_one_line_wordmark() {
    let capabilities = Capabilities::available();
    let state = load_defaults(&capabilities);
    let mut wizard = JourneyWizard::new(capabilities, state);
    wizard.started = true;
    let question = screen(&wizard, 120, 40);
    assert!(!question.contains("███╗"), "{question}");
    assert_eq!(
        question.lines().next().unwrap().trim_matches('"').trim(),
        "NEMOCLAW",
        "{question}"
    );
    let review = reviewing_wizard(unverified_engine());
    let tall = screen(&review, 120, 80);
    assert!(!tall.contains("███╗"), "{tall}");
    assert_eq!(
        tall.lines().next().unwrap().trim_matches('"').trim(),
        "NEMOCLAW",
        "{tall}"
    );
}

#[test]
fn compatible_terminal_keeps_the_brand_image_beside_the_wordmark() {
    let capabilities = Capabilities::available();
    let state = load_defaults(&capabilities);
    let wizard = JourneyWizard::new(capabilities, state);
    for (height, beside) in [(50, "██╔██╗"), (30, "NEMOCLAW")] {
        let mut terminal = Terminal::new(TestBackend::new(120, height)).unwrap();
        terminal
            .draw(|frame| wizard.render_with_brand(frame, Some(BrandImage::from_id(0x12_34_56))))
            .unwrap();
        let screen = terminal.backend().to_string();
        assert!(
            screen
                .lines()
                .any(|line| line.contains('\u{10eeee}') && line.contains(beside)),
            "{screen}"
        );
        // Both rows of the image are placed.
        assert_eq!(
            screen
                .lines()
                .filter(|line| line.contains('\u{10eeee}'))
                .count(),
            2,
            "{screen}"
        );
    }
}

#[test]
fn narrow_terminal_asks_for_resize_instead_of_clipping_questions() {
    let capabilities = Capabilities::available();
    let state = load_defaults(&capabilities);
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
    let state = load_defaults(&capabilities);
    let mut wizard = JourneyWizard::new(capabilities, state);
    for _ in 0..40 {
        wizard.advance();
        if wizard.accepted {
            break;
        }
    }
    assert!(wizard.accepted);
    wizard.toggle_configuration();
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
            "adapter:nvidia.fabric.openclaw:/interfaces",
            "adapter:nvidia.fabric.openclaw:/openclaw_command",
            "adapter:nvidia.fabric.openclaw:/port_range",
            "adapter:nvidia.fabric.openclaw:/read_timeout_seconds",
            "adapter:nvidia.fabric.openclaw:/shutdown_timeout_seconds",
            "adapter:nvidia.fabric.openclaw:/startup_timeout_seconds",
            "adapter:nvidia.fabric.openclaw:/agents",
            "adapter:nvidia.fabric.openclaw:/plugins",
            "adapter:nvidia.fabric.openclaw:/tools",
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
    let state = load_defaults(&capabilities);
    let mut wizard = JourneyWizard::new(capabilities, state);
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
    let state = load_defaults(&capabilities);
    let harness = "/spec/sandboxes/assistant/harness/kind";
    let original = state.values().pointer(harness).cloned();
    let mut wizard = JourneyWizard::new(capabilities, state);
    wizard
        .submit(Some(serde_json::json!("nvidia.fabric.hermes")))
        .unwrap();
    assert_eq!(wizard.question().unwrap().unwrap().id(), "/metadata/name");
    wizard.back();
    assert_eq!(wizard.question().unwrap().unwrap().id(), harness);
    assert_eq!(wizard.state().values().pointer(harness), original.as_ref());
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
    let state = load_defaults(&capabilities);
    let mut wizard = JourneyWizard::new(capabilities, state);
    for _ in 0..30 {
        if wizard
            .question()
            .unwrap()
            .is_some_and(|question| question.omittable())
        {
            let id = wizard.question().unwrap().unwrap().id().to_owned();
            wizard.submit(None).unwrap();
            assert_eq!(
                wizard.state().decision_status(&id),
                nemoclaw_authoring::DecisionStatus::Omitted
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
    let state = load_defaults(&capabilities);
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

/// The agent image the tests type, since no default image exists to suggest.
const AGENT_IMAGE: &str =
    "nc-fabric@sha256:0000000000000000000000000000000000000000000000000000000000000000";

/// The default journey with the agent image answered, since the journey has no
/// default image to suggest.
fn load_defaults(capabilities: &Capabilities) -> nemoclaw_authoring::JourneyState {
    let mut state = load_journey(Source::Defaults, capabilities).unwrap();
    state
        .answer(
            capabilities,
            "/spec/sandboxes/assistant/image/ref",
            Some(serde_json::json!(AGENT_IMAGE)),
        )
        .unwrap();
    state
}

/// Accept every suggestion, type the agent image the journey cannot suggest,
/// and return the questions in the order asked.
fn questions_until_review(wizard: &mut JourneyWizard) -> Vec<String> {
    wizard.started = true;
    let mut asked = Vec::new();
    for _ in 0..40 {
        if let Some(question) = wizard.question().unwrap() {
            asked.push(question.id().to_owned());
            if question.id().ends_with("/image/ref") {
                wizard.submit(Some(serde_json::json!(AGENT_IMAGE))).unwrap();
                if wizard.accepted {
                    return asked;
                }
                continue;
            }
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
fn default_journey_asks_route_choices_and_leaves_adapter_settings_at_their_defaults() {
    let capabilities = Capabilities::available();
    let state = load_journey(Source::Defaults, &capabilities).unwrap();
    let mut wizard = JourneyWizard::new(capabilities, state);
    assert_eq!(
        questions_until_review(&mut wizard),
        [
            "/spec/sandboxes/assistant/harness/kind",
            "/metadata/name",
            "/spec/gateway/target",
            "inference:preset",
            "/spec/sandboxes/assistant/image/ref",
            "/spec/sandboxes/assistant/agent/inference/routes/0/overrides/model",
            "/spec/gateway/target/docker/engine",
        ]
    );
}

/// The default journey on a machine whose one Docker engine answered as `status`.
async fn wizard_with_one_docker_engine(
    status: nemoclaw_sdk::discovery::ObservationStatus,
) -> JourneyWizard {
    let capabilities = Capabilities::available();
    let state = load_defaults(&capabilities);
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
    wizard
}

#[tokio::test]
async fn the_only_engine_that_answered_is_recorded_without_asking_for_its_socket() {
    use nemoclaw_sdk::discovery::ObservationStatus;
    let mut wizard = wizard_with_one_docker_engine(ObservationStatus::Available).await;
    let asked = questions_until_review(&mut wizard);
    let engine = "/spec/gateway/target/docker/engine";
    assert!(!asked.iter().any(|id| id == engine), "{asked:?}");
    let saved: Value = serde_saphyr::from_str(&wizard.saved_yaml().unwrap()).unwrap();
    assert_eq!(
        saved.pointer(engine),
        Some(&serde_json::json!("unix:///home/me/.colima/docker.sock"))
    );
    wizard.accepted = false;
    wizard.toggle_configuration();
    assert!(
        screen(&wizard, 160, 120).contains("engine: unix:///home/me/.colima/docker.sock"),
        "the review shows the engine it recorded"
    );
}

#[test]
fn a_hermes_run_is_named_after_its_agent() {
    let capabilities = Capabilities::available();
    let state = load_defaults(&capabilities);
    let mut wizard = JourneyWizard::new(capabilities, state);
    wizard.started = true;
    let question = wizard.question().unwrap().unwrap();
    assert_eq!(question.id(), "/spec/sandboxes/assistant/harness/kind");
    wizard.selected = question
        .choices()
        .iter()
        .position(|choice| choice == "nvidia.fabric.hermes")
        .unwrap();
    wizard.selection_changed = true;
    wizard.advance();
    let name = wizard.question().unwrap().unwrap();
    assert_eq!(name.id(), "/metadata/name");
    assert_eq!(name.suggestion(), Some(&serde_json::json!("hermes")));
    questions_until_review(&mut wizard);
    let saved: Value = serde_saphyr::from_str(&wizard.saved_yaml().unwrap()).unwrap();
    assert_eq!(saved["metadata"]["name"], "hermes");
}

#[test]
fn review_summarizes_the_network_tier_it_left_at_its_default() {
    let capabilities = Capabilities::available();
    let state = load_defaults(&capabilities);
    let mut wizard = JourneyWizard::new(capabilities, state);
    questions_until_review(&mut wizard);
    let yaml = wizard.saved_yaml().unwrap();
    assert!(!yaml.contains("tier"), "{yaml}");
    wizard.accepted = false;
    let screen = flat(&screen(&wizard, 160, 120));
    assert!(
        screen.contains("Network Isolated: only the model endpoint"),
        "{screen}"
    );
    // The summary comes before the YAML, where the review opens.
    wizard.toggle_configuration();
    let lines = review_text(&wizard);
    let network = lines.iter().position(|line| line.contains("Network"));
    let yaml = lines
        .iter()
        .position(|line| line.starts_with("│ apiVersion:"));
    assert!(network.is_some() && network < yaml, "{lines:#?}");
}

/// The review's lines as plain text.
fn review_text(wizard: &JourneyWizard) -> Vec<String> {
    wizard
        .review_lines(u16::MAX)
        .iter()
        .map(|line| line.to_string())
        .collect()
}

/// The review of the default journey with `harness`, saving to
/// `deployment.yaml`. This machine answered for no engine.
fn reviewing_wizard_with(harness: &str) -> JourneyWizard {
    let capabilities = Capabilities::available();
    let state = load_defaults(&capabilities);
    let mut wizard = JourneyWizard::new(capabilities, state)
        .with_local_engine_candidates(vec![])
        .with_output("deployment.yaml".into());
    wizard.started = true;
    wizard.submit(Some(serde_json::json!(harness))).unwrap();
    questions_until_review(&mut wizard);
    wizard.accepted = false;
    wizard
}

/// The review of the journey `path` starts. This machine answered for no engine.
fn reviewing_template(path: &std::path::Path) -> JourneyWizard {
    let capabilities = Capabilities::available();
    let state = load_journey(Source::Template(path), &capabilities).unwrap();
    let mut wizard = JourneyWizard::new(capabilities, state).with_local_engine_candidates(vec![]);
    questions_until_review(&mut wizard);
    wizard.accepted = false;
    wizard
}

#[test]
fn at_120x40_the_review_shows_the_agent_model_and_image_without_scrolling() {
    let wizard = reviewing_wizard_with("nvidia.fabric.hermes");
    let screen = screen(&wizard, 120, 40);
    let text = flat(&screen);
    for row in [
        "Review your deployment",
        "Agent Hermes",
        "Model nvidia/nemotron-3.5-super-vl-120b-a12b · NVIDIA Endpoints",
        "API key NVIDIA_API_KEY",
        "Runs on Docker on this machine",
        format!("Image {AGENT_IMAGE} · not checked").as_str(),
        "Network Isolated: only the model endpoint",
        "File deployment.yaml",
        "Configuration file",
    ] {
        assert!(text.contains(row), "{row:?} is not on screen: {screen}");
    }
    assert!(
        text.find(&format!("Image {AGENT_IMAGE}")) < text.find("Configuration file"),
        "{screen}"
    );
    // The saved file's details stay in the YAML, not the summary.
    let summary = &text[..text.find("Configuration file").unwrap()];
    for detail in ["unix://", "managed", "uid"] {
        assert!(!summary.contains(detail), "{detail:?} in {summary}");
    }
}

#[test]
fn the_configuration_file_opens_under_the_summary_as_the_saved_yaml() {
    let mut wizard = reviewing_wizard_with("nvidia.fabric.openclaw");
    let saved = wizard.saved_yaml().unwrap();
    assert!(saved.contains("uid: "), "{saved}");
    // Collapsed, the review names the file and how to open it.
    let collapsed = review_text(&wizard);
    let heading = collapsed
        .iter()
        .position(|line| line.starts_with("▸ Configuration file"))
        .expect("Configuration file heading");
    assert!(
        collapsed[heading].contains("Tab shows it"),
        "{collapsed:#?}"
    );
    assert!(
        !collapsed.iter().any(|line| line.contains("apiVersion")),
        "{collapsed:#?}"
    );
    wizard.press(key(KeyCode::Tab));
    let open = review_text(&wizard);
    assert!(
        open[heading].starts_with("▾ Configuration file"),
        "{open:#?}"
    );
    let file = open[heading + 1..heading + 1 + saved.lines().count()]
        .iter()
        .map(|line| {
            line.strip_prefix("│ ")
                .unwrap_or_else(|| panic!("{line:?}"))
        })
        .collect::<Vec<_>>();
    assert_eq!(file, saved.lines().collect::<Vec<_>>());
    assert_eq!(open[heading + 1 + saved.lines().count()], "╰─");
}

#[test]
fn a_template_with_search_and_grants_summarizes_both() {
    let mut values: Value = serde_saphyr::from_slice(include_bytes!(
        "../../../../examples/onboarding/openclaw.yaml"
    ))
    .unwrap();
    values["spec"]["integrations"] = serde_json::json!({
        "search": {"kind": "webSearch", "provider": "brave", "credential": {"env": "BRAVE_API_KEY"}}
    });
    let sandbox = &mut values["spec"]["sandboxes"]["assistant"];
    sandbox["harness"]["kind"] = serde_json::json!("nvidia.fabric.hermes");
    sandbox["agent"]["integrationRefs"] = serde_json::json!(["search"]);
    sandbox["network"] = serde_json::json!({
        "tier": "isolated",
        "grants": {"documentation": {"endpoints": [{"host": "docs.example.com", "port": 443}]}}
    });
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("template.yaml");
    std::fs::write(&path, serde_json::to_vec(&values).unwrap()).unwrap();
    let wizard = reviewing_template(&path);
    let text = flat(&screen(&wizard, 160, 60));
    assert!(text.contains("Search Brave · BRAVE_API_KEY"), "{text}");
    assert!(
        text.contains(
            "Network Isolated: only the model and search endpoints, and the documentation grant"
        ),
        "{text}"
    );
}

#[test]
fn a_template_with_referenced_grants_summarizes_them_beside_its_own() {
    let mut values: Value = serde_saphyr::from_slice(include_bytes!(
        "../../../../examples/onboarding/openclaw.yaml"
    ))
    .unwrap();
    values["spec"]["grants"] = serde_json::json!({
        "github": {"endpoints": [{"host": "api.github.com", "port": 443}]}
    });
    values["spec"]["sandboxes"]["assistant"]["network"] = serde_json::json!({
        "tier": "isolated",
        "grants": {"documentation": {"endpoints": [{"host": "docs.example.com", "port": 443}]}},
        "grantRefs": ["github"]
    });
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("template.yaml");
    std::fs::write(&path, serde_json::to_vec(&values).unwrap()).unwrap();
    let wizard = reviewing_template(&path);
    let text = flat(&screen(&wizard, 160, 60));
    assert!(
        text.contains(
            "Network Isolated: only the model endpoint, and the documentation and github grants"
        ),
        "{text}"
    );
}

#[test]
fn the_runtime_menu_names_each_runtime_and_offers_no_omit() {
    let capabilities = Capabilities::available();
    let state = load_defaults(&capabilities);
    let mut wizard = JourneyWizard::new(capabilities, state);
    wizard.started = true;
    for _ in 0..5 {
        if wizard
            .question()
            .unwrap()
            .is_some_and(|question| question.id() == "/spec/gateway/target")
        {
            break;
        }
        wizard.advance();
    }
    let question = wizard.question().unwrap().unwrap();
    assert_eq!(question.id(), "/spec/gateway/target");
    let screen = screen(&wizard, 140, 40);
    for label in ["Docker", "Podman", "Kubernetes", "OpenShift"] {
        assert!(screen.contains(label), "{label}: {screen}");
    }
    assert!(!screen.contains("kubernetes"), "{screen}");
    assert!(!screen.contains("Omit"), "{screen}");
    assert!(
        !screen.contains("Ctrl+O"),
        "the footer offers no omit key: {screen}"
    );
    // The last choice is the last runtime; there is nothing after it.
    for _ in 0..10 {
        wizard.next();
    }
    assert_eq!(wizard.choice_index(&question), question.choices().len() - 1);
}

#[test]
fn default_journey_saves_the_reviewed_deployment_without_unasked_sdk_defaults() {
    let capabilities = Capabilities::available();
    let state = load_defaults(&capabilities);
    let mut wizard = JourneyWizard::new(capabilities, state);
    questions_until_review(&mut wizard);
    let yaml = wizard.saved_yaml().unwrap();
    let saved: Value = serde_saphyr::from_str(&yaml).unwrap();
    let docker = saved["spec"]["gateway"]["target"]["docker"]
        .as_object()
        .unwrap();
    assert!(!docker.contains_key("port"), "{yaml}");
    assert!(!docker.contains_key("networkCIDR"), "{yaml}");
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
    let state = load_defaults(&capabilities);
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
    let state = load_defaults(&capabilities);
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
    let state = load_defaults(&capabilities);
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
    values["spec"]["gateway"]["target"]["docker"]["port"] = 17681.into();
    std::fs::write(&template, values.to_string()).unwrap();
    let capabilities = Capabilities::available();
    let state = load_journey(Source::Template(&template), &capabilities).unwrap();
    let mut wizard = JourneyWizard::new(capabilities, state);
    questions_until_review(&mut wizard);
    let saved: Value = serde_saphyr::from_str(&wizard.saved_yaml().unwrap()).unwrap();
    assert_eq!(
        saved.pointer("/spec/gateway/target/docker/port"),
        Some(&Value::from(17681))
    );
}

#[test]
fn review_shows_the_configuration_that_will_be_saved() {
    let capabilities = Capabilities::available();
    let state = load_defaults(&capabilities);
    let mut wizard = JourneyWizard::new(capabilities, state);
    questions_until_review(&mut wizard);
    wizard.accepted = false;
    wizard.toggle_configuration();
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
    let mut state = load_defaults(&capabilities);
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
    // A template's harness outside the offering joins the menu for its run.
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("template.yaml");
    let mut values: Value = serde_saphyr::from_slice(include_bytes!(
        "../../../../examples/onboarding/openclaw.yaml"
    ))
    .unwrap();
    values["spec"]["sandboxes"]["assistant"]["harness"]["kind"] =
        serde_json::json!("nvidia.fabric.remote-agent");
    std::fs::write(&path, serde_json::to_vec(&values).unwrap()).unwrap();
    let mut state = load_journey(Source::Template(&path), &capabilities).unwrap();
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
        .review_lines(u16::MAX)
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
    let state = load_defaults(&capabilities);
    let mut wizard = JourneyWizard::new(capabilities, state);
    wizard.started = true;
    wizard.advance();
    let name = wizard.question().unwrap().unwrap();
    assert_eq!(name.id(), "/metadata/name");
    assert_eq!(name.suggestion(), Some(&serde_json::json!("openclaw")));
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
    values["spec"]["gateway"]["target"]["docker"]["networkCIDR"] =
        serde_json::json!("172.30.77.0/24");
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("template.yaml");
    std::fs::write(&path, values.to_string()).unwrap();
    let capabilities = Capabilities::available();
    let state = load_journey(Source::Template(&path), &capabilities).unwrap();
    let mut wizard = JourneyWizard::new(capabilities, state);
    let asked = questions_until_review(&mut wizard);
    assert!(
        !asked
            .iter()
            .any(|id| id.ends_with("/startup_timeout_seconds")
                || id == "/spec/gateway/target/docker/networkCIDR"),
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
            "Docker: network CIDR: 172.30.77.0/24",
            "Startup timeout seconds: 45",
        ]
    );
}

#[test]
fn mixed_local_and_hosted_template_reaches_review_without_losing_routes() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../examples/platforms/docker/vllm/dgx-spark/local-and-hosted.yaml");
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

#[test]
fn a_template_with_several_routes_gets_a_model_row_for_each() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../examples/platforms/docker/vllm/dgx-spark/local-and-hosted.yaml");
    let wizard = reviewing_template(&path);
    let text = flat(&screen(&wizard, 160, 60));
    for row in [
        "Model local (default): nvidia/Qwen3.8-27B-NVFP4 · local service",
        "Model hosted: replace-with-your-hosted-model · hosted.example",
        "API key HOSTED_API_KEY",
    ] {
        assert!(text.contains(row), "{row:?} is not on screen: {text}");
    }
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
    let state = load_defaults(&capabilities);
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

    let document = Document::parse(
        include_bytes!(
            "../../../../examples/platforms/docker/ollama/dgx-spark/managed-ollama.yaml"
        )
        .as_slice(),
    )
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
    let state = load_defaults(&capabilities);
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
    let state = load_defaults(&capabilities);
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
            models: vec![
                "nvidia/nemotron-3-ultra-550b-a55b".into(),
                "vendor/discovered".into(),
            ],
            api_verified: false,
        }),
    );
    let question = wizard.question().unwrap().unwrap();
    // The endpoint lists a model that is not recommended, so only the
    // recommended model it lists is offered.
    assert_eq!(
        question.choices(),
        [serde_json::json!("nvidia/nemotron-3-ultra-550b-a55b")]
    );
    let mut terminal = Terminal::new(TestBackend::new(140, 40)).unwrap();
    terminal.draw(|frame| wizard.render(frame)).unwrap();
    let screen = terminal.backend().to_string();
    assert!(!screen.contains("vendor/discovered"), "{screen}");
    assert!(screen.contains("Type another model"), "{screen}");
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

#[tokio::test]
async fn a_key_typed_while_the_model_catalog_is_read_does_not_choose_from_the_resolved_menu() {
    let capabilities = Capabilities::available();
    let state = load_defaults(&capabilities);
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
    let query = model_catalog_probe(&wizard).unwrap();
    let shown = wizard.question().unwrap().unwrap().suggestion().cloned();
    // The endpoint answers slowly and lists only a model other than the
    // suggestion on screen, so the resolved menu suggests a different one.
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
    let read = {
        let request = request.clone();
        async move |_: Vec<DiscoveryQuery>, _: &CancellationToken| {
            tokio::time::sleep(std::time::Duration::from_millis(150)).await;
            Ok(DiscoveryObservations::new().with(
                DiscoveryQuery::Inference(request),
                DiscoveryObservation::Inference(EndpointObservation {
                    status: ObservationStatus::Available,
                    reason: None,
                    source: "fixture".into(),
                    reachable: Some(true),
                    authentication:
                        nemoclaw_sdk::inference_discovery::AuthenticationStatus::Accepted,
                    models: vec!["nvidia/nemotron-3-ultra-550b-a55b".into()],
                    api_verified: false,
                }),
            ))
        }
    };
    let enter = crossterm::event::Event::Key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
    let mut queue = std::collections::VecDeque::new();
    assert!(
        ask_target(
            &mut wizard,
            read,
            vec![query],
            &CancellationToken::new(),
            &mut queue,
            || Ok(Some(enter.clone())),
        )
        .await
        .unwrap()
    );
    let resolved = wizard.question().unwrap().unwrap();
    assert_ne!(resolved.suggestion().cloned(), shown);
    assert!(queue.is_empty(), "{queue:?}");
}

#[test]
fn tui_preserves_podman_as_an_authored_target_choice() {
    let capabilities = Capabilities::available();
    let state = load_defaults(&capabilities);
    let mut wizard = JourneyWizard::new(capabilities, state);
    for _ in 0..5 {
        if wizard
            .question()
            .unwrap()
            .is_some_and(|question| question.id() == "/spec/gateway/target")
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
        Some(&serde_json::json!({"podman": {}}))
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
    let state = load_defaults(&capabilities);
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
            .is_some_and(|question| question.id() == "/spec/gateway/target")
        {
            break;
        }
        wizard.advance();
    }
    wizard.advance();
    assert!(wizard.error.is_none(), "{:?}", wizard.error);
    assert_eq!(
        wizard.state().values().pointer("/spec/gateway/target"),
        Some(&serde_json::json!({"podman": {"engine": podman}}))
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
            "adapter:nvidia.fabric.openclaw:/interfaces",
            "adapter:nvidia.fabric.openclaw:/openclaw_command",
            "adapter:nvidia.fabric.openclaw:/port_range",
            "adapter:nvidia.fabric.openclaw:/read_timeout_seconds",
            "adapter:nvidia.fabric.openclaw:/shutdown_timeout_seconds",
            "adapter:nvidia.fabric.openclaw:/startup_timeout_seconds",
            "adapter:nvidia.fabric.openclaw:/agents",
            "adapter:nvidia.fabric.openclaw:/plugins",
            "adapter:nvidia.fabric.openclaw:/tools",
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
            DiscoveryQuery::Gateway(_) => {
                DiscoveryObservation::Gateway(GatewayObservation::unknown("unreachable"))
            }
            DiscoveryQuery::Hardware(_) => {
                DiscoveryObservation::Hardware(HardwareObservation::unknown_because("unreachable"))
            }
            other => panic!("unexpected read {other:?}"),
        };
        observed.record(query, observation);
    }
    Ok(observed)
}

const DOCKER_ENGINE: &str = "unix:///home/me/.colima/docker.sock";
const HERMES_IMAGE: &str =
    "nc-fabric@sha256:1111111111111111111111111111111111111111111111111111111111111111";

/// The default journey for `harness` on a machine whose one Docker engine
/// answered, at the sandbox image question.
fn at_the_image_question(harness: &str) -> JourneyWizard {
    let capabilities = Capabilities::available();
    let state = load_journey(Source::Defaults, &capabilities).unwrap();
    let mut wizard = on_one_docker_engine(capabilities, state);
    wizard.submit(Some(serde_json::json!(harness))).unwrap();
    to_the_image_question(wizard)
}

/// `state` on a machine whose one Docker engine answered, with the first
/// question open.
fn on_one_docker_engine(
    capabilities: Capabilities,
    state: nemoclaw_authoring::JourneyState,
) -> JourneyWizard {
    let candidate = DiscoveryRequest {
        engine: DOCKER_ENGINE.into(),
        compute_driver: ComputeDriver::Docker,
    };
    let mut wizard = JourneyWizard::new(capabilities, state)
        .with_local_engine_candidates(vec![candidate.clone()]);
    wizard.remember(DiscoveryObservations::new().with(
        DiscoveryQuery::Engine(candidate),
        DiscoveryObservation::Engine(engine_observation(ObservationStatus::Available)),
    ));
    wizard.started = true;
    wizard
}

/// Accept suggestions until the sandbox image question is open.
fn to_the_image_question(mut wizard: JourneyWizard) -> JourneyWizard {
    for _ in 0..12 {
        if wizard
            .question()
            .unwrap()
            .is_some_and(|question| question.id().ends_with("/image/ref"))
        {
            return wizard;
        }
        wizard.advance();
        assert!(wizard.error.is_none(), "{:?}", wizard.error);
    }
    panic!("the journey did not reach the image question");
}

/// The engine's images that install the harness asked about.
fn agent_images(references: &[&str]) -> DiscoveryObservation {
    DiscoveryObservation::AgentImages(AgentImagesObservation {
        status: ObservationStatus::Available,
        reason: None,
        details: Default::default(),
        references: references
            .iter()
            .map(|reference| (*reference).into())
            .collect(),
    })
}

const OLDER_HERMES_IMAGE: &str =
    "nc-fabric@sha256:2222222222222222222222222222222222222222222222222222222222222222";
const OPENCLAW_IMAGE: &str =
    "nc-fabric@sha256:4444444444444444444444444444444444444444444444444444444444444444";
const IMAGE_QUESTION: &str = "/spec/sandboxes/assistant/image/ref";

#[test]
fn a_release_image_for_the_selected_harness_fills_an_empty_engine() {
    const RELEASE_IMAGE: &str = "ghcr.io/nvidia/nemoclaw/v1/hermes@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    let capabilities = Capabilities::available().with_release_pins(
        &serde_json::to_vec(&serde_json::json!({
            "release": "v0.1.0-rc.5",
            "components": {"hermes": {"image": RELEASE_IMAGE}},
            "agentImages": [{
                "reference": RELEASE_IMAGE,
                "fabricRevision": nemoclaw_sdk::fabric_catalog::FabricCatalog::bundled_ref().fabric_revision,
                "adapters": ["nvidia.fabric.hermes"]
            }]
        })).unwrap(), Some("v0.1.0-rc.5")
    ).unwrap();
    let state = load_journey(Source::Defaults, &capabilities).unwrap();
    let mut wizard = on_one_docker_engine(capabilities, state);
    wizard
        .submit(Some(serde_json::json!("nvidia.fabric.hermes")))
        .unwrap();
    let mut wizard = to_the_image_question(wizard);
    let query = agent_images_probe(&wizard).unwrap();
    wizard.record(query, agent_images(&[]));
    for _ in 0..30 {
        if wizard.question().unwrap().is_none() {
            break;
        }
        wizard.advance();
        assert!(wizard.error.is_none(), "{:?}", wizard.error);
    }
    let yaml = wizard
        .configuration()
        .expect("release suggestion should reach review")
        .unwrap();
    assert!(yaml.contains(RELEASE_IMAGE));
}

#[test]
fn release_fallback_preserves_local_precedence_and_does_not_cross_harnesses() {
    const PUBLISHED: &str = "ghcr.io/nvidia/nemoclaw/v1/hermes@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    for (harness, local, expected) in [
        (
            "nvidia.fabric.hermes",
            vec![HERMES_IMAGE],
            Some(HERMES_IMAGE),
        ),
        ("nvidia.fabric.hermes", vec![], Some(PUBLISHED)),
        ("nvidia.fabric.openclaw", vec![], None),
    ] {
        let pins = serde_json::json!({
            "release":"v0.1.0-rc.5", "components":{"hermes":{"image":PUBLISHED}},
            "agentImages":[{"reference":PUBLISHED,
                "fabricRevision": nemoclaw_sdk::fabric_catalog::FabricCatalog::bundled_ref().fabric_revision,
                "adapters":["nvidia.fabric.hermes"]}]
        });
        let capabilities = Capabilities::available()
            .with_release_pins(&serde_json::to_vec(&pins).unwrap(), None)
            .unwrap();
        let state = load_journey(Source::Defaults, &capabilities).unwrap();
        let mut wizard = on_one_docker_engine(capabilities, state);
        wizard.submit(Some(serde_json::json!(harness))).unwrap();
        let mut wizard = to_the_image_question(wizard);
        let query = agent_images_probe(&wizard).unwrap();
        wizard.record(query, agent_images(&local));
        if let Some(expected) = expected {
            assert_eq!(
                wizard
                    .state()
                    .values()
                    .pointer(IMAGE_QUESTION)
                    .and_then(serde_json::Value::as_str),
                Some(expected)
            );
        } else {
            assert!(wizard.state().values().pointer(IMAGE_QUESTION).is_none());
            assert_eq!(wizard.question().unwrap().unwrap().id(), IMAGE_QUESTION);
        }
    }
}

#[test]
fn multiple_release_images_stay_choices_and_an_explicit_rejection_blocks_review() {
    const FIRST: &str = "ghcr.io/nvidia/nemoclaw/v1/hermes@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const SECOND: &str = "ghcr.io/nvidia/nemoclaw/v1/alternate@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    let pins = serde_json::json!({
        "release":"v0.1.0-rc.5", "components":{"hermes":{"image":FIRST},"alternate":{"image":SECOND}},
        "agentImages":([FIRST,SECOND].map(|reference| serde_json::json!({
            "reference":reference,
            "fabricRevision":nemoclaw_sdk::fabric_catalog::FabricCatalog::bundled_ref().fabric_revision,
            "adapters":["nvidia.fabric.hermes"]
        })))
    });
    let capabilities = Capabilities::available()
        .with_release_pins(&serde_json::to_vec(&pins).unwrap(), None)
        .unwrap();
    let state = load_journey(Source::Defaults, &capabilities).unwrap();
    let mut wizard = on_one_docker_engine(capabilities, state);
    wizard
        .submit(Some(serde_json::json!("nvidia.fabric.hermes")))
        .unwrap();
    let mut wizard = to_the_image_question(wizard);
    let query = agent_images_probe(&wizard).unwrap();
    wizard.record(query, agent_images(&[]));
    let question = wizard.question().unwrap().unwrap();
    assert_eq!(question.id(), IMAGE_QUESTION);
    assert_eq!(
        question.choices(),
        &[serde_json::json!(FIRST), serde_json::json!(SECOND)]
    );
    wizard.submit(Some(serde_json::json!(SECOND))).unwrap();
    for _ in 0..30 {
        if wizard.question().unwrap().is_none() {
            break;
        }
        wizard.advance();
    }
    let document = wizard
        .resolution()
        .unwrap()
        .assessment()
        .document()
        .unwrap()
        .clone();
    let query = nemoclaw_sdk::discovery::plan_queries(&document)
        .unwrap()
        .into_iter()
        .find(|query| matches!(query, DiscoveryQuery::Fabric(_)))
        .unwrap();
    wizard.record(
        query,
        DiscoveryObservation::Fabric(FabricObservation {
            status: ObservationStatus::Available,
            image_id: Some(format!("sha256:{}", "c".repeat(64))),
            compatibility: Some(nemoclaw_sdk::fabric_capabilities::CompatibilityReport {
                status: nemoclaw_sdk::fabric_capabilities::Support::Unsupported,
                adapter_id: Some("nvidia.fabric.hermes".into()),
                checks: vec![nemoclaw_sdk::fabric_capabilities::CapabilityCheck {
                    requirement: "fixture_runtime".into(),
                    status: nemoclaw_sdk::fabric_capabilities::Support::Unsupported,
                    reason: "runtime cannot run this configuration".into(),
                }],
            }),
            ..FabricObservation::unknown("rejected fixture")
        }),
    );
    assert_eq!(
        wizard
            .state()
            .values()
            .pointer(IMAGE_QUESTION)
            .and_then(serde_json::Value::as_str),
        Some(SECOND),
        "an explicit choice stays authored for review instead of silently replacing it"
    );
    assert_eq!(
        wizard
            .resolution()
            .unwrap()
            .target_assessment()
            .unwrap()
            .status,
        nemoclaw_authoring::CompatibilityStatus::Conflict
    );
}

#[test]
fn image_choices_show_engine_metadata_without_changing_the_saved_digest() {
    let mut wizard = at_the_image_question("nvidia.fabric.hermes");
    let query = agent_images_probe(&wizard).unwrap();
    wizard.record(
        query,
        DiscoveryObservation::AgentImages(
            serde_json::from_value(serde_json::json!({
                "status": "available", "reason": null,
                "references": [HERMES_IMAGE, OLDER_HERMES_IMAGE],
                "details": {HERMES_IMAGE: {
                    "tags": ["hermes:local"], "created": 1795550400,
                    "revision": "abc123"
                }}
            }))
            .unwrap(),
        ),
    );
    let text = flat(&screen(&wizard, 160, 45));
    for expected in ["hermes:local", "2026-11-24", "abc123", "not advertised"] {
        assert!(text.contains(expected), "missing {expected}: {text}");
    }
    wizard.advance();
    assert_eq!(
        wizard.state().values().pointer(IMAGE_QUESTION),
        Some(&serde_json::json!(HERMES_IMAGE))
    );
}

#[test]
fn compatible_review_distinguishes_metadata_from_runtime_and_inference_checks() {
    let wizard = reviewing_wizard_with("nvidia.fabric.hermes");
    let resolution = wizard.state().resolve(&wizard.capabilities).unwrap();
    let rows = super::summary::rows(
        resolution.assessment().document().unwrap(),
        &super::summary::Facts {
            observations: wizard.observations(),
            target: Some(nemoclaw_authoring::CompatibilityStatus::Compatible),
            output: None,
        },
    );
    let image = rows.iter().find(|row| row.label == "Image").unwrap();
    assert_eq!(image.status.as_ref().unwrap().text, "metadata compatible");
    let detail = image.detail.as_deref().unwrap_or_default();
    assert!(
        detail.contains("runtime") && detail.contains("inference"),
        "{detail}"
    );
}

#[test]
fn review_names_the_full_inference_url_before_a_request_is_attempted() {
    let document = nemoclaw_sdk::config::Document::parse(
        include_bytes!("../../../../examples/onboarding/openclaw.yaml").as_slice(),
    )
    .unwrap();
    let rows = super::summary::rows(
        &document,
        &super::summary::Facts {
            observations: &DiscoveryObservations::new(),
            target: None,
            output: None,
        },
    );
    assert!(
        rows.iter()
            .any(|row| row.value == "https://integrate.api.nvidia.com/v1")
    );
}

#[test]
fn review_requests_gateway_credentials_at_plan_time() {
    let document = nemoclaw_sdk::config::Document::parse(
        include_bytes!("../../../../examples/platforms/kubernetes/external-gateway.yaml")
            .as_slice(),
    )
    .unwrap();
    let mut value = serde_json::to_value(document).unwrap();
    value["spec"]["inferenceProviders"]["inference"]["credential"]["env"] =
        serde_json::json!("GATEWAY_TOKEN");
    let document =
        nemoclaw_sdk::config::Document::parse(serde_json::to_vec(&value).unwrap().as_slice())
            .unwrap();
    let mut observations = DiscoveryObservations::new();
    for reference in document.plan_credential_names() {
        observations.record(
            DiscoveryQuery::Credential(CredentialRequest {
                reference: reference.into(),
            }),
            DiscoveryObservation::Credential(CredentialObservation {
                reference: reference.into(),
                status: ObservationStatus::Unavailable,
                reason: None,
            }),
        );
    }
    let rows = super::summary::rows(
        &document,
        &super::summary::Facts {
            observations: &observations,
            target: None,
            output: None,
        },
    );
    let row = rows
        .iter()
        .find(|row| row.value == "GATEWAY_TOKEN")
        .unwrap();
    assert_eq!(
        row.status.as_ref().unwrap().text,
        "not set (plan will ask for it)"
    );
}

#[test]
fn a_discovered_image_is_named_when_its_question_is_skipped() {
    let mut wizard = at_the_image_question("nvidia.fabric.hermes");
    let query = agent_images_probe(&wizard).unwrap();
    wizard.record(query, agent_images(&[HERMES_IMAGE]));
    assert_ne!(wizard.question().unwrap().unwrap().id(), IMAGE_QUESTION);
    let text = flat(&screen(&wizard, 160, 40));
    assert!(text.contains("Automatically selected image"), "{text}");
    assert!(
        text.contains("only image discovered for this harness"),
        "{text}"
    );
    assert!(text.contains(HERMES_IMAGE), "{text}");
    assert!(text.contains("back to change"), "{text}");
}

#[test]
fn a_matching_image_without_a_digest_explains_how_to_rebuild_it() {
    let mut wizard = at_the_image_question("nvidia.fabric.hermes");
    let query = agent_images_probe(&wizard).unwrap();
    wizard.record(query, DiscoveryObservation::AgentImages(AgentImagesObservation {
        status: ObservationStatus::Available,
        reason: Some("Matching images have no repository digest. Enable the containerd image store and rebuild.".into()),
        references: vec![],
        details: Default::default(),
    }));
    let text = flat(&screen(&wizard, 160, 40));
    assert!(text.contains("no repository digest"), "{text}");
    assert!(text.contains("containerd"), "{text}");
    assert!(!text.contains("No image on this engine installs"), "{text}");
}

#[test]
fn an_image_tag_is_rejected_with_the_required_reference_format() {
    let mut wizard = at_the_image_question("nvidia.fabric.hermes");
    let error = wizard
        .submit(Some(serde_json::json!("hermes:latest")))
        .unwrap_err()
        .to_string();
    assert!(error.contains("NAME@sha256:"), "{error}");
    assert!(error.contains("repository digest"), "{error}");
    assert_eq!(wizard.question().unwrap().unwrap().id(), IMAGE_QUESTION);
}

#[test]
fn the_image_question_suggests_the_newest_of_the_local_images_that_install_the_chosen_harness() {
    let mut wizard = at_the_image_question("nvidia.fabric.hermes");
    let query = agent_images_probe(&wizard).expect("the image question reads the engine's images");
    assert_eq!(
        query,
        DiscoveryQuery::AgentImages(AgentImagesRequest {
            engine: DOCKER_ENGINE.into(),
            adapter_id: "nvidia.fabric.hermes".into(),
        })
    );
    wizard.record(query, agent_images(&[HERMES_IMAGE, OLDER_HERMES_IMAGE]));
    assert_eq!(
        agent_images_probe(&wizard),
        None,
        "the images are read once"
    );
    let question = wizard.question().unwrap().unwrap();
    assert_eq!(question.id(), IMAGE_QUESTION);
    assert_eq!(
        question.suggestion(),
        Some(&serde_json::json!(HERMES_IMAGE))
    );
    assert_eq!(
        question.choices(),
        [
            serde_json::json!(HERMES_IMAGE),
            serde_json::json!(OLDER_HERMES_IMAGE)
        ]
    );
}

#[test]
fn exactly_one_local_image_for_the_harness_is_chosen_without_asking_and_saved() {
    let mut wizard = at_the_image_question("nvidia.fabric.hermes");
    let query = agent_images_probe(&wizard).unwrap();
    wizard.record(query, agent_images(&[HERMES_IMAGE]));
    let mut asked = Vec::new();
    while let Some(question) = wizard.question().unwrap() {
        assert!(
            asked.len() < 40,
            "the journey did not reach review: {asked:?}"
        );
        asked.push(question.id().to_owned());
        wizard.advance();
        assert!(wizard.error.is_none(), "{asked:?}: {:?}", wizard.error);
    }
    assert!(!asked.iter().any(|id| id == IMAGE_QUESTION), "{asked:?}");
    let yaml = wizard.configuration().unwrap().unwrap();
    assert!(yaml.contains(HERMES_IMAGE), "{yaml}");
    let review = screen(&wizard, 160, 60);
    assert!(review.contains(HERMES_IMAGE), "{review}");
}

/// The only image on the engine for the harness is chosen without asking, but
/// when the review's read finds it can't run the configuration, onboarding
/// asks for the image again, says why, and doesn't choose it again (#14798).
#[test]
fn an_only_image_that_cannot_run_the_configuration_is_asked_for_with_the_reason() {
    use nemoclaw_sdk::discovery::plan_queries;
    use nemoclaw_sdk::fabric_capabilities::{CapabilityCheck, CompatibilityReport, Support};
    const REJECTION: &str = "spec.sandboxes[assistant].harness.runtime.keep_state: the adapter does not declare that it keeps its state in an agent-named folder";
    let mut wizard = at_the_image_question("nvidia.fabric.hermes");
    let query = agent_images_probe(&wizard).unwrap();
    wizard.record(query, agent_images(&[HERMES_IMAGE]));
    while wizard.question().unwrap().is_some() {
        wizard.advance();
        assert!(wizard.error.is_none(), "{:?}", wizard.error);
    }
    let document = wizard
        .resolution()
        .unwrap()
        .assessment()
        .document()
        .cloned()
        .unwrap();
    let image_query = plan_queries(&document)
        .unwrap()
        .into_iter()
        .find(|query| matches!(query, DiscoveryQuery::Fabric(_)))
        .unwrap();
    wizard.record(
        image_query,
        DiscoveryObservation::Fabric(FabricObservation {
            status: ObservationStatus::Available,
            compatibility: Some(CompatibilityReport {
                status: Support::Unsupported,
                adapter_id: Some("nvidia.fabric.hermes".into()),
                checks: vec![CapabilityCheck {
                    requirement: "fabric_configuration".into(),
                    status: Support::Unsupported,
                    reason: REJECTION.into(),
                }],
            }),
            ..FabricObservation::unknown("fixture")
        }),
    );
    let question = wizard
        .question()
        .unwrap()
        .expect("the image is asked for again");
    assert_eq!(question.id(), IMAGE_QUESTION);
    let note = question.note().unwrap_or_default();
    assert!(
        note.contains(HERMES_IMAGE) && note.contains(REJECTION),
        "{note}"
    );
    let text = flat(&screen(&wizard, 160, 60));
    assert!(text.contains("can't run this configuration"), "{text}");
}

/// The chosen image is only a default: going back from the next question asks
/// for it, so the user can enter another image.
#[test]
fn going_back_from_the_question_after_a_chosen_image_asks_for_the_image() {
    const REGISTRY_IMAGE: &str = "registry.example/agents/hermes@sha256:1111111111111111111111111111111111111111111111111111111111111111";
    let mut wizard = at_the_image_question("nvidia.fabric.hermes");
    let query = agent_images_probe(&wizard).unwrap();
    wizard.record(query, agent_images(&[HERMES_IMAGE]));
    assert_ne!(wizard.question().unwrap().unwrap().id(), IMAGE_QUESTION);
    wizard.back();
    let question = wizard.question().unwrap().unwrap();
    assert_eq!(question.id(), IMAGE_QUESTION);
    assert_eq!(
        question.suggestion(),
        Some(&serde_json::json!(HERMES_IMAGE))
    );
    wizard
        .submit(Some(serde_json::json!(REGISTRY_IMAGE)))
        .unwrap();
    let mut asked = Vec::new();
    while let Some(question) = wizard.question().unwrap() {
        assert!(
            asked.len() < 40,
            "the journey did not reach review: {asked:?}"
        );
        asked.push(question.id().to_owned());
        wizard.advance();
        assert!(wizard.error.is_none(), "{asked:?}: {:?}", wizard.error);
    }
    let yaml = wizard.configuration().unwrap().unwrap();
    assert!(
        yaml.contains(REGISTRY_IMAGE) && !yaml.contains(HERMES_IMAGE),
        "{yaml}"
    );
}

/// A rejected entry at the reopened image question keeps the question open,
/// rather than bringing back the image the user went back to replace.
#[test]
fn a_rejected_image_at_the_reopened_question_keeps_it_open() {
    let mut wizard = at_the_image_question("nvidia.fabric.hermes");
    let query = agent_images_probe(&wizard).unwrap();
    wizard.record(query, agent_images(&[HERMES_IMAGE]));
    wizard.back();
    assert_eq!(wizard.question().unwrap().unwrap().id(), IMAGE_QUESTION);
    assert!(
        wizard
            .submit(Some(serde_json::json!("hermes:latest")))
            .is_err()
    );
    assert_eq!(wizard.question().unwrap().unwrap().id(), IMAGE_QUESTION);
}

#[test]
fn an_image_the_engine_could_not_list_is_still_asked() {
    let mut wizard = at_the_image_question("nvidia.fabric.hermes");
    let query = agent_images_probe(&wizard).unwrap();
    wizard.record(
        query,
        DiscoveryObservation::AgentImages(AgentImagesObservation {
            status: ObservationStatus::Unknown,
            reason: Some("the engine did not answer".into()),
            references: vec![HERMES_IMAGE.into()],
            details: Default::default(),
        }),
    );
    assert_eq!(wizard.question().unwrap().unwrap().id(), IMAGE_QUESTION);
}

/// The express OpenClaw template after `edit`, on a machine whose one Docker
/// engine answered, at the sandbox image question with the engine holding
/// `local`.
fn template_at_the_image_question(edit: impl FnOnce(&mut Value), local: &[&str]) -> JourneyWizard {
    let mut values: Value = serde_saphyr::from_slice(include_bytes!(
        "../../../../examples/onboarding/openclaw.yaml"
    ))
    .unwrap();
    edit(&mut values);
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("template.yaml");
    std::fs::write(&path, values.to_string()).unwrap();
    let capabilities = Capabilities::available();
    let state = load_journey(Source::Template(&path), &capabilities).unwrap();
    let mut wizard = to_the_image_question(on_one_docker_engine(capabilities, state));
    let query = agent_images_probe(&wizard).unwrap();
    wizard.record(query, agent_images(local));
    wizard
}

/// Name `image` as the template's sandbox image, or none.
fn with_image(image: Option<&str>) -> impl FnOnce(&mut Value) {
    move |values| {
        let sandbox = values["spec"]["sandboxes"]["assistant"]
            .as_object_mut()
            .unwrap();
        match image {
            Some(image) => sandbox.insert("image".into(), serde_json::json!({"ref": image})),
            None => sandbox.remove("image"),
        };
    }
}

#[test]
fn a_template_image_is_asked_about_unless_it_is_the_one_local_image() {
    // The template's own image is a placeholder digest.
    let placeholder = template_at_the_image_question(|_| {}, &[OPENCLAW_IMAGE]);
    let other = template_at_the_image_question(with_image(Some(HERMES_IMAGE)), &[OPENCLAW_IMAGE]);
    for wizard in [placeholder, other] {
        let question = wizard.question().unwrap().unwrap();
        assert_eq!(question.id(), IMAGE_QUESTION);
        assert_eq!(
            question.suggestion(),
            Some(&serde_json::json!(OPENCLAW_IMAGE))
        );
    }
    let same = template_at_the_image_question(with_image(Some(OPENCLAW_IMAGE)), &[OPENCLAW_IMAGE]);
    let next = same
        .question()
        .unwrap()
        .map(|question| question.id().to_owned());
    assert_ne!(next.as_deref(), Some(IMAGE_QUESTION));
}

#[test]
fn the_one_image_of_a_harness_the_sandbox_refers_to_is_chosen() {
    let wizard = template_at_the_image_question(
        |values| {
            let sandbox = values["spec"]["sandboxes"]["assistant"]
                .as_object_mut()
                .unwrap();
            sandbox.remove("harness");
            sandbox.remove("image");
            sandbox.insert("harnessRef".into(), serde_json::json!("shared"));
            values["spec"]["harnesses"] =
                serde_json::json!({"shared": {"kind": "nvidia.fabric.openclaw"}});
        },
        &[OPENCLAW_IMAGE],
    );
    assert_eq!(
        wizard.state().values().pointer(IMAGE_QUESTION),
        Some(&serde_json::json!(OPENCLAW_IMAGE))
    );
}

#[test]
fn an_engine_the_journey_still_asks_about_keeps_the_image_question_open() {
    // No engine answered on the template's socket, so the engine question
    // follows the image question, and the engine chosen there may not hold
    // the image.
    let wizard = template_at_the_image_question(
        |values| {
            values["spec"]["gateway"]["target"]["docker"]["engine"] =
                serde_json::json!("unix:///other/engine.sock");
            with_image(None)(values);
        },
        &[OPENCLAW_IMAGE],
    );
    assert_eq!(wizard.question().unwrap().unwrap().id(), IMAGE_QUESTION);
}

#[test]
fn going_back_to_a_question_the_image_read_depends_on_leaves_the_image_unanswered() {
    // The template names the engine, so the images stay read at the earlier
    // questions, where the harness or target chosen next may not match them.
    for earlier in [
        "/spec/sandboxes/assistant/harness/kind",
        "/spec/gateway/target",
    ] {
        let mut wizard = template_at_the_image_question(
            |values| {
                values["spec"]["gateway"]["target"]["docker"]["engine"] =
                    serde_json::json!(DOCKER_ENGINE);
                with_image(None)(values);
            },
            &[OPENCLAW_IMAGE],
        );
        assert!(wizard.state().values().pointer(IMAGE_QUESTION).is_some());
        for _ in 0..14 {
            if wizard.question().unwrap().unwrap().id() == earlier {
                break;
            }
            wizard.back();
        }
        assert_eq!(wizard.question().unwrap().unwrap().id(), earlier);
        assert_eq!(
            wizard.state().values().pointer(IMAGE_QUESTION),
            None,
            "{earlier}"
        );
    }
}

#[tokio::test]
async fn keys_typed_while_the_one_image_is_read_do_not_answer_the_next_question() {
    let mut wizard = at_the_image_question("nvidia.fabric.hermes");
    let query = agent_images_probe(&wizard).unwrap();
    let mut queued = std::collections::VecDeque::new();
    let enter = crossterm::event::Event::Key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
    let mut typed = vec![enter];
    // The read ends once the key has been taken off the input.
    let taken = tokio::sync::Notify::new();
    let read = async |queries: Vec<DiscoveryQuery>, _: &CancellationToken| {
        taken.notified().await;
        Ok(observe_fixture(queries))
    };
    let answered = ask_target(
        &mut wizard,
        read,
        vec![query],
        &CancellationToken::new(),
        &mut queued,
        || {
            let event = typed.pop();
            if event.is_some() {
                taken.notify_one();
            }
            Ok(event)
        },
    )
    .await;
    assert!(answered.unwrap());
    assert_ne!(wizard.question().unwrap().unwrap().id(), IMAGE_QUESTION);
    assert!(queued.is_empty(), "{queued:?}");
}

/// What an engine that holds one hermes image, and an inference endpoint
/// that cannot be reached, say to `queries`.
fn observe_fixture(queries: Vec<DiscoveryQuery>) -> DiscoveryObservations {
    let mut observed = DiscoveryObservations::new();
    for query in queries {
        let observation = match &query {
            DiscoveryQuery::AgentImages(_) => agent_images(&[HERMES_IMAGE]),
            DiscoveryQuery::Inference(_) => {
                DiscoveryObservation::Inference(EndpointObservation::unknown("unreachable"))
            }
            other => panic!("unexpected read {other:?}"),
        };
        observed.record(query, observation);
    }
    observed
}

#[tokio::test]
async fn the_question_after_the_one_image_is_read_for_before_input() {
    let mut wizard = at_the_image_question("nvidia.fabric.hermes");
    let reads = std::cell::RefCell::new(Vec::new());
    let read = async |queries: Vec<DiscoveryQuery>, _: &CancellationToken| {
        reads.borrow_mut().push(queries.clone());
        Ok(observe_fixture(queries))
    };
    let discovered = discover_before_input(
        &mut wizard,
        read,
        &CancellationToken::new(),
        &mut std::collections::VecDeque::new(),
        || Ok(None),
        |_| Ok(()),
    )
    .await;
    assert!(discovered.unwrap());
    let reads = reads.into_inner();
    assert!(
        matches!(
            reads.as_slice(),
            [images, catalog]
                if matches!(images[..], [DiscoveryQuery::AgentImages(_)])
                    && matches!(catalog[..], [DiscoveryQuery::Inference(_)])
        ),
        "{reads:?}"
    );
    let question = wizard.question().unwrap().unwrap();
    assert_eq!(question.kind(), JourneyQuestionKind::InferenceModel);
}

#[test]
fn without_a_local_image_for_the_harness_the_image_question_says_how_to_build_one() {
    let mut wizard = at_the_image_question("nvidia.fabric.hermes");
    let query = agent_images_probe(&wizard).unwrap();
    wizard.record(query, agent_images(&[]));
    let question = wizard.question().unwrap().unwrap();
    assert_eq!(question.suggestion(), None);
    let note = question
        .note()
        .expect("the question says why it suggests no image");
    assert!(
        note.contains("/docs/build-deploy/build.md#building-agent-images")
            && !note.contains("/blob/v1/"),
        "{note}"
    );
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
    let state = load_defaults(&capabilities);
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
    let state = load_defaults(&capabilities);
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
    let text = flat(&screen(&wizard, 100, 40));
    assert!(
        text.contains("API key NVIDIA_API_KEY · could not be read (apply will ask for it)"),
        "{text}"
    );
    // The key may be set but unreadable here, so getting a new one is no fix.
    assert!(text.contains("hidden input"), "{text}");
    assert!(!text.contains("export NVIDIA_API_KEY="), "{text}");
    assert!(!text.contains("Get a key at"), "{text}");
}

/// Read as `unreachable` does, except that the engine holds no image.
async fn without_images(
    queries: Vec<DiscoveryQuery>,
    cancel: &CancellationToken,
) -> Result<DiscoveryObservations, Error> {
    let (images, rest): (Vec<_>, Vec<_>) = queries
        .into_iter()
        .partition(|query| matches!(query, DiscoveryQuery::Fabric(_)));
    let mut observed = unreachable(rest, cancel).await?;
    for query in images {
        observed.record(
            query,
            DiscoveryObservation::Fabric(FabricObservation {
                status: ObservationStatus::Unavailable,
                reason: Some("image is not present on the selected engine".into()),
                ..FabricObservation::unknown("fixture")
            }),
        );
    }
    Ok(observed)
}

#[tokio::test]
async fn review_reads_the_image_once_and_says_how_to_get_an_absent_one() {
    let mut wizard = reviewing_wizard(unverified_engine());
    let asked = image_probe(&wizard);
    assert!(
        asked
            .iter()
            .any(|query| matches!(query, DiscoveryQuery::Fabric(_))),
        "{asked:?}"
    );
    assert!(
        ask_target(
            &mut wizard,
            without_images,
            asked,
            &CancellationToken::new(),
            &mut std::collections::VecDeque::new(),
            || Ok(None),
        )
        .await
        .unwrap()
    );
    assert!(image_probe(&wizard).is_empty(), "the image is read once");
    for (width, height) in [(160, 40), (80, 30)] {
        let text = flat(&screen(&wizard, width, height));
        assert!(text.contains("not present"), "{width}x{height}: {text}");
        // Source-pinned links can wrap within any path segment.
        let unwrapped: String = text
            .chars()
            .filter(|c| !c.is_whitespace() && *c != '"')
            .collect();
        assert!(
            unwrapped.contains("/docs/build-deploy/build.md#building-agent-images"),
            "{width}x{height}: {text}"
        );
        assert!(!text.contains("/blob/v1/"), "{text}");
        assert!(!text.contains("not checked"), "{width}x{height}: {text}");
        assert!(
            !text.contains("not been observed"),
            "{width}x{height}: {text}"
        );
    }
}

#[tokio::test]
async fn the_enter_that_reveals_an_absent_image_shows_it_before_saving() {
    let mut wizard = reviewing_wizard(unverified_engine());
    let enter = async |wizard: &mut JourneyWizard| {
        accept_review(
            wizard,
            without_images,
            &CancellationToken::new(),
            &mut std::collections::VecDeque::new(),
            || Ok(None),
        )
        .await
        .unwrap()
    };
    assert!(enter(&mut wizard).await);
    assert!(!wizard.accepted, "the read changed what the review showed");
    assert!(flat(&screen(&wizard, 160, 40)).contains("not present"));
    assert!(enter(&mut wizard).await);
    assert!(wizard.accepted, "the review now shows what saving reads");
}

#[test]
fn a_target_onboarding_did_not_read_is_not_checked_without_asking_for_action() {
    let wizard = reviewing_wizard_with("nvidia.fabric.hermes");
    assert!(wizard.resolution().unwrap().target_assessment().is_none());
    // The image is too long to share a line with its verdict on this screen.
    assert_eq!(foreground_of(&wizard, "not checked"), super::view::MUTED);
}

#[test]
fn questions_do_not_check_credentials() {
    let capabilities = Capabilities::available();
    let state = load_defaults(&capabilities);
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
        (ObservationStatus::Available, "API key NVIDIA_API_KEY · set"),
        (
            ObservationStatus::Unavailable,
            "API key NVIDIA_API_KEY · not set (apply will ask for it)",
        ),
    ] {
        let capabilities = Capabilities::available();
        let state = load_defaults(&capabilities);
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
                assert!(!text.contains("NVIDIA_API_KEY ·"), "{text}");
            }
            wizard.advance();
        }
        assert!(wizard.question().unwrap().is_none(), "review");
        for (width, height) in [(160, 35), (72, 24)] {
            let text = flat(&screen(&wizard, width, height));
            assert!(text.contains(expected), "{width}x{height}: {text}");
            let unset = status == ObservationStatus::Unavailable;
            let hints = ["https://build.nvidia.com/settings/api-keys", "hidden input"];
            for hint in hints {
                assert_eq!(
                    text.contains(hint),
                    unset,
                    "{hint} at {width}x{height}: {text}"
                );
            }
            assert!(!text.contains("non-interactive"), "{text}");
            assert!(!text.contains("export NVIDIA_API_KEY="), "{text}");
        }
        if status == ObservationStatus::Unavailable {
            // The detail wraps under the value, not back to the label column.
            let screen = screen(&wizard, 72, 24);
            let rows = screen
                .lines()
                .map(|row| row.trim_matches('"'))
                .collect::<Vec<_>>();
            let first = rows
                .iter()
                .position(|row| row.contains("Get a key"))
                .unwrap();
            let value = rows.iter().find(|row| row.contains("API key")).unwrap();
            let column = value.find("NVIDIA_API_KEY").unwrap();
            for row in &rows[first..=first + 1] {
                assert_eq!(
                    row.len() - row.trim_start().len(),
                    column,
                    "{row:?} in {screen}"
                );
            }
        }
        // Color is not the only signal, but an unset key is what the user must act on.
        assert_eq!(
            foreground_after(&wizard, "NVIDIA_API_KEY · ") == super::view::WARNING,
            status == ObservationStatus::Unavailable
        );
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
    let mut wizard = wizard_with_one_docker_engine(status).await;
    wizard.started = true;
    for _ in 0..20 {
        if wizard
            .question()
            .unwrap()
            .is_some_and(|question| question.id() == "/spec/gateway/target/docker/engine")
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

/// The default journey at review. This machine answered for no engine, and the
/// engine the document names was read as `engine`.
fn reviewing_wizard(engine: EngineObservation) -> JourneyWizard {
    let capabilities = Capabilities::available();
    let mut state = load_defaults(&capabilities);
    // The document is complete once the agent, its name, and its image are chosen.
    for (id, answer) in [
        (
            "/spec/sandboxes/assistant/harness/kind",
            "nvidia.fabric.openclaw",
        ),
        ("/metadata/name", "openclaw"),
        ("/spec/sandboxes/assistant/image/ref", AGENT_IMAGE),
    ] {
        state
            .answer(&capabilities, id, Some(serde_json::json!(answer)))
            .unwrap();
    }
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

/// The foreground of the cell after the first `prefix` on the rendered screen.
fn foreground_after(wizard: &JourneyWizard, prefix: &str) -> ratatui::style::Color {
    let buffer = drawn(wizard, 100, 40);
    for y in 0..buffer.area.height {
        let row = (0..buffer.area.width)
            .map(|x| buffer[(x, y)].symbol().to_owned())
            .collect::<String>();
        if let Some(column) = row.find(prefix) {
            let x = row[..column + prefix.len()].chars().count() as u16;
            return buffer[(x, y)].fg;
        }
    }
    panic!("{prefix:?} is not on screen");
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
            "Image nc-fabric@sha256:",
            "not checked",
            "No docker engine answered on this machine.",
            "The selected engine remains unverified.",
            "The selected image's Fabric capabilities have not been observed.",
        ] {
            assert!(text.contains(expected), "{width}x{height}: {screen}");
        }
        if let Some(yaml) = screen.find("kind:") {
            assert!(screen.find("not checked") < Some(yaml), "{screen}");
        }
        assert!(!text.contains("Target:"), "{screen}");
    }
    for unverified in ["not checked", "No docker engine answered"] {
        assert_eq!(foreground_of(&wizard, unverified), super::view::WARNING);
    }
}

#[test]
fn a_target_conflict_blocks_saving_and_says_why_on_the_review() {
    let mut wizard = reviewing_wizard(conflicting_engine());
    for (width, height) in [(80, 24), (140, 40)] {
        wizard.review_scroll = 0;
        let screen = screen(&wizard, width, height);
        let text = flat(&screen);
        assert!(text.contains("Target: Conflict"), "{screen}");
        // The conflict prevents saving, so it leads the screen.
        assert!(
            text.find("Target: Conflict") < text.find("Agent OpenClaw"),
            "{screen}"
        );
        assert!(text.contains("Image nc-fabric@sha256:"), "{screen}");
        assert!(text.contains("conflict"), "{screen}");
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
    wizard.toggle_configuration();
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
            "adapter:nvidia.fabric.openclaw:/interfaces",
            "adapter:nvidia.fabric.openclaw:/openclaw_command",
            "adapter:nvidia.fabric.openclaw:/port_range",
            "adapter:nvidia.fabric.openclaw:/read_timeout_seconds",
            "adapter:nvidia.fabric.openclaw:/shutdown_timeout_seconds",
            "adapter:nvidia.fabric.openclaw:/startup_timeout_seconds",
            "adapter:nvidia.fabric.openclaw:/agents",
            "adapter:nvidia.fabric.openclaw:/plugins",
            "adapter:nvidia.fabric.openclaw:/tools",
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
    (3..height - 2)
        .map(|y| buffer[(width - 3, y)].symbol().to_owned())
        .collect()
}

#[test]
fn the_scrollbar_thumb_reaches_each_end_with_the_review() {
    let mut wizard = reviewing_wizard(unverified_engine());
    wizard.toggle_configuration();
    let top = scrollbar_column(&wizard, 80, 24);
    assert!(top.starts_with('┃'), "{top}");
    scroll_to_end(&mut wizard, 80, 24);
    let bottom = scrollbar_column(&wizard, 80, 24);
    assert!(bottom.ends_with('┃'), "{bottom}");
}

#[test]
fn review_opens_at_the_top_after_going_back_and_returning() {
    let mut wizard = reviewing_wizard(unverified_engine());
    wizard.toggle_configuration();
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

#[test]
fn the_default_harness_menu_offers_openclaw_then_hermes() {
    let capabilities = Capabilities::available();
    let state = load_defaults(&capabilities);
    let mut wizard = JourneyWizard::new(capabilities, state);
    wizard.advance();
    let question = wizard.question().unwrap().unwrap();
    assert_eq!(question.id(), "/spec/sandboxes/assistant/harness/kind");
    assert_eq!(
        question.choices(),
        [
            serde_json::json!("nvidia.fabric.openclaw"),
            serde_json::json!("nvidia.fabric.hermes")
        ]
    );
    assert_eq!(
        question.suggestion(),
        Some(&serde_json::json!("nvidia.fabric.openclaw"))
    );
}

fn key(code: KeyCode) -> KeyEvent {
    KeyEvent::new(code, KeyModifiers::NONE)
}

fn type_text(wizard: &mut JourneyWizard, text: &str) {
    for character in text.chars() {
        wizard.press(key(KeyCode::Char(character)));
    }
}

/// The default journey at the question `id`, accepting every suggestion before it.
fn wizard_at(id: &str) -> JourneyWizard {
    let capabilities = Capabilities::available();
    let state = load_defaults(&capabilities);
    let mut wizard = JourneyWizard::new(capabilities, state);
    wizard.started = true;
    for _ in 0..20 {
        if wizard
            .question()
            .unwrap()
            .is_some_and(|question| question.id() == id)
        {
            return wizard;
        }
        wizard.advance();
        assert!(wizard.error.is_none(), "{:?}", wizard.error);
    }
    panic!("the default journey never asked {id}");
}

/// The text answer's line on screen: the one with the cursor.
fn input_line(wizard: &JourneyWizard) -> String {
    screen(wizard, 100, 40)
        .lines()
        .find(|line| line.contains('▌'))
        .expect("a text question draws a cursor")
        .trim_matches('"')
        .trim()
        .to_owned()
}

#[test]
fn after_tab_backspace_removes_one_character_of_the_suggestion() {
    let mut wizard = wizard_at("/metadata/name");
    wizard.press(key(KeyCode::Tab));
    wizard.press(key(KeyCode::Backspace));
    assert_eq!(input_line(&wizard), "opencla▌");
    type_text(&mut wizard, "w-2");
    wizard.press(key(KeyCode::Enter));
    assert_eq!(
        wizard.state().values().pointer("/metadata/name"),
        Some(&serde_json::json!("openclaw-2"))
    );
}

#[test]
fn an_emptied_answer_shows_the_suggestion_as_a_placeholder_not_as_typed_text() {
    let mut wizard = wizard_at("/metadata/name");
    type_text(&mut wizard, "x");
    wizard.press(key(KeyCode::Backspace));
    // The cursor comes before the suggestion, which is marked in text.
    assert_eq!(input_line(&wizard), "▌openclaw  (suggested)");
    let placeholder = foreground_of(&wizard, "openclaw");
    type_text(&mut wizard, "openclaw");
    assert_ne!(
        placeholder,
        foreground_of(&wizard, "openclaw"),
        "the placeholder is drawn unlike typed text"
    );
}

#[test]
fn enter_on_an_empty_answer_accepts_the_suggestion() {
    let mut wizard = wizard_at("/metadata/name");
    type_text(&mut wizard, "x");
    wizard.press(key(KeyCode::Backspace));
    wizard.press(key(KeyCode::Enter));
    assert!(wizard.error.is_none(), "{:?}", wizard.error);
    assert_eq!(
        wizard.state().values().pointer("/metadata/name"),
        Some(&serde_json::json!("openclaw"))
    );
}

#[test]
fn typing_replaces_the_placeholder() {
    let mut wizard = wizard_at("/metadata/name");
    type_text(&mut wizard, "my-agent");
    assert_eq!(input_line(&wizard), "my-agent▌");
    wizard.press(key(KeyCode::Enter));
    assert_eq!(
        wizard.state().values().pointer("/metadata/name"),
        Some(&serde_json::json!("my-agent"))
    );
}

#[test]
fn an_optional_suggested_value_is_left_out_with_the_omit_key_the_screen_names() {
    let engine = "/spec/gateway/target/docker/engine";
    let mut wizard = wizard_at(engine);
    let question = wizard.question().unwrap().unwrap();
    assert!(question.omittable() && question.suggestion().is_some());
    // The narrowest terminal the wizard draws still names the key.
    let screen = screen(&wizard, 72, 24);
    assert!(screen.contains("Ctrl+O  omit"), "{screen}");
    wizard.press(KeyEvent::new(KeyCode::Char('o'), KeyModifiers::CONTROL));
    assert!(wizard.error.is_none(), "{:?}", wizard.error);
    assert_eq!(
        wizard.state().decision_status(engine),
        nemoclaw_authoring::DecisionStatus::Omitted
    );
    assert_eq!(wizard.state().values().pointer(engine), None);
}

#[test]
fn a_suggested_text_question_names_every_key_at_the_narrowest_width() {
    let wizard = wizard_at("/metadata/name");
    let screen = screen(&wizard, 72, 24);
    for keys in ["Tab  edit suggestion", "Enter  continue", "Esc  exit"] {
        assert!(screen.contains(keys), "{keys}: {screen}");
    }
}

#[test]
fn another_model_entry_starts_empty_because_enter_needs_a_typed_identifier() {
    let mut wizard =
        wizard_at("/spec/sandboxes/assistant/agent/inference/routes/0/overrides/model");
    let question = wizard.question().unwrap().unwrap();
    assert!(question.suggestion().is_some());
    wizard.selected = question.choices().len();
    wizard.selection_changed = true;
    wizard.press(key(KeyCode::Enter));
    assert!(wizard.custom_answer);
    assert_eq!(input_line(&wizard), "▌");
    wizard.press(key(KeyCode::Tab));
    wizard.press(key(KeyCode::Enter));
    assert_eq!(wizard.error.as_deref(), Some("Enter a model identifier."));
}

#[test]
fn an_explicit_policy_is_not_summarized_as_isolated() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../examples/features/explicit-policy.yaml");
    let wizard = reviewing_template(&path);
    let text = flat(&screen(&wizard, 160, 60));
    assert!(
        text.contains("Network Explicit policy from the configuration file"),
        "{text}"
    );
    assert!(!text.contains("Isolated"), "{text}");
}

#[test]
fn a_referenced_policy_is_not_summarized_as_isolated() {
    let mut values: Value = serde_saphyr::from_slice(include_bytes!(
        "../../../../examples/features/explicit-policy.yaml"
    ))
    .unwrap();
    let network = &mut values["spec"]["sandboxes"]["assistant"]["network"];
    let policy = network["policy"]["explicit"].take();
    *network = serde_json::json!({"policyRef": "docs-only"});
    values["spec"]["policies"] = serde_json::json!({"docs-only": policy});
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("template.yaml");
    std::fs::write(&path, serde_json::to_vec(&values).unwrap()).unwrap();
    let wizard = reviewing_template(&path);
    let text = flat(&screen(&wizard, 160, 60));
    assert!(
        text.contains("Network Explicit policy from the configuration file"),
        "{text}"
    );
    assert!(!text.contains("Isolated"), "{text}");
}

#[test]
fn an_open_configuration_file_marks_and_rules_its_wrapped_lines() {
    let mut wizard = reviewing_wizard_with("nvidia.fabric.hermes");
    wizard.toggle_configuration();
    let longest = wizard
        .saved_yaml()
        .unwrap()
        .lines()
        .map(|line| line.chars().count())
        .max()
        .unwrap();
    assert!(longest > 72, "no line wraps at 72 columns");
    scroll_to_end(&mut wizard, 72, 24);
    let screen = screen(&wizard, 72, 24);
    let rows = screen
        .lines()
        .map(|line| line.trim_matches('"').trim_start())
        .skip_while(|line| !line.starts_with('│'))
        .take_while(|line| !line.starts_with("╰─"))
        .collect::<Vec<_>>();
    assert!(rows.len() > 5, "{screen}");
    let yaml = wizard.saved_yaml().unwrap();
    let mut continued = 0;
    for row in rows {
        let Some(text) = row.strip_prefix('│') else {
            panic!("{row:?} in {screen}");
        };
        // The scrollbar track ends the row.
        let text = text.trim().trim_end_matches(['│', '┃']).trim();
        assert!(!text.is_empty(), "a wrap leaves a blank row in {screen}");
        if text.starts_with('↪') {
            continued += 1;
        } else {
            assert!(
                yaml.lines().any(|line| line.trim_start().starts_with(text)),
                "{row:?} continues a line without a marker in {screen}"
            );
        }
    }
    assert!(continued > 0, "{screen}");
}

#[test]
fn the_review_footer_fits_the_narrowest_terminal() {
    let mut wizard = reviewing_wizard_with("nvidia.fabric.hermes");
    for _ in 0..2 {
        let text = flat(&screen(&wizard, 72, 24));
        for key in ["Enter save", "Tab file", "Esc exit"] {
            assert!(text.contains(key), "{key:?} in {text}");
        }
        wizard.toggle_configuration();
    }
}
