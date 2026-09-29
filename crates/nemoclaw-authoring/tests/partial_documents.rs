// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_authoring::{PartialDocument, PartialIssueKind};
use nemoclaw_sdk::config::Document;

#[test]
fn sparse_input_reports_missing_values_without_constructing_a_document() {
    let partial = PartialDocument::from_yaml(
        b"apiVersion: nemoclaw.nvidia.com/v1alpha1\nkind: NemoClawConfig\nspec:\n  sandboxes:\n    - harness:\n        kind: nvidia.fabric.openclaw\n",
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
        b"apiVersion: nemoclaw.nvidia.com/v1alpha1\nkind: NemoClawConfig\nmetadata:\n  name: Bad Name\nspec:\n  sandboxes:\n    - harness:\n        kind: nvidia.fabric.openclaw\n",
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
        .pointer_mut("/spec/sandboxes/0/agent")
        .unwrap()
        .as_object_mut()
        .unwrap();
    let inference = agent.remove("inference").unwrap();
    let partial = PartialDocument::from_yaml(value.to_string().as_bytes()).unwrap();
    let assessment = partial.assess();
    assert!(assessment.issues().iter().any(|issue| {
        issue.path() == "/spec/sandboxes/0/agent" && issue.kind() == PartialIssueKind::Deferred
    }));

    let agent = value
        .pointer_mut("/spec/sandboxes/0/agent")
        .unwrap()
        .as_object_mut()
        .unwrap();
    agent.insert("inference".into(), inference);
    agent.insert("inferenceRef".into(), "somewhere".into());
    let partial = PartialDocument::from_yaml(value.to_string().as_bytes()).unwrap();
    let assessment = partial.assess();
    assert!(assessment.issues().iter().any(|issue| {
        issue.path() == "/spec/sandboxes/0/agent" && issue.kind() == PartialIssueKind::Invalid
    }));
}
