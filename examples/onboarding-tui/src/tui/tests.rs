// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::app::{Input, Step, Wizard};
use nemoclaw_authoring::{Answers, ApiChoice, Capabilities, Draft, HarnessChoice, Session};
use ratatui::{Terminal, backend::TestBackend};

fn wizard() -> Wizard {
    let capabilities = Capabilities::available();
    let authored = Session::new()
        .unwrap()
        .project(&capabilities, &Answers::onboarding_defaults())
        .unwrap();
    let draft = Draft::from_document(authored.document().clone()).unwrap();
    Wizard::new(capabilities, draft)
}

fn navigate(wizard: &mut Wizard, wanted: Step, input: Input) {
    for _ in 0..280 {
        if wizard.step() == wanted {
            return;
        }
        wizard.handle(input);
    }
    panic!(
        "did not reach {wanted:?}; at {:?}: {:?}",
        wizard.step(),
        wizard.error()
    );
}

fn select_label(wizard: &mut Wizard, label: &str) {
    let choices = wizard.choice_labels();
    assert!(
        choices.iter().any(|choice| choice == label),
        "missing {label}: {choices:?}"
    );
    for _ in 0..choices.len() {
        if wizard.choice_labels()[wizard.selected] == label {
            return;
        }
        wizard.handle(Input::Next);
    }
    panic!("choice unavailable: {label}");
}

#[test]
fn catalog_harness_outside_original_menu_authors_valid_yaml() {
    let mut wizard = wizard();
    wizard.handle(Input::Continue);
    select_label(&mut wizard, "nvidia.fabric.claude");
    wizard.handle(Input::Continue);
    navigate(&mut wizard, Step::Review, Input::Continue);
    let reviewed = wizard.draft().review().unwrap();
    assert!(reviewed.yaml().contains("nvidia.fabric.claude"));
    assert_eq!(
        wizard
            .draft()
            .guided_answers(&wizard.capabilities)
            .unwrap()
            .harness
            .as_str(),
        "nvidia.fabric.claude"
    );
}

#[test]
fn wizard_guides_every_authoring_choice_and_filters_invalid_apis() {
    let mut wizard = wizard();
    assert_eq!(wizard.step(), Step::Welcome);
    wizard.handle(Input::Continue);
    assert_eq!(wizard.step(), Step::Harness);

    select_label(&mut wizard, "nvidia.fabric.langchain.deepagents");
    wizard.handle(Input::Continue);
    assert_eq!(
        wizard
            .draft()
            .guided_answers(&wizard.capabilities)
            .unwrap()
            .harness,
        "nvidia.fabric.langchain.deepagents".parse().unwrap()
    );
    assert_eq!(wizard.step(), Step::Inference);
    navigate(&mut wizard, Step::DeploymentName, Input::Continue);
    assert_eq!(
        wizard
            .draft()
            .guided_answers(&wizard.capabilities)
            .unwrap()
            .api,
        ApiChoice::OpenaiCompletions
    );
}

#[test]
fn focused_screen_uses_a_static_texture_inline_step_and_thin_footer_progress() {
    let mut wizard = wizard();
    wizard.handle(Input::Continue);
    let backend = TestBackend::new(120, 30);
    let mut terminal = Terminal::new(backend).unwrap();
    terminal.draw(|frame| wizard.render(frame)).unwrap();
    let rendered = terminal.backend().to_string();
    let mut rows = rendered.lines();
    assert!(
        !rows.next().unwrap().contains('█'),
        "logo is glued to top\n{rendered}"
    );
    assert!(
        rows.next().unwrap().contains("███╗"),
        "logo did not follow spacer\n{rendered}"
    );
    for expected in [
        "███╗",
        "Choose your agent harness",
        "openclaw",
        "hermes",
        "Enter",
    ] {
        assert!(
            rendered.contains(expected),
            "missing {expected:?}\n{rendered}"
        );
    }
    assert!(!rendered.contains("DEPLOYMENT STUDIO"), "{rendered}");
    assert!(
        rendered
            .chars()
            .any(|character| ('\u{2800}'..='\u{28ff}').contains(&character)),
        "missing braille texture\n{rendered}"
    );
    let question = rendered
        .lines()
        .find(|line| line.contains("Choose your agent harness"))
        .unwrap();
    let question = question.trim_start_matches('"');
    assert!(
        question.find('C').unwrap() <= 4,
        "not left aligned\n{rendered}"
    );
    let lines = rendered.lines().collect::<Vec<_>>();
    let texture = lines
        .iter()
        .position(|line| {
            line.chars()
                .any(|character| ('\u{2800}'..='\u{28ff}').contains(&character))
        })
        .unwrap();
    let title = lines
        .iter()
        .position(|line| line.contains("Choose your agent harness"))
        .unwrap();
    assert_eq!(
        title,
        texture + 2,
        "question needs a spacer after logo\n{rendered}"
    );
    assert!(
        question.contains(&format!("⟦ 1/{} ⟧", wizard.flow_steps().len())),
        "step is not beside title\n{rendered}"
    );
    let progress = rendered.lines().last().unwrap();
    let strip = progress
        .chars()
        .filter(|character| *character == '▄')
        .count();
    assert_eq!(
        strip, 112,
        "footer progress should span the body\n{rendered}"
    );
    assert!(
        !progress.contains('█'),
        "progress should be half-height\n{rendered}"
    );
}

#[test]
fn welcome_uses_the_same_spacer_after_the_logo() {
    let wizard = wizard();
    let backend = TestBackend::new(100, 30);
    let mut terminal = Terminal::new(backend).unwrap();
    terminal.draw(|frame| wizard.render(frame)).unwrap();
    let rendered = terminal.backend().to_string();
    let lines = rendered.lines().collect::<Vec<_>>();
    let texture = lines
        .iter()
        .position(|line| {
            line.chars()
                .any(|character| ('\u{2800}'..='\u{28ff}').contains(&character))
        })
        .unwrap();
    let welcome = lines
        .iter()
        .position(|line| line.contains("Welcome to NemoClaw"))
        .unwrap();
    assert_eq!(
        welcome,
        texture + 2,
        "welcome needs a spacer after logo\n{rendered}"
    );
    for expected in [
        "isolated sandbox",
        "Docker or Podman",
        "deployment YAML",
        "Nothing is installed or started yet.",
    ] {
        assert!(
            rendered.contains(expected),
            "welcome is missing {expected:?}\n{rendered}"
        );
    }
}

#[test]
fn text_entry_is_local_to_the_active_question_and_back_preserves_it() {
    let mut wizard = wizard();
    navigate(&mut wizard, Step::DeploymentName, Input::Continue);
    assert_eq!(wizard.step(), Step::DeploymentName);
    wizard.handle(Input::SelectAll);
    for character in "demo-fleet".chars() {
        wizard.handle(Input::Character(character));
    }
    wizard.handle(Input::Continue);
    assert_eq!(
        wizard
            .draft()
            .guided_answers(&wizard.capabilities)
            .unwrap()
            .deployment_name,
        "demo-fleet"
    );
    wizard.handle(Input::Back);
    assert_eq!(wizard.input_value(), "demo-fleet");
}

#[test]
fn invalid_answer_stays_focused_and_explains_the_authoring_rule() {
    let mut wizard = wizard();
    navigate(&mut wizard, Step::DeploymentName, Input::Continue);
    wizard.handle(Input::SelectAll);
    for character in "Not a DNS name".chars() {
        wizard.handle(Input::Character(character));
    }
    wizard.handle(Input::Continue);

    assert_eq!(wizard.step(), Step::DeploymentName);
    assert!(wizard.error().unwrap().contains("must be a lowercase name"));
}

#[test]
fn compatible_provider_prompts_for_endpoint_and_manual_model() {
    let mut wizard = wizard();
    navigate(&mut wizard, Step::Inference, Input::Continue);
    select_label(
        &mut wizard,
        nemoclaw_authoring::ProviderPreset::OpenAiCompatible.label(),
    );
    wizard.handle(Input::Continue);
    navigate(&mut wizard, Step::Endpoint, Input::Continue);
    wizard.handle(Input::SelectAll);
    for character in "https://models.example.test/v1".chars() {
        wizard.handle(Input::Character(character));
    }
    wizard.handle(Input::Continue);
    navigate(&mut wizard, Step::Model, Input::Continue);
    for character in "acme/custom-model".chars() {
        wizard.handle(Input::Character(character));
    }
    wizard.handle(Input::Continue);

    let answers = wizard.draft().guided_answers(&wizard.capabilities).unwrap();
    assert_eq!(answers.endpoint, "https://models.example.test/v1");
    assert_eq!(answers.model, "acme/custom-model");
    navigate(&mut wizard, Step::Review, Input::Continue);
    assert_eq!(wizard.step(), Step::Review);
}

#[test]
fn provider_default_allows_an_unlisted_model() {
    let mut wizard = wizard();
    navigate(&mut wizard, Step::Model, Input::Continue);
    assert_eq!(wizard.step(), Step::Model);
    wizard.handle(Input::Next);
    wizard.handle(Input::Continue);
    for character in "vendor/new-model".chars() {
        wizard.handle(Input::Character(character));
    }
    wizard.handle(Input::Continue);

    assert_eq!(
        wizard
            .draft()
            .guided_answers(&wizard.capabilities)
            .unwrap()
            .model,
        "vendor/new-model"
    );
}

#[test]
fn review_shows_only_the_choices_the_author_made() {
    let mut wizard = wizard();
    navigate(&mut wizard, Step::Review, Input::Continue);
    assert_eq!(wizard.step(), Step::Review);
    let backend = TestBackend::new(80, 24);
    let mut terminal = Terminal::new(backend).unwrap();
    terminal.draw(|frame| wizard.render(frame)).unwrap();
    let rendered = terminal.backend().to_string();
    let lines = rendered.lines().collect::<Vec<_>>();
    let texture = lines
        .iter()
        .position(|line| {
            line.chars()
                .any(|character| ('\u{2800}'..='\u{28ff}').contains(&character))
        })
        .unwrap();
    let deployment = lines
        .iter()
        .position(|line| line.contains("Deployment"))
        .unwrap();
    assert_eq!(
        deployment,
        texture + 2,
        "review needs a spacer after logo\n{rendered}"
    );
    for expected in [
        "Deployment",
        "Harness",
        "Runtime",
        "Provider",
        "API",
        "Model",
    ] {
        assert!(
            rendered.contains(expected),
            "missing {expected:?}\n{rendered}"
        );
    }
    for internal in ["DEPLOYMENT", "CREDENTIAL", "SANDBOX", "AGENT"] {
        assert!(
            !rendered.contains(internal),
            "showed {internal:?}\n{rendered}"
        );
    }
    assert!(lines[deployment].contains("openclaw-nvidia-hosted"));
}

#[test]
fn accepting_template_defaults_preserves_a_custom_model() {
    let capabilities = Capabilities::available();
    let mut answers = Answers::onboarding_defaults();
    answers.model = "my-org/my-model".into();
    let authored = Session::new()
        .unwrap()
        .project(&capabilities, &answers)
        .unwrap();
    let mut wizard = Wizard::new(
        capabilities,
        Draft::from_yaml(authored.yaml().as_bytes()).unwrap(),
    );
    for _ in 0..280 {
        if wizard.step() == Step::Review {
            break;
        }
        wizard.handle(Input::Continue);
    }
    assert_eq!(wizard.step(), Step::Review);
    assert_only_native_defaults_added(&wizard, authored.document());
    assert_eq!(
        wizard
            .draft()
            .guided_answers(&wizard.capabilities)
            .unwrap()
            .model,
        answers.model
    );
}

#[test]
fn a_conflicting_choice_can_be_cancelled_or_explicitly_accepted() {
    let mut wizard = wizard();
    wizard.draft = wizard
        .draft
        .propose_guided_edit(
            &wizard.capabilities,
            nemoclaw_authoring::EditableField::Api,
            nemoclaw_authoring::FieldValue::Api(ApiChoice::OpenaiResponses),
        )
        .unwrap()
        .accept();
    navigate(&mut wizard, Step::Inference, Input::Continue);
    select_label(&mut wizard, "Anthropic");
    let original = wizard.draft().review().unwrap().yaml().to_owned();
    wizard.handle(Input::Continue);
    assert!(wizard.pending_edit.is_some());
    assert_eq!(wizard.draft().review().unwrap().yaml(), original);
    let mut terminal = Terminal::new(TestBackend::new(100, 30)).unwrap();
    terminal.draw(|frame| wizard.render(frame)).unwrap();
    let rendered = terminal.backend().to_string();
    assert!(rendered.contains("answers you already accepted"));
    assert!(rendered.contains("OpenAI Responses"));
    assert!(rendered.contains("keep current answers"));
    wizard.handle(Input::Back);
    assert!(wizard.pending_edit.is_none());
    assert_eq!(wizard.draft().review().unwrap().yaml(), original);
    wizard.handle(Input::Continue);
    wizard.handle(Input::Continue);
    assert_ne!(wizard.step(), Step::Inference);
    assert_eq!(
        wizard
            .draft()
            .guided_answers(&wizard.capabilities)
            .unwrap()
            .inference,
        nemoclaw_authoring::ProviderPreset::Anthropic
    );
}

#[test]
fn changing_provider_reasks_the_model_without_reasking_an_accepted_name() {
    let mut wizard = wizard();
    navigate(&mut wizard, Step::Review, Input::Continue);
    navigate(&mut wizard, Step::Inference, Input::Back);
    select_label(
        &mut wizard,
        nemoclaw_authoring::ProviderPreset::OpenRouter.label(),
    );
    wizard.handle(Input::Continue);
    assert!(wizard.pending_edit.is_some());
    wizard.handle(Input::Continue);
    assert_eq!(wizard.step(), Step::Model);
    assert!(
        wizard
            .draft()
            .is_accepted(nemoclaw_authoring::EditableField::DeploymentName)
    );
}

#[test]
fn engine_status_and_review_fit_in_the_minimum_terminal() {
    let mut wizard = wizard();
    navigate(&mut wizard, Step::Review, Input::Continue);
    wizard.target_status = Some("Engine unverified. You can save for later.".into());
    let mut terminal = Terminal::new(TestBackend::new(80, 24)).unwrap();
    terminal.draw(|frame| wizard.render(frame)).unwrap();
    let rendered = terminal.backend().to_string();
    for expected in ["Deployment:", "Model:", "Engine unverified", "author YAML"] {
        assert!(
            rendered.contains(expected),
            "missing {expected}: {rendered}"
        );
    }
}

#[test]
fn every_guided_template_preserves_defaults_and_requires_missing_adapter_answers() {
    let capabilities = Capabilities::available();
    let defaults = Answers::onboarding_defaults();
    let mut templates: Vec<_> = capabilities
        .harnesses()
        .iter()
        .map(|harness| Answers {
            harness: harness.clone(),
            ..defaults.clone()
        })
        .collect();
    templates.extend(
        nemoclaw_authoring::ProviderPreset::ALL
            .into_iter()
            .map(|provider| defaults.clone().for_provider(provider)),
    );
    for (index, template) in templates.iter().enumerate() {
        for custom in [false, true] {
            let mut answers = template.clone();
            answers.deployment_name = format!("template-{index}");
            answers.sandbox_name = "template-sandbox".into();
            answers.agent_name = "template-agent".into();
            if custom {
                answers.model = "my-org/custom-model-120b".into();
                if matches!(
                    answers.inference,
                    nemoclaw_authoring::ProviderPreset::OpenAiCompatible
                        | nemoclaw_authoring::ProviderPreset::AnthropicCompatible
                ) {
                    answers.endpoint = "https://inference.example.org/v1".into();
                }
            }
            let original = Session::new()
                .unwrap()
                .project(&capabilities, &answers)
                .unwrap();
            let directory = tempfile::tempdir().unwrap();
            let path = directory.path().join("template.yaml");
            std::fs::write(&path, original.yaml()).unwrap();
            let draft = crate::load(crate::Source::Template(&path), &capabilities).unwrap();
            let expected = draft.document().clone();
            assert_ne!(expected.metadata.uid, original.document().metadata.uid);
            let mut wizard = Wizard::for_host(capabilities.clone(), draft, "linux");
            let mut required_unanswered = false;
            for _ in 0..280 {
                if wizard.step() == Step::Review {
                    break;
                }
                assert!(
                    wizard.error().is_none(),
                    "{answers:?}: {:?}",
                    wizard.error()
                );
                if let Some(question) = wizard.setting_question() {
                    if question.required && question.suggestion.is_none() {
                        assert!(!wizard.accepted());
                        assert!(wizard.draft.validate_settings(&capabilities).is_err());
                        required_unanswered = true;
                        break;
                    }
                    // Explicitly accept only an advertised default; optional absent values
                    // stay absent rather than choosing the first enum item by accident.
                    if question.suggestion.is_none() && wizard.is_choice() {
                        wizard.selected = question.choices.len();
                    }
                    wizard.handle(Input::Continue);
                    continue;
                }
                // Check what Enter will accept, not just the eventual YAML.
                if wizard.is_choice() {
                    let field = wizard
                        .draft()
                        .guided_fields(&capabilities)
                        .unwrap()
                        .into_iter()
                        .find(|field| match field.id() {
                            nemoclaw_authoring::EditableField::Harness => {
                                wizard.step() == Step::Harness
                            }
                            nemoclaw_authoring::EditableField::Runtime => {
                                wizard.step() == Step::Runtime
                            }
                            nemoclaw_authoring::EditableField::Inference => {
                                wizard.step() == Step::Inference
                            }
                            nemoclaw_authoring::EditableField::Api => wizard.step() == Step::Api,
                            nemoclaw_authoring::EditableField::Model => {
                                wizard.step() == Step::Model
                            }
                            _ => false,
                        })
                        .unwrap();
                    assert_eq!(
                        &field.choices()[wizard.selected],
                        field.value(),
                        "{answers:?}"
                    );
                } else {
                    match wizard.step() {
                        Step::DeploymentName => {
                            assert_eq!(wizard.input_value(), answers.deployment_name)
                        }
                        Step::Endpoint => assert_eq!(wizard.input_value(), answers.endpoint),
                        Step::Model => assert_eq!(wizard.input_value(), answers.model),
                        _ => {}
                    }
                }
                wizard.handle(Input::Continue);
            }
            let mut actual = wizard.draft().guided_answers(&capabilities).unwrap();
            let accepted_settings = actual.harness_settings.take();
            assert_eq!(
                actual, answers,
                "schema answers must preserve deployment defaults"
            );
            let mut expected = expected;
            expected.spec.sandboxes[0]
                .harness
                .as_mut()
                .unwrap()
                .settings = accepted_settings;
            assert_eq!(wizard.draft().document(), &expected);
            if required_unanswered {
                assert!(matches!(wizard.step(), Step::Setting(_)));
                assert_eq!(std::fs::read_to_string(path).unwrap(), original.yaml());
                continue;
            }
            assert_eq!(wizard.step(), Step::Review, "{answers:?}");
            wizard.handle(Input::Continue);
            assert!(wizard.accepted());
            let output = directory.path().join("result.yaml");
            crate::write_path(&output, wizard.draft().review().unwrap().yaml().as_bytes()).unwrap();
            let result = crate::read_draft(&output).unwrap();

            assert_eq!(result.document(), &expected, "{answers:?}");
            assert_eq!(std::fs::read_to_string(path).unwrap(), original.yaml());
        }
    }
}

#[test]
fn a_podman_template_is_disabled_on_mac_and_requires_a_runtime_change() {
    use nemoclaw_authoring::RuntimeChoice;
    let capabilities = Capabilities::available();
    let answers = Answers {
        runtime: RuntimeChoice::Podman,
        ..Answers::onboarding_defaults()
    };
    let authored = Session::new()
        .unwrap()
        .project(&capabilities, &answers)
        .unwrap();
    let mut wizard = Wizard::for_host(
        capabilities.clone(),
        Draft::from_yaml(authored.yaml().as_bytes()).unwrap(),
        "macos",
    );
    navigate(&mut wizard, Step::Runtime, Input::Continue);
    let mut terminal = Terminal::new(TestBackend::new(80, 24)).unwrap();
    terminal.draw(|frame| wizard.render(frame)).unwrap();
    let rendered = terminal.backend().to_string();
    assert!(
        rendered.contains("Podman (unavailable: requires local Linux)"),
        "{rendered}"
    );
    wizard.handle(Input::Continue);
    assert_eq!(wizard.step(), Step::Runtime);
    assert_eq!(
        wizard.draft().guided_answers(&capabilities).unwrap(),
        answers
    );
    wizard.handle(Input::Previous);
    wizard.handle(Input::Continue);
    assert_eq!(wizard.step(), Step::DeploymentName);
    assert_eq!(
        wizard
            .draft()
            .guided_answers(&capabilities)
            .unwrap()
            .runtime,
        RuntimeChoice::Docker
    );
}

#[test]
fn mac_navigation_skips_podman_and_keeps_large_hosted_models_available() {
    let mut wizard = wizard();
    // Use an explicit platform so this regression also runs on Linux CI.
    wizard = Wizard::for_host(wizard.capabilities.clone(), wizard.draft().clone(), "macos");
    navigate(&mut wizard, Step::Inference, Input::Continue);
    assert!(wizard.choice_labels().contains(&"NVIDIA Endpoints".into()));
    assert!(
        wizard
            .choice_labels()
            .iter()
            .all(|choice| !choice.to_lowercase().contains("vllm"))
    );
    navigate(&mut wizard, Step::Runtime, Input::Continue);
    wizard.handle(Input::Next);
    assert_eq!(wizard.choice_labels()[wizard.selected], "Docker");
    wizard.handle(Input::Previous);
    assert_eq!(wizard.choice_labels()[wizard.selected], "Docker");
    wizard.handle(Input::Continue);
    navigate(&mut wizard, Step::Model, Input::Continue);
    assert_eq!(wizard.step(), Step::Model);
    assert_eq!(
        wizard.choice_labels()[wizard.selected],
        "nvidia/nemotron-3-super-120b-a12b"
    );
    navigate(&mut wizard, Step::Review, Input::Continue);
    wizard.handle(Input::Continue);
    assert!(wizard.accepted());
}

#[test]
fn interview_prioritizes_dependent_choices_and_back_follows_actual_history() {
    let mut wizard = wizard();
    wizard.handle(Input::Continue);
    wizard.handle(Input::Continue);
    assert_eq!(wizard.step(), Step::Inference);
    let mut terminal = Terminal::new(TestBackend::new(120, 30)).unwrap();
    terminal.draw(|frame| wizard.render(frame)).unwrap();
    assert!(
        terminal
            .backend()
            .to_string()
            .contains(&format!("⟦ 2/{} ⟧", wizard.flow_steps().len()))
    );
    wizard.handle(Input::Continue);
    assert_eq!(wizard.step(), Step::Api);
    wizard.handle(Input::Back);
    assert_eq!(wizard.step(), Step::Inference);
    wizard.handle(Input::Back);
    assert_eq!(wizard.step(), Step::Harness);
}

#[test]
fn review_revisits_a_reopened_requirement_before_allowing_save() {
    let mut wizard = wizard();
    for _ in 0..280 {
        if wizard.step() == Step::Review {
            break;
        }
        wizard.handle(Input::Continue);
    }
    assert_eq!(wizard.step(), Step::Review);
    wizard.draft = wizard
        .draft
        .propose_guided_edit(
            &wizard.capabilities,
            nemoclaw_authoring::EditableField::Api,
            nemoclaw_authoring::FieldValue::Api(ApiChoice::OpenaiResponses),
        )
        .unwrap()
        .accept();
    wizard.handle(Input::Continue);
    assert!(!wizard.accepted());
    assert_eq!(wizard.step(), Step::Model);
    wizard.handle(Input::Continue);
    assert_eq!(wizard.step(), Step::Review);
    wizard.handle(Input::Continue);
    assert!(wizard.accepted());
}

#[test]
fn observed_adapter_conflict_blocks_review_until_the_selection_changes() {
    use nemoclaw_authoring::DiscoveryEvidence;
    use nemoclaw_sdk::discovery::{EngineObservation, FabricObservation, ObservationStatus};
    let mut wizard = wizard();
    navigate(&mut wizard, Step::Review, Input::Continue);
    let key = wizard.draft.discovery_key().unwrap();
    let mut catalog = nemoclaw_sdk::fabric_catalog::FabricCatalog::bundled();
    catalog
        .adapters
        .retain(|adapter| adapter.descriptor["adapter_id"] == "nvidia.fabric.hermes");
    wizard.discovery = Some(DiscoveryEvidence {
        key,
        engine: Some(EngineObservation {
            status: ObservationStatus::Available,
            reason: None,
            source: "fixture".into(),
            server_version: None,
            architecture: None,
            operating_system: None,
            memory_bytes: None,
            cpus: None,
        }),
        fabric: Some(FabricObservation {
            status: ObservationStatus::Available,
            reason: None,
            source: "fixture".into(),
            image_id: Some("sha256:fixture".into()),
            catalog: Some(catalog),
            image: Default::default(),
            compatibility: None,
        }),
    });
    navigate(&mut wizard, Step::Review, Input::Continue);
    wizard.handle(Input::Continue);
    assert!(!wizard.accepted());
    assert!(wizard.error().unwrap().contains("fabric_plan"));
    let mut terminal = Terminal::new(TestBackend::new(120, 30)).unwrap();
    terminal.draw(|frame| wizard.render(frame)).unwrap();
    assert!(terminal.backend().to_string().contains("fabric_plan"));
}

#[test]
fn discovered_model_can_be_selected_without_overwriting_the_current_suggestion() {
    use nemoclaw_authoring::{AuthoringFacts, EndpointEvidence};
    use nemoclaw_sdk::{
        discovery::ObservationStatus,
        inference_discovery::{AuthenticationStatus, EndpointObservation},
    };
    let mut wizard = wizard();
    wizard.facts = AuthoringFacts {
        endpoint: Some(EndpointEvidence {
            request: wizard
                .draft
                .inference_request(&wizard.capabilities)
                .unwrap(),
            observation: EndpointObservation {
                status: ObservationStatus::Available,
                reason: None,
                source: "control_host_http_models".into(),
                reachable: Some(true),
                authentication: AuthenticationStatus::Accepted,
                models: vec!["vendor/discovered-model".into()],
                api_verified: false,
            },
        }),
        ..Default::default()
    };
    navigate(&mut wizard, Step::Model, Input::Continue);
    assert_eq!(
        wizard.choice_labels()[wizard.selected],
        "nvidia/nemotron-3-super-120b-a12b"
    );
    wizard.handle(Input::Next);
    assert_eq!(
        wizard.choice_labels()[wizard.selected],
        "vendor/discovered-model"
    );
    wizard.handle(Input::Continue);
    assert_eq!(
        wizard
            .draft
            .guided_answers(&wizard.capabilities)
            .unwrap()
            .model,
        "vendor/discovered-model"
    );
}

/// Acceptance scenario: choosing a harness and delegating compatible remaining
/// settings reaches review without answering the individual setting questions.
#[test]
fn delegation_after_harness_goes_directly_to_review_with_valid_yaml() {
    use nemoclaw_authoring::{AnswerStatus, EditableField};
    let mut wizard = wizard();
    wizard.handle(Input::Continue);
    wizard.handle(Input::Continue);
    let before = wizard.draft.document().clone();
    establish_observed_discovery(&mut wizard);

    wizard.handle(Input::DelegateRemaining);

    assert_eq!(wizard.step(), Step::Review, "{:?}", wizard.error());
    assert_only_native_defaults_added(&wizard, &before);
    assert_eq!(
        wizard.draft.answer_status(EditableField::Harness),
        AnswerStatus::Accepted
    );
    assert_eq!(
        wizard.draft.answer_status(EditableField::Runtime),
        AnswerStatus::Delegated
    );
    assert_eq!(
        wizard.draft.answer_status(EditableField::Model),
        AnswerStatus::Delegated
    );
    assert!(
        wizard
            .draft
            .next_question(&wizard.capabilities)
            .unwrap()
            .is_none()
    );
    assert!(
        !wizard.accepted(),
        "delegation authorizes review, not saving"
    );
    let yaml = wizard.draft.review().unwrap().yaml().to_owned();
    nemoclaw_sdk::config::Document::parse(yaml.as_bytes()).unwrap();
    wizard.handle(Input::Continue);
    assert!(wizard.accepted());
}

fn assert_only_native_defaults_added(wizard: &Wizard, before: &nemoclaw_sdk::config::Document) {
    let mut after = wizard.draft.document().clone();
    let original = &before.spec.sandboxes[0].harness.as_ref().unwrap().settings;
    let native = &mut after.spec.sandboxes[0].harness.as_mut().unwrap().settings;
    if let Some(original) = original {
        for (key, value) in original {
            assert_eq!(native.as_ref().unwrap().get(key), Some(value));
        }
    }
    *native = original.clone();
    assert_eq!(
        &after, before,
        "accepting native defaults must preserve existing intent"
    );
    wizard
        .draft
        .validate_settings(&wizard.capabilities)
        .unwrap();
}

fn establish_observed_discovery(wizard: &mut Wizard) {
    use nemoclaw_authoring::{AuthoringFacts, DiscoveryEvidence, EndpointEvidence};
    use nemoclaw_sdk::{
        discovery::{EngineObservation, FabricObservation, ObservationStatus},
        fabric_capabilities::ImageMetadata,
        fabric_catalog::FabricCatalog,
        inference_discovery::{AuthenticationStatus, CredentialObservation, EndpointObservation},
    };
    let key = wizard.draft.discovery_key().unwrap();
    let request = wizard
        .draft
        .inference_request(&wizard.capabilities)
        .unwrap();
    let model = wizard
        .draft
        .guided_answers(&wizard.capabilities)
        .unwrap()
        .model;
    wizard.discovery = Some(DiscoveryEvidence {
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
    });
    wizard.facts = AuthoringFacts {
        endpoint: Some(EndpointEvidence {
            request,
            observation: EndpointObservation {
                status: ObservationStatus::Available,
                reason: None,
                source: "control_host_http_models".into(),
                reachable: Some(true),
                authentication: AuthenticationStatus::Accepted,
                models: vec![model],
                api_verified: false,
            },
        }),
        credentials: wizard
            .draft
            .document()
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
    let assessment = wizard
        .discovery
        .as_ref()
        .unwrap()
        .assessment(&wizard.draft)
        .unwrap();
    assert_eq!(
        assessment.status,
        nemoclaw_authoring::CompatibilityStatus::Compatible,
        "{:?}",
        assessment.reasons
    );
}

#[test]
fn delegation_requires_permission_and_current_compatible_discovery() {
    use nemoclaw_sdk::{discovery::ObservationStatus, inference_discovery::AuthenticationStatus};
    for case in [
        "no target",
        "stale target",
        "unknown engine",
        "conflicting image",
        "no endpoint",
        "stale endpoint",
        "unknown catalog",
        "unreachable",
        "authentication denied",
        "unadvertised model",
        "missing credentials",
    ] {
        let mut wizard = wizard();
        wizard.handle(Input::Continue);
        wizard.handle(Input::Continue);
        establish_observed_discovery(&mut wizard);
        match case {
            "no target" => wizard.discovery = None,
            "stale target" => wizard
                .discovery
                .as_mut()
                .unwrap()
                .key
                .engine
                .push_str("-other"),
            "unknown engine" => {
                wizard
                    .discovery
                    .as_mut()
                    .unwrap()
                    .engine
                    .as_mut()
                    .unwrap()
                    .status = ObservationStatus::Unknown
            }
            "conflicting image" => {
                wizard
                    .discovery
                    .as_mut()
                    .unwrap()
                    .fabric
                    .as_mut()
                    .unwrap()
                    .image
                    .architecture = Some("amd64".into())
            }
            "no endpoint" => wizard.facts.endpoint = None,
            "stale endpoint" => wizard
                .facts
                .endpoint
                .as_mut()
                .unwrap()
                .request
                .endpoint
                .push_str("/other"),
            "unknown catalog" => {
                wizard.facts.endpoint.as_mut().unwrap().observation.status =
                    ObservationStatus::Unknown
            }
            "unreachable" => {
                wizard
                    .facts
                    .endpoint
                    .as_mut()
                    .unwrap()
                    .observation
                    .reachable = Some(false)
            }
            "authentication denied" => {
                wizard
                    .facts
                    .endpoint
                    .as_mut()
                    .unwrap()
                    .observation
                    .authentication = AuthenticationStatus::Denied
            }
            "unadvertised model" => wizard
                .facts
                .endpoint
                .as_mut()
                .unwrap()
                .observation
                .models
                .clear(),
            "missing credentials" => wizard.facts.credentials.clear(),
            _ => unreachable!(),
        }
        let before = wizard.draft.document().clone();
        wizard.handle(Input::DelegateRemaining);
        assert_ne!(wizard.step(), Step::Review, "{case}");
        assert!(wizard.error().is_some(), "{case}");
        assert_eq!(wizard.draft.document(), &before, "{case}");
        assert!(!wizard.draft.has_delegated_answers(), "{case}");
    }
    let mut wizard = wizard();
    establish_observed_discovery(&mut wizard);
    wizard.handle(Input::Continue);
    wizard.handle(Input::DelegateRemaining);
    assert_eq!(wizard.step(), Step::Harness, "must choose a harness first");
    wizard.handle(Input::Continue);
    assert_ne!(
        wizard.step(),
        Step::Review,
        "discovery alone is not permission"
    );
}

#[test]
fn delegation_is_visible_and_discovery_errors_are_visible_at_minimum_terminal_size() {
    let mut wizard = wizard();
    wizard.handle(Input::Continue);
    wizard.handle(Input::Continue);
    let mut terminal = Terminal::new(TestBackend::new(72, 24)).unwrap();
    terminal.draw(|frame| wizard.render(frame)).unwrap();
    assert!(
        terminal
            .backend()
            .to_string()
            .contains("Ctrl+D  choose remaining settings and review")
    );
    wizard.handle(Input::DelegateRemaining);
    terminal.draw(|frame| wizard.render(frame)).unwrap();
    assert!(
        terminal
            .backend()
            .to_string()
            .contains("Target discovery is missing or stale")
    );
}

#[test]
fn delegated_settings_are_checked_again_when_review_is_saved() {
    let mut wizard = wizard();
    wizard.handle(Input::Continue);
    wizard.handle(Input::Continue);
    establish_observed_discovery(&mut wizard);
    wizard.handle(Input::DelegateRemaining);
    assert_eq!(wizard.step(), Step::Review);
    // Simulate review refresh losing evidence. Do not save the delegated draft.
    wizard.facts.endpoint = None;
    wizard.handle(Input::Continue);
    assert!(!wizard.accepted());
    assert!(wizard.error().unwrap().contains("Model discovery"));
    // The user can back out and explicitly accept the remaining settings instead.
    wizard.handle(Input::Back);
    for _ in 0..20 {
        if wizard.accepted() {
            break;
        }
        wizard.handle(Input::Continue);
    }
    assert!(
        wizard.accepted(),
        "manual fallback should remain available: {:?}",
        wizard.error()
    );
}

#[test]
fn changing_runtime_reopens_delegated_settings_but_preserves_explicit_harness() {
    use nemoclaw_authoring::{AnswerStatus, EditableField, FieldValue, RuntimeChoice};
    let mut wizard = wizard();
    wizard.handle(Input::Continue);
    wizard.handle(Input::Continue);
    establish_observed_discovery(&mut wizard);
    wizard.handle(Input::DelegateRemaining);
    let changed = wizard
        .draft
        .propose_guided_edit(
            &wizard.capabilities,
            EditableField::Runtime,
            FieldValue::Runtime(RuntimeChoice::Podman),
        )
        .unwrap()
        .accept();
    assert_eq!(
        changed.answer_status(EditableField::Harness),
        AnswerStatus::Accepted
    );
    assert_eq!(
        changed.answer_status(EditableField::Inference),
        AnswerStatus::Suggested
    );
    assert_eq!(
        changed.answer_status(EditableField::Model),
        AnswerStatus::Suggested
    );
}

#[test]
fn delegation_preserves_a_nondefault_harness_and_an_explicit_deployment_name() {
    use nemoclaw_authoring::{AnswerStatus, EditableField};
    let mut wizard = wizard();
    wizard.handle(Input::Continue);
    select_label(&mut wizard, "nvidia.fabric.hermes");
    wizard.handle(Input::Continue);
    navigate(&mut wizard, Step::DeploymentName, Input::Continue);
    wizard.handle(Input::SelectAll);
    for character in "chosen-name".chars() {
        wizard.handle(Input::Character(character));
    }
    wizard.handle(Input::Continue);
    establish_observed_discovery(&mut wizard);
    let before = wizard.draft.document().clone();
    wizard.handle(Input::DelegateRemaining);
    assert_eq!(wizard.step(), Step::Review, "{:?}", wizard.error());
    assert_only_native_defaults_added(&wizard, &before);
    let answers = wizard.draft.guided_answers(&wizard.capabilities).unwrap();
    assert_eq!(answers.harness.as_str(), "nvidia.fabric.hermes");
    assert_eq!(answers.deployment_name, "chosen-name");
    assert_eq!(
        wizard.draft.answer_status(EditableField::DeploymentName),
        AnswerStatus::Accepted
    );
}

#[test]
fn delegation_does_not_discard_an_unsubmitted_answer() {
    let mut wizard = wizard();
    navigate(&mut wizard, Step::DeploymentName, Input::Continue);
    establish_observed_discovery(&mut wizard);
    wizard.handle(Input::SelectAll);
    wizard.handle(Input::Character('x'));
    wizard.handle(Input::DelegateRemaining);
    assert_eq!(wizard.step(), Step::DeploymentName);
    assert_eq!(wizard.input_value(), "x");
    assert!(wizard.error().unwrap().contains("Press Enter"));
}

#[test]
fn accepting_the_same_harness_preserves_delegation_but_changing_it_reopens_dependents() {
    use nemoclaw_authoring::{AnswerStatus, EditableField, FieldValue};
    let mut wizard = wizard();
    wizard.handle(Input::Continue);
    wizard.handle(Input::Continue);
    establish_observed_discovery(&mut wizard);
    wizard.handle(Input::DelegateRemaining);
    let same = wizard
        .draft
        .propose_guided_edit(
            &wizard.capabilities,
            EditableField::Harness,
            FieldValue::Harness("nvidia.fabric.openclaw".parse::<HarnessChoice>().unwrap()),
        )
        .unwrap()
        .accept();
    assert_eq!(
        same.answer_status(EditableField::Inference),
        AnswerStatus::Delegated
    );
    let changed = same
        .propose_guided_edit(
            &wizard.capabilities,
            EditableField::Harness,
            FieldValue::Harness(
                "nvidia.fabric.langchain.deepagents"
                    .parse::<HarnessChoice>()
                    .unwrap(),
            ),
        )
        .unwrap()
        .accept();
    assert_eq!(
        changed.answer_status(EditableField::Inference),
        AnswerStatus::Suggested
    );
    assert_eq!(
        changed.answer_status(EditableField::Model),
        AnswerStatus::Suggested
    );
    assert_eq!(
        changed.answer_status(EditableField::DeploymentName),
        AnswerStatus::Delegated
    );
}

#[test]
fn bulk_delegation_requires_an_explicit_harness_choice_even_for_other_frontends() {
    let mut wizard = wizard();
    establish_observed_discovery(&mut wizard);
    wizard
        .draft
        .delegate(
            &wizard.capabilities,
            nemoclaw_authoring::EditableField::Harness,
        )
        .unwrap();
    assert!(
        wizard
            .draft
            .delegate_remaining(
                &wizard.capabilities,
                wizard.discovery.as_ref(),
                &wizard.facts
            )
            .is_err()
    );
}

#[test]
fn live_image_catalog_adds_an_unknown_harness_to_the_actual_wizard() {
    let mut wizard = wizard();
    let before = wizard.draft.document().clone();
    install_live_fixture_catalog(&mut wizard);
    wizard.handle(Input::Continue);
    assert!(
        wizard
            .choice_labels()
            .contains(&"fixture-live-adapter".into())
    );
    assert_eq!(
        wizard.draft.document(),
        &before,
        "observations cannot rewrite intent"
    );
    select_label(&mut wizard, "fixture-live-adapter");
    wizard.handle(Input::Continue);
    assert_eq!(
        wizard
            .draft
            .document()
            .sandbox_harness(&wizard.draft.document().spec.sandboxes[0])
            .unwrap()
            .kind
            .as_str(),
        "fixture-live-adapter"
    );
    assert_eq!(
        wizard.draft.document().spec.sandboxes[0].image,
        before.spec.sandboxes[0].image
    );
    navigate(&mut wizard, Step::Review, Input::Continue);
}

fn install_live_fixture_catalog(wizard: &mut Wizard) {
    establish_observed_discovery(wizard);
    let catalog = wizard
        .discovery
        .as_mut()
        .unwrap()
        .fabric
        .as_mut()
        .unwrap()
        .catalog
        .as_mut()
        .unwrap();
    let mut adapter = catalog.adapters[0].clone();

    adapter.descriptor["adapter_id"] = "fixture-live-adapter".into();
    catalog.adapters = vec![adapter];
}

#[test]
fn image_catalog_choices_expire_with_their_target_without_erasing_selected_intent() {
    let mut wizard = wizard();
    install_live_fixture_catalog(&mut wizard);
    wizard.handle(Input::Continue);
    assert!(
        !wizard
            .choice_labels()
            .contains(&"nvidia.fabric.claude".into())
    );
    wizard
        .discovery
        .as_mut()
        .unwrap()
        .key
        .engine
        .push_str("-stale");
    wizard.refresh_catalog();
    assert!(
        !wizard
            .choice_labels()
            .contains(&"fixture-live-adapter".into())
    );
    assert!(
        wizard
            .choice_labels()
            .contains(&"nvidia.fabric.claude".into())
    );

    install_live_fixture_catalog(&mut wizard);
    wizard.refresh_catalog();
    select_label(&mut wizard, "fixture-live-adapter");
    wizard.handle(Input::Continue);
    let selected = wizard.draft.document().clone();
    wizard.discovery.as_mut().unwrap().fabric = None;
    wizard.refresh_catalog();
    assert_eq!(wizard.draft.document(), &selected);
    assert_eq!(
        wizard
            .draft
            .guided_answers(&wizard.capabilities)
            .unwrap()
            .harness
            .as_str(),
        "fixture-live-adapter"
    );
    navigate(&mut wizard, Step::Review, Input::Continue);
}

#[test]
fn reopened_unknown_harness_is_reviewable_before_discovery() {
    let mut document = wizard().draft.document().clone();
    document.spec.sandboxes[0].harness.as_mut().unwrap().kind =
        "fixture-reopen-adapter".parse().unwrap();
    let draft = Draft::from_document(document.clone()).unwrap();
    let mut wizard = Wizard::new(Capabilities::available(), draft);
    navigate(&mut wizard, Step::Review, Input::Continue);
    assert_eq!(wizard.draft.document(), &document);
    wizard.handle(Input::Continue);
    assert!(wizard.accepted());
}

#[test]
fn wizard_interviews_new_conditional_adapter_settings_and_preserves_them() {
    let mut wizard = wizard();
    install_live_fixture_catalog(&mut wizard);
    let catalog = wizard
        .discovery
        .as_mut()
        .unwrap()
        .fabric
        .as_mut()
        .unwrap()
        .catalog
        .as_mut()
        .unwrap();
    catalog.adapters[0].descriptor["settings_schema"] = serde_json::json!({
        "type":"object","properties":{"mode":{"type":"string","enum":["basic","remote"],"default":"basic"}},"required":["mode"],
        "if":{"properties":{"mode":{"const":"remote"}},"required":["mode"]},
        "then":{"properties":{"region":{"type":"string","enum":["west","east"]}},"required":["region"]}
    });
    wizard.handle(Input::Continue);
    select_label(&mut wizard, "fixture-live-adapter");
    wizard.handle(Input::Continue);
    navigate(&mut wizard, Step::Setting(0), Input::Continue);
    assert_eq!(wizard.setting_question().unwrap().path, "/mode");
    select_label(&mut wizard, "remote");
    wizard.handle(Input::Continue);
    assert_eq!(
        wizard
            .setting_question()
            .unwrap_or_else(|| panic!(
                "step {:?}, error {:?}, settings {:?}",
                wizard.step(),
                wizard.error(),
                wizard.draft.setting_questions(&wizard.capabilities)
            ))
            .path,
        "/region"
    );
    select_label(&mut wizard, "west");
    wizard.handle(Input::Continue);
    assert_eq!(wizard.step(), Step::Review);
    let review = wizard.draft.review().unwrap();
    let reopened = Draft::from_yaml(review.yaml().as_bytes()).unwrap();
    let settings = reopened.document().spec.sandboxes[0]
        .harness
        .as_ref()
        .unwrap()
        .settings
        .as_ref()
        .unwrap();
    assert_eq!(settings["mode"], "remote");
    assert_eq!(settings["region"], "west");
    let mut terminal = Terminal::new(TestBackend::new(100, 30)).unwrap();
    terminal.draw(|frame| wizard.render(frame)).unwrap();
    assert!(terminal.backend().to_string().contains("region"));
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires explicit NEMOCLAW_TEST_BUNDLE, installed Fabric fixture interpreter/descriptor, and an isolated model endpoint"]
async fn fabric_owned_descriptor_drives_wizard_settings_save_and_reopen() {
    let path = std::env::var("NEMOCLAW_TEST_FABRIC_DESCRIPTOR").expect("Fabric descriptor path");
    let descriptor: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    let id = descriptor["adapter_id"].as_str().unwrap().to_owned();
    let python = std::env::var_os("NEMOCLAW_TEST_FABRIC_PYTHON")
        .expect("Fabric interpreter with installed fixture");
    let bundled = nemoclaw_sdk::fabric_catalog::FabricCatalog::bundled();
    let output = std::process::Command::new(python)
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../image/fabric/catalog.py"
        ))
        .args([
            "--revision",
            &bundled.fabric_revision,
            "--source-sha256",
            &bundled.source_sha256,
        ])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let catalog = nemoclaw_sdk::fabric_catalog::FabricCatalog::from_json(
        std::str::from_utf8(&output.stdout).unwrap(),
    )
    .unwrap();
    let record = catalog
        .adapters
        .iter()
        .find(|record| record.adapter_id() == id)
        .expect("installed Fabric fixture discovered by production packaging");
    for (key, value) in descriptor.as_object().unwrap() {
        assert_eq!(&record.descriptor[key], value, "Fabric preserves {key}");
    }
    assert!(
        record
            .provenance
            .as_array()
            .unwrap()
            .iter()
            .any(|source| source["source"] == "installed_package")
    );
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let bundle = std::env::var_os("NEMOCLAW_TEST_BUNDLE").expect("verified native bundle");
    let models = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/v1", models.local_addr().unwrap());
    let model_reads = Arc::new(AtomicUsize::new(0));
    let reads = model_reads.clone();
    let model_server = tokio::spawn(async move {
        loop {
            let (mut stream, _) = models.accept().await.unwrap();
            let mut request = Vec::new();
            while !request.ends_with(b"\r\n\r\n") {
                request.push(stream.read_u8().await.unwrap());
            }
            let request = String::from_utf8(request).unwrap();
            assert!(request.starts_with("GET /v1/models HTTP/1.1\r\n"));
            reads.fetch_add(1, Ordering::SeqCst);
            let body = r#"{"data":[{"id":"fixture-model"}]}"#;
            stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
        }
    });
    let catalog_json = serde_json::to_string(&catalog).unwrap();
    let mut answers = Answers::onboarding_defaults()
        .for_provider(nemoclaw_authoring::ProviderPreset::OpenAiCompatible);
    answers.endpoint = endpoint;
    answers.credential_env.clear();
    answers.model = "fixture-model".into();
    let image = answers.image.clone();
    let image_digest = image.split_once('@').unwrap().1.to_owned();
    let engine_reads = Arc::new(AtomicUsize::new(0));
    let reads = engine_reads.clone();
    let engine = discovery_transport::Fixture::start(move |request| {
        assert_eq!(request.method, "GET");
        assert!(request.body.is_empty());
        reads.fetch_add(1, Ordering::SeqCst);
        let body = if request.path == "/info" {
            serde_json::json!({"ID":"onboard-fixture","Architecture":"arm64","OSType":"linux","ServerVersion":"28.0","NCPU":8,"MemTotal":17179869184u64})
        } else if request.path.starts_with("/images/") && request.path.ends_with("/json") {
            serde_json::json!({"Id":image_digest,"Architecture":"arm64","Os":"linux","RepoDigests":[image],"Config":{"Labels":{nemoclaw_sdk::fabric_catalog::IMAGE_CATALOG_LABEL:catalog_json}}})
        } else { panic!("unexpected onboarding engine request {}", request.path); };
        Some((200, serde_json::to_vec(&body).unwrap()))
    }).await;
    answers.engine = Some(engine.endpoint.clone());
    let capabilities = Capabilities::available();
    let authored = Session::new()
        .unwrap()
        .project(&capabilities, &answers)
        .unwrap();
    let mut wizard = Wizard::new(
        capabilities,
        Draft::from_document(authored.document().clone()).unwrap(),
    );
    let mut session =
        nemoclaw_sdk::discovery_session::DiscoverySession::new(std::path::Path::new(&bundle))
            .unwrap();
    let cancel = nemoclaw_sdk::CancellationToken::new();
    let (evidence, facts) = super::terminal::check_discovery(
        Some(&mut session),
        &wizard.draft,
        &wizard.capabilities,
        None,
        Default::default(),
        false,
        &cancel,
    )
    .await
    .unwrap();
    assert_eq!(
        evidence.engine.as_ref().unwrap().status,
        nemoclaw_sdk::discovery::ObservationStatus::Available
    );
    assert_eq!(
        evidence.fabric.as_ref().unwrap().catalog.as_ref().unwrap(),
        &catalog
    );
    wizard.discovery = Some(evidence);
    wizard.facts = facts;
    wizard.handle(Input::Continue);
    select_label(&mut wizard, &id);
    wizard.handle(Input::Continue);
    navigate(&mut wizard, Step::Setting(0), Input::Continue);
    assert_eq!(wizard.setting_question().unwrap().path, "/mode");
    assert_eq!(
        wizard.setting_question().unwrap().suggestion,
        Some(serde_json::json!("simple"))
    );
    select_label(&mut wizard, "advanced");
    wizard.handle(Input::Continue);
    assert_eq!(wizard.setting_question().unwrap().path, "/budget");
    wizard.input = "4".into();
    wizard.handle(Input::Continue);
    navigate(&mut wizard, Step::Review, Input::Continue);
    let (evidence, facts) = super::terminal::check_discovery(
        Some(&mut session),
        &wizard.draft,
        &wizard.capabilities,
        wizard.discovery.take(),
        std::mem::take(&mut wizard.facts),
        true,
        &cancel,
    )
    .await
    .unwrap();
    assert_eq!(
        evidence.assessment(&wizard.draft).unwrap().status,
        nemoclaw_authoring::CompatibilityStatus::Compatible
    );
    wizard.discovery = Some(evidence);
    wizard.facts = facts;
    assert!(engine_reads.load(Ordering::SeqCst) >= 4);
    assert!(model_reads.load(Ordering::SeqCst) >= 2);
    wizard.handle(Input::Continue);
    assert!(wizard.accepted(), "{:?}", wizard.error());
    let yaml = wizard.draft.review().unwrap().yaml().to_owned();
    let reopened = Draft::from_yaml(yaml.as_bytes()).unwrap();
    assert_eq!(reopened.document(), wizard.draft.document());
    let harness = reopened.document().spec.sandboxes[0]
        .harness
        .as_ref()
        .unwrap();
    assert_eq!(harness.kind.as_str(), id);
    assert_eq!(harness.settings.as_ref().unwrap()["budget"], 4);
    assert_eq!(harness.settings.as_ref().unwrap()["mode"], "advanced");
    if let Some(output) = std::env::var_os("NEMOCLAW_TEST_AUTHORED_YAML") {
        crate::write_path(std::path::Path::new(&output), yaml.as_bytes()).unwrap();
    }
    model_server.abort();
}

#[test]
fn wizard_authors_a_discovered_workflow_target_without_adapter_specific_rules() {
    let mut wizard = wizard();
    establish_observed_discovery(&mut wizard);
    wizard.handle(Input::Continue);
    select_label(&mut wizard, "nvidia.fabric.nooa");
    wizard.handle(Input::Continue);
    navigate(&mut wizard, Step::Setting(0), Input::Continue);
    assert_eq!(
        wizard.setting_question().unwrap().path,
        "workflow:/target_id"
    );
    select_label(&mut wizard, "nvidia.nooa.coding-agent");
    wizard.handle(Input::Continue);
    navigate(&mut wizard, Step::Review, Input::Continue);
    wizard.handle(Input::Continue);
    assert!(wizard.accepted(), "{:?}", wizard.error());
    let reopened = Draft::from_yaml(wizard.draft.review().unwrap().yaml().as_bytes()).unwrap();
    assert_eq!(
        reopened.document().spec.sandboxes[0]
            .harness
            .as_ref()
            .unwrap()
            .config
            .as_ref()
            .unwrap()["workflow"]["target_id"],
        "nvidia.nooa.coding-agent"
    );
}

#[cfg(unix)]
#[path = "../../../../crates/test-support/docker.rs"]
mod discovery_transport;

#[test]
fn optional_enum_without_owner_default_starts_unset() {
    let mut wizard = wizard();
    install_live_fixture_catalog(&mut wizard);
    let adapter = &mut wizard
        .discovery
        .as_mut()
        .unwrap()
        .fabric
        .as_mut()
        .unwrap()
        .catalog
        .as_mut()
        .unwrap()
        .adapters[0];
    adapter.descriptor["model_schema"] = serde_json::Value::Null;
    adapter.descriptor["settings_schema"] = serde_json::json!({"type":"object","properties":{"mode":{"type":"string","enum":["a","b"]}}});
    wizard.handle(Input::Continue);
    select_label(&mut wizard, "fixture-live-adapter");
    wizard.handle(Input::Continue);
    navigate(&mut wizard, Step::Setting(0), Input::Continue);
    assert_eq!(wizard.setting_question().unwrap().path, "/mode");
    assert_eq!(wizard.choice_labels()[wizard.selected], "Leave unset");
    wizard.handle(Input::Continue);
    assert_eq!(wizard.step(), Step::Review);
    assert!(
        wizard.draft.document().spec.sandboxes[0]
            .harness
            .as_ref()
            .unwrap()
            .settings
            .as_ref()
            .unwrap()
            .get("mode")
            .is_none()
    );
}
