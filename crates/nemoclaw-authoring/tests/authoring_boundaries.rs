// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_authoring::{AnswerOverrides, Answers, Capabilities, Draft, ProviderPreset, Session};
use nemoclaw_sdk::config::{
    ComputeDriver, Document, HarnessKind, InferenceApi, InferenceProviderKind, NetworkPolicy,
};

const UID: &str = "12345678-1234-4234-9234-123456789abc";
const NVIDIA_MODEL: &str = "nvidia/nemotron-3-super-120b-a12b";

fn begin_onboarding(capabilities: &Capabilities) -> Draft {
    let suggested = Session::with_uid(UID)
        .unwrap()
        .project(capabilities, &Answers::onboarding_defaults())
        .unwrap();
    Draft::from_document(suggested.document().clone()).unwrap()
}

#[test]
fn accepting_the_openclaw_suggestion_builds_its_hosted_inference_boundary() {
    let capabilities = Capabilities::available();
    let draft = begin_onboarding(&capabilities);
    let document = draft.review().unwrap().into_authored();
    let sandbox = &document.document().spec.sandboxes[0];
    let provider = document.document().inference_provider().unwrap();
    let route = &document
        .document()
        .sandbox_inference(sandbox)
        .unwrap()
        .routes[0];
    assert_eq!(provider.provider, InferenceProviderKind::Openai);
    assert_eq!(provider.api, Some(InferenceApi::OpenaiCompletions));
    assert_eq!(provider.endpoint, "https://integrate.api.nvidia.com/v1");
    assert_eq!(route.overrides.model, NVIDIA_MODEL);
    assert!(matches!(sandbox.network.policy, NetworkPolicy::Isolated));
}

#[test]
fn choosing_hermes_keeps_the_safe_isolated_network_default() {
    let capabilities = Capabilities::available();
    let answers = Answers {
        harness: "nvidia.fabric.hermes".parse::<HarnessKind>().unwrap(),
        ..Answers::onboarding_defaults()
    };
    let authored = Session::with_uid(UID)
        .unwrap()
        .project(&capabilities, &answers)
        .unwrap();
    let sandbox = &authored.document().spec.sandboxes[0];
    assert!(matches!(sandbox.network.policy, NetworkPolicy::Isolated));
}

#[test]
fn every_choice_the_guide_advertises_leads_to_a_document_that_can_be_reopened() {
    let capabilities = Capabilities::available();

    for harness in capabilities.harnesses() {
        let suggested = Answers {
            harness: harness.clone(),
            ..Answers::onboarding_defaults()
        };
        let authored = Session::with_uid(UID)
            .unwrap()
            .project(&capabilities, &suggested)
            .unwrap();
        let reopened = Draft::from_yaml(authored.yaml().as_bytes()).unwrap();
        assert_eq!(reopened.review().unwrap().document(), authored.document());
    }
}

#[test]
fn a_custom_v1_document_remains_owned_even_when_it_is_not_a_guided_preset() {
    let capabilities = Capabilities::available();
    let bytes = include_bytes!("../../../examples/multiple-sandboxes.yaml");
    let expected = Document::parse(bytes.as_slice()).unwrap();

    let draft = Draft::from_yaml(bytes.as_slice()).unwrap();

    assert_eq!(draft.document(), &expected);
    assert_eq!(draft.review().unwrap().document(), &expected);
    assert!(draft.guided_answers(&capabilities).is_err());
}

#[test]
fn an_imported_provider_endpoint_remains_owned_through_guided_rewrites() {
    let capabilities = Capabilities::available();
    let original = begin_onboarding(&capabilities);
    let mut customized = original.document().clone();
    customized.spec.inference_providers[0].endpoint = "https://example.com/v1".into();
    let draft = Draft::from_document(customized.clone()).unwrap();

    let answers = draft.guided_answers(&capabilities).unwrap();
    assert_eq!(answers.endpoint, "https://example.com/v1");
    assert_eq!(draft.document(), &customized);
    assert_eq!(
        Session::with_uid(&customized.metadata.uid)
            .unwrap()
            .project(&capabilities, &answers)
            .unwrap()
            .document(),
        &customized
    );
}

#[test]
fn automation_can_override_every_suggestion_before_authoring_begins() {
    let capabilities = Capabilities::available();
    let answers = Answers::onboarding_defaults().with_overrides(AnswerOverrides {
        deployment_name: Some("automated-deployment".into()),
        sandbox_name: Some("automated-sandbox".into()),
        agent_name: Some("automated-agent".into()),
        harness: Some("nvidia.fabric.openclaw".parse::<HarnessKind>().unwrap()),
        runtime: Some(ComputeDriver::Docker),
        inference: Some(ProviderPreset::NvidiaEndpoints),
        api: Some(InferenceApi::OpenaiResponses),
        provider_name: Some("automated-provider".into()),
        endpoint: None,
        model: Some(NVIDIA_MODEL.into()),
        credential_env: Some("AUTOMATED_API_KEY".into()),
    });

    let authored = Session::new()
        .unwrap()
        .project(&capabilities, &answers)
        .unwrap();
    let document = authored.document();
    let sandbox = &document.spec.sandboxes[0];

    assert_eq!(document.metadata.name, "automated-deployment");
    assert_eq!(sandbox.name, "automated-sandbox");
    assert_eq!(sandbox.agent.name, "automated-agent");
    assert_eq!(
        document.inference_provider().unwrap().name,
        "automated-provider"
    );
    assert_eq!(
        document.inference_provider().unwrap().api,
        Some(InferenceApi::OpenaiResponses)
    );
    assert_eq!(document.credential_names(), ["AUTOMATED_API_KEY"]);
}

#[test]
fn direct_authoring_preserves_unobserved_harness_intent_but_checks_endpoint_protocol() {
    let capabilities = Capabilities::available();
    let session = Session::with_uid(UID).unwrap();

    let unsupported_harness = Answers {
        harness: "nvidia.fabric.claude".parse::<HarnessKind>().unwrap(),
        ..Answers::onboarding_defaults()
    };
    let offline = Capabilities::from_harnesses([]);
    let authored = session.project(&offline, &unsupported_harness).unwrap();
    let draft = Draft::from_yaml(authored.yaml().as_bytes()).unwrap();
    assert_eq!(draft.guided_answers(&offline).unwrap(), unsupported_harness);
    assert!(!offline.offers(
        &unsupported_harness,
        nemoclaw_authoring::EditableField::Harness,
        &nemoclaw_authoring::FieldValue::Harness(unsupported_harness.harness.clone())
    ));

    let unsupported_api = Answers {
        api: InferenceApi::AnthropicMessages,
        ..Answers::onboarding_defaults()
    };
    assert_eq!(
        session
            .project(&capabilities, &unsupported_api)
            .unwrap_err()
            .items()[0]
            .field(),
        "api"
    );
}

#[test]
fn arbitrary_provider_identity_is_preserved_without_matching_a_branded_preset() {
    let capabilities = Capabilities::available();
    let authored = Session::with_uid(UID)
        .unwrap()
        .project(&capabilities, &Answers::onboarding_defaults())
        .unwrap();
    let mut document = authored.document().clone();
    let provider = &mut document.spec.inference_providers[0];
    provider.name = "my-private-service".into();
    provider.endpoint = "https://models.private.example/v1".into();
    provider.credential.as_mut().unwrap().env = "PRIVATE_MODEL_TOKEN".into();
    document.spec.sandboxes[0]
        .agent
        .inference
        .as_mut()
        .unwrap()
        .routes[0]
        .provider_ref = Some("my-private-service".into());
    let draft = Draft::from_document(document.clone()).unwrap();
    let retained = capabilities.preserving_draft(&draft).unwrap();
    let answers = draft.guided_answers(&retained).unwrap();
    let projected = Session::with_uid(UID)
        .unwrap()
        .project(&retained, &answers)
        .unwrap();
    assert_eq!(projected.document(), &document);
    let mut edited = draft;
    edited
        .set_guided_field(
            &retained,
            nemoclaw_authoring::EditableField::Model,
            nemoclaw_authoring::FieldValue::Model("custom/new-model".into()),
        )
        .unwrap();
    let provider = &edited.document().spec.inference_providers[0];
    assert_eq!(provider.name, "my-private-service");
    assert_eq!(provider.endpoint, "https://models.private.example/v1");
    assert_eq!(
        provider.credential.as_ref().unwrap().env,
        "PRIVATE_MODEL_TOKEN"
    );
}
