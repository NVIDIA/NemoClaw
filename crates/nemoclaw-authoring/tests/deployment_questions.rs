// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use nemoclaw_authoring::Draft;
use serde_json::json;

fn example(name: &str) -> Draft {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../examples")
        .join(name);
    Draft::from_yaml(&std::fs::read(path).unwrap()).unwrap()
}

#[test]
fn external_gateway_questions_preserve_deployment_and_reject_invalid_or_stale_answers() {
    let mut draft = example("fabric-pi.yaml");
    let questions = draft.deployment_questions().unwrap();
    assert!(questions.iter().any(|q| q.path == "/spec/gateway/endpoint"));
    assert!(!questions.iter().any(|q| q.path == "/spec/gateway/engine"
        || q.path.contains("settings")
        || q.path.contains("uid")));
    let before = draft.document().clone();
    assert!(
        draft
            .answer_deployment_question("/metadata/uid", json!("bad"))
            .is_err()
    );
    assert!(
        draft
            .answer_deployment_question("/spec/gateway/endpoint", json!("invalid-url"))
            .is_err()
    );
    assert_eq!(draft.document(), &before);
    draft
        .answer_deployment_question("/spec/gateway/endpoint", json!("http://127.0.0.1:19001"))
        .unwrap();
    let mut expected = serde_json::to_value(before).unwrap();
    expected["spec"]["gateway"]["endpoint"] = json!("http://127.0.0.1:19001");
    assert_eq!(serde_json::to_value(draft.document()).unwrap(), expected);
}

#[test]
fn managed_service_questions_reuse_sdk_types_and_preserve_recipe_as_one_value() {
    let mut draft = example("spark/remote-vllm.yaml");
    let fields = draft.deployment_questions().unwrap();
    for path in [
        "/spec/services/qwen/placement/engine",
        "/spec/services/qwen/publication/endpoint",
        "/spec/services/qwen/model/revision",
        "/spec/services/qwen/serving/contextTokens",
        "/spec/services/qwen/memory/gpuMemoryGiB",
    ] {
        assert!(fields.iter().any(|q| q.path == path), "missing {path}");
    }
    let field = fields
        .iter()
        .find(|q| q.path.ends_with("/contextTokens"))
        .unwrap();
    assert_eq!(field.parse("4096").unwrap(), json!(4096));
    let before = draft.document().clone();
    assert!(
        draft
            .answer_deployment_question(&field.path, json!(-1))
            .is_err()
    );
    assert_eq!(draft.document(), &before);
    let recipe = example("spark/spark-inline.yaml");
    let fields = recipe.deployment_questions().unwrap();
    assert_eq!(
        fields.iter().filter(|q| q.path.contains("/recipe")).count(),
        1
    );
    let recipe = fields.iter().find(|q| q.path.ends_with("/recipe")).unwrap();
    assert!(recipe.schema.get("$defs").is_some());
    assert!(recipe.suggestion.as_ref().unwrap().is_object());
}

#[test]
fn single_sandbox_examples_expose_only_existing_sdk_values_and_keep_defaults_losslessly() {
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
    let mut paths = Vec::new();
    files(
        &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../examples"),
        &mut paths,
    );
    let mut covered = 0;
    for path in paths {
        let mut draft = Draft::from_yaml(&std::fs::read(&path).unwrap()).unwrap();
        if draft.document().spec.sandboxes.len() != 1 {
            continue;
        }
        let before = draft.document().clone();
        let values = serde_json::to_value(&before).unwrap();
        let questions = draft.deployment_questions().unwrap();
        eprintln!(
            "{}: {} deployment questions",
            path.display(),
            questions.len()
        );
        assert!(!questions.is_empty());
        for question in &questions {
            assert_eq!(question.suggestion.as_ref(), values.pointer(&question.path));
            assert_eq!(
                nemoclaw_sdk::fabric_capabilities::schema_accepts(
                    &question.schema,
                    question.suggestion.as_ref().unwrap()
                ),
                Some(true),
                "{}",
                question.path
            );
        }
        let first = &questions[0];
        draft
            .answer_deployment_question(&first.path, first.suggestion.clone().unwrap())
            .unwrap();
        assert_eq!(draft.document(), &before);
        covered += 1;
    }
    assert_eq!(covered, 30);
}

#[test]
fn reference_scoped_execution_questions_follow_the_selected_harness_only() {
    let base = example("fabric-openclaw.yaml");
    let mut value = serde_json::to_value(base.document()).unwrap();
    let mut harness = value["spec"]["sandboxes"][0]["harness"].clone();
    harness["execution"] = json!({"timeoutSeconds":120});
    value["spec"]["harnesses"] = json!({"unused":harness});
    let mut draft = Draft::from_yaml(value.to_string().as_bytes()).unwrap();
    let path = "/spec/harnesses/unused/execution/timeoutSeconds";
    assert!(
        !draft
            .deployment_questions()
            .unwrap()
            .iter()
            .any(|question| question.path == path)
    );
    assert!(draft.answer_deployment_question(path, json!(240)).is_err());
    value["spec"]["sandboxes"][0]
        .as_object_mut()
        .unwrap()
        .remove("harness");
    value["spec"]["sandboxes"][0]["harnessRef"] = json!("unused");
    let mut draft = Draft::from_yaml(value.to_string().as_bytes()).unwrap();
    assert!(
        draft
            .deployment_questions()
            .unwrap()
            .iter()
            .any(|question| question.path == path)
    );
    draft.answer_deployment_question(path, json!(240)).unwrap();
    assert_eq!(
        serde_json::to_value(draft.document())
            .unwrap()
            .pointer(path),
        Some(&json!(240))
    );
}
