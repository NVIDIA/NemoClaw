// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_authoring::{
    Answers, ApiChoice, Capabilities, Draft, HarnessChoice, IdentityEdits, InferenceEdits, Session,
};
use nemoclaw_sdk::config::Document;

const UID: &str = "12345678-1234-4234-9234-123456789abc";

#[test]
fn standalone_authoring_preserves_answers_and_reopens_equivalent_yaml() {
    let capabilities = Capabilities::available();
    let answers = Answers::onboarding_defaults();
    let authored = Session::with_uid(UID)
        .unwrap()
        .project(&capabilities, &answers)
        .unwrap();
    let document = Document::parse(authored.yaml().as_bytes()).unwrap();
    assert_eq!(&document, authored.document());
    assert_eq!(document.metadata.uid, UID);
    assert_eq!(document.metadata.name, answers.deployment_name);
    assert_eq!(document.spec.sandboxes[0].name, answers.sandbox_name);
    assert_eq!(document.spec.sandboxes[0].agent.name, answers.agent_name);
    assert_eq!(
        document.inference_provider().unwrap().name,
        answers.provider_name
    );
    assert_eq!(
        document.credential_names(),
        [answers.credential_env.as_str()]
    );
    let source: serde_json::Value = serde_saphyr::from_str(authored.yaml()).unwrap();
    for input in [
        authored.yaml().to_owned(),
        format!("# An editor may add comments.\n{}", authored.yaml()),
        serde_json::to_string(&source).unwrap(),
    ] {
        let reopened = Draft::from_yaml(&capabilities, input.as_bytes()).unwrap();
        let review = reopened.review(&capabilities).unwrap();
        assert_eq!(review.document(), &document);
        assert_eq!(review.uid(), UID);
        assert_eq!(review.model(), answers.model);
    }
}

#[test]
fn every_advertised_scenario_can_be_authored_and_reopened() {
    let capabilities = Capabilities::available();
    assert!(!capabilities.scenarios().is_empty());
    for scenario in capabilities.scenarios() {
        assert!(!scenario.models().is_empty());
        for model in scenario.models() {
            let answers = Answers {
                harness: scenario.harness(),
                runtime: scenario.runtime(),
                inference: scenario.inference(),
                api: scenario.api(),
                model: (*model).into(),
                ..Answers::onboarding_defaults()
            };
            let authored = Session::with_uid(UID)
                .unwrap()
                .project(&capabilities, &answers)
                .unwrap();
            let reopened = Draft::from_yaml(&capabilities, authored.yaml().as_bytes()).unwrap();
            assert_eq!(
                reopened.review(&capabilities).unwrap().document(),
                authored.document()
            );
        }
    }
}

#[test]
fn invalid_edits_report_fields_without_replacing_the_previous_draft() {
    let capabilities = Capabilities::available();
    let mut draft = Draft::new(
        Session::with_uid(UID).unwrap(),
        Answers::onboarding_defaults(),
    );
    let before = draft.review(&capabilities).unwrap();
    let errors = draft
        .edit_inference(
            &capabilities,
            InferenceEdits {
                provider_name: Some("replacement".into()),
                model: Some("unsupported/model".into()),
                credential_env: Some("not-an-env-name".into()),
            },
        )
        .unwrap_err();
    let fields: Vec<_> = errors.items().iter().map(|error| error.field()).collect();
    assert_eq!(fields, ["credential-env", "model"]);
    assert!(
        errors
            .items()
            .iter()
            .all(|error| !error.message().is_empty())
    );
    assert_eq!(draft.review(&capabilities).unwrap().yaml(), before.yaml());

    draft
        .edit_identity(
            &capabilities,
            IdentityEdits {
                deployment_name: Some("renamed".into()),
                ..IdentityEdits::default()
            },
        )
        .unwrap();
    draft
        .edit_inference(
            &capabilities,
            InferenceEdits {
                provider_name: Some("replacement".into()),
                credential_env: Some("OTHER_KEY".into()),
                ..InferenceEdits::default()
            },
        )
        .unwrap();
    let review = draft.review(&capabilities).unwrap();
    assert_eq!(review.uid(), UID);
    assert_eq!(review.deployment_name(), "renamed");
    assert_eq!(review.sandbox_name(), before.sandbox_name());
    assert_eq!(review.agent_name(), before.agent_name());
    assert_eq!(review.model(), before.model());
    assert_eq!(review.provider_name(), "replacement");
    assert_eq!(review.credential_references(), ["OTHER_KEY"]);
}

#[test]
fn unsupported_combinations_and_customized_documents_are_not_silently_rewritten() {
    let capabilities = Capabilities::available();
    let session = Session::with_uid(UID).unwrap();
    let answers = Answers {
        harness: HarnessChoice::Hermes,
        api: ApiChoice::OpenAiResponses,
        ..Answers::onboarding_defaults()
    };
    let errors = session.project(&capabilities, &answers).unwrap_err();
    assert_eq!(errors.items()[0].field(), "api");

    let authored = session
        .project(&capabilities, &Answers::onboarding_defaults())
        .unwrap();
    let mut custom: serde_json::Value = serde_saphyr::from_str(authored.yaml()).unwrap();
    custom["spec"]["inferenceProviders"][0]["endpoint"] =
        serde_json::json!("https://example.com/v1");
    let yaml = serde_saphyr::to_string(&custom).unwrap();
    Document::parse(yaml.as_bytes()).unwrap();
    let errors = Draft::from_yaml(&capabilities, yaml.as_bytes()).unwrap_err();
    assert_eq!(errors.items()[0].field(), "document");
    assert!(errors.items()[0].message().contains("only YAML generated"));
}
