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
        HarnessKind::OpenClaw
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
    assert_eq!(harness.value(), &FieldValue::Harness(HarnessKind::OpenClaw));
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
        FieldValue::Harness(HarnessKind::Hermes),
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
        HarnessKind::Hermes
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
    assert_eq!(answers.harness, HarnessKind::OpenClaw);
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
    assert_eq!(answers.harness, HarnessKind::OpenClaw);
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
    assert_eq!(answers.harness, HarnessKind::OpenClaw);
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
        FieldValue::Harness(HarnessKind::Pi),
    );

    let diagnostics = draft
        .set_guided_field(
            &capabilities,
            EditableField::Api,
            FieldValue::Api(InferenceApi::OpenaiResponses),
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
            EditableField::Harness,
            FieldValue::Harness(HarnessKind::Pi),
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
    assert!(revised.is_accepted(EditableField::Harness));
    assert_eq!(
        revised.guided_answers(&capabilities).unwrap().api,
        InferenceApi::OpenaiCompletions
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
            EditableField::Harness,
            FieldValue::Harness(HarnessKind::Pi),
        )
        .unwrap();
    assert!(edit.conflicts().is_empty());
    assert_eq!(
        edit.accept().guided_answers(&capabilities).unwrap().api,
        InferenceApi::OpenaiCompletions
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
            FieldValue::Harness(HarnessKind::OpenClaw),
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
    let capabilities = Capabilities::from_harnesses([HarnessKind::OpenClaw]);
    let draft = begin_onboarding(&capabilities);
    assert_eq!(
        choices_for(&draft, &capabilities, EditableField::Harness),
        vec![FieldValue::Harness(HarnessKind::OpenClaw)]
    );
    assert!(Capabilities::from_harnesses([]).scenarios().is_empty());
    assert!(
        Capabilities::from_harnesses([HarnessKind::Codex])
            .scenarios()
            .iter()
            .all(|scenario| scenario.harness() == HarnessKind::Codex)
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
fn advertised_api_constraints_remove_incompatible_onboarding_choices() {
    let mut catalog = nemoclaw_sdk::fabric_catalog::FabricCatalog::bundled();
    catalog
        .adapters
        .retain(|adapter| adapter.harness == "openclaw");
    catalog.adapters[0].descriptor["settings_schema"]["$defs"]["api"]["enum"]
        .as_array_mut()
        .unwrap()
        .retain(|value| value.as_str() == Some("openai-responses"));
    let choices = nemoclaw_authoring::Capabilities::from_catalog(&catalog);
    assert!(!choices.scenarios().is_empty());
    assert!(
        choices
            .scenarios()
            .iter()
            .all(|scenario| scenario.api() == nemoclaw_sdk::config::InferenceApi::OpenaiResponses)
    );
}

#[test]
fn every_sdk_known_catalog_harness_can_be_authored_and_roundtripped() {
    let catalog = nemoclaw_sdk::fabric_catalog::FabricCatalog::bundled();
    let capabilities = Capabilities::from_catalog(&catalog);
    for harness in catalog
        .adapters
        .iter()
        .filter_map(|adapter| adapter.harness.parse::<HarnessKind>().ok())
    {
        let scenario = capabilities
            .scenarios()
            .iter()
            .find(|scenario| scenario.harness() == harness)
            .unwrap_or_else(|| panic!("catalog harness {harness:?} excluded"));
        let mut draft = begin_onboarding(&capabilities);
        choose(
            &mut draft,
            &capabilities,
            EditableField::Harness,
            FieldValue::Harness(harness.clone()),
        );
        let answers = draft.guided_answers(&capabilities).unwrap();
        assert_eq!(answers.harness, harness);
        assert!(
            capabilities
                .scenarios()
                .iter()
                .any(|scenario| scenario.harness() == harness && scenario.api() == answers.api)
        );
        assert_eq!(scenario.harness(), harness);
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
fn inference_profiles_follow_protocols_without_harness_brand_restrictions() {
    let capabilities = Capabilities::available();
    assert!(
        capabilities
            .scenarios()
            .iter()
            .any(|scenario| scenario.harness() == HarnessKind::OpenClaw
                && scenario.inference() == ProviderPreset::Nous)
    );
    assert!(
        capabilities
            .scenarios()
            .iter()
            .filter(|scenario| scenario.inference() == ProviderPreset::AnthropicCompatible)
            .all(|scenario| scenario.api() == InferenceApi::AnthropicMessages)
    );
}

#[test]
fn a_previously_unknown_fabric_harness_is_authorable_without_a_code_registration() {
    let mut catalog = nemoclaw_sdk::fabric_catalog::FabricCatalog::bundled();
    let mut descriptor = catalog
        .adapters
        .iter()
        .find(|adapter| adapter.harness == "openclaw")
        .unwrap()
        .clone();
    descriptor.harness = "fixture-new-agent".into();
    descriptor.adapter_id = "test.fixture.new-agent".into();
    descriptor.descriptor["adapter_id"] = descriptor.adapter_id.clone().into();
    catalog.adapters.push(descriptor);
    let capabilities = Capabilities::from_catalog(&catalog);
    let scenario = capabilities
        .scenarios()
        .iter()
        .find(|scenario| scenario.harness().as_str() == "fixture-new-agent")
        .expect("a descriptor-provided harness must not require SDK registration");
    let mut answers = Answers::onboarding_defaults().for_scenario(scenario);
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
    assert!(authored.yaml().contains("fixture-new-agent"));
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
    assert_eq!(sandbox["agent_runtime"], "fabric-fixture-new-agent");
    let runtime: serde_json::Value =
        serde_json::from_str(sandbox["inference_json"].as_str().unwrap()).unwrap();
    assert_eq!(
        runtime["settings"],
        serde_json::to_value(&answers.harness_settings).unwrap()
    );
}

#[test]
fn updated_metadata_can_offer_a_new_protocol_for_an_existing_harness() {
    let mut catalog = nemoclaw_sdk::fabric_catalog::FabricCatalog::bundled();
    catalog
        .adapters
        .retain(|adapter| adapter.harness == "codex");
    catalog.adapters[0].descriptor["settings_schema"] = serde_json::json!({
        "type": "object", "properties": {"api_type": {"enum": ["anthropic-messages"]}}
    });
    let capabilities = Capabilities::from_catalog(&catalog);
    let scenario = capabilities
        .scenarios()
        .iter()
        .find(|scenario| {
            scenario.harness() == HarnessKind::Codex
                && scenario.inference() == ProviderPreset::Anthropic
        })
        .expect("updated descriptor must override the old protocol assumption");
    let answers = Answers::onboarding_defaults().for_scenario(scenario);
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
