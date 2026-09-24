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
    for _ in 0..24 {
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

#[test]
fn wizard_guides_every_authoring_choice_and_filters_invalid_apis() {
    let mut wizard = wizard();
    assert_eq!(wizard.step(), Step::Welcome);
    wizard.handle(Input::Continue);
    assert_eq!(wizard.step(), Step::Harness);

    wizard.handle(Input::Next);
    wizard.handle(Input::Next);
    wizard.handle(Input::Continue);
    assert_eq!(
        wizard
            .draft()
            .guided_answers(&wizard.capabilities)
            .unwrap()
            .harness,
        HarnessChoice::DeepAgents
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
        "OpenClaw",
        "Hermes",
        "⟦ 1/7 ⟧",
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
        question.contains("⟦ 1/7 ⟧"),
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
    for _ in 0..3 {
        wizard.handle(Input::Next);
    }
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
    for _ in 0..12 {
        if wizard.step() == Step::Review {
            break;
        }
        wizard.handle(Input::Continue);
    }
    assert_eq!(wizard.step(), Step::Review);
    assert_eq!(
        wizard.draft().guided_answers(&wizard.capabilities).unwrap(),
        answers
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
    wizard.handle(Input::Continue);
    wizard.handle(Input::Next);
    wizard.handle(Input::Next);
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
    assert_eq!(wizard.step(), Step::Inference);
    assert_eq!(
        wizard
            .draft()
            .guided_answers(&wizard.capabilities)
            .unwrap()
            .harness,
        HarnessChoice::DeepAgents
    );
}

#[test]
fn changing_provider_reasks_the_model_without_reasking_an_accepted_name() {
    let mut wizard = wizard();
    navigate(&mut wizard, Step::Review, Input::Continue);
    navigate(&mut wizard, Step::Inference, Input::Back);
    wizard.handle(Input::Next);
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
fn every_guided_template_keeps_its_defaults_through_review_and_save() {
    let capabilities = Capabilities::available();
    for (index, scenario) in capabilities.scenarios().iter().enumerate() {
        for custom in [false, true] {
            let mut answers = Answers::onboarding_defaults().for_scenario(scenario);
            answers.deployment_name = format!("template-{index}");
            answers.sandbox_name = "template-sandbox".into();
            answers.agent_name = "template-agent".into();
            if custom {
                answers.model = "my-org/custom-model-120b".into();
                if scenario.accepts_custom_endpoint() {
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
            for _ in 0..12 {
                if wizard.step() == Step::Review {
                    break;
                }
                assert!(
                    wizard.error().is_none(),
                    "{answers:?}: {:?}",
                    wizard.error()
                );
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
            assert_eq!(wizard.step(), Step::Review, "{answers:?}");
            assert_eq!(
                wizard.draft().guided_answers(&capabilities).unwrap(),
                answers
            );
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
    let scenario = capabilities
        .scenarios()
        .iter()
        .find(|scenario| scenario.runtime() == RuntimeChoice::Podman)
        .unwrap();
    let answers = Answers::onboarding_defaults().for_scenario(scenario);
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
    wizard.handle(Input::Continue);
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
    assert!(terminal.backend().to_string().contains("⟦ 2/7 ⟧"));
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
    for _ in 0..12 {
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
    let key = wizard.draft.discovery_key().unwrap();
    let mut catalog = nemoclaw_sdk::fabric_catalog::FabricCatalog::bundled();
    catalog
        .adapters
        .retain(|adapter| adapter.harness == "hermes");
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
            adapters: Vec::new(),
        }),
    });
    navigate(&mut wizard, Step::Review, Input::Continue);
    wizard.handle(Input::Continue);
    assert!(!wizard.accepted());
    assert!(wizard.error().unwrap().contains("harness:openclaw"));
    let mut terminal = Terminal::new(TestBackend::new(120, 30)).unwrap();
    terminal.draw(|frame| wizard.render(frame)).unwrap();
    assert!(terminal.backend().to_string().contains("harness:openclaw"));
}
