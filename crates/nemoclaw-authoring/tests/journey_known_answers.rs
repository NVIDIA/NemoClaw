// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Questions whose answer the journey already knows are not asked: the preset
//! decides a vendor's API, the only engine that answered becomes the gateway's,
//! and the agent suggests the deployment's name.

use nemoclaw_authoring::{Capabilities, JourneyDefinition, JourneyScope, PartialDocument};
use nemoclaw_sdk::config::ComputeDriver;
use serde_json::{Value, json};

const API: &str = "/spec/inferenceProviders/nvidia-prod/api";
const ENGINE: &str = "/spec/gateway/engine";
const RUNTIME: &str = "/spec/gateway/runtime/provider";
const HARNESS: &str = "/spec/sandboxes/assistant/harness/kind";
const TIER: &str = "/spec/sandboxes/assistant/network/tier";
const ROUTE: &str = "/spec/sandboxes/assistant/agent/inference/routes/0";

fn example() -> Value {
    serde_saphyr::from_slice(include_bytes!("../../../examples/onboarding/openclaw.yaml")).unwrap()
}

fn base(values: &Value) -> PartialDocument {
    PartialDocument::from_yaml(values.to_string().as_bytes()).unwrap()
}

fn preset_journey(definition: JourneyDefinition) -> nemoclaw_authoring::JourneyState {
    definition
        .ask([HARNESS, "inference:preset"])
        .ask([JourneyScope::InferenceApi, JourneyScope::RouteModels])
        .start(&Capabilities::available())
        .unwrap()
}

#[test]
fn a_vendor_preset_decides_the_api_and_a_compatible_endpoint_still_asks() {
    let capabilities = Capabilities::available();
    for preset in nemoclaw_authoring::ProviderPreset::ALL {
        let mut state = preset_journey(JourneyDefinition::new("api", base(&example())));
        state
            .answer(&capabilities, "inference:preset", Some(json!(preset.id())))
            .unwrap();
        let asked = state
            .resolve(&capabilities)
            .unwrap()
            .question(API)
            .is_some();
        let compatible = matches!(
            preset,
            nemoclaw_authoring::ProviderPreset::OpenAiCompatible
                | nemoclaw_authoring::ProviderPreset::AnthropicCompatible
        );
        assert_eq!(asked, compatible, "{}", preset.id());
    }
}

#[test]
fn a_vendor_preset_keeps_the_api_its_template_supplied_without_asking() {
    let capabilities = Capabilities::available();
    let mut values = example();
    values["spec"]["inferenceProviders"]["nvidia-prod"]["api"] = json!("openai-responses");
    let state = preset_journey(JourneyDefinition::new("api", base(&values)));
    let mut state = state;
    state
        .answer(
            &capabilities,
            "inference:preset",
            Some(json!("nvidia-endpoints")),
        )
        .unwrap();
    let resolution = state.resolve(&capabilities).unwrap();
    assert!(resolution.question(API).is_none());
    assert_eq!(
        state.values().pointer(API),
        Some(&json!("openai-responses"))
    );
}

#[test]
fn exact_guidance_still_asks_a_vendor_presets_api() {
    let capabilities = Capabilities::available();
    let mut state = preset_journey(JourneyDefinition::new("api", base(&example())).ask([API]));
    state
        .answer(
            &capabilities,
            "inference:preset",
            Some(json!("nvidia-endpoints")),
        )
        .unwrap();
    assert!(
        state
            .resolve(&capabilities)
            .unwrap()
            .question(API)
            .is_some()
    );
}

#[test]
fn an_edited_vendor_endpoint_asks_the_api_again() {
    let capabilities = Capabilities::available();
    let mut values = example();
    values["spec"]["inferenceProviders"]["nvidia-prod"]["endpoint"] =
        json!("https://proxy.example.com/v1");
    let state = JourneyDefinition::new("api", base(&values))
        .ask([JourneyScope::InferenceApi])
        .start(&capabilities)
        .unwrap();
    assert!(
        state
            .resolve(&capabilities)
            .unwrap()
            .question(API)
            .is_some()
    );
}

/// A journey that reviews deployment fields after choosing the runtime, on a
/// machine where `engines` answered.
fn engine_journey(
    values: &Value,
    engines: &[(&str, ComputeDriver)],
) -> (
    nemoclaw_authoring::JourneyState,
    nemoclaw_sdk::discovery::DiscoveryObservations,
) {
    let capabilities = Capabilities::available();
    let mut state = JourneyDefinition::new("engine", base(values))
        .ask([RUNTIME])
        .ask([JourneyScope::DeploymentFields])
        .start(&capabilities)
        .unwrap();
    let observations = crate::support::found_local_engines(&mut state, engines);
    state
        .answer(&capabilities, RUNTIME, Some(json!("docker")))
        .unwrap();
    (state, observations)
}

#[test]
fn the_only_engine_that_answered_for_the_runtime_is_not_asked() {
    let capabilities = Capabilities::available();
    let docker = "unix:///home/me/.colima/docker.sock";
    let (state, observations) = engine_journey(&example(), &[(docker, ComputeDriver::Docker)]);
    let resolution = state
        .resolve_with_observations(&capabilities, &observations)
        .unwrap();
    assert!(resolution.question(ENGINE).is_none());
    assert!(
        state
            .resolve(&capabilities)
            .unwrap()
            .question(ENGINE)
            .is_none()
    );
    assert_eq!(state.values().pointer(ENGINE), Some(&json!(docker)));
}

#[test]
fn the_engine_is_asked_when_several_or_none_answered_or_the_template_differs() {
    let capabilities = Capabilities::available();
    let several = [
        ("unix:///var/run/docker.sock", ComputeDriver::Docker),
        (
            "unix:///home/me/.docker/run/docker.sock",
            ComputeDriver::Docker,
        ),
    ];
    let mut other = example();
    other["spec"]["gateway"]["engine"] = json!("unix:///srv/owned/docker.sock");
    for (name, values, engines) in [
        ("several", example(), several.as_slice()),
        ("none", example(), &[][..]),
        ("template differs", other, &several[..1]),
    ] {
        let (state, observations) = engine_journey(&values, engines);
        assert!(
            state
                .resolve_with_observations(&capabilities, &observations)
                .unwrap()
                .question(ENGINE)
                .is_some(),
            "{name}"
        );
    }
}

#[test]
fn a_missing_name_is_suggested_from_the_chosen_agent() {
    let capabilities = Capabilities::available();
    let mut values = example();
    values["metadata"].as_object_mut().unwrap().remove("name");
    let mut state = JourneyDefinition::new("name", base(&values))
        .ask([HARNESS, "/metadata/name"])
        .start(&capabilities)
        .unwrap();
    let first = state.resolve(&capabilities).unwrap();
    assert_eq!(first.next_question().unwrap().id(), HARNESS);
    state
        .answer(&capabilities, HARNESS, Some(json!("nvidia.fabric.hermes")))
        .unwrap();
    let question = state
        .resolve(&capabilities)
        .unwrap()
        .question("/metadata/name")
        .cloned()
        .unwrap();
    assert_eq!(question.suggestion(), Some(&json!("hermes")));

    // A supplied name stays the suggestion whatever the agent.
    let mut state = JourneyDefinition::new("name", base(&example()))
        .ask([HARNESS, "/metadata/name"])
        .start(&capabilities)
        .unwrap();
    state
        .answer(&capabilities, HARNESS, Some(json!("nvidia.fabric.hermes")))
        .unwrap();
    assert_eq!(
        state
            .resolve(&capabilities)
            .unwrap()
            .question("/metadata/name")
            .unwrap()
            .suggestion(),
        Some(&json!("openclaw-nvidia-hosted"))
    );
}

#[test]
fn omitting_a_native_model_setting_leaves_no_empty_settings() {
    let capabilities = Capabilities::available();
    let setting = "model:/supports_usage_in_streaming";
    let mut state = JourneyDefinition::new("native", base(&example()))
        .ask([setting])
        .start(&capabilities)
        .unwrap();
    state.answer(&capabilities, setting, None).unwrap();
    let overrides = state
        .values()
        .pointer(&format!("{ROUTE}/overrides"))
        .unwrap();
    assert!(overrides.get("settings").is_none(), "{overrides}");

    // Revisiting an answer to omit it removes the emptied settings too.
    state
        .answer(&capabilities, setting, Some(json!(true)))
        .unwrap();
    state.answer(&capabilities, setting, None).unwrap();
    let overrides = state
        .values()
        .pointer(&format!("{ROUTE}/overrides"))
        .unwrap();
    assert!(overrides.get("settings").is_none(), "{overrides}");
}

#[test]
fn an_optional_choice_whose_default_is_offered_cannot_also_be_omitted() {
    let capabilities = Capabilities::available();
    let mut state = JourneyDefinition::new("omit", base(&example()))
        .ask([RUNTIME])
        .start(&capabilities)
        .unwrap();
    let runtime = state
        .resolve(&capabilities)
        .unwrap()
        .question(RUNTIME)
        .cloned()
        .unwrap();
    assert!(!runtime.required());
    assert!(!runtime.omittable());
    assert!(state.answer(&capabilities, RUNTIME, None).is_err());

    let native = JourneyDefinition::new("omit", base(&example()))
        .ask(["model:/supports_usage_in_streaming"])
        .start(&capabilities)
        .unwrap();
    assert!(
        native
            .resolve(&capabilities)
            .unwrap()
            .question("model:/supports_usage_in_streaming")
            .unwrap()
            .omittable()
    );
}

#[test]
fn an_omitted_field_reports_the_value_the_sdk_fills_in() {
    let capabilities = Capabilities::available();
    let state = JourneyDefinition::new("defaults", base(&example()))
        .ask([JourneyScope::DeploymentFields])
        .omit([TIER])
        .start(&capabilities)
        .unwrap();
    let resolution = state.resolve(&capabilities).unwrap();
    assert!(resolution.question(TIER).is_none());
    assert!(state.values().pointer(TIER).is_none());
    assert!(
        resolution
            .defaults()
            .contains(&(TIER.to_owned(), json!("isolated"))),
        "{:?}",
        resolution.defaults()
    );
}
