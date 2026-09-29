// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_authoring::{
    Capabilities, JourneyDefinition, JourneyQuestionReason, JourneyScope, PartialDocument,
};
use nemoclaw_sdk::config::Document;
use serde_json::json;

fn example(name: &str) -> PartialDocument {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../examples")
        .join(name);
    PartialDocument::from_yaml(&std::fs::read(path).unwrap()).unwrap()
}

fn journey(name: &str) -> nemoclaw_authoring::JourneyState {
    let capabilities = Capabilities::available();
    JourneyDefinition::new(name, example(name))
        .ask([JourneyScope::DeploymentFields])
        .start(&capabilities)
        .unwrap()
}

#[test]
fn external_gateway_questions_preserve_deployment_and_reject_invalid_or_stale_answers() {
    let capabilities = Capabilities::available();
    let mut state = journey("fabric-pi.yaml");
    let resolution = state.resolve(&capabilities).unwrap();
    assert!(resolution.question("/spec/gateway/endpoint").is_some());
    assert!(resolution.question("/spec/gateway/engine").is_none());
    assert!(resolution.question("/metadata/uid").is_none());
    let before = state.values().clone();
    assert!(
        state
            .answer(&capabilities, "/metadata/uid", Some(json!("bad")))
            .is_err()
    );
    assert!(
        state
            .answer(
                &capabilities,
                "/spec/gateway/endpoint",
                Some(json!("invalid-url"))
            )
            .is_err()
    );
    assert_eq!(state.values(), &before);
    state
        .answer(
            &capabilities,
            "/spec/gateway/endpoint",
            Some(json!("http://127.0.0.1:19001")),
        )
        .unwrap();
    let mut expected = before;
    expected["spec"]["gateway"]["endpoint"] = json!("http://127.0.0.1:19001");
    assert_eq!(state.values(), &expected);
}

#[test]
fn managed_service_questions_use_sdk_types_and_keep_recipe_as_one_value() {
    let capabilities = Capabilities::available();
    let mut state = journey("spark/remote-vllm.yaml");
    let resolution = state.resolve(&capabilities).unwrap();
    for path in [
        "/spec/services/qwen/placement/engine",
        "/spec/services/qwen/publication/endpoint",
        "/spec/services/qwen/model/revision",
        "/spec/services/qwen/serving/contextTokens",
        "/spec/services/qwen/memory/gpuMemoryGiB",
    ] {
        assert!(resolution.question(path).is_some(), "missing {path}");
    }
    let before = state.values().clone();
    let path = "/spec/services/qwen/serving/contextTokens";
    assert!(state.answer(&capabilities, path, Some(json!(-1))).is_err());
    assert_eq!(state.values(), &before);

    let recipe = journey("spark/spark-inline.yaml");
    let resolution = recipe.resolve(&capabilities).unwrap();
    let recipes = resolution
        .questions()
        .iter()
        .filter(|question| question.id().contains("/recipe"))
        .collect::<Vec<_>>();
    assert_eq!(recipes.len(), 1);
    assert!(recipes[0].schema().get("$defs").is_some());
    assert!(recipes[0].suggestion().unwrap().is_object());
}

#[test]
fn optional_supplied_deployment_field_can_be_omitted_through_the_shared_question() {
    let capabilities = Capabilities::available();
    let mut supplied = example("onboarding/openclaw.yaml").supplied().clone();
    supplied["spec"]["gateway"]["imagePullPolicy"] = json!("Never");
    let base = PartialDocument::from_yaml(supplied.to_string().as_bytes()).unwrap();
    let mut state = JourneyDefinition::new("optional-deployment", base)
        .ask([JourneyScope::DeploymentFields])
        .start(&capabilities)
        .unwrap();
    let path = "/spec/gateway/imagePullPolicy";
    let resolution = state.resolve(&capabilities).unwrap();
    let question = resolution.question(path).expect("deployment question");
    assert!(!question.required());
    assert_eq!(question.suggestion(), Some(&json!("Never")));

    state.answer(&capabilities, path, None).unwrap();
    assert!(state.values().pointer(path).is_none());
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
fn deployment_questions_follow_the_selected_sdk_hardware_form() {
    let capabilities = Capabilities::available();
    let dedicated = journey("nemotron-amd64.yaml");
    let question = dedicated
        .resolve(&capabilities)
        .unwrap()
        .question("/spec/services/nemotron/hardware/architecture")
        .cloned()
        .expect("dedicated hardware architecture question");
    assert!(question.required());
    assert_eq!(question.choices(), &[json!("amd64")]);

    let profiled = journey("spark/remote-vllm.yaml");
    let question = profiled
        .resolve(&capabilities)
        .unwrap()
        .question("/spec/services/qwen/hardware/profile")
        .cloned()
        .expect("profiled hardware question");
    assert!(question.required());
    assert_eq!(question.suggestion(), Some(&json!("dgx-spark")));
}

#[test]
fn single_sandbox_examples_offer_existing_sdk_values_without_changing_them() {
    fn files(root: &std::path::Path, result: &mut Vec<std::path::PathBuf>) {
        for entry in std::fs::read_dir(root).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                files(&path, result);
            } else if path
                .extension()
                .is_some_and(|ext| ext == "yaml" || ext == "yml")
            {
                result.push(path);
            }
        }
    }
    let capabilities = Capabilities::available();
    let mut paths = Vec::new();
    files(
        &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../examples"),
        &mut paths,
    );
    let mut covered = 0;
    for path in paths {
        let bytes = std::fs::read(&path).unwrap();
        let document = Document::parse(bytes.as_slice()).unwrap();
        if document.spec.sandboxes.len() != 1 {
            continue;
        }
        let base = PartialDocument::from_yaml(&bytes).unwrap();
        let mut state = JourneyDefinition::new("example", base)
            .ask([JourneyScope::DeploymentFields])
            .start(&capabilities)
            .unwrap();
        let before = serde_json::to_value(&document).unwrap();
        let resolution = state.resolve(&capabilities).unwrap();
        let questions = resolution
            .questions()
            .iter()
            .filter(|question| {
                question.reason() == JourneyQuestionReason::ExplicitAsk
                    && question.id().starts_with('/')
            })
            .collect::<Vec<_>>();
        assert!(!questions.is_empty(), "{}", path.display());
        for question in &questions {
            assert_eq!(question.suggestion(), before.pointer(question.id()));
            assert_eq!(
                nemoclaw_sdk::fabric_capabilities::schema_accepts(
                    question.schema(),
                    question.suggestion().unwrap()
                ),
                Some(true),
                "{}",
                question.id()
            );
        }
        let first = questions[0];
        state
            .answer(&capabilities, first.id(), first.suggestion().cloned())
            .unwrap();
        let after = state.resolve(&capabilities).unwrap();
        assert_eq!(
            serde_json::to_value(after.assessment().document().unwrap()).unwrap(),
            before
        );
        covered += 1;
    }
    assert_eq!(covered, 30);
}

#[test]
fn reference_scoped_execution_questions_follow_the_selected_harness_only() {
    let capabilities = Capabilities::available();
    let mut value = example("fabric-openclaw.yaml").supplied().clone();
    let mut harness = value["spec"]["sandboxes"][0]["harness"].clone();
    harness["execution"] = json!({"timeoutSeconds":120});
    value["spec"]["harnesses"] = json!({"unused":harness});
    let path = "/spec/harnesses/unused/execution/timeoutSeconds";
    let state = JourneyDefinition::new(
        "inline",
        PartialDocument::from_yaml(value.to_string().as_bytes()).unwrap(),
    )
    .ask([JourneyScope::DeploymentFields])
    .start(&capabilities)
    .unwrap();
    assert!(
        state
            .resolve(&capabilities)
            .unwrap()
            .question(path)
            .is_none()
    );
    let mut state = state;
    assert!(state.answer(&capabilities, path, Some(json!(240))).is_err());

    value["spec"]["sandboxes"][0]
        .as_object_mut()
        .unwrap()
        .remove("harness");
    value["spec"]["sandboxes"][0]["harnessRef"] = json!("unused");
    let mut state = JourneyDefinition::new(
        "reference",
        PartialDocument::from_yaml(value.to_string().as_bytes()).unwrap(),
    )
    .ask([JourneyScope::DeploymentFields])
    .start(&capabilities)
    .unwrap();
    assert!(
        state
            .resolve(&capabilities)
            .unwrap()
            .question(path)
            .is_some()
    );
    state.answer(&capabilities, path, Some(json!(240))).unwrap();
    assert_eq!(state.values().pointer(path), Some(&json!(240)));
}
