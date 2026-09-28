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
    assert!(
        resources
            .iter()
            .any(|r| r.address == "nemoclaw_provider_profile.inference_local")
    );
    let sandbox = &resources
        .iter()
        .find(|r| r.kind == "agent_configuration")
        .unwrap()
        .values;
    let settings: serde_json::Value = serde_json::from_str(&sandbox["config_json"]).unwrap();
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
fn explicit_protocol_is_preserved_for_selected_image_validation() {
    use nemoclaw_sdk::config::{InferenceApi, InferenceProviderKind};
    let mut document =
        Document::parse(include_str!("fixtures/config/local.yaml").as_bytes()).unwrap();
    document.spec.sandboxes[0].harness.as_mut().unwrap().kind =
        "nvidia.fabric.codex".parse().unwrap();
    document.spec.inference_providers[0].api = Some(InferenceApi::AnthropicMessages);
    document.spec.inference_providers[0].provider = InferenceProviderKind::Anthropic;
    document.validate().unwrap();
    let generations: Generations = ["workspace", "provider", "sandbox"]
        .map(|key| (key.into(), "a".repeat(32)))
        .into();
    let resources = targets(&document, &generations).unwrap();
    let sandbox = resources
        .iter()
        .find(|resource| resource.kind == "agent_configuration")
        .unwrap();
    let settings: serde_json::Value = serde_json::from_str(&sandbox.values["config_json"]).unwrap();
    assert_eq!(settings["models"]["default"]["api"], "anthropic-messages");
}
