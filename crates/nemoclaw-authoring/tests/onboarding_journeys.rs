// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_authoring::{
    Answers, Capabilities, Draft, EditableField, FieldValue, ProviderPreset, Session,
};
use nemoclaw_sdk::config::{ComputeDriver, HarnessKind, InferenceApi, InferenceProviderKind};

const UID: &str = "12345678-1234-4234-9234-123456789abc";

fn begin(capabilities: &Capabilities) -> Draft {
    let authored = Session::with_uid(UID)
        .unwrap()
        .project(capabilities, &Answers::onboarding_defaults())
        .unwrap();
    Draft::from_document(authored.document().clone()).unwrap()
}

fn choices(draft: &Draft, capabilities: &Capabilities, wanted: EditableField) -> Vec<FieldValue> {
    draft
        .guided_fields(capabilities)
        .unwrap()
        .into_iter()
        .find(|field| field.id() == wanted)
        .unwrap()
        .choices()
        .to_vec()
}

fn choose(draft: &mut Draft, capabilities: &Capabilities, field: EditableField, value: FieldValue) {
    draft.set_guided_field(capabilities, field, value).unwrap();
}

#[test]
fn an_author_can_start_with_every_supported_agent_experience() {
    let capabilities = Capabilities::available();
    let draft = begin(&capabilities);

    assert_eq!(
        choices(&draft, &capabilities, EditableField::Harness),
        capabilities
            .scenarios()
            .iter()
            .map(|scenario| FieldValue::Harness(scenario.harness()))
            .fold(Vec::new(), |mut choices, value| {
                if !choices.contains(&value) {
                    choices.push(value);
                }
                choices
            })
    );
}

#[test]
fn an_openclaw_author_can_choose_the_complete_remote_provider_menu() {
    let capabilities = Capabilities::available();
    let draft = begin(&capabilities);

    assert_eq!(
        choices(&draft, &capabilities, EditableField::Inference),
        [
            FieldValue::Inference(ProviderPreset::NvidiaEndpoints),
            FieldValue::Inference(ProviderPreset::OpenRouter),
            FieldValue::Inference(ProviderPreset::OpenAi),
            FieldValue::Inference(ProviderPreset::OpenAiCompatible),
            FieldValue::Inference(ProviderPreset::Anthropic),
            FieldValue::Inference(ProviderPreset::AnthropicCompatible),
            FieldValue::Inference(ProviderPreset::Gemini),
            FieldValue::Inference(ProviderPreset::Nous),
        ]
    );
}

#[test]
fn choosing_openai_derives_its_connection_without_claiming_a_vendor_catalog() {
    let capabilities = Capabilities::available();
    let mut draft = begin(&capabilities);

    choose(
        &mut draft,
        &capabilities,
        EditableField::Inference,
        FieldValue::Inference(ProviderPreset::OpenAi),
    );

    assert_eq!(
        choices(&draft, &capabilities, EditableField::Model),
        [FieldValue::Model("gpt-5.4".into())]
    );
    choose(
        &mut draft,
        &capabilities,
        EditableField::Model,
        FieldValue::Model("organization/new-model".into()),
    );
    let document = draft.document();
    let provider = document.inference_provider().unwrap();
    assert_eq!(provider.name, "openai-api");
    assert_eq!(provider.endpoint, "https://api.openai.com/v1");
    assert_eq!(provider.provider, InferenceProviderKind::Openai);
    assert_eq!(document.credential_names(), ["OPENAI_API_KEY"]);
}

#[test]
fn choosing_anthropic_switches_the_protocol_and_model_family() {
    let capabilities = Capabilities::available();
    let mut draft = begin(&capabilities);

    choose(
        &mut draft,
        &capabilities,
        EditableField::Inference,
        FieldValue::Inference(ProviderPreset::Anthropic),
    );

    assert_eq!(
        choices(&draft, &capabilities, EditableField::Api),
        [FieldValue::Api(InferenceApi::AnthropicMessages)]
    );
    assert_eq!(
        choices(&draft, &capabilities, EditableField::Model),
        [FieldValue::Model("claude-sonnet-4-6".into())]
    );
    let provider = draft.document().inference_provider().unwrap();
    assert_eq!(provider.provider, InferenceProviderKind::Anthropic);
    assert_eq!(provider.api, Some(InferenceApi::AnthropicMessages));
    assert_eq!(draft.document().credential_names(), ["ANTHROPIC_API_KEY"]);
}

#[test]
fn choosing_gemini_uses_googles_openai_compatible_surface() {
    let capabilities = Capabilities::available();
    let mut draft = begin(&capabilities);

    choose(
        &mut draft,
        &capabilities,
        EditableField::Inference,
        FieldValue::Inference(ProviderPreset::Gemini),
    );

    let provider = draft.document().inference_provider().unwrap();
    assert_eq!(provider.provider, InferenceProviderKind::Openai);
    assert_eq!(
        provider.endpoint,
        "https://generativelanguage.googleapis.com/v1beta/openai/"
    );
    assert_eq!(draft.document().credential_names(), ["GEMINI_API_KEY"]);
    assert!(
        choices(&draft, &capabilities, EditableField::Model)
            .contains(&FieldValue::Model("gemini-3.6-flash".into()))
    );
}

#[test]
fn a_custom_endpoint_author_enters_the_endpoint_and_model_but_not_internal_names() {
    let capabilities = Capabilities::available();
    let mut draft = begin(&capabilities);

    choose(
        &mut draft,
        &capabilities,
        EditableField::Inference,
        FieldValue::Inference(ProviderPreset::OpenAiCompatible),
    );
    choose(
        &mut draft,
        &capabilities,
        EditableField::Endpoint,
        FieldValue::Text("https://inference.example.com/v1".into()),
    );
    choose(
        &mut draft,
        &capabilities,
        EditableField::Model,
        FieldValue::Model("example/reasoning-model".into()),
    );

    let fields = draft.guided_fields(&capabilities).unwrap();
    assert!(
        fields
            .iter()
            .any(|field| field.id() == EditableField::Endpoint)
    );
    assert!(
        !fields
            .iter()
            .any(|field| field.id() == EditableField::ProviderName)
    );
    assert!(
        !fields
            .iter()
            .any(|field| field.id() == EditableField::CredentialEnv)
    );
    let provider = draft.document().inference_provider().unwrap();
    assert_eq!(provider.endpoint, "https://inference.example.com/v1");
    assert_eq!(draft.document().credential_names(), ["COMPATIBLE_API_KEY"]);
}

#[test]
fn hermes_can_use_the_shared_nous_provider() {
    let capabilities = Capabilities::available();
    let mut draft = begin(&capabilities);

    choose(
        &mut draft,
        &capabilities,
        EditableField::Harness,
        FieldValue::Harness(HarnessKind::Hermes),
    );

    let providers = choices(&draft, &capabilities, EditableField::Inference);
    assert!(providers.contains(&FieldValue::Inference(ProviderPreset::Nous)));
    choose(
        &mut draft,
        &capabilities,
        EditableField::Inference,
        FieldValue::Inference(ProviderPreset::Nous),
    );
    let provider = draft.document().inference_provider().unwrap();
    assert_eq!(
        provider.endpoint,
        "https://inference-api.nousresearch.com/v1"
    );
    assert_eq!(draft.document().credential_names(), ["OPENAI_API_KEY"]);
    assert!(
        choices(&draft, &capabilities, EditableField::Model)
            .contains(&FieldValue::Model("moonshotai/kimi-k2.6".into()))
    );
}

#[test]
fn deep_agents_and_pi_receive_only_protocols_their_native_clients_support() {
    let capabilities = Capabilities::available();
    let mut draft = begin(&capabilities);

    for harness in [HarnessKind::DeepAgents, HarnessKind::Pi] {
        choose(
            &mut draft,
            &capabilities,
            EditableField::Harness,
            FieldValue::Harness(harness),
        );
        assert_eq!(
            choices(&draft, &capabilities, EditableField::Api),
            [FieldValue::Api(InferenceApi::OpenaiCompletions)]
        );
        assert!(
            !choices(&draft, &capabilities, EditableField::Inference)
                .contains(&FieldValue::Inference(ProviderPreset::Anthropic))
        );
        assert_eq!(
            draft.document().spec.sandboxes[0]
                .harness
                .as_ref()
                .unwrap()
                .kind,
            harness
        );
    }
}

#[test]
fn an_author_can_choose_a_rootless_podman_sandbox_without_reanswering_inference() {
    let capabilities = Capabilities::available();
    let mut draft = begin(&capabilities);
    let model_before = draft.guided_answers(&capabilities).unwrap().model;

    choose(
        &mut draft,
        &capabilities,
        EditableField::Runtime,
        FieldValue::Runtime(ComputeDriver::Podman),
    );

    let answers = draft.guided_answers(&capabilities).unwrap();
    assert_eq!(answers.model, model_before);
    assert_eq!(
        draft.document().spec.sandboxes[0].runtime.provider,
        ComputeDriver::Podman
    );
    assert_eq!(
        draft.document().spec.gateway.as_managed().unwrap().engine,
        "unix:///run/user/1000/podman/podman.sock"
    );
}

#[test]
fn every_advertised_scenario_authors_valid_yaml_and_can_resume_the_same_journey() {
    let capabilities = Capabilities::available();

    for scenario in capabilities.scenarios() {
        let answers = Answers::onboarding_defaults().for_scenario(scenario);
        let authored = Session::with_uid(UID)
            .unwrap()
            .project(&capabilities, &answers)
            .unwrap();
        let reopened = Draft::from_yaml(authored.yaml().as_bytes()).unwrap();

        assert_eq!(reopened.document(), authored.document());
        assert_eq!(reopened.guided_answers(&capabilities).unwrap(), answers);
    }
}
