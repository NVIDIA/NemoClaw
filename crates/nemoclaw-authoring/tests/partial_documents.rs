// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_authoring::{PartialDocument, PartialIssueKind};
use nemoclaw_sdk::config::Document;

#[test]
fn a_pinned_nim_document_materializes_with_an_operator_credential_reference() {
    let yaml = include_bytes!("../../nemoclaw-e2e/cases/docker-openclaw-nim.yaml");
    let assessment = PartialDocument::from_yaml(yaml).unwrap().assess();
    assert!(assessment.issues().is_empty(), "{:?}", assessment.issues());
    assert_eq!(
        assessment.document(),
        Some(&Document::parse(yaml.as_slice()).unwrap())
    );
}

#[test]
fn sparse_input_reports_missing_values_without_constructing_a_document() {
    let partial = PartialDocument::from_yaml(
        b"apiVersion: nemoclaw.nvidia.com/v1alpha1\nkind: NemoClawConfig\nspec:\n  sandboxes:\n    assistant:\n      harness:\n        kind: nvidia.fabric.openclaw\n",
    )
    .unwrap();
    let assessment = partial.assess();

    assert!(assessment.document().is_none());
    assert!(
        assessment.issues().iter().any(|issue| {
            issue.kind() == PartialIssueKind::Missing && issue.path() == "/metadata"
        })
    );
    assert!(
        assessment
            .issues()
            .iter()
            .all(|issue| issue.kind() != PartialIssueKind::Invalid)
    );
}

#[test]
fn supplied_invalid_name_is_distinct_from_missing_values() {
    let partial = PartialDocument::from_yaml(
        b"apiVersion: nemoclaw.nvidia.com/v1alpha1\nkind: NemoClawConfig\nmetadata:\n  name: Bad Name\nspec:\n  sandboxes:\n    assistant:\n      harness:\n        kind: nvidia.fabric.openclaw\n",
    )
    .unwrap();
    let assessment = partial.assess();

    assert!(assessment.issues().iter().any(|issue| {
        issue.kind() == PartialIssueKind::Invalid && issue.path() == "/metadata/name"
    }));
    assert!(
        assessment
            .issues()
            .iter()
            .any(|issue| issue.kind() == PartialIssueKind::Missing)
    );
}

#[test]
fn complete_input_materializes_through_the_sdk() {
    let yaml = include_bytes!("../../../examples/onboarding/openclaw.yaml");
    let partial = PartialDocument::from_yaml(yaml).unwrap();
    let assessment = partial.assess();

    assert!(assessment.issues().is_empty());
    assert_eq!(
        assessment.document(),
        Some(&Document::parse(yaml.as_slice()).unwrap())
    );
}

#[test]
fn inference_form_is_pending_when_absent_and_invalid_when_both_forms_are_supplied() {
    let yaml = include_bytes!("../../../examples/onboarding/openclaw.yaml");
    let original = Document::parse(yaml.as_slice()).unwrap();
    let mut value = serde_json::to_value(original).unwrap();
    let agent = value
        .pointer_mut("/spec/sandboxes/assistant/agent")
        .unwrap()
        .as_object_mut()
        .unwrap();
    let inference = agent.remove("inference").unwrap();
    let partial = PartialDocument::from_yaml(value.to_string().as_bytes()).unwrap();
    let assessment = partial.assess();
    assert!(assessment.issues().iter().any(|issue| {
        issue.path() == "/spec/sandboxes/assistant/agent"
            && issue.kind() == PartialIssueKind::Deferred
    }));

    let agent = value
        .pointer_mut("/spec/sandboxes/assistant/agent")
        .unwrap()
        .as_object_mut()
        .unwrap();
    agent.insert("inference".into(), inference);
    agent.insert("inferenceRef".into(), "somewhere".into());
    let partial = PartialDocument::from_yaml(value.to_string().as_bytes()).unwrap();
    let assessment = partial.assess();
    assert!(assessment.issues().iter().any(|issue| {
        issue.path() == "/spec/sandboxes/assistant/agent"
            && issue.kind() == PartialIssueKind::Invalid
    }));
}

#[test]
fn a_pinned_llama_cpp_document_materializes_without_loading_credentials() {
    let yaml = include_bytes!("../../nemoclaw-e2e/cases/docker-openclaw-llama-cpp.yaml");
    let assessment = PartialDocument::from_yaml(yaml).unwrap().assess();
    assert!(assessment.issues().is_empty(), "{:?}", assessment.issues());
    let document = assessment
        .document()
        .expect("complete managed GGUF desired state");
    assert!(
        document.credential_names().is_empty(),
        "serving key is owned by the runtime"
    );
}

#[test]
fn a_semantic_failure_names_its_field_and_reason() {
    // API-key auth whose provider has no credential.
    let yaml = include_str!("../../../examples/local.yaml").replace(
        "        name: main\n",
        "        name: main\n        auth:\n          method: api-key\n",
    );
    let assessment = PartialDocument::from_yaml(yaml.as_bytes())
        .unwrap()
        .assess();
    assert!(assessment.document().is_none());
    let issues: Vec<_> = assessment
        .issues()
        .iter()
        .map(|issue| (issue.path(), issue.kind(), issue.rule()))
        .collect();
    // A semantic issue isn't one answer's to fix, so onboarding shows it
    // rather than asking for the field again.
    assert_eq!(
        issues,
        [(
            "/spec/sandboxes/assistant/agent/auth",
            PartialIssueKind::Semantic,
            "API-key auth must reference the routed provider with a credential"
        )]
    );
}
