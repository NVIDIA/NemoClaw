// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_authoring::{
    Answers, ApiChoice, Capabilities, CompletionBoundary, Draft, EditableField, FieldValue,
    IdentityEdits, ProviderPreset, Session,
};
use nemoclaw_sdk::config::{ComputeDriver, HarnessKind, InferenceApi};

const UID: &str = "12345678-1234-4234-9234-123456789abc";
const NVIDIA_MODEL: &str = "nvidia/nemotron-3-super-120b-a12b";

fn begin_onboarding(capabilities: &Capabilities) -> Draft {
    let suggested = Session::with_uid(UID)
        .unwrap()
        .project(capabilities, &Answers::onboarding_defaults())
        .unwrap();
    Draft::from_document(suggested.document().clone()).unwrap()
}

fn choices_for(
    draft: &Draft,
    capabilities: &Capabilities,
    wanted: EditableField,
) -> Vec<FieldValue> {
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
fn a_new_author_can_accept_the_openclaw_defaults_and_review_safe_desired_state() {
    let capabilities = Capabilities::available();
    let draft = begin_onboarding(&capabilities);

    assert_eq!(
        choices_for(&draft, &capabilities, EditableField::Harness),
        capabilities
            .harnesses()
            .iter()
            .cloned()
            .map(FieldValue::Harness)
            .collect::<Vec<_>>()
    );
    assert_eq!(
        choices_for(&draft, &capabilities, EditableField::Api),
        [
            FieldValue::Api(InferenceApi::OpenaiCompletions),
            FieldValue::Api(InferenceApi::OpenaiResponses),
        ]
    );
    assert_eq!(
        choices_for(&draft, &capabilities, EditableField::Model),
        [FieldValue::Model(NVIDIA_MODEL.into())]
    );

    let review = draft.review().unwrap();
    let document = review.document();
    let sandbox = &document.spec.sandboxes[0];

    assert_eq!(
        document.sandbox_harness(sandbox).unwrap().kind,
        "nvidia.fabric.openclaw".parse::<HarnessKind>().unwrap()
    );
    assert_eq!(sandbox.runtime.provider, ComputeDriver::Docker);
    assert_eq!(review.credential_references(), ["NVIDIA_INFERENCE_API_KEY"]);
    assert!(!review.yaml().contains("nvapi-"));
    assert_eq!(
        draft
            .review()
            .unwrap()
            .into_authored()
            .completion_boundary(),
        CompletionBoundary::GeneratedDesiredState
    );
}

#[test]
fn a_frontend_can_explain_which_suggestions_are_choices_and_which_are_free_text() {
    let capabilities = Capabilities::available();
    let draft = begin_onboarding(&capabilities);

    let fields = draft.guided_fields(&capabilities).unwrap();
    let harness = fields
        .iter()
        .find(|field| field.id() == EditableField::Harness)
        .unwrap();
    let deployment_name = fields
        .iter()
        .find(|field| field.id() == EditableField::DeploymentName)
        .unwrap();

    assert!(harness.is_choice());
    assert_eq!(
        harness.value(),
        &FieldValue::Harness("nvidia.fabric.openclaw".parse::<HarnessKind>().unwrap())
    );
    assert!(!deployment_name.is_choice());
    assert_eq!(
        deployment_name.value(),
        &FieldValue::Text("openclaw-nvidia-hosted".into())
    );
    assert!(deployment_name.choices().is_empty());
}

#[test]
fn an_author_can_follow_the_available_choices_from_openclaw_to_hermes() {
    let capabilities = Capabilities::available();
    let mut draft = begin_onboarding(&capabilities);

    choose(
        &mut draft,
        &capabilities,
        EditableField::Harness,
        FieldValue::Harness("nvidia.fabric.hermes".parse::<HarnessKind>().unwrap()),
    );

    assert_eq!(
        choices_for(&draft, &capabilities, EditableField::Runtime),
        [
            FieldValue::Runtime(ComputeDriver::Docker),
            FieldValue::Runtime(ComputeDriver::Podman),
        ]
    );
    assert!(
        choices_for(&draft, &capabilities, EditableField::Inference)
            .contains(&FieldValue::Inference(ProviderPreset::Nous))
    );
    assert_eq!(
        choices_for(&draft, &capabilities, EditableField::Api),
        [
            FieldValue::Api(InferenceApi::OpenaiCompletions),
            FieldValue::Api(InferenceApi::OpenaiResponses),
        ]
    );
    choose(
        &mut draft,
        &capabilities,
        EditableField::Runtime,
        FieldValue::Runtime(ComputeDriver::Docker),
    );
    choose(
        &mut draft,
        &capabilities,
        EditableField::Inference,
        FieldValue::Inference(ProviderPreset::NvidiaEndpoints),
    );
    choose(
        &mut draft,
        &capabilities,
        EditableField::Model,
        FieldValue::Model(NVIDIA_MODEL.into()),
    );

    let review = draft.review().unwrap();
    let document = review.document();
    let sandbox = &document.spec.sandboxes[0];

    assert_eq!(
        document.sandbox_harness(sandbox).unwrap().kind,
        "nvidia.fabric.hermes".parse::<HarnessKind>().unwrap()
    );
    assert_eq!(
        document.inference_provider().unwrap().api,
        Some(InferenceApi::OpenaiCompletions)
    );
}

#[test]
fn an_openclaw_author_can_choose_responses_without_losing_their_model() {
    let capabilities = Capabilities::available();
    let mut draft = begin_onboarding(&capabilities);

    choose(
        &mut draft,
        &capabilities,
        EditableField::Api,
        FieldValue::Api(InferenceApi::OpenaiResponses),
    );

    assert_eq!(
        choices_for(&draft, &capabilities, EditableField::Model),
        [FieldValue::Model(NVIDIA_MODEL.into())]
    );
    let answers = draft.guided_answers(&capabilities).unwrap();
    assert_eq!(
        answers.harness,
        "nvidia.fabric.openclaw".parse::<HarnessKind>().unwrap()
    );
    assert_eq!(answers.api, InferenceApi::OpenaiResponses);
    assert_eq!(answers.model, NVIDIA_MODEL);
    assert_eq!(
        draft
            .review()
            .unwrap()
            .document()
            .inference_provider()
            .unwrap()
            .api,
        Some(InferenceApi::OpenaiResponses)
    );
}

#[test]
fn an_author_can_reopen_generated_yaml_and_continue_where_they_left_off() {
    let capabilities = Capabilities::available();
    let mut draft = begin_onboarding(&capabilities);
    choose(
        &mut draft,
        &capabilities,
        EditableField::Api,
        FieldValue::Api(InferenceApi::OpenaiResponses),
    );
    let saved_yaml = draft.review().unwrap().yaml().to_owned();

    let reopened = Draft::from_yaml(saved_yaml.as_bytes()).unwrap();
    let answers = reopened.guided_answers(&capabilities).unwrap();

    assert_eq!(reopened.review().unwrap().uid(), UID);
    assert_eq!(
        answers.harness,
        "nvidia.fabric.openclaw".parse::<HarnessKind>().unwrap()
    );
    assert_eq!(answers.api, InferenceApi::OpenaiResponses);
    assert_eq!(answers.model, NVIDIA_MODEL);
    assert_eq!(
        reopened.review().unwrap().credential_references(),
        ["NVIDIA_INFERENCE_API_KEY"]
    );
}

#[test]
fn a_rejected_identity_edit_leaves_the_authors_draft_exactly_as_it_was() {
    let capabilities = Capabilities::available();
    let mut draft = begin_onboarding(&capabilities);
    let before = draft.review().unwrap().yaml().to_owned();

    let diagnostics = draft
        .edit_identity(
            &capabilities,
            IdentityEdits {
                deployment_name: Some("not a slug".into()),
                sandbox_name: None,
                agent_name: None,
            },
        )
        .unwrap_err();

    assert_eq!(
        diagnostics
            .items()
            .iter()
            .map(|diagnostic| diagnostic.field())
            .collect::<Vec<_>>(),
        ["deployment-name"]
    );
    assert_eq!(draft.review().unwrap().yaml(), before);
    assert_eq!(
        diagnostics.to_string(),
        "deployment-name: must be a lowercase name of at most 40 characters"
    );
}

#[test]
fn an_author_can_rename_their_deployment_without_changing_its_identity_or_inference() {
    let capabilities = Capabilities::available();
    let mut draft = begin_onboarding(&capabilities);

    draft
        .edit_identity(
            &capabilities,
            IdentityEdits {
                deployment_name: Some("renamed-deployment".into()),
                sandbox_name: Some("renamed-sandbox".into()),
                agent_name: None,
            },
        )
        .unwrap();

    let review = draft.review().unwrap();
    let answers = draft.guided_answers(&capabilities).unwrap();
    assert_eq!(review.uid(), UID);
    assert_eq!(review.deployment_name(), "renamed-deployment");
    assert_eq!(answers.sandbox_name, "renamed-sandbox");
    assert_eq!(answers.agent_name, "primary");
    assert_eq!(
        answers.harness,
        "nvidia.fabric.openclaw".parse::<HarnessKind>().unwrap()
    );
    assert_eq!(answers.model, NVIDIA_MODEL);
    assert_eq!(review.credential_references(), ["NVIDIA_INFERENCE_API_KEY"]);
}

#[test]
fn the_guide_hides_internal_names_and_credential_environment_variables() {
    let capabilities = Capabilities::available();
    let draft = begin_onboarding(&capabilities);
    let fields = draft
        .guided_fields(&capabilities)
        .unwrap()
        .into_iter()
        .map(|field| field.id())
        .collect::<Vec<_>>();

    assert!(!fields.contains(&EditableField::SandboxName));
    assert!(!fields.contains(&EditableField::AgentName));
    assert!(!fields.contains(&EditableField::ProviderName));
    assert!(!fields.contains(&EditableField::CredentialEnv));
}

#[test]
fn the_guide_reports_when_a_frontend_uses_the_wrong_value_type() {
    let capabilities = Capabilities::available();
    let mut draft = begin_onboarding(&capabilities);

    let diagnostics = draft
        .set_guided_field(
            &capabilities,
            EditableField::DeploymentName,
            FieldValue::Model(NVIDIA_MODEL.into()),
        )
        .unwrap_err();

    assert_eq!(diagnostics.items()[0].field(), "deployment-name");
    assert_eq!(
        diagnostics.items()[0].message(),
        "value has the wrong type for this field"
    );
}

#[test]
fn the_guide_rejects_a_choice_that_is_not_available_at_that_point_in_the_journey() {
    let capabilities = Capabilities::available();
    let mut draft = begin_onboarding(&capabilities);
    choose(
        &mut draft,
        &capabilities,
        EditableField::Harness,
        FieldValue::Harness("nvidia.fabric.pi".parse::<HarnessKind>().unwrap()),
    );

    let diagnostics = draft
        .set_guided_field(
            &capabilities,
            EditableField::Api,
            FieldValue::Api(InferenceApi::AnthropicMessages),
        )
        .unwrap_err();

    assert_eq!(diagnostics.items()[0].field(), "api");
    assert!(diagnostics.items()[0].message().contains("not available"));
    assert_eq!(
        draft.guided_answers(&capabilities).unwrap().api,
        InferenceApi::OpenaiCompletions
    );
}

#[test]
fn direct_inputs_and_guided_choices_reach_the_same_openclaw_responses_document() {
    let capabilities = Capabilities::available();
    let direct_answers = Answers {
        api: ApiChoice::OpenaiResponses,
        ..Answers::onboarding_defaults()
    };
    let direct = Session::with_uid(UID)
        .unwrap()
        .project(&capabilities, &direct_answers)
        .unwrap();

    let mut guided = begin_onboarding(&capabilities);
    choose(
        &mut guided,
        &capabilities,
        EditableField::Api,
        FieldValue::Api(InferenceApi::OpenaiResponses),
    );

    assert_eq!(guided.review().unwrap().document(), direct.document());
}

#[test]
fn accepted_answers_are_preserved_until_a_conflicting_edit_is_confirmed() {
    let capabilities = Capabilities::available();
    let draft = begin_onboarding(&capabilities);
    assert!(!draft.is_accepted(EditableField::Api));
    let draft = draft
        .propose_guided_edit(
            &capabilities,
            EditableField::Api,
            FieldValue::Api(InferenceApi::OpenaiResponses),
        )
        .unwrap()
        .accept();
    let before = draft.review().unwrap().yaml().to_owned();
    let edit = draft
        .propose_guided_edit(
            &capabilities,
            EditableField::Inference,
            FieldValue::Inference(ProviderPreset::Anthropic),
        )
        .unwrap();
    assert!(
        edit.conflicts()
            .iter()
            .any(|change| change.field == EditableField::Api)
    );
    assert_eq!(draft.review().unwrap().yaml(), before);
    assert!(draft.is_accepted(EditableField::Api));
    let revised = edit.accept();
    assert!(!revised.is_accepted(EditableField::Api));
    assert!(revised.is_accepted(EditableField::Inference));
    assert_eq!(
        revised.guided_answers(&capabilities).unwrap().api,
        InferenceApi::AnthropicMessages
    );
}

#[test]
fn untouched_template_defaults_can_change_without_an_accepted_answer_conflict() {
    let capabilities = Capabilities::available();
    let mut draft = begin_onboarding(&capabilities);
    choose(
        &mut draft,
        &capabilities,
        EditableField::Api,
        FieldValue::Api(InferenceApi::OpenaiResponses),
    );
    let edit = draft
        .propose_guided_edit(
            &capabilities,
            EditableField::Inference,
            FieldValue::Inference(ProviderPreset::Anthropic),
        )
        .unwrap();
    assert!(edit.conflicts().is_empty());
    assert_eq!(
        edit.accept().guided_answers(&capabilities).unwrap().api,
        InferenceApi::AnthropicMessages
    );
}

#[test]
fn changing_a_provider_revisits_the_accepted_model_but_keeps_the_deployment_name() {
    let capabilities = Capabilities::available();
    let draft = begin_onboarding(&capabilities)
        .propose_guided_edit(
            &capabilities,
            EditableField::DeploymentName,
            FieldValue::Text("my-agent".into()),
        )
        .unwrap()
        .accept()
        .propose_guided_edit(
            &capabilities,
            EditableField::Model,
            FieldValue::Model(NVIDIA_MODEL.into()),
        )
        .unwrap()
        .accept();
    let edit = draft
        .propose_guided_edit(
            &capabilities,
            EditableField::Inference,
            FieldValue::Inference(ProviderPreset::Anthropic),
        )
        .unwrap();
    assert_eq!(
        edit.conflicts()
            .iter()
            .map(|change| change.field)
            .collect::<Vec<_>>(),
        [EditableField::Model]
    );
    let revised = edit.accept();
    assert!(revised.is_accepted(EditableField::DeploymentName));
    assert!(!revised.is_accepted(EditableField::Model));
    assert_eq!(
        revised
            .guided_answers(&capabilities)
            .unwrap()
            .deployment_name,
        "my-agent"
    );
    assert_ne!(
        revised.guided_answers(&capabilities).unwrap().model,
        NVIDIA_MODEL
    );
}

#[test]
fn rejected_answer_preserves_both_the_document_and_accepted_answers() {
    let capabilities = Capabilities::available();
    let draft = begin_onboarding(&capabilities)
        .propose_guided_edit(
            &capabilities,
            EditableField::DeploymentName,
            FieldValue::Text("my-agent".into()),
        )
        .unwrap()
        .accept();
    let before = draft.review().unwrap().yaml().to_owned();
    assert!(
        draft
            .propose_guided_edit(
                &capabilities,
                EditableField::DeploymentName,
                FieldValue::Text("invalid name".into())
            )
            .is_err()
    );
    assert!(draft.is_accepted(EditableField::DeploymentName));
    assert_eq!(draft.review().unwrap().yaml(), before);
}

#[test]
fn interview_resolves_dependencies_before_unrelated_identity_and_skips_accepted_answers() {
    let capabilities = Capabilities::available();
    let mut draft = begin_onboarding(&capabilities);
    assert_eq!(
        draft.next_question(&capabilities).unwrap().unwrap().id(),
        EditableField::Harness
    );
    let edit = draft
        .propose_guided_edit(
            &capabilities,
            EditableField::Harness,
            FieldValue::Harness("nvidia.fabric.openclaw".parse::<HarnessKind>().unwrap()),
        )
        .unwrap();
    draft = edit.accept();
    assert_eq!(
        draft.next_question(&capabilities).unwrap().unwrap().id(),
        EditableField::Inference
    );
    assert_eq!(
        draft.answer_status(EditableField::Harness),
        nemoclaw_authoring::AnswerStatus::Accepted
    );
    assert_eq!(
        draft.answer_status(EditableField::Model),
        nemoclaw_authoring::AnswerStatus::Suggested
    );
}

#[test]
fn changing_api_reconfirms_model_even_when_identifier_is_unchanged() {
    let capabilities = Capabilities::available();
    let draft = begin_onboarding(&capabilities)
        .propose_guided_edit(
            &capabilities,
            EditableField::Model,
            FieldValue::Model(NVIDIA_MODEL.into()),
        )
        .unwrap()
        .accept()
        .propose_guided_edit(
            &capabilities,
            EditableField::DeploymentName,
            FieldValue::Text("my-project".into()),
        )
        .unwrap()
        .accept();
    let edit = draft
        .propose_guided_edit(
            &capabilities,
            EditableField::Api,
            FieldValue::Api(InferenceApi::OpenaiResponses),
        )
        .unwrap();
    assert_eq!(
        edit.conflicts()
            .iter()
            .map(|change| change.field)
            .collect::<Vec<_>>(),
        vec![EditableField::Model]
    );
    let changed = edit.accept();
    assert!(!changed.is_accepted(EditableField::Model));
    assert!(changed.is_accepted(EditableField::DeploymentName));
}

#[test]
fn explicit_delegation_resolves_a_suggestion_and_context_changes_reopen_it() {
    let capabilities = Capabilities::available();
    let mut draft = begin_onboarding(&capabilities);
    draft.delegate(&capabilities, EditableField::Model).unwrap();
    assert_eq!(
        draft.answer_status(EditableField::Model),
        nemoclaw_authoring::AnswerStatus::Delegated
    );
    let revised = draft
        .propose_guided_edit(
            &capabilities,
            EditableField::Api,
            FieldValue::Api(InferenceApi::OpenaiResponses),
        )
        .unwrap()
        .accept();
    assert_eq!(
        revised.answer_status(EditableField::Model),
        nemoclaw_authoring::AnswerStatus::Suggested
    );
}

#[test]
fn observed_harnesses_bound_authoring_choices_without_inventing_support() {
    let capabilities =
        Capabilities::from_harnesses(["nvidia.fabric.openclaw".parse::<HarnessKind>().unwrap()]);
    let draft = begin_onboarding(&capabilities);
    assert_eq!(
        choices_for(&draft, &capabilities, EditableField::Harness),
        vec![FieldValue::Harness(
            "nvidia.fabric.openclaw".parse::<HarnessKind>().unwrap()
        )]
    );
    assert!(Capabilities::from_harnesses([]).harnesses().is_empty());
    assert_eq!(
        Capabilities::from_harnesses(["nvidia.fabric.codex".parse().unwrap()]).harnesses(),
        &["nvidia.fabric.codex".parse::<HarnessKind>().unwrap()]
    );
}

#[test]
fn singleton_protocol_is_implied_and_hidden_endpoint_does_not_block_completion() {
    let capabilities = Capabilities::available();
    let mut draft = begin_onboarding(&capabilities)
        .propose_guided_edit(
            &capabilities,
            EditableField::Inference,
            FieldValue::Inference(ProviderPreset::Anthropic),
        )
        .unwrap()
        .accept();
    assert_eq!(
        draft
            .field_status(&capabilities, EditableField::Api)
            .unwrap(),
        nemoclaw_authoring::AnswerStatus::Implied
    );
    assert_eq!(
        draft
            .field_status(&capabilities, EditableField::Endpoint)
            .unwrap(),
        nemoclaw_authoring::AnswerStatus::Inactive
    );
    let mut asked = Vec::new();
    while let Some(question) = draft.next_question(&capabilities).unwrap() {
        assert!(asked.len() < 7);
        asked.push(question.id());
        draft = draft
            .propose_guided_edit(&capabilities, question.id(), question.value().clone())
            .unwrap()
            .accept();
    }
    assert!(!asked.contains(&EditableField::Api));
    assert!(!asked.contains(&EditableField::Endpoint));
    assert!(asked.contains(&EditableField::Model));
}

#[test]
fn endpoint_protocol_choices_do_not_invent_harness_protocol_exclusions() {
    let capabilities = Capabilities::available();
    for harness in capabilities.harnesses() {
        for provider in ProviderPreset::ALL {
            let answers = Answers {
                harness: harness.clone(),
                ..Answers::onboarding_defaults().for_provider(provider)
            };
            let authored = Session::new()
                .unwrap()
                .project(&capabilities, &answers)
                .unwrap();
            let draft = Draft::from_document(authored.document().clone()).unwrap();
            assert_eq!(
                choices_for(&draft, &capabilities, EditableField::Api),
                provider
                    .apis()
                    .iter()
                    .copied()
                    .map(FieldValue::Api)
                    .collect::<Vec<_>>()
            );
        }
    }
}

#[test]
fn every_catalog_adapter_can_be_selected_and_roundtripped() {
    let capabilities = Capabilities::available();
    for harness in capabilities.harnesses() {
        let mut draft = begin_onboarding(&capabilities);
        choose(
            &mut draft,
            &capabilities,
            EditableField::Harness,
            FieldValue::Harness(harness.clone()),
        );
        let answers = draft.guided_answers(&capabilities).unwrap();
        assert_eq!(&answers.harness, harness);
        let review = draft.review().unwrap();
        let parsed = nemoclaw_sdk::config::Document::parse(review.yaml().as_bytes()).unwrap();
        assert_eq!(
            Draft::from_document(parsed)
                .unwrap()
                .guided_answers(&capabilities)
                .unwrap(),
            answers
        );
    }
}

#[test]
fn a_previously_unknown_fabric_harness_is_authorable_without_a_code_registration() {
    let mut catalog = nemoclaw_sdk::fabric_catalog::FabricCatalog::bundled();
    let mut descriptor = catalog.adapters[0].clone();
    descriptor.descriptor["adapter_id"] = "test.fixture.new-agent".into();
    catalog.adapters.push(descriptor);
    let capabilities = Capabilities::from_catalog(&catalog);
    let harness: HarnessKind = "test.fixture.new-agent".parse().unwrap();
    assert!(capabilities.harnesses().contains(&harness));
    let mut answers = Answers {
        harness,
        ..Answers::onboarding_defaults()
    };
    answers.image = "registry.example.test/custom-fabric@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into();
    answers.harness_settings = Some(
        serde_json::from_value(serde_json::json!({
            "custom_option": { "limit": 7, "optional": null },
            "flags": [true, "fixture"]
        }))
        .unwrap(),
    );
    let authored = Session::new()
        .unwrap()
        .project(&capabilities, &answers)
        .unwrap();
    let restored = Draft::from_yaml(authored.yaml().as_bytes()).unwrap();
    assert_eq!(restored.guided_answers(&capabilities).unwrap(), answers);
    assert!(authored.yaml().contains("test.fixture.new-agent"));
    let generations = [
        "workspace",
        "provider",
        "sandbox",
        "managed_gateway",
        "inference_service",
    ]
    .map(|kind| (kind.into(), "a".repeat(32)))
    .into();
    let graph = nemoclaw_sdk::compile::compile(restored.document(), &generations, "0.1.0").unwrap();
    let sandbox = &graph["resource"]["nemoclaw_sandbox"][&answers.sandbox_name];
    assert_eq!(sandbox["agent_runtime"], "fabric");
    let runtime: serde_json::Value = serde_json::from_str(
        graph["resource"]["nemoclaw_agent_configuration"][&answers.sandbox_name]["config_json"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(
        runtime["harness"]["settings"],
        serde_json::to_value(&answers.harness_settings).unwrap()
    );
}

#[test]
fn explicit_protocol_configuration_is_not_rejected_by_a_named_sdk_gate() {
    let mut catalog = nemoclaw_sdk::fabric_catalog::FabricCatalog::bundled();
    catalog.adapters[0].descriptor["settings_schema"] = serde_json::json!({"type":"object","properties":{"api_type":{"enum":["anthropic-messages"]}}});
    let capabilities = Capabilities::from_catalog(&catalog);
    let answers = Answers {
        harness: capabilities.harnesses()[0].clone(),
        ..Answers::onboarding_defaults().for_provider(ProviderPreset::Anthropic)
    };
    let authored = Session::new()
        .unwrap()
        .project(&capabilities, &answers)
        .unwrap();
    assert_eq!(
        authored.document().inference_provider().unwrap().api,
        Some(InferenceApi::AnthropicMessages)
    );
    assert_eq!(
        Draft::from_yaml(authored.yaml().as_bytes())
            .unwrap()
            .guided_answers(&capabilities)
            .unwrap(),
        answers
    );
}

#[test]
fn lossless_draft_editing_does_not_require_a_cached_compatibility_scenario() {
    let draft = begin_onboarding(&Capabilities::available());
    let unavailable = Capabilities::from_harnesses([]);
    let before = draft.document().clone();
    let edited = draft
        .propose_guided_edit(
            &unavailable,
            EditableField::DeploymentName,
            FieldValue::Text("offline-rename".into()),
        )
        .expect("catalog absence must not prevent editing retained intent")
        .accept();
    assert_eq!(edited.document().spec, before.spec);
    assert_eq!(edited.document().metadata.name, "offline-rename");
    assert_eq!(edited.document().metadata.uid, before.metadata.uid);
    assert!(edited.is_accepted(EditableField::DeploymentName));
}

#[test]
fn direct_provider_choice_and_guided_choice_share_one_endpoint_preset() {
    let capabilities = Capabilities::available();
    let direct =
        Answers::onboarding_defaults().with_overrides(nemoclaw_authoring::AnswerOverrides {
            inference: Some(ProviderPreset::Anthropic),
            ..Default::default()
        });
    let authored = Session::with_uid(UID)
        .unwrap()
        .project(&capabilities, &direct)
        .unwrap();
    let guided = begin_onboarding(&capabilities)
        .propose_guided_edit(
            &capabilities,
            EditableField::Inference,
            FieldValue::Inference(ProviderPreset::Anthropic),
        )
        .unwrap()
        .accept();
    assert_eq!(authored.document(), guided.document());
}

#[test]
fn guided_edits_preserve_an_explicit_target_engine() {
    let capabilities = Capabilities::available();
    let draft = begin_onboarding(&capabilities);
    let mut document = draft.document().clone();
    document.spec.gateway.as_managed_mut().unwrap().engine =
        "unix:///tmp/owned-discovery-fixture.sock".into();
    let mut draft = Draft::from_document(document.clone()).unwrap();
    draft
        .set_guided_field(
            &capabilities,
            EditableField::Model,
            FieldValue::Model("updated-model".into()),
        )
        .unwrap();
    assert_eq!(draft.document().spec.gateway, document.spec.gateway);
}

#[test]
fn anonymous_http_provider_is_losslessly_authorable_without_a_credential_reference() {
    let capabilities = Capabilities::available();
    let mut draft = begin_onboarding(&capabilities);
    draft
        .set_guided_field(
            &capabilities,
            EditableField::Inference,
            FieldValue::Inference(ProviderPreset::OpenAiCompatible),
        )
        .unwrap();
    draft
        .set_guided_field(
            &capabilities,
            EditableField::Endpoint,
            FieldValue::Text("http://127.0.0.1:11434/v1".into()),
        )
        .unwrap();
    assert!(
        draft.document().spec.inference_providers[0]
            .credential
            .is_none()
    );
    draft
        .set_guided_field(
            &capabilities,
            EditableField::Model,
            FieldValue::Model("local-model".into()),
        )
        .unwrap();
    let reopened = Draft::from_yaml(draft.review().unwrap().yaml().as_bytes()).unwrap();
    assert_eq!(reopened.document(), draft.document());
    assert!(
        reopened
            .guided_answers(&capabilities)
            .unwrap()
            .credential_env
            .is_empty()
    );
    reopened
        .inference_request(&capabilities)
        .unwrap()
        .validate()
        .unwrap();
}
