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

fn budget_warnings(warnings: &[String]) -> Vec<&str> {
    warnings
        .iter()
        .filter(|message| message.contains("initial prompt"))
        .map(String::as_str)
        .collect()
}

#[tokio::test]
async fn native_route_window_above_the_service_limit_warns_even_with_initial_prompt_room() {
    for source in [CLUSTER_VLLM, CLUSTER_OLLAMA, DOCKER_VLLM, DOCKER_OLLAMA] {
        for explicit_window in [false, true] {
            let mut input = with_context(source, 24576);
            let metadata = &mut input["spec"]["sandboxes"][0]["agent"]["inference"]["routes"][0]["overrides"]
                ["settings"]["model_metadata"];
            *metadata = json!({});
            if explicit_window {
                metadata["contextWindow"] = json!(32768);
            }
            let document = Document::parse(input.to_string().as_bytes()).unwrap();
            for apply in [false, true] {
                let warnings = context_warnings(&document, apply).await;
                assert_eq!(
                    warnings.len(),
                    1,
                    "a larger native window permits conversations beyond the server limit"
                );
                for detail in ["assistant", "primary", "qwen", "24576", "32768"] {
                    assert!(
                        warnings[0].contains(detail),
                        "missing {detail}: {}",
                        warnings[0]
                    );
                }
                assert!(warnings[0].contains("conversations"), "{}", warnings[0]);
            }
        }
    }
}

#[tokio::test]
async fn native_route_window_at_or_below_the_service_limit_needs_no_mismatch_warning() {
    for source in [CLUSTER_VLLM, CLUSTER_OLLAMA, DOCKER_VLLM, DOCKER_OLLAMA] {
        for context in [32768, 65536] {
            for route_context in [None, Some(24576), Some(32768)] {
                let mut input = with_context(source, context);
                let metadata = &mut input["spec"]["sandboxes"][0]["agent"]["inference"]["routes"]
                    [0]["overrides"]["settings"]["model_metadata"];
                *metadata = json!({});
                if let Some(route_context) = route_context {
                    metadata["contextWindow"] = json!(route_context);
                }
                let document = Document::parse(input.to_string().as_bytes()).unwrap();
                for apply in [false, true] {
                    assert!(
                        context_warnings(&document, apply).await.is_empty(),
                        "{input}"
                    );
                }
            }
        }
    }
}

#[tokio::test]
async fn native_route_mismatch_is_assessed_independently_of_unusable_reply_metadata() {
    for source in [CLUSTER_VLLM, CLUSTER_OLLAMA, DOCKER_VLLM, DOCKER_OLLAMA] {
        for route_context in [None, Some(32768), Some(24576)] {
            let mut input = with_context(source, 24576);
            let metadata = &mut input["spec"]["sandboxes"][0]["agent"]["inference"]["routes"][0]["overrides"]
                ["settings"]["model_metadata"];
            *metadata = json!({"maxTokens": "unusable-reply-secret"});
            if let Some(route_context) = route_context {
                metadata["contextWindow"] = json!(route_context);
            }
            let document = Document::parse(input.to_string().as_bytes()).unwrap();
            for apply in [false, true] {
                let warnings = context_warnings(&document, apply).await;
                let mismatch = route_context != Some(24576);
                assert_eq!(warnings.len(), 1 + usize::from(mismatch), "{warnings:?}");
                assert_eq!(
                    warnings
                        .iter()
                        .filter(|message| message.contains("conversations"))
                        .count(),
                    usize::from(mismatch)
                );
                assert_eq!(
                    warnings
                        .iter()
                        .filter(|message| message.contains("cannot assess"))
                        .count(),
                    1
                );
                assert!(
                    warnings
                        .iter()
                        .all(|message| !message.contains("unusable-reply-secret"))
                );
            }
        }
    }
}

#[tokio::test]
async fn small_managed_openclaw_context_warns_before_plan_or_apply_mutation() {
    for source in [CLUSTER_VLLM, CLUSTER_OLLAMA, DOCKER_VLLM, DOCKER_OLLAMA] {
        let document = Document::parse(with_context(source, 8192).to_string().as_bytes()).unwrap();
        for apply in [false, true] {
            let warnings = context_warnings(&document, apply).await;
            assert_eq!(
                warnings.len(),
                2,
                "budget and route mismatch both need warnings"
            );
            assert_eq!(
                warnings
                    .iter()
                    .filter(|message| message.contains("conversations"))
                    .count(),
                1
            );
            let budgets = budget_warnings(&warnings);
            assert_eq!(budgets.len(), 1);
            let warning = budgets[0];
            for detail in ["assistant", "primary", "qwen", "8192", "32768"] {
                assert!(warning.contains(detail), "missing {detail}: {warning}");
            }
        }
    }
}

#[tokio::test]
async fn route_context_warns_even_when_the_managed_service_has_room() {
    for source in [CLUSTER_VLLM, CLUSTER_OLLAMA, DOCKER_VLLM, DOCKER_OLLAMA] {
        let mut input = with_context(source, 32768);
        input["spec"]["sandboxes"][0]["agent"]["inference"]["routes"][0]["overrides"]["settings"]
            ["model_metadata"]["contextWindow"] = json!(8192);
        let document = Document::parse(input.to_string().as_bytes()).unwrap();
        for apply in [false, true] {
            let warnings = context_warnings(&document, apply).await;
            assert_eq!(warnings.len(), 1, "a low route context must warn");
            assert!(warnings[0].contains("contextWindow=8192"));
        }
    }
}

#[tokio::test]
async fn context_advisory_reserves_the_effective_reply_allowance() {
    for source in [CLUSTER_VLLM, CLUSTER_OLLAMA, DOCKER_VLLM, DOCKER_OLLAMA] {
        let mut input = with_context(source, 20000);
        let overrides =
            &mut input["spec"]["sandboxes"][0]["agent"]["inference"]["routes"][0]["overrides"];
        overrides["maxTokens"] = json!(2048);
        overrides["settings"]["model_metadata"]["contextWindow"] = json!(32768);
        let document = Document::parse(input.to_string().as_bytes()).unwrap();
        for apply in [false, true] {
            let warnings = context_warnings(&document, apply).await;
            assert_eq!(warnings.len(), 2);
            let warnings = budget_warnings(&warnings);
            assert_eq!(
                warnings.len(),
                1,
                "the prompt budget alone leaves no reply room"
            );
            for budget in ["2048", "22048"] {
                assert!(warnings[0].contains(budget), "{}", warnings[0]);
            }
        }
    }
}

#[tokio::test]
async fn context_advisory_follows_native_defaults_and_metadata_precedence() {
    for (context, metadata, max_tokens, warns) in [
        (65536, None, Some(16000), true),
        (24095, None, None, true),
        (24096, None, None, false),
        (
            32768,
            Some(json!({"contextWindow": 22047})),
            Some(2048),
            true,
        ),
        (
            32768,
            Some(json!({"contextWindow": 22048})),
            Some(2048),
            false,
        ),
        (21024, Some(json!({"maxTokens": 1024})), Some(8192), false),
        (21023, Some(json!({"maxTokens": 1024})), Some(8192), true),
        (25000, Some(json!({"maxTokens": 8192})), Some(1024), true),
        (28192, Some(json!({"maxTokens": 8192})), Some(1024), false),
        (
            65536,
            Some(json!({"contextWindow": u64::MAX, "maxTokens": u64::MAX})),
            None,
            true,
        ),
    ] {
        let mut input = with_context(CLUSTER_VLLM, context);
        let overrides =
            &mut input["spec"]["sandboxes"][0]["agent"]["inference"]["routes"][0]["overrides"];
        let settings = overrides["settings"].as_object_mut().unwrap();
        if let Some(metadata) = metadata {
            settings.insert("model_metadata".into(), metadata);
        } else {
            settings.remove("model_metadata");
        }
        if let Some(max_tokens) = max_tokens {
            overrides["maxTokens"] = json!(max_tokens);
        } else {
            overrides.as_object_mut().unwrap().remove("maxTokens");
        }
        let document = Document::parse(input.to_string().as_bytes()).unwrap();
        assert_eq!(
            budget_warnings(&context_warnings(&document, false).await).len(),
            usize::from(warns),
            "{input}"
        );
    }
}

#[tokio::test]
async fn context_advisory_reports_unusable_metadata_without_guessing_or_echoing_values() {
    for metadata in [
        Value::Null,
        json!("not-a-number-secret"),
        json!({"contextWindow": null}),
        json!({"contextWindow": "not-a-number-secret"}),
        json!({"contextWindow": 0}),
        json!({"maxTokens": null}),
        json!({"maxTokens": "not-a-number-secret"}),
        json!({"maxTokens": 0}),
    ] {
        let mut input = with_context(CLUSTER_VLLM, 32768);
        input["spec"]["sandboxes"][0]["agent"]["inference"]["routes"][0]["overrides"]["settings"]
            ["model_metadata"] = metadata;
        let document = Document::parse(input.to_string().as_bytes()).unwrap();
        for apply in [false, true] {
            let warnings = context_warnings(&document, apply).await;
            assert_eq!(
                warnings.len(),
                1,
                "unusable metadata must not silently use defaults: {input}"
            );
            assert!(warnings[0].contains("cannot assess"), "{}", warnings[0]);
            assert!(!warnings[0].contains("not-a-number-secret"));
        }
    }
}

#[tokio::test]
async fn context_advisory_uses_the_selected_harness_and_service_budget() {
    for (context, count) in [
        (19_999, 1),
        (20_000, 1),
        (22_047, 1),
        (22_048, 0),
        (32_768, 0),
    ] {
        let document =
            Document::parse(with_context(CLUSTER_VLLM, context).to_string().as_bytes()).unwrap();
        assert_eq!(
            budget_warnings(&context_warnings(&document, false).await).len(),
            count
        );
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
    let warnings = context_warnings(&document, false).await;
    assert_eq!(warnings.len(), 2);
    assert_eq!(budget_warnings(&warnings).len(), 1);
}
