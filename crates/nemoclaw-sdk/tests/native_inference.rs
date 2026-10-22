// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use nemoclaw_sdk::{
    compile::{Generations, targets},
    config::Document,
};

#[test]
fn native_inference_attaches_provider_without_a_managed_route() {
    let document = Document::parse(include_str!("fixtures/config/local.yaml").as_bytes()).unwrap();
    let generations: Generations = ["workspace", "provider", "sandbox"]
        .map(|k| (k.into(), "a".repeat(32)))
        .into();
    let resources = targets(&document, &generations).unwrap();
    assert!(resources.iter().all(|r| r.kind != "route"));
    assert!(resources.iter().any(|r| {
        r.address
            .starts_with("openshell_inference.inference_local-")
    }));
    let sandbox = &resources.iter().find(|r| r.kind == "agent").unwrap().values;
    let settings: serde_json::Value = nemoclaw_fabric::agent::compose(sandbox).unwrap();
    assert_eq!(settings["models"]["default"]["model"], "qwen3.5:0.8b");
    assert_eq!(
        settings["models"]["default"]["base_url"],
        "http://172.20.0.1:11436/v1"
    );
    assert_eq!(
        settings["models"]["default"]["api_key_env"],
        "NEMOCLAW_ANONYMOUS_API_KEY"
    );
    assert_eq!(settings["models"]["default"]["provider"], "openai");
}

#[test]
fn anthropic_providers_register_messages_without_a_per_model_api() {
    use nemoclaw_sdk::config::{InferenceApi, InferenceProviderKind};
    let mut document =
        Document::parse(include_str!("fixtures/config/local.yaml").as_bytes()).unwrap();
    document.spec.sandboxes[0].harness.as_mut().unwrap().kind =
        "nvidia.fabric.codex".parse().unwrap();
    let provider = document.spec.inference_providers.get_mut("local").unwrap();
    provider.api = Some(InferenceApi::AnthropicMessages);
    provider.provider = InferenceProviderKind::Anthropic;
    document.validate().unwrap();
    let generations: Generations = ["workspace", "provider", "sandbox"]
        .map(|key| (key.into(), "a".repeat(32)))
        .into();
    let resources = targets(&document, &generations).unwrap();
    let sandbox = resources
        .iter()
        .find(|resource| resource.kind == "agent")
        .unwrap();
    let settings: serde_json::Value = nemoclaw_fabric::agent::compose(&sandbox.values).unwrap();
    // Fabric v0.5.0 has no per-model API field (#13320); OpenShell routes the
    // provider's protocol.
    assert!(settings["models"]["default"].get("api").is_none());
    let registration = resources
        .iter()
        .find(|resource| resource.kind == "inference")
        .unwrap();
    assert_eq!(registration.values["api"], "anthropic-messages");
}
