// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Sparse authored input and a conservative first pass over the SDK input schema.

use std::sync::LazyLock;

use nemoclaw_sdk::config::{Document, parse_yaml_value, schema::input_schema};
use serde_json::Value;

use crate::{Diagnostics, diagnostics::diagnostic};
use jsonschema::error::ValidationErrorKind as Kind;

static INPUT_VALIDATOR: LazyLock<jsonschema::Validator> = LazyLock::new(|| {
    jsonschema::validator_for(&input_schema()).expect("SDK input schema must compile")
});

/// Authored values before SDK defaults or required-field validation.
#[derive(Clone, Debug, PartialEq)]
pub struct PartialDocument {
    supplied: Value,
}

/// A conservative classification of one full-schema validation error.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PartialIssueKind {
    Missing,
    Invalid,
    Deferred,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PartialIssue {
    path: String,
    kind: PartialIssueKind,
    rule: String,
}

impl PartialIssue {
    pub fn path(&self) -> &str {
        &self.path
    }

    pub fn kind(&self) -> PartialIssueKind {
        self.kind
    }

    pub fn rule(&self) -> &str {
        &self.rule
    }
}

/// Complete only when the SDK parses and validates the proposed document.
#[derive(Clone, Debug)]
pub struct PartialAssessment {
    issues: Vec<PartialIssue>,
    document: Option<Document>,
}

impl PartialAssessment {
    pub fn issues(&self) -> &[PartialIssue] {
        &self.issues
    }

    pub fn document(&self) -> Option<&Document> {
        self.document.as_ref()
    }
}

impl PartialDocument {
    pub(crate) fn from_value(supplied: Value) -> Self {
        Self { supplied }
    }

    /// Apply the SDK's YAML size and syntax limits without requiring a complete document.
    pub fn from_yaml(bytes: &[u8]) -> Result<Self, Diagnostics> {
        let supplied =
            parse_yaml_value(bytes).map_err(|error| diagnostic("document", &error.to_string()))?;
        Ok(Self { supplied })
    }

    pub fn supplied(&self) -> &Value {
        &self.supplied
    }

    /// Inspect the current sparse input. Compound rules remain deferred until
    /// a partial evaluator can prove whether a branch is impossible or incomplete.
    pub fn assess(&self) -> PartialAssessment {
        let mut issues = INPUT_VALIDATOR
            .iter_errors(&self.supplied)
            .flat_map(|error| tagged_branch(&error).unwrap_or_else(|| vec![issue(&error)]))
            .collect::<Vec<_>>();
        issues.sort_by(|left, right| (&left.path, &left.rule).cmp(&(&right.path, &right.rule)));
        issues.dedup();
        if !issues.is_empty() {
            return PartialAssessment {
                issues,
                document: None,
            };
        }
        let bytes = self.supplied.to_string();
        match Document::parse(bytes.as_bytes()) {
            Ok(document) => PartialAssessment {
                issues,
                document: Some(document),
            },
            Err(_) => PartialAssessment {
                issues: vec![PartialIssue {
                    path: String::new(),
                    kind: PartialIssueKind::Invalid,
                    rule: "sdk-semantic".into(),
                }],
                document: None,
            },
        }
    }
}

fn issue(error: &jsonschema::ValidationError<'_>) -> PartialIssue {
    let mut path = error.instance_path().to_string();
    if let Kind::Required { property } = error.kind()
        && let Some(property) = property.as_str()
    {
        path.push('/');
        path.push_str(&property.replace('~', "~0").replace('/', "~1"));
    }
    PartialIssue {
        path,
        kind: classify(error.kind()),
        rule: error.kind().keyword().to_owned(),
    }
}

/// For a tagged union such as the gateway, whose `management` names its
/// kind, report the errors inside the branch the input selects, so an
/// invalid field is attributed to that field rather than to the whole union.
fn tagged_branch(error: &jsonschema::ValidationError<'_>) -> Option<Vec<PartialIssue>> {
    let Kind::OneOfNotValid { context } = error.kind() else {
        return None;
    };
    let tag = ["management", "kind"]
        .into_iter()
        .find_map(|tag| error.instance().get(tag).and_then(Value::as_str))?;
    let schema = input_schema();
    let branches = schema
        .pointer(&error.schema_path().to_string())?
        .as_array()?;
    let selected = branches.iter().zip(context).find(|(branch, _)| {
        ["management", "kind"]
            .iter()
            .any(|key| branch["properties"][key]["const"].as_str() == Some(tag))
    })?;
    Some(selected.1.iter().map(issue).collect())
}

fn classify(kind: &Kind) -> PartialIssueKind {
    match kind {
        Kind::Required { .. } => PartialIssueKind::Missing,
        Kind::MinItems { .. } | Kind::MinProperties { .. } => PartialIssueKind::Missing,
        Kind::AnyOf { context } | Kind::OneOfNotValid { context } => {
            if context.iter().any(|branch| {
                branch
                    .iter()
                    .all(|error| classify(error.kind()) != PartialIssueKind::Invalid)
            }) {
                PartialIssueKind::Deferred
            } else {
                PartialIssueKind::Invalid
            }
        }
        Kind::OneOfMultipleValid { .. } => PartialIssueKind::Deferred,
        Kind::Not { schema } if schema.get("required").is_none() => PartialIssueKind::Deferred,
        _ => PartialIssueKind::Invalid,
    }
}
