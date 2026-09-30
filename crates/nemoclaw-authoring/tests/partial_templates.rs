// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_authoring::{
    AnswerOverrides, AnswerStatus, Capabilities, EditableField, FieldValue, PartialTemplate,
    ProviderPreset, TargetFacts, TargetStatus,
};

#[test]
fn selected_question_remains_open_until_answered() {
    let capabilities = Capabilities::available();
    let template = PartialTemplate::new("minimal").ask([EditableField::DeploymentName]);
    let mut draft = template
        .draft(&TargetFacts::new("test target"), &capabilities)
        .unwrap();

    assert_eq!(
        draft.next_question(&capabilities).unwrap().unwrap().id(),
        EditableField::DeploymentName
    );
    assert_eq!(
        draft.answer_status(EditableField::Harness),
        AnswerStatus::Delegated
    );
    draft = draft
        .propose_guided_edit(
            &capabilities,
            EditableField::DeploymentName,
            FieldValue::Text("my-deployment".into()),
        )
        .unwrap()
        .accept();
    assert_eq!(
        draft.answer_status(EditableField::DeploymentName),
        AnswerStatus::Accepted
    );
    assert!(draft.next_question(&capabilities).unwrap().is_none());
}

#[test]
fn changing_provider_reopens_a_missing_custom_endpoint() {
    let capabilities = Capabilities::available();
    let template = PartialTemplate::new("provider-change")
        .with_values(AnswerOverrides {
            inference: Some(ProviderPreset::NvidiaEndpoints),
            ..AnswerOverrides::default()
        })
        .ask([EditableField::Inference, EditableField::Model]);
    let draft = template
        .draft(&TargetFacts::new("test target"), &capabilities)
        .unwrap();
    assert_eq!(
        draft
            .field_status(&capabilities, EditableField::Endpoint)
            .unwrap(),
        AnswerStatus::Inactive
    );

    let draft = draft
        .propose_guided_edit(
            &capabilities,
            EditableField::Inference,
            FieldValue::Inference(ProviderPreset::OpenAiCompatible),
        )
        .unwrap()
        .accept();
    assert_eq!(
        draft
            .field_status(&capabilities, EditableField::Endpoint)
            .unwrap(),
        AnswerStatus::Suggested
    );
}

#[test]
fn required_target_fact_blocks_until_observed() {
    let template = PartialTemplate::new("needs-hardware").requiring(["hardware"]);
    let target = TargetFacts::new("remote host").mark_unknown("hardware", "probe unavailable");
    assert_eq!(
        template.target_status(&target),
        TargetStatus::Blocked(vec![
            "target 'remote host' needs fact 'hardware': probe unavailable".into()
        ])
    );
    assert!(template.draft(&target, &Capabilities::available()).is_err());
    let target = target.observe("hardware", "gpu present");
    assert_eq!(template.target_status(&target), TargetStatus::Ready);
    assert!(template.draft(&target, &Capabilities::available()).is_ok());
}

#[test]
fn complete_custom_endpoint_template_has_no_guided_questions() {
    let capabilities = Capabilities::available();
    let template = PartialTemplate::new("complete-compatible").with_values(AnswerOverrides {
        inference: Some(ProviderPreset::OpenAiCompatible),
        provider_name: Some("compatible-endpoint".into()),
        endpoint: Some("https://inference.example.com/v1".into()),
        model: Some("vendor/model".into()),
        credential_env: Some("COMPATIBLE_API_KEY".into()),
        ..AnswerOverrides::default()
    });
    let draft = template
        .draft(&TargetFacts::new("test target"), &capabilities)
        .unwrap();
    assert!(draft.next_question(&capabilities).unwrap().is_none());
    assert_eq!(
        draft.guided_answers(&capabilities).unwrap().endpoint,
        "https://inference.example.com/v1"
    );
    assert!(draft.review().is_ok());
}

#[test]
fn invalid_template_is_rejected_before_the_interview() {
    let template = PartialTemplate::new("invalid").with_values(AnswerOverrides {
        deployment_name: Some(String::new()),
        ..AnswerOverrides::default()
    });
    assert!(
        template
            .draft(&TargetFacts::new("test target"), &Capabilities::available())
            .is_err()
    );
}
