// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use crate::{Capabilities, Diagnostics, Draft, EditableField, GuidedField};

/// Whether a document value is a suggestion or an explicit user decision.
/// Discovery evidence is kept separately: accepting a value does not verify it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AnswerStatus {
    Suggested,
    Accepted,
    Delegated,
    Implied,
    Inactive,
}

/// Dependencies between authoring decisions, independent of screen order.
/// These describe the supported hosted-inference projection, not every SDK field.
#[derive(Clone, Copy, Debug, Default)]
pub struct DependencyGraph;

impl DependencyGraph {
    pub fn prerequisites(self, field: EditableField) -> &'static [EditableField] {
        use EditableField::*;
        match field {
            Inference => &[Harness],
            Api => &[Harness, Inference],
            Endpoint | ProviderName | CredentialEnv => &[Inference],
            Model => &[Harness, Inference, Api, Endpoint],
            _ => &[],
        }
    }

    /// Includes transitive dependencies; identity and engine remain independent.
    pub fn depends_on(self, field: EditableField, prerequisite: EditableField) -> bool {
        self.prerequisites(field)
            .iter()
            .any(|parent| *parent == prerequisite || self.depends_on(*parent, prerequisite))
    }
}

impl Draft {
    pub fn answer_status(&self, field: EditableField) -> AnswerStatus {
        self.decisions
            .get(&field)
            .copied()
            .unwrap_or(AnswerStatus::Suggested)
    }

    /// Include the current constraint domain and conditional question visibility.
    pub fn field_status(
        &self,
        capabilities: &Capabilities,
        field: EditableField,
    ) -> Result<AnswerStatus, Diagnostics> {
        let fields = self.guided_fields(capabilities)?;
        Ok(match fields.iter().find(|current| current.id() == field) {
            None => AnswerStatus::Inactive,
            Some(current) if !self.is_accepted(field) && implied(current) => AnswerStatus::Implied,
            Some(_) => self.answer_status(field),
        })
    }

    /// Explicitly use the current suggestion. Dependency changes still reopen it.
    pub fn delegate(
        &mut self,
        capabilities: &Capabilities,
        field: EditableField,
    ) -> Result<(), Diagnostics> {
        let fields = self.guided_fields(capabilities)?;
        let current = fields
            .iter()
            .find(|current| current.id() == field)
            .ok_or_else(|| {
                crate::diagnostics::diagnostic(
                    "field",
                    "cannot delegate an inactive interview field",
                )
            })?;
        let edit = self.propose_guided_edit(capabilities, field, current.value().clone())?;
        if !edit.conflicts().is_empty() {
            return Err(crate::diagnostics::diagnostic(
                "field",
                "delegation would change accepted answers; propose and confirm the edit instead",
            ));
        }
        *self = edit.accept();
        self.decisions.insert(field, AnswerStatus::Delegated);
        Ok(())
    }

    /// Select an unresolved decision whose active prerequisites are resolved.
    /// Prefer questions that constrain more remaining decisions; stable ties
    /// retain presentation order. Hidden fields never block the interview.
    pub fn next_question(
        &self,
        capabilities: &Capabilities,
    ) -> Result<Option<GuidedField>, Diagnostics> {
        let fields = self.guided_fields(capabilities)?;
        let graph = DependencyGraph;
        let mut best: Option<(usize, GuidedField)> = None;
        for field in &fields {
            if self.is_accepted(field.id())
                || implied(field)
                || graph.prerequisites(field.id()).iter().any(|required| {
                    fields
                        .iter()
                        .any(|candidate| candidate.id() == *required && !implied(candidate))
                        && !self.is_accepted(*required)
                })
            {
                continue;
            }
            let impact = fields
                .iter()
                .filter(|other| {
                    !self.is_accepted(other.id()) && graph.depends_on(other.id(), field.id())
                })
                .count();
            if best.as_ref().is_none_or(|(score, _)| impact > *score) {
                best = Some((impact, field.clone()));
            }
        }
        Ok(best.map(|(_, field)| field))
    }
}

fn implied(field: &GuidedField) -> bool {
    field.is_choice() && !field.accepts_custom() && field.choices().len() == 1
}
