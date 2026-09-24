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
        .find(|r| r.kind == "sandbox")
        .unwrap()
        .values;
    let settings: serde_json::Value = serde_json::from_str(&sandbox["inference_json"]).unwrap();
    assert_eq!(settings["connection"]["model"], "qwen3.5:0.8b");
    assert_eq!(
        settings["connection"]["base_url"],
        "http://172.20.0.1:11436/v1"
    );
    assert_eq!(
        settings["connection"]["api_key_env"],
        "NEMOCLAW_ANONYMOUS_API_KEY"
    );
    assert_eq!(settings["provider"], "local");
}

#[test]
fn provider_api_override_preserves_native_harness_selection() {
    use nemoclaw_sdk::config::{HarnessKind, InferenceApi};
    for harness in [
        HarnessKind::DeepAgents,
        HarnessKind::Hermes,
        HarnessKind::OpenClaw,
        HarnessKind::Claude,
        HarnessKind::Codex,
        HarnessKind::MiniSweAgent,
        HarnessKind::Nooa,
        HarnessKind::NooaBench,
        HarnessKind::RemoteAgent,
        HarnessKind::Pi,
    ] {
        let mut document =
            Document::parse(include_str!("fixtures/config/local.yaml").as_bytes()).unwrap();
        document.spec.sandboxes[0].harness.as_mut().unwrap().kind = harness.clone();
        let api = InferenceApi::for_harness(harness.clone());
        let provider = &mut document.spec.inference_providers[0];
        provider.api = api.provider_override(harness.clone());
        provider.provider = if api == InferenceApi::AnthropicMessages {
            nemoclaw_sdk::config::InferenceProviderKind::Anthropic
        } else {
            nemoclaw_sdk::config::InferenceProviderKind::Openai
        };
        document.validate().unwrap();
        let generations: Generations = ["workspace", "provider", "sandbox"]
            .map(|key| (key.into(), "a".repeat(32)))
            .into();
        let resources = targets(&document, &generations).unwrap();
        assert!(resources.iter().any(|resource| resource.kind == "sandbox"));
        if harness == HarnessKind::Pi {
            assert_eq!(provider_api(&document), None);
            document.spec.inference_providers[0].api = Some(api);
            assert!(document.validate().is_err());
        } else {
            assert_eq!(provider_api(&document), Some(api));
        }
    }
}

fn provider_api(document: &Document) -> Option<nemoclaw_sdk::config::InferenceApi> {
    document.spec.inference_providers[0].api
}

#[test]
fn explicit_protocol_is_preserved_for_selected_image_validation() {
    use nemoclaw_sdk::config::{HarnessKind, InferenceApi, InferenceProviderKind};
    let mut document =
        Document::parse(include_str!("fixtures/config/local.yaml").as_bytes()).unwrap();
    document.spec.sandboxes[0].harness.as_mut().unwrap().kind = HarnessKind::Codex;
    document.spec.inference_providers[0].api = Some(InferenceApi::AnthropicMessages);
    document.spec.inference_providers[0].provider = InferenceProviderKind::Anthropic;
    document.validate().unwrap();
    let generations: Generations = ["workspace", "provider", "sandbox"]
        .map(|key| (key.into(), "a".repeat(32)))
        .into();
    let resources = targets(&document, &generations).unwrap();
    let sandbox = resources
        .iter()
        .find(|resource| resource.kind == "sandbox")
        .unwrap();
    let settings: serde_json::Value =
        serde_json::from_str(&sandbox.values["inference_json"]).unwrap();
    assert_eq!(settings["api"], "anthropic-messages");
}
