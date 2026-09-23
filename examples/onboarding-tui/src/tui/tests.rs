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
    assert_eq!(wizard.step(), Step::Runtime);

    wizard.handle(Input::Continue);
    wizard.handle(Input::Continue);
    assert_eq!(wizard.step(), Step::DeploymentName);
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
    for _ in 0..5 {
        wizard.handle(Input::Continue);
    }
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
    for _ in 0..5 {
        wizard.handle(Input::Continue);
    }
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
    wizard.handle(Input::Continue);
    wizard.handle(Input::Continue);
    wizard.handle(Input::Continue);
    for _ in 0..3 {
        wizard.handle(Input::Next);
    }
    wizard.handle(Input::Continue);
    wizard.handle(Input::Continue);
    wizard.handle(Input::Continue);

    assert_eq!(wizard.step(), Step::Endpoint);
    wizard.handle(Input::SelectAll);
    for character in "https://models.example.test/v1".chars() {
        wizard.handle(Input::Character(character));
    }
    wizard.handle(Input::Continue);
    assert_eq!(wizard.step(), Step::Model);
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
    for _ in 0..6 {
        wizard.handle(Input::Continue);
    }
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
    for _ in 0..11 {
        wizard.handle(Input::Continue);
    }
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
    assert!(lines[deployment + 1].contains("openclaw-nvidia-hosted"));
}
