// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::*;

const CLUSTER_VLLM: &[u8] = include_bytes!("../../../../examples/kubernetes/local-vllm.yaml");
const CLUSTER_OLLAMA: &[u8] = include_bytes!("../../../../examples/kubernetes/local-ollama.yaml");
const DOCKER_VLLM: &[u8] = include_bytes!("../../../../examples/spark/vllm.yaml");
const DOCKER_OLLAMA: &[u8] = include_bytes!("../../../../examples/managed-ollama-gpu.yaml");

fn with_context(source: &[u8], context: i64) -> Value {
    let mut document = serde_json::to_value(Document::parse(source).unwrap()).unwrap();
    document["spec"]["services"]["qwen"]["serving"]["contextTokens"] = json!(context);
    document
}

async fn context_warnings(document: &Document, apply: bool) -> Vec<String> {
    let directory = tempfile::tempdir().unwrap();
    let events = Arc::new(std::sync::Mutex::new(Vec::new()));
    let saved = events.clone();
    let state = directory.path().join("state");
    let deployment = Deployment::new(&state, &directory.path().join("missing-bundle"))
        .with_progress(Arc::new(move |event| saved.lock().unwrap().push(event)));
    let result = if apply {
        deployment.apply(document, &CancellationToken::new()).await
    } else {
        deployment.plan(document, &CancellationToken::new()).await
    };
    assert!(matches!(result, Err(Error::Bundle(_))), "{result:?}");
    assert!(!state.exists(), "the advisory precedes state creation");
    let events = events.lock().unwrap();
    assert!(!events.contains(&Progress::MutationStarted));
    events
        .iter()
        .filter_map(|event| match event {
            Progress::Warning { message } if message.contains("contextTokens") => {
                Some(message.clone())
            }
            _ => None,
        })
        .collect()
}

#[tokio::test]
async fn small_managed_openclaw_context_warns_before_plan_or_apply_mutation() {
    for source in [CLUSTER_VLLM, CLUSTER_OLLAMA, DOCKER_VLLM, DOCKER_OLLAMA] {
        let document = Document::parse(with_context(source, 8192).to_string().as_bytes()).unwrap();
        for apply in [false, true] {
            let warnings = context_warnings(&document, apply).await;
            assert_eq!(warnings.len(), 1);
            let warning = &warnings[0];
            for detail in ["assistant", "primary", "qwen", "8192", "32768"] {
                assert!(warning.contains(detail), "missing {detail}: {warning}");
            }
        }
    }
}

#[tokio::test]
async fn context_advisory_uses_the_selected_harness_and_service_budget() {
    for (context, count) in [(19_999, 1), (20_000, 0), (32_768, 0)] {
        let document =
            Document::parse(with_context(CLUSTER_VLLM, context).to_string().as_bytes()).unwrap();
        assert_eq!(context_warnings(&document, false).await.len(), count);
    }
    let mut other_harness = with_context(CLUSTER_VLLM, 8192);
    other_harness["spec"]["sandboxes"][0]["harness"]["kind"] = json!("nvidia.fabric.codex");
    let document = Document::parse(other_harness.to_string().as_bytes()).unwrap();
    assert!(context_warnings(&document, false).await.is_empty());

    let mut external = with_context(CLUSTER_VLLM, 8192);
    external["spec"]["inferenceProviders"][0]
        .as_object_mut()
        .unwrap()
        .remove("serviceRef");
    external["spec"]["inferenceProviders"][0]["endpoint"] = json!("http://10.20.30.40:8000/v1");
    let document = Document::parse(external.to_string().as_bytes()).unwrap();
    assert!(
        context_warnings(&document, false).await.is_empty(),
        "an unselected small-context service cannot characterize an external endpoint"
    );
}

#[tokio::test]
async fn context_advisory_resolves_referenced_harnesses_and_local_providers() {
    let mut input = with_context(CLUSTER_VLLM, 8192);
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
    let document = Document::parse(input.to_string().as_bytes()).unwrap();
    assert_eq!(context_warnings(&document, false).await.len(), 1);
}
