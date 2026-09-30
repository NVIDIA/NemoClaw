// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use std::collections::BTreeMap;

use crate::{
    AnswerOverrides, AnswerStatus, Answers, Capabilities, Diagnostics, Draft, EditableField,
    Session,
};

/// Facts observed about the machine that will run the deployment.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TargetFacts {
    id: String,
    facts: BTreeMap<String, String>,
    unknown: BTreeMap<String, String>,
}

impl TargetFacts {
    pub fn new(id: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            facts: BTreeMap::new(),
            unknown: BTreeMap::new(),
        }
    }

    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn observe(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        let key = key.into();
        self.unknown.remove(&key);
        self.facts.insert(key, value.into());
        self
    }

    pub fn mark_unknown(mut self, key: impl Into<String>, reason: impl Into<String>) -> Self {
        let key = key.into();
        self.facts.remove(&key);
        self.unknown.insert(key, reason.into());
        self
    }

    pub fn fact(&self, key: &str) -> Option<&str> {
        self.facts.get(key).map(String::as_str)
    }

    pub fn unknown_reason(&self, key: &str) -> Option<&str> {
        self.unknown.get(key).map(String::as_str)
    }
}

/// Result of checking the target facts required by one template.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TargetStatus {
    Ready,
    Blocked(Vec<String>),
}

/// Defaults and open questions for a guided draft. Consumers own concrete
/// templates; the SDK document and answer state remain in [`Draft`].
#[derive(Clone, Debug)]
pub struct PartialTemplate {
    id: String,
    values: AnswerOverrides,
    questions: Vec<EditableField>,
    requires: Vec<String>,
}

impl PartialTemplate {
    pub fn new(id: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            values: AnswerOverrides::default(),
            questions: Vec::new(),
            requires: Vec::new(),
        }
    }

    pub fn with_values(mut self, values: AnswerOverrides) -> Self {
        self.values = values;
        self
    }

    pub fn ask(mut self, fields: impl IntoIterator<Item = EditableField>) -> Self {
        self.questions = fields.into_iter().collect();
        self
    }

    pub fn requiring(mut self, facts: impl IntoIterator<Item = impl Into<String>>) -> Self {
        self.requires = facts.into_iter().map(Into::into).collect();
        self
    }

    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn question_fields(&self) -> &[EditableField] {
        &self.questions
    }

    pub fn target_status(&self, target: &TargetFacts) -> TargetStatus {
        let blockers = self
            .requires
            .iter()
            .filter(|key| target.fact(key).is_none())
            .map(|key| {
                format!(
                    "target '{}' needs fact '{key}': {}",
                    target.id(),
                    target.unknown_reason(key).unwrap_or("not observed")
                )
            })
            .collect::<Vec<_>>();
        if blockers.is_empty() {
            TargetStatus::Ready
        } else {
            TargetStatus::Blocked(blockers)
        }
    }

    /// Project defaults into a validated document. Open questions remain
    /// suggested; other active guided values are delegated until a dependency
    /// change reopens them. A missing custom endpoint is always a question.
    pub fn draft(
        &self,
        target: &TargetFacts,
        capabilities: &Capabilities,
    ) -> Result<Draft, Diagnostics> {
        if let TargetStatus::Blocked(messages) = self.target_status(target) {
            return Err(crate::diagnostics::from_messages("target", messages));
        }
        let answers = Answers::onboarding_defaults().with_overrides(self.values.clone());
        let authored = Session::new()?.project(capabilities, &answers)?;
        let mut draft = Draft::from_document(authored.document().clone())?;
        for field in draft.guided_fields(capabilities)? {
            if !self.questions.contains(&field.id())
                && !(field.id() == EditableField::Endpoint && self.values.endpoint.is_none())
            {
                draft.decisions.insert(field.id(), AnswerStatus::Delegated);
            }
        }
        Ok(draft)
    }
}
