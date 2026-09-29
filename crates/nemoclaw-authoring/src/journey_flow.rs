// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Question order for a complete document while the sparse resolver grows to cover it.

use crate::{Capabilities, Diagnostics, Draft, EditableField, GuidedField, SettingQuestion};

/// The next decision in a complete-document onboarding journey.
#[derive(Clone, Debug)]
pub enum JourneyFlowQuestion {
    Guided(GuidedField),
    Route(Vec<String>),
    Setting {
        index: usize,
        question: SettingQuestion,
    },
    Deployment {
        index: usize,
        question: SettingQuestion,
    },
    Review,
}

/// A read-only view of the live draft and the TUI's navigation progress.
/// All authored values and answer statuses remain in `Draft`.
pub struct JourneyFlow<'a> {
    draft: &'a Draft,
    capabilities: &'a Capabilities,
    completed_routes: &'a [String],
    route_selected: bool,
    deployment_cursor: usize,
}

impl<'a> JourneyFlow<'a> {
    pub fn new(draft: &'a Draft, capabilities: &'a Capabilities) -> Self {
        Self {
            draft,
            capabilities,
            completed_routes: &[],
            route_selected: false,
            deployment_cursor: 0,
        }
    }

    pub fn with_progress(
        mut self,
        completed_routes: &'a [String],
        route_selected: bool,
        deployment_cursor: usize,
    ) -> Self {
        self.completed_routes = completed_routes;
        self.route_selected = route_selected;
        self.deployment_cursor = deployment_cursor;
        self
    }

    pub fn remaining_routes(&self) -> Result<Vec<String>, Diagnostics> {
        Ok(self
            .draft
            .route_names()?
            .into_iter()
            .filter(|route| !self.completed_routes.contains(route))
            .collect())
    }

    pub fn setting_at(&self, index: usize) -> Result<Option<SettingQuestion>, Diagnostics> {
        Ok(self
            .draft
            .setting_questions(self.capabilities)?
            .get(index)
            .cloned())
    }

    pub fn deployment_at(&self, index: usize) -> Result<Option<SettingQuestion>, Diagnostics> {
        Ok(self.draft.deployment_questions()?.get(index).cloned())
    }

    pub fn next_question(&self) -> Result<JourneyFlowQuestion, Diagnostics> {
        if let Some(field) = self.draft.next_question(self.capabilities)? {
            if matches!(
                field.id(),
                EditableField::Inference
                    | EditableField::Api
                    | EditableField::Endpoint
                    | EditableField::Model
            ) && !self.route_selected
                && self.remaining_routes()?.len() > 1
            {
                return Ok(JourneyFlowQuestion::Route(self.remaining_routes()?));
            }
            return Ok(JourneyFlowQuestion::Guided(field));
        }
        if let Some(setting) = self.draft.next_setting(self.capabilities)? {
            let index = self
                .draft
                .setting_questions(self.capabilities)?
                .iter()
                .position(|question| question.path == setting.path)
                .expect("active setting is enumerable");
            return Ok(JourneyFlowQuestion::Setting {
                index,
                question: setting,
            });
        }
        let current = self.draft.current_route()?;
        let remaining = self
            .remaining_routes()?
            .into_iter()
            .filter(|route| !self.route_selected || route != current)
            .collect::<Vec<_>>();
        if !remaining.is_empty() && self.draft.route_names()?.len() > 1 {
            return Ok(JourneyFlowQuestion::Route(remaining));
        }
        if let Some(question) = self
            .draft
            .deployment_questions()?
            .get(self.deployment_cursor)
            .cloned()
        {
            return Ok(JourneyFlowQuestion::Deployment {
                index: self.deployment_cursor,
                question,
            });
        }
        Ok(JourneyFlowQuestion::Review)
    }
}
