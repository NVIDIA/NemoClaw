// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::labels::display_value;
use nemoclaw_authoring::{Capabilities, Diagnostics, JourneyQuestion, JourneyState};
use nemoclaw_sdk::discovery::DiscoveryObservations;
use nemoclaw_sdk::{config::Document, discovery::DiscoveryRequest};
use serde_json::Value;

pub(crate) struct JourneyWizard {
    pub(super) capabilities: Capabilities,
    pub(super) state: JourneyState,
    pub(super) history: Vec<JourneyState>,
    pub(super) selected: usize,
    pub(super) selection_changed: bool,
    pub(super) custom_answer: bool,
    pub(super) observations: DiscoveryObservations,
    /// The engines this machine's environment names, read before the first question.
    pub(super) local_engine_candidates: Vec<DiscoveryRequest>,
    pub(super) input: String,
    pub(super) error: Option<String>,
    pub(super) started: bool,
    pub(super) accepted: bool,
    pub(super) review_scroll: u16,
}

impl JourneyWizard {
    pub(crate) fn new(capabilities: Capabilities, state: JourneyState) -> Self {
        Self {
            capabilities,
            state,
            history: Vec::new(),
            selected: 0,
            selection_changed: false,
            custom_answer: false,
            observations: DiscoveryObservations::new(),
            local_engine_candidates: Vec::new(),
            input: String::new(),
            error: None,
            started: false,
            accepted: false,
            review_scroll: 0,
        }
    }

    /// Read `candidates` as this machine's engines.
    pub(crate) fn with_local_engine_candidates(
        mut self,
        candidates: Vec<DiscoveryRequest>,
    ) -> Self {
        self.local_engine_candidates = candidates;
        self
    }

    /// Keep what the target said, and which of this machine's engines answered.
    pub(super) fn remember(&mut self, observed: DiscoveryObservations) {
        self.observations.merge(observed);
        self.state
            .use_local_engines(&self.local_engine_candidates, &self.observations);
    }

    #[cfg(test)]
    pub(crate) fn state(&self) -> &JourneyState {
        &self.state
    }

    pub(crate) fn question(&self) -> Result<Option<JourneyQuestion>, Diagnostics> {
        Ok(self
            .state
            .resolve_with_observations(&self.capabilities, &self.observations)?
            .next_question()
            .cloned())
    }

    pub(super) fn choice_index(&self, question: &JourneyQuestion) -> usize {
        if self.selection_changed {
            return self.selected;
        }
        question
            .suggestion()
            .and_then(|suggested| {
                question
                    .choices()
                    .iter()
                    .position(|choice| choice == suggested)
            })
            .unwrap_or_else(|| {
                if question.required() {
                    0
                } else {
                    question.choices().len()
                }
            })
    }

    pub(crate) fn submit(&mut self, answer: Option<Value>) -> Result<(), Diagnostics> {
        let question = self
            .question()?
            .expect("submit requires an active question");
        let previous = self.state.clone();
        self.state
            .answer(&self.capabilities, question.id(), answer)?;
        self.history.push(previous);
        self.selected = 0;
        self.selection_changed = false;
        self.custom_answer = false;
        self.input.clear();
        self.error = None;
        Ok(())
    }

    pub(super) fn delegate(&mut self) {
        match self
            .state
            .delegate_remaining(&self.capabilities, &self.observations)
        {
            Ok(delegated) => {
                self.history.push(self.state.clone());
                self.state = delegated;
                self.error = None;
            }
            // The resolver already supplies a catalog credential note. Keep
            // its deferred model check separate from compatibility failures.
            Err(error)
                if error
                    .items()
                    .iter()
                    .all(|item| item.field() == "inference:catalog:credential") =>
            {
                self.error = None;
            }
            Err(error) => self.error = Some(error.to_string()),
        }
    }

    pub(super) fn back(&mut self) {
        if let Some(previous) = self.history.pop() {
            self.state = previous;
            self.selected = 0;
            self.selection_changed = false;
            self.custom_answer = false;
            self.input.clear();
            self.error = None;
        } else {
            self.started = false;
        }
    }

    // A resolver failure has no choices to move through; the view shows it.
    pub(super) fn previous(&mut self) {
        match self.question() {
            Ok(None) if self.started => {
                self.review_scroll = self.review_scroll.saturating_sub(1);
            }
            Ok(Some(question)) if !question.choices().is_empty() => {
                self.selected = self.choice_index(&question).saturating_sub(1);
                self.selection_changed = true;
            }
            _ => {}
        }
    }

    pub(super) fn next(&mut self) {
        match self.question() {
            Ok(None) if self.started => {
                self.review_scroll = self.review_scroll.saturating_add(1);
            }
            Ok(Some(question)) if !question.choices().is_empty() => {
                self.selected = (self.choice_index(&question) + 1).min(
                    question.choices().len()
                        - usize::from(question.required() && !question.allows_custom_answer()),
                );
                self.selection_changed = true;
            }
            _ => {}
        }
    }

    pub(super) fn suggested_input(&self, question: &JourneyQuestion) -> String {
        question
            .suggestion()
            .map_or_else(String::new, display_value)
    }

    pub(super) fn answer_from_input(
        &self,
        question: &JourneyQuestion,
    ) -> Result<Option<Value>, String> {
        if !question.choices().is_empty() {
            if question.allows_custom_answer() && self.custom_answer {
                return if self.input.trim().is_empty() {
                    Err("Enter a model identifier.".into())
                } else {
                    Ok(Some(Value::String(self.input.clone())))
                };
            }
            return Ok(question.choices().get(self.choice_index(question)).cloned());
        }
        let raw = if self.input.is_empty() {
            self.suggested_input(question)
        } else {
            self.input.clone()
        };
        if raw.trim().is_empty() {
            return if question.required() {
                Err("A value is required.".into())
            } else {
                Ok(None)
            };
        }
        if question.schema()["type"] == "string"
            || (question.schema()["type"].is_null()
                && question.schema().get("oneOf").is_none()
                && question.schema().get("anyOf").is_none())
        {
            Ok(Some(Value::String(raw)))
        } else {
            serde_json::from_str(&raw)
                .map(Some)
                .map_err(|error| format!("Enter a JSON value: {error}"))
        }
    }

    pub(super) fn advance(&mut self) {
        if !self.started {
            self.started = true;
            return;
        }
        let resolution = match self
            .state
            .resolve_with_observations(&self.capabilities, &self.observations)
        {
            Ok(resolution) => resolution,
            Err(error) => {
                self.error = Some(error.to_string());
                return;
            }
        };
        let Some(question) = resolution.next_question().cloned() else {
            if resolution.ready_document().is_some() {
                self.accepted = true;
            } else {
                let issues = resolution
                    .assessment()
                    .issues()
                    .iter()
                    .map(|issue| format!("{}: {}", issue.path(), issue.rule()))
                    .collect::<Vec<_>>();
                self.error = Some(format!(
                    "Cannot save yet: {} {} {}",
                    resolution.unverified().join("; "),
                    issues.join("; "),
                    resolution
                        .target_assessment()
                        .map(|assessment| assessment.reasons.join("; "))
                        .unwrap_or_default()
                ));
            }
            return;
        };
        if question.allows_custom_answer()
            && !question.choices().is_empty()
            && self.choice_index(&question) == question.choices().len()
            && !self.custom_answer
        {
            self.custom_answer = true;
            self.input.clear();
            return;
        }
        let result = self
            .answer_from_input(&question)
            .and_then(|value| self.submit(value).map_err(|error| error.to_string()));
        if let Err(error) = result {
            self.error = Some(error);
        }
    }

    pub(super) fn document(&self) -> Result<Document, Box<dyn std::error::Error>> {
        self.state
            .resolve_with_observations(&self.capabilities, &self.observations)?
            .ready_document()
            .cloned()
            .ok_or_else(|| "the journey is not complete".into())
    }
}
