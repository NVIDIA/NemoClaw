// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::app::{Input, Step, Wizard};
use crate::{Source, load, write_path};
use nemoclaw_authoring::Capabilities;
use nemoclaw_sdk::config::Document;
use std::path::{Path, PathBuf};

fn example_templates() -> Vec<(PathBuf, Document)> {
    fn visit(directory: &Path, paths: &mut Vec<PathBuf>) {
        for entry in std::fs::read_dir(directory).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                visit(&path, paths);
            } else if matches!(
                path.extension().and_then(|value| value.to_str()),
                Some("yaml" | "yml")
            ) {
                paths.push(path);
            }
        }
    }
    let mut paths = Vec::new();
    visit(
        &Path::new(env!("CARGO_MANIFEST_DIR")).join(".."),
        &mut paths,
    );
    paths.sort();
    paths
        .into_iter()
        .filter_map(|path| {
            let bytes = std::fs::read(&path).unwrap();
            let shape: serde_json::Value = serde_saphyr::from_slice(&bytes)
                .unwrap_or_else(|error| panic!("{}: {error}", path.display()));
            if shape.get("kind").and_then(serde_json::Value::as_str) != Some("NemoClawConfig") {
                return None;
            }
            let document = Document::parse(bytes.as_slice())
                .unwrap_or_else(|error| panic!("{}: {error}", path.display()));
            (document.spec.sandboxes.len() == 1).then_some((path, document))
        })
        .collect()
}

fn finish(wizard: &mut Wizard, template: &Path, rename: bool) {
    let mut renamed = false;
    for _ in 0..512 {
        if wizard.step() == Step::Review {
            assert!(
                !rename || renamed,
                "{} never asked the deployment name",
                template.display()
            );
            wizard.handle(Input::Continue);
            assert!(
                wizard.accepted(),
                "{} review did not accept: {:?}",
                template.display(),
                wizard.error()
            );
            return;
        }
        if rename && wizard.step() == Step::DeploymentName {
            wizard.handle(Input::SelectAll);
            for character in "template-copy".chars() {
                wizard.handle(Input::Character(character));
            }
            renamed = true;
        }
        wizard.handle(Input::Continue);
        assert!(
            wizard.error().is_none(),
            "{} at {:?}: {:?}",
            template.display(),
            wizard.step(),
            wizard.error()
        );
    }
    panic!(
        "{} did not reach review; at {:?}: {:?}",
        template.display(),
        wizard.step(),
        wizard.error()
    );
}

fn exercise_templates(rename: bool) {
    let templates = example_templates();
    assert!(
        !templates.is_empty(),
        "example discovery must exercise real templates"
    );
    let directory = tempfile::tempdir().unwrap();
    for (index, (path, original)) in templates.iter().enumerate() {
        let original_bytes = std::fs::read(path).unwrap();
        let capabilities = Capabilities::available();
        let draft = load(Source::Template(path), &capabilities)
            .unwrap_or_else(|error| panic!("{} failed template loading: {error}", path.display()));
        assert_ne!(
            draft.document().metadata.uid,
            original.metadata.uid,
            "{} reused deployment identity",
            path.display()
        );
        assert_eq!(
            draft.document().spec,
            original.spec,
            "{} lost template settings during loading",
            path.display()
        );
        let mut wizard = Wizard::new(capabilities, draft);
        finish(&mut wizard, path, rename);
        let reviewed = wizard.draft().review().unwrap();
        let output = directory.path().join(format!("example-{index}.yaml"));
        write_path(&output, reviewed.yaml().as_bytes()).unwrap();
        let saved = Document::parse(std::fs::File::open(&output).unwrap()).unwrap();
        assert_eq!(&saved, wizard.draft().document());
        assert_eq!(
            saved.spec,
            original.spec,
            "{} changed unrelated template settings",
            path.display()
        );
        assert_eq!(
            saved.metadata.name,
            if rename {
                "template-copy"
            } else {
                original.metadata.name.as_str()
            }
        );
        assert_ne!(saved.metadata.uid, original.metadata.uid);
        assert_eq!(
            std::fs::read(path).unwrap(),
            original_bytes,
            "{} overwrote original",
            path.display()
        );
    }
}

#[test]
fn every_single_sandbox_example_completes_onboarding_without_losing_defaults() {
    exercise_templates(false);
}

#[test]
fn every_single_sandbox_example_accepts_an_answer_without_changing_other_settings() {
    exercise_templates(true);
}

fn template_wizard(name: &str) -> (PathBuf, Wizard) {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join(name);
    let capabilities = Capabilities::available();
    let draft = load(Source::Template(&path), &capabilities).unwrap();
    (path, Wizard::new(capabilities, draft))
}

fn enter_text(wizard: &mut Wizard, value: &str) {
    wizard.handle(Input::SelectAll);
    for character in value.chars() {
        wizard.handle(Input::Character(character));
    }
}

fn save_and_compare(wizard: &Wizard, expected: &serde_json::Value) {
    assert!(
        wizard.accepted(),
        "wizard must accept the reviewed document"
    );
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("edited.yaml");
    write_path(&path, wizard.draft().review().unwrap().yaml().as_bytes()).unwrap();
    let saved = Document::parse(std::fs::File::open(path).unwrap()).unwrap();
    assert_eq!(serde_json::to_value(saved).unwrap(), *expected);
}

#[test]
fn changing_second_route_model_keeps_first_route_and_managed_service() {
    let (path, mut wizard) = template_wizard("spark/local-and-hosted.yaml");
    let original = std::fs::read(&path).unwrap();
    let mut expected = serde_json::to_value(wizard.draft().document()).unwrap();
    let model_path = "/spec/sandboxes/0/agent/inference/routes/1/overrides/model";
    *expected.pointer_mut(model_path).unwrap() = serde_json::json!("replacement-model");
    let mut changed = false;
    for _ in 0..512 {
        if !changed
            && wizard.step() == Step::Model
            && wizard.draft().current_route().unwrap() == "hosted"
        {
            enter_text(&mut wizard, "replacement-model");
            changed = true;
        }
        wizard.handle(Input::Continue);
        assert!(
            wizard.error().is_none(),
            "{:?}: {:?}",
            wizard.step(),
            wizard.error()
        );
        if wizard.accepted() {
            break;
        }
    }
    assert!(changed, "second route model was not offered");
    save_and_compare(&wizard, &expected);
    assert_eq!(std::fs::read(path).unwrap(), original);
}

fn edit_deployment_questions(name: &str, changes: &[(&str, serde_json::Value)]) {
    let (path, mut wizard) = template_wizard(name);
    let original = std::fs::read(&path).unwrap();
    let mut expected = serde_json::to_value(wizard.draft().document()).unwrap();
    for (path, value) in changes {
        *expected.pointer_mut(path).unwrap() = value.clone();
    }
    let mut changed = vec![false; changes.len()];
    for _ in 0..512 {
        if let Some(question) = wizard.setting_question() {
            for (index, (path, value)) in changes.iter().enumerate() {
                if !changed[index] && question.path == *path {
                    if question.choices.is_empty() {
                        enter_text(
                            &mut wizard,
                            &value
                                .as_str()
                                .map(str::to_owned)
                                .unwrap_or_else(|| value.to_string()),
                        );
                    } else {
                        let position = question
                            .choices
                            .iter()
                            .position(|choice| choice == value)
                            .unwrap();
                        for _ in 0..question.choices.len() + 1 {
                            if wizard.selected == position {
                                break;
                            }
                            wizard.handle(Input::Next);
                        }
                        assert_eq!(wizard.selected, position);
                    }
                    changed[index] = true;
                }
            }
        }
        wizard.handle(Input::Continue);
        assert!(
            wizard.error().is_none(),
            "{name} {:?}: {:?}",
            wizard.step(),
            wizard.error()
        );
        if wizard.accepted() {
            break;
        }
    }
    for (index, (path, _)) in changes.iter().enumerate() {
        assert!(changed[index], "{name} never asked {path}");
    }
    save_and_compare(&wizard, &expected);
    assert_eq!(std::fs::read(path).unwrap(), original);
}

#[test]
fn service_revision_and_execution_timeout_are_editable_without_changing_routes() {
    edit_deployment_questions(
        "spark/two-models.yaml",
        &[
            (
                "/spec/services/smart/model/revision",
                serde_json::json!("1111111111111111111111111111111111111111"),
            ),
            (
                "/spec/sandboxes/0/harness/execution/timeoutSeconds",
                serde_json::json!(420),
            ),
        ],
    );
}

#[test]
fn model_token_limit_is_editable_without_changing_native_settings() {
    edit_deployment_questions(
        "inference-tuning.yaml",
        &[(
            "/spec/sandboxes/0/agent/inference/routes/0/overrides/maxTokens",
            serde_json::json!(4096),
        )],
    );
}

#[test]
fn explicit_policy_is_editable_without_changing_gateway_or_proxy() {
    let (_, wizard) = template_wizard("explicit-policy.yaml");
    let document = serde_json::to_value(wizard.draft().document()).unwrap();
    let path = "/spec/sandboxes/0/network/policy";
    let mut policy = document.pointer(path).unwrap().clone();
    policy["explicit"]["process"]["run_as_user"] = serde_json::json!("1001");
    edit_deployment_questions("explicit-policy.yaml", &[(path, policy)]);
}

#[test]
fn authentication_question_preserves_the_sdk_supported_method_and_credential_reference() {
    edit_deployment_questions(
        "hermes-auth.yaml",
        &[(
            "/spec/sandboxes/0/agent/auth/method",
            serde_json::json!("api-key"),
        )],
    );
}
