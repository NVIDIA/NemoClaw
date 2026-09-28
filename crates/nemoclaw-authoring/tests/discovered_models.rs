// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use nemoclaw_authoring::{
    Answers, AuthoringFacts, Capabilities, Draft, EditableField, EndpointEvidence, FieldValue,
    ProviderPreset, Session,
};
use nemoclaw_sdk::{
    discovery::ObservationStatus,
    inference_discovery::{AuthenticationStatus, EndpointObservation},
};

fn draft(capabilities: &Capabilities) -> Draft {
    Draft::from_document(
        Session::new()
            .unwrap()
            .project(capabilities, &Answers::onboarding_defaults())
            .unwrap()
            .document()
            .clone(),
    )
    .unwrap()
}
fn facts(draft: &Draft, capabilities: &Capabilities) -> AuthoringFacts {
    AuthoringFacts {
        endpoint: Some(EndpointEvidence {
            request: draft.inference_request(capabilities).unwrap(),
            observation: EndpointObservation {
                status: ObservationStatus::Available,
                reason: None,
                source: "control_host_http_models".into(),
                reachable: Some(true),
                authentication: AuthenticationStatus::Accepted,
                models: vec!["vendor/discovered-model".into()],
                api_verified: false,
            },
        }),
        ..Default::default()
    }
}
#[test]
fn discovered_models_extend_suggestions_without_changing_accepted_custom_intent() {
    let capabilities = Capabilities::available();
    let draft = draft(&capabilities)
        .propose_guided_edit(
            &capabilities,
            EditableField::Model,
            FieldValue::Model("private/custom".into()),
        )
        .unwrap()
        .accept();
    let facts = facts(&draft, &capabilities);
    let fields = draft
        .guided_fields_with_facts(&capabilities, &facts)
        .unwrap();
    let model = fields
        .iter()
        .find(|field| field.id() == EditableField::Model)
        .unwrap();
    assert!(
        model
            .choices()
            .contains(&FieldValue::Model("vendor/discovered-model".into()))
    );
    assert_eq!(model.value(), &FieldValue::Model("private/custom".into()));
    assert!(draft.is_accepted(EditableField::Model));
    assert!(model.accepts_custom());
}
#[test]
fn changed_endpoint_or_failed_observation_cannot_supply_stale_model_choices() {
    let capabilities = Capabilities::available();
    let original = draft(&capabilities);
    let mut facts = facts(&original, &capabilities);
    let changed = original
        .propose_guided_edit(
            &capabilities,
            EditableField::Inference,
            FieldValue::Inference(ProviderPreset::OpenAi),
        )
        .unwrap()
        .accept();
    let choices = changed
        .guided_fields_with_facts(&capabilities, &facts)
        .unwrap();
    assert!(
        !choices
            .iter()
            .find(|field| field.id() == EditableField::Model)
            .unwrap()
            .choices()
            .contains(&FieldValue::Model("vendor/discovered-model".into()))
    );
    facts.endpoint.as_mut().unwrap().observation.status = ObservationStatus::Unknown;
    let choices = original
        .guided_fields_with_facts(&capabilities, &facts)
        .unwrap();
    assert!(
        !choices
            .iter()
            .find(|field| field.id() == EditableField::Model)
            .unwrap()
            .choices()
            .contains(&FieldValue::Model("vendor/discovered-model".into()))
    );
}
