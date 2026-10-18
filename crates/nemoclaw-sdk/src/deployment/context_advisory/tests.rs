// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use crate::{CancellationToken, Deployment, Error, config::Document, deployment::Progress};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

const DOCKER_VLLM: &[u8] = include_bytes!("../../../../../examples/spark/vllm.yaml");
const DOCKER_OLLAMA: &[u8] = include_bytes!("../../../../../examples/managed-ollama-gpu.yaml");

fn with_context(source: &[u8], context: i64) -> Value {
    let mut document = serde_json::to_value(Document::parse(source).unwrap()).unwrap();
    document["spec"]["services"]["qwen"]["serving"]["contextTokens"] = json!(context);
    document
}

fn with_hermes(source: &[u8], context: i64) -> Value {
    let mut document = with_context(source, context);
    document["spec"]["sandboxes"][0]["harness"]["kind"] = json!("nvidia.fabric.hermes");
    document
}

/// The advisory for `input` after the defaults and validation that plan and
/// apply perform first.
fn warnings(input: &Value) -> Vec<String> {
    let mut document = Document::parse(input.to_string().as_bytes()).unwrap();
    document.defaults();
    document.validate().unwrap();
    super::context_warnings(&document).unwrap()
}

/// The warnings plan or apply reports, which must all come before the
/// operation creates state or starts a mutation.
async fn reported(input: &Value, apply: bool) -> Vec<String> {
    let document = Document::parse(input.to_string().as_bytes()).unwrap();
    let directory = tempfile::tempdir().unwrap();
    let events = Arc::new(Mutex::new(Vec::new()));
    let saved = events.clone();
    let state = directory.path().join("state");
    let deployment = Deployment::new(&state, &directory.path().join("missing-bundle"))
        .with_progress(Arc::new(move |event| saved.lock().unwrap().push(event)));
    let result = if apply {
        deployment.apply(&document, &CancellationToken::new()).await
    } else {
        deployment.plan(&document, &CancellationToken::new()).await
    };
    assert!(matches!(result, Err(Error::Bundle(_))), "{result:?}");
    assert!(!state.exists(), "the advisory precedes state creation");
    let events = events.lock().unwrap();
    assert!(!events.contains(&Progress::MutationStarted));
    events
        .iter()
        .filter_map(|event| match event {
            Progress::Warning { message } => Some(message.clone()),
            _ => None,
        })
        .collect()
}

#[tokio::test]
async fn plan_and_apply_report_the_advisory_before_creating_state_or_mutating() {
    for input in [
        with_hermes(DOCKER_VLLM, 8192),
        with_hermes(DOCKER_OLLAMA, 8192),
    ] {
        let expected = warnings(&input);
        assert!(!expected.is_empty());
        for apply in [false, true] {
            assert_eq!(reported(&input, apply).await, expected, "{input}");
        }
    }
}

#[test]
fn context_advisory_warns_only_for_hermes_routes_to_managed_services() {
    // The examples' OpenClaw sandboxes get no advisory; the adapter owns its
    // context handling.
    assert!(warnings(&with_context(DOCKER_VLLM, 8192)).is_empty());
    let mut other_harness = with_context(DOCKER_VLLM, 8192);
    other_harness["spec"]["sandboxes"][0]["harness"]["kind"] = json!("nvidia.fabric.codex");
    assert!(warnings(&other_harness).is_empty());
    let hermes = warnings(&with_hermes(DOCKER_VLLM, 8192));
    assert_eq!(hermes.len(), 1, "{hermes:?}");
    assert!(hermes[0].starts_with("Hermes sandbox"), "{}", hermes[0]);

    let mut external = with_hermes(DOCKER_VLLM, 8192);
    external["spec"]["inferenceProviders"][0]
        .as_object_mut()
        .unwrap()
        .remove("serviceRef");
    external["spec"]["inferenceProviders"][0]["endpoint"] = json!("http://10.20.30.40:8000/v1");
    assert!(
        warnings(&external).is_empty(),
        "an unselected small-context service cannot characterize an external endpoint"
    );
}

#[test]
fn context_advisory_resolves_referenced_harnesses_and_local_providers() {
    let mut input = with_hermes(DOCKER_VLLM, 8192);
    input["spec"]["harnesses"] = json!({"selected":
        input["spec"]["sandboxes"][0].as_object_mut().unwrap().remove("harness").unwrap()
    });
    input["spec"]["sandboxes"][0]["harnessRef"] = json!("selected");
    input["spec"]["sandboxes"][0]["inferenceProviders"] = input["spec"]
        .as_object_mut()
        .unwrap()
        .remove("inferenceProviders")
        .unwrap();
    let inference = input["spec"]["sandboxes"][0]["agent"]
        .as_object_mut()
        .unwrap()
        .remove("inference")
        .unwrap();
    input["spec"]["sandboxes"][0]["inferences"] = json!({"selected": inference});
    input["spec"]["sandboxes"][0]["agent"]["inferenceRef"] = json!("selected");
    let warnings = warnings(&input);
    assert_eq!(warnings.len(), 1, "{warnings:?}");
    assert!(warnings[0].starts_with("Hermes sandbox"), "{}", warnings[0]);
}

#[test]
fn hermes_routes_to_managed_services_below_its_minimum_context_warn() {
    for source in [DOCKER_VLLM, DOCKER_OLLAMA] {
        for context in [8192, 32768, 40960, 63999] {
            let warnings = warnings(&with_hermes(source, context));
            assert_eq!(warnings.len(), 1, "{warnings:?}");
            let context = context.to_string();
            for detail in ["Hermes", "assistant", "primary", "qwen", &context, "64000"] {
                assert!(
                    warnings[0].contains(detail),
                    "missing {detail}: {}",
                    warnings[0]
                );
            }
        }
    }
}

#[test]
fn hermes_routes_at_its_minimum_context_need_no_warning() {
    for source in [DOCKER_VLLM, DOCKER_OLLAMA] {
        for context in [64000, 65536] {
            assert!(warnings(&with_hermes(source, context)).is_empty());
        }
    }
}
